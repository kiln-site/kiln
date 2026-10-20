/**
 * Ordered lanes for every Relay mutation.
 *
 * An operation names the resources it touches as lock keys, each shared or
 * exclusive. It is granted when no running operation holds a conflicting
 * lock and no operation admitted before it is still waiting on a
 * conflicting one, so conflicting work runs in admission order while work on
 * other resources runs at once. All of an operation's locks are granted
 * together, which rules out deadlock.
 *
 * Every actor admits through the same lanes: Hearth's control socket, the
 * browser socket, SFTP, schedules, crash recovery, and the background
 * workers. See docs/relay-operations.md for the keys each operation takes.
 */
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"

export type LaneMode = "exclusive" | "shared"

export interface LaneLock {
  readonly key: string
  readonly mode: LaneMode
}

export const exclusive = (key: string): LaneLock => ({
  key,
  mode: "exclusive",
})

export const shared = (key: string): LaneLock => ({ key, mode: "shared" })

/**
 * Lock keys. A whole resource and its parts are separate keys: work on a part
 * takes the whole shared and the part exclusive, and work that replaces the
 * whole takes it exclusive, which waits for every part.
 */
export const laneKeys = {
  app: (id: string) => `app:${id}`,
  appFiles: (id: string) => `app:${id}/files`,
  appLifecycle: (id: string) => `app:${id}/lifecycle`,
  database: (id: string) => `database:${id}`,
  /** The Relay host's own files, under the host file root. */
  hostFiles: "relay:host-files",
  instance: (id: string) => `instance:${id}`,
  instanceFiles: (id: string) => `instance:${id}/files`,
  /** Power and console input: anything that changes the running process. */
  instanceLifecycle: (id: string) => `instance:${id}/lifecycle`,
  instanceMetadata: (id: string) => `instance:${id}/metadata`,
  /** Web routes, game ports, and the edge proxy shared by every resource. */
  routes: "relay:routes",
  /**
   * The node's memory and disk, which instances' limits reserve: checking a
   * change against the others and applying it happen together.
   */
  allocations: "relay:allocations",
  /** The Relay's own Tailscale settings, which every stack runs under. */
  tailscale: "relay:tailscale",
  /** One of the Relay's Docker named volumes. */
  volume: (id: string) => `volume:${id}`,
} as const

export class LaneRejectedError extends Schema.TaggedError<LaneRejectedError>()(
  "LaneRejectedError",
  {
    reason: Schema.Literals(["busy", "cancelled", "paused", "superseded"]),
    message: Schema.String,
  }
) {}

export interface LaneAdmission {
  /** Names the operation in diagnostics, such as `instance.action`. */
  readonly label: string
  /**
   * The locks, or a promise of them when a target must be looked up first.
   * Until a lookup settles, nothing admitted after it can be granted.
   */
  readonly locks: ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>>
  /**
   * Checked when the locks are granted, so it sees everything that ran
   * before. Returning false ends the operation as superseded.
   */
  readonly precondition?: () => boolean
}

export interface LaneTicket {
  /**
   * Waits for the locks, then runs `effect` holding them. Once started, the
   * operation runs to completion and keeps its locks even if the caller
   * stops waiting: an interrupted caller only abandons the result.
   */
  readonly run: <A, E>(
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, E | LaneRejectedError>
  /** Withdraws an operation that hasn't started. Running ones are unaffected. */
  readonly cancel: () => void
}

type WaiterState = "done" | "granted" | "running" | "waiting"

interface Waiter {
  readonly label: string
  readonly nested: boolean
  locks: ReadonlyArray<LaneLock> | null
  readonly precondition: (() => boolean) | undefined
  readonly granted: Deferred.Deferred<void, LaneRejectedError>
  /** Why a granted operation was withdrawn before it started. */
  refusal?: LaneRejectedError
  state: WaiterState
}

interface HeldLock {
  shared: number
  exclusive: boolean
}

export interface OperationLanesOptions {
  /** Operations allowed to wait at once before new ones are refused. */
  readonly maxWaiting?: number
}

const DEFAULT_MAX_WAITING = 512

export class OperationLanes {
  readonly #maxWaiting: number
  readonly #waiting: Array<Waiter> = []
  readonly #nested: Array<Waiter> = []
  readonly #active = new Set<Waiter>()
  readonly #exclusiveStarts = new Map<string, number>()
  #paused = false
  readonly #held = new Map<string, HeldLock>()

  constructor(options: OperationLanesOptions = {}) {
    this.#maxWaiting = options.maxWaiting ?? DEFAULT_MAX_WAITING
  }

