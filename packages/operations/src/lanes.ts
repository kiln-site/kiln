/**
 * In-memory operation lanes: the scheduler a single process runs, as each
 * Relay does for every change it makes.
 *
 * An operation names the resources it touches as lock keys, each shared or
 * exclusive. It is granted when no running operation holds a conflicting
 * lock and no operation admitted before it is still waiting on a
 * conflicting one (see `selectGrants`), so conflicting work runs in
 * admission order while work on other resources runs at once.
 */
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"

import { explainWait, selectGrants, type WaitReason } from "./grants.js"
import { LockTable, normalizeLocks, type LaneLock } from "./locks.js"

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

/** What the lanes hold and what waits on what, for diagnostics. */
export interface LaneDescription {
  readonly active: ReadonlyArray<{
    readonly label: string
    readonly locks: ReadonlyArray<LaneLock>
  }>
  readonly waiting: ReadonlyArray<{
    readonly label: string
    /** Null while its locks are still being looked up. */
    readonly locks: ReadonlyArray<LaneLock> | null
    /** The labels of the operations in its way, by key. */
    readonly waitingOn: ReadonlyArray<WaitReason<string>>
  }>
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

export interface OperationLanesOptions {
  /** Operations allowed to wait at once before new ones are refused. */
  readonly maxWaiting?: number
  /** What a refused operation is told, in its home's words. */
  readonly messages?: {
    readonly busy?: string
    readonly paused?: (label: string) => string
  }
  /**
   * The span attribute noting how long an operation waited its turn, kept
   * stable for each home's dashboards.
   */
  readonly waitAttribute?: string
}

const DEFAULT_MAX_WAITING = 512

export class OperationLanes {
  readonly #maxWaiting: number
  readonly #busyMessage: string
  readonly #pausedMessage: (label: string) => string
  readonly #waitAttribute: string
  readonly #waiting: Array<Waiter> = []
  readonly #nested: Array<Waiter> = []
  readonly #active = new Set<Waiter>()
  readonly #exclusiveStarts = new Map<string, number>()
  #paused = false
  readonly #held = new LockTable()

  constructor(options: OperationLanesOptions = {}) {
    this.#maxWaiting = options.maxWaiting ?? DEFAULT_MAX_WAITING
    this.#busyMessage =
      options.messages?.busy ??
      "Too many operations are waiting; try again shortly"
    this.#pausedMessage =
      options.messages?.paused ??
      ((label) => `${label} didn't run: operations are paused`)
    this.#waitAttribute = options.waitAttribute ?? "lanes.wait_ms"
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
      Deferred.doneUnsafe(waiter.granted, Exit.fail(this.#pausedError(waiter)))
    }
    for (const waiter of this.#active) {
      if (waiter.nested || waiter.state !== "granted") continue
      waiter.refusal = this.#pausedError(waiter)
      this.#release(waiter)
    }
    this.#grant()
  }

  get paused(): boolean {
    return this.#paused
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

  /** What holds which locks, and what each waiting operation waits on. */
  describe(): LaneDescription {
    const occupant = (waiter: Waiter) => ({
      id: waiter.label,
      locks: waiter.locks ?? [],
    })
    const active = [...this.#active].map(occupant)
    const queue = [...this.#nested, ...this.#waiting]
    return {
      active: active.map(({ id, locks }) => ({ label: id, locks })),
      waiting: queue.map((waiter, index) => ({
        label: waiter.label,
        locks: waiter.locks,
        waitingOn:
          waiter.locks === null
            ? []
            : explainWait(
                waiter.locks,
                active,
                queue.slice(0, index).map(occupant)
              ),
      })),
    }
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
      this.#reject(waiter, this.#pausedError(waiter))
    } else if (!nested && this.#waiting.length >= this.#maxWaiting) {
      this.#reject(
        waiter,
        new LaneRejectedError({ message: this.#busyMessage, reason: "busy" })
      )
    } else {
      queue.push(waiter)
      if (Array.isArray(admission.locks)) {
        waiter.locks = normalizeLocks(admission.locks)
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
                waiter.locks = normalizeLocks(locks)
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
                this.#waitAttribute,
                Date.now() - queuedAt
              )
            )
          )
        )
        if (waiter.state !== "granted") {
          return yield* (
            waiter.refusal ??
              new LaneRejectedError({
                message: `${waiter.label} was already run or withdrawn`,
                reason: "cancelled",
              })
          )
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

  #pausedError(waiter: Waiter) {
    return new LaneRejectedError({
      message: this.#pausedMessage(waiter.label),
      reason: "paused",
    })
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
    this.#held.release(waiter.locks ?? [])
    this.#grant()
  }

  #start(waiter: Waiter) {
    waiter.state = "granted"
    this.#active.add(waiter)
    Deferred.doneUnsafe(waiter.granted, Exit.void)
  }

  /**
   * Grants nested operations whose locks are free, then every waiting
   * operation the lane rule allows.
   */
  #grant() {
    // Nested operations wait only for holders, never for the line, and
    // what they still wait for holds back the line behind them.
    const blocked = new LockTable()
    for (let index = 0; index < this.#nested.length;) {
      const waiter = this.#nested[index]!
      if (
        waiter.locks === null ||
        waiter.locks.some((lock) => this.#held.conflicts(lock))
      ) {
        blocked.take(waiter.locks ?? [])
        index += 1
        continue
      }
      this.#nested.splice(index, 1)
      this.#held.take(waiter.locks)
      this.#start(waiter)
    }
    const { dropped, granted } = selectGrants(this.#held, this.#waiting, {
      admit: (waiter) => !waiter.precondition || waiter.precondition(),
      blocked,
      locksOf: (waiter) => waiter.locks,
    })
    for (const waiter of [...granted, ...dropped]) this.#remove(waiter)
    for (const waiter of dropped) {
      this.#reject(
        waiter,
        new LaneRejectedError({
          message: `${waiter.label} no longer applies`,
          reason: "superseded",
        })
      )
    }
    for (const waiter of granted) this.#start(waiter)
  }
}