  /**
   * Takes the operation's place in line now. Call this as the request
   * arrives, before any asynchronous work, so arrival order is kept.
   */
  admit(admission: LaneAdmission): LaneTicket {
    return this.#admit(admission, false)
  }

  /** Admits and runs in one step, for callers that start right away. */
  run<A, E>(
    admission: LaneAdmission,
    effect: Effect.Effect<A, E>
  ): Effect.Effect<A, E | LaneRejectedError> {
    return Effect.suspend(() => this.#admit(admission, false).run(effect))
  }

  /**
   * Takes more locks from inside a running operation, such as a delete that
   * clears its web routes once the server is gone. It waits only for
   * operations holding those locks, not for ones waiting in line, since
   * those may be waiting for this operation to finish.
   *
   * Only call this while running an operation, and only for keys that no
   * operation takes while waiting on what this one holds.
   */
  runNested<A, E>(
    admission: Omit<LaneAdmission, "precondition">,
    effect: Effect.Effect<A, E>
  ): Effect.Effect<A, E | LaneRejectedError> {
    return Effect.suspend(() => this.#admit(admission, true).run(effect))
  }

  /**
   * While paused, nothing new starts: work admitted now is refused, and work
   * still waiting, or granted but not yet started, is withdrawn. Work already
   * running finishes, and can take the nested locks it needs to.
   */
  setPaused(paused: boolean): void {
    this.#paused = paused
    if (!paused) return
    for (const waiter of this.#waiting.splice(0)) {
      waiter.state = "done"
      Deferred.doneUnsafe(waiter.granted, Exit.fail(pausedError(waiter.label)))
    }
    for (const waiter of this.#active) {
      if (waiter.nested || waiter.state !== "granted") continue
      waiter.refusal = pausedError(waiter.label)
      this.#release(waiter)
    }
    this.#grant()
  }

  get paused(): boolean {
    return this.#paused
  }

  #admit(admission: LaneAdmission, nested: boolean): LaneTicket {
    const waiter: Waiter = {
      granted: Deferred.makeUnsafe<void, LaneRejectedError>(),
      label: admission.label,
      locks: null,
      nested,
      precondition: admission.precondition,
      state: "waiting",
    }
    const queue = nested ? this.#nested : this.#waiting
    if (!nested && this.#paused) {
      this.#reject(waiter, pausedError(admission.label))
    } else if (!nested && this.#waiting.length >= this.#maxWaiting) {
      this.#reject(
        waiter,
        new LaneRejectedError({
          message: "The Relay is busy; try again shortly",
          reason: "busy",
        })
      )
    } else {
      queue.push(waiter)
      if (Array.isArray(admission.locks)) {
        waiter.locks = admission.locks
      } else {
        const lookup = admission.locks as Promise<ReadonlyArray<LaneLock>>
        Effect.runFork(
          Effect.tryPromise(() => lookup).pipe(
            Effect.match({
              onFailure: (cause) => {
                if (waiter.state !== "waiting") return
                this.#remove(waiter)
                waiter.state = "done"
                Deferred.doneUnsafe(waiter.granted, Exit.die(cause))
                this.#grant()
              },
              onSuccess: (locks) => {
                if (waiter.state !== "waiting") return
                waiter.locks = locks
                this.#grant()
              },
            })
          )
        )
      }
      this.#grant()
    }
    return {
      cancel: () => this.#cancel(waiter),
      run: (effect) => this.#run(waiter, effect),
    }
  }

  /**
   * How many operations holding `key` exclusively have started. Something
   * that keeps a resource open across operations, such as an SFTP file
   * handle, notes this and stops once it changes: whatever replaced the
   * resource ran between.
   */
  exclusiveGeneration(key: string): number {
    return this.#exclusiveStarts.get(key) ?? 0
  }

  /** How many operations hold locks and how many wait, for diagnostics. */
  get pending(): { readonly active: number; readonly waiting: number } {
    return {
      active: this.#active.size,
      waiting: this.#waiting.length + this.#nested.length,
    }
  }

  #run<A, E>(
    waiter: Waiter,
    effect: Effect.Effect<A, E>
  ): Effect.Effect<A, E | LaneRejectedError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        // The span the work runs in notes how long it waited its turn, for
        // a request or a background worker alike.
        const queuedAt = Date.now()
        yield* restore(Deferred.await(waiter.granted)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => this.#cancel(waiter))),
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.annotateCurrentSpan(
                "relay.lanes.wait_ms",
                Date.now() - queuedAt
              )
            )
          )
        )
        if (waiter.state !== "granted") {
          return yield* (waiter.refusal ??
            new LaneRejectedError({
              message: `${waiter.label} was already run or withdrawn`,
              reason: "cancelled",
            }))
        }
        waiter.state = "running"
        // Counted once it runs, so a request refused or withdrawn after its
        // grant replaces nothing.
        for (const lock of waiter.locks ?? []) {
          if (lock.mode === "exclusive") {
            this.#exclusiveStarts.set(
              lock.key,
              this.exclusiveGeneration(lock.key) + 1
            )
          }
        }
        const fiber = yield* effect.pipe(
          Effect.ensuring(Effect.sync(() => this.#release(waiter))),
          Effect.forkDetach({ startImmediately: true })
        )
        return yield* restore(Fiber.join(fiber))
      })
    )
  }

  #cancel(waiter: Waiter) {
    if (waiter.state === "waiting") {
      this.#remove(waiter)
      this.#reject(
        waiter,
        new LaneRejectedError({
          message: `${waiter.label} was withdrawn before it started`,
          reason: "cancelled",
        })
      )
      this.#grant()
    } else if (waiter.state === "granted") {
      this.#release(waiter)
    }
  }

  #reject(waiter: Waiter, error: LaneRejectedError) {
    waiter.state = "done"
    Deferred.doneUnsafe(waiter.granted, Exit.fail(error))
  }

  #remove(waiter: Waiter) {
    const queue = waiter.nested ? this.#nested : this.#waiting
    const index = queue.indexOf(waiter)
    if (index >= 0) queue.splice(index, 1)
  }

  #release(waiter: Waiter) {
    if (waiter.state === "done") return
    waiter.state = "done"
    this.#active.delete(waiter)
    for (const lock of waiter.locks ?? []) {
      const held = this.#held.get(lock.key)
      if (!held) continue
      if (lock.mode === "exclusive") held.exclusive = false
      else held.shared -= 1
      if (!held.exclusive && held.shared === 0) this.#held.delete(lock.key)
    }
    this.#grant()
  }

  #take(locks: ReadonlyArray<LaneLock>) {
    for (const lock of locks) hold(this.#held, lock)
  }

  /**
   * Grants every waiting operation whose locks are free and that no earlier
   * waiting operation conflicts with. An operation still looking up its
   * locks holds back everything after it.
   */
  #grant() {
    const blocked = new Map<string, HeldLock>()
    for (let index = 0; index < this.#nested.length;) {
      const waiter = this.#nested[index]!
      if (
        waiter.locks === null ||
        waiter.locks.some((lock) =>
          conflicts(this.#held.get(lock.key), lock.mode)
        )
      ) {
        for (const lock of waiter.locks ?? []) hold(blocked, lock)
        index += 1
        continue
      }
      this.#nested.splice(index, 1)
      this.#take(waiter.locks)
      waiter.state = "granted"
      this.#active.add(waiter)
      Deferred.doneUnsafe(waiter.granted, Exit.void)
    }
    for (let index = 0; index < this.#waiting.length;) {
      const waiter = this.#waiting[index]!
      if (waiter.locks === null) return
      const free = waiter.locks.every(
        (lock) =>
          !conflicts(this.#held.get(lock.key), lock.mode) &&
          !conflicts(blocked.get(lock.key), lock.mode)
      )
      if (!free) {
        for (const lock of waiter.locks) hold(blocked, lock)
        index += 1
        continue
      }
      this.#waiting.splice(index, 1)
      if (waiter.precondition && !waiter.precondition()) {
        this.#reject(
          waiter,
          new LaneRejectedError({
            message: `${waiter.label} no longer applies`,
            reason: "superseded",
          })
        )
        continue
      }
      this.#take(waiter.locks)
      waiter.state = "granted"
      this.#active.add(waiter)
      Deferred.doneUnsafe(waiter.granted, Exit.void)
    }
  }
}

function pausedError(label: string): LaneRejectedError {
  return new LaneRejectedError({
    message: `${label} didn't run: this Relay is paused`,
    reason: "paused",
  })
}

function conflicts(held: HeldLock | undefined, mode: LaneMode): boolean {
  if (!held) return false
  return held.exclusive || (mode === "exclusive" && held.shared > 0)
}

function hold(table: Map<string, HeldLock>, lock: LaneLock) {
  const held = table.get(lock.key) ?? { exclusive: false, shared: 0 }
  if (lock.mode === "exclusive") held.exclusive = true
  else held.shared += 1
  table.set(lock.key, held)
}
