import { availableParallelism, loadavg } from "node:os"

import { Effect, Fiber, Queue, type Tracer } from "effect"

import type {
  ProvisioningPhase,
  ProvisioningState,
  ProvisioningWorkPhase,
} from "@workspace/contracts"

import {
  RelayStateStore,
  type RelayProvisioningJob,
  type RelayProvisioningKind,
} from "./effect/state.js"
import { provisioningErrorMessage } from "./provisioning-errors.js"
import type { LaneLock, OperationLanes } from "./operation-lanes.js"

// Every kind of instance provisions through this one queue: Hearth prepares
// a job and claims it, a worker runs it in the instance's lane, and the
// job's placeholder stands in for the instance until it exists. What
// differs by kind is in its adapter.
//
// Jobs for different instances run at once, up to the host's capacity, so a
// slow image download or install doesn't hold up everything queued behind
// it. Each job still waits for its own instance's lanes, and a kind that
// runs one job at a time waits for its own running job, while jobs of other
// kinds go ahead of it.

type WorkPhase = ProvisioningWorkPhase

/** How many provisioning jobs the host runs at once. */
export interface ProvisioningCapacity {
  /** The most jobs that run at once. */
  readonly slots: number
  /** Whether the host is too busy to start another job beside one running. */
  readonly busy: () => boolean
}

/**
 * Half the host's cores, from two to four jobs. Past the first job, another
 * only starts while the load average is under one per core, so provisioning
 * doesn't slow the game servers already running. On Linux the load average
 * also counts work waiting on the disk, which image extraction and database
 * setup mostly are.
 */
export function hostProvisioningCapacity(): ProvisioningCapacity {
  const cores = Math.max(availableParallelism(), 1)
  return {
    busy: () => (loadavg()[0] ?? 0) / cores >= 1,
    slots: Math.min(4, Math.max(2, Math.floor(cores / 2))),
  }
}

// How long a busy host waits before checking its load again, when no running
// job finishes first.
const BUSY_RECHECK = "5 seconds"

/** How one kind of instance provisions. */
export interface ProvisioningAdapter<Kind extends RelayProvisioningKind> {
  readonly kind: Kind
  /** Names the lane work, as in `instance.provision`. */
  readonly label: string
  /** What a job holds for the whole create. */
  readonly locks: (instanceId: string) => ReadonlyArray<LaneLock>
  /**
   * Runs one job of this kind at a time, for a kind whose create changes
   * something its instances share beyond what its locks cover.
   */
  readonly oneAtATime?: boolean
  /** The placeholder showing where provisioning is. */
  readonly withState: (
    placeholder: RelayProvisioningJob<Kind>["placeholder"],
    state: ProvisioningState
  ) => RelayProvisioningJob<Kind>["placeholder"]
  /**
   * Creates the instance, calling `onPhase` as each phase starts. The job
   * is done once this resolves.
   */
  readonly provision: (
    job: RelayProvisioningJob<Kind>,
    onPhase: (phase: WorkPhase) => Promise<void>
  ) => Promise<void>
  /**
   * Tells Hearth a placeholder changed, for a kind it doesn't read on
   * request, as game servers come in the Relay's snapshot.
   */
  readonly announce?: () => Promise<unknown>
}

export type ProvisioningAdapters = {
  readonly [Kind in RelayProvisioningKind]: ProvisioningAdapter<Kind>
}

/** What a placeholder says at each phase, for an instance called `noun`. */
export function provisioningStatus(
  phase: ProvisioningPhase,
  noun: string
): string {
  switch (phase) {
    case "awaiting_claim":
      return "Waiting for Hearth"
    case "queued":
      return "Queued for provisioning"
    case "preparing":
      return `Preparing ${noun}`
    case "pulling_image":
      return `Downloading ${noun} image`
    case "creating_container":
      return `Creating ${noun}`
    case "finalizing":
      return `Finalizing ${noun}`
    case "failed":
      return "Provisioning failed"
  }
}

function provisioningState(
  phase: ProvisioningPhase,
  attempt: number,
  error: string | null = null,
  failedPhase?: WorkPhase
): ProvisioningState {
  return { attempt, error, ...(failedPhase ? { failedPhase } : {}), phase }
}

// One job's adapter, with the job's own kind.
function adapterFor<Kind extends RelayProvisioningKind>(
  adapters: ProvisioningAdapters,
  job: RelayProvisioningJob<Kind>
): ProvisioningAdapter<Kind> {
  return adapters[job.kind] as ProvisioningAdapter<Kind>
}

function placeholderAt<Kind extends RelayProvisioningKind>(
  adapters: ProvisioningAdapters,
  job: RelayProvisioningJob<Kind>,
  state: ProvisioningState
): RelayProvisioningJob<Kind>["placeholder"] {
  return adapterFor(adapters, job).withState(job.placeholder, state)
}

export class ProvisioningManager {
  readonly #adapters: ProvisioningAdapters
  readonly #capacity: ProvisioningCapacity
  readonly #lanes: OperationLanes
  // The span of the request that claimed each job, so the job's own span
  // continues the trace of the create that started it. Lost on restart.
  readonly #claims = new Map<string, Tracer.AnySpan>()
  // Jobs being claimed this moment, whose noted spans the worker keeps.
  readonly #claiming = new Set<string>()
  // Jobs the worker has taken and not yet finished or put back. Each claim
  // is its own entry, so a job put back and claimed again counts once.
  readonly #running = new Set<RelayProvisioningJob>()
  #recheckScheduled = false
  readonly #state: RelayStateStore["Service"]
  readonly #wake: Queue.Queue<void>

  private constructor(options: {
    adapters: ProvisioningAdapters
    capacity: ProvisioningCapacity
    lanes: OperationLanes
    state: RelayStateStore["Service"]
    wake: Queue.Queue<void>
  }) {
    this.#adapters = options.adapters
    this.#capacity = options.capacity
    this.#lanes = options.lanes
    this.#state = options.state
    this.#wake = options.wake
  }

  static make(options: {
    adapters: ProvisioningAdapters
    /** How many jobs run at once; see `hostProvisioningCapacity`. */
    capacity: ProvisioningCapacity
    /** The worker holds each new instance's lanes for the whole create. */
    lanes: OperationLanes
  }) {
    return Effect.gen(function* () {
      const state = yield* RelayStateStore
      const wake = yield* Queue.unbounded<void>()
      const manager = new ProvisioningManager({ ...options, state, wake })
      yield* state.requeueInterruptedProvisioningJobs(Date.now())
      yield* Queue.offer(wake, undefined)
      return manager
    })
  }

  /**
   * Records a job that waits for Hearth to claim it. The same key with the
   * same input answers the job it made before.
   */
  prepare(
    input: Omit<
      RelayProvisioningJob,
      "attempt" | "createdAt" | "error" | "status" | "updatedAt"
    >
  ) {
    return Effect.gen({ self: this }, function* () {
      const job = yield* this.#state.enqueueProvisioningJob(input, Date.now())
      yield* this.#announce(job.kind)
      return job.placeholder
    })
  }

  claim(kind: RelayProvisioningKind, instanceId: string) {
    return Effect.gen({ self: this }, function* () {
      // Noted before the job can run, so the worker always finds it.
      this.#claiming.add(instanceId)
      const claimedBy = yield* Effect.option(Effect.currentSpan)
      if (claimedBy._tag === "Some") {
        this.#claims.set(instanceId, claimedBy.value)
      }
      const job = yield* this.#state.claimProvisioningJob(
        kind,
        instanceId,
        Date.now()
      )
      if (!job)
        return yield* Effect.fail(new Error("Provisioning job not found"))
      // A job already taken or failed keeps whatever trace it had.
      if (job.status !== "queued") this.#claims.delete(instanceId)
      const placeholder =
        job.status === "queued"
          ? placeholderAt(
              this.#adapters,
              job,
              provisioningState("queued", job.attempt)
            )
          : job.placeholder
      if (job.status === "queued") {
        yield* this.#state.updateProvisioningJobPlaceholder(
          instanceId,
          placeholder,
          Date.now()
        )
        yield* Queue.offer(this.#wake, undefined)
      }
      yield* this.#announce(kind)
      return placeholder
    }).pipe(
      Effect.onError(() => Effect.sync(() => this.#claims.delete(instanceId))),
      Effect.ensuring(Effect.sync(() => this.#claiming.delete(instanceId)))
    )
  }

  cancel(kind: RelayProvisioningKind, instanceId: string) {
    return Effect.gen({ self: this }, function* () {
      const cancelled = yield* this.#state.cancelProvisioningJob(
        kind,
        instanceId
      )
      if (cancelled) this.#claims.delete(instanceId)
      if (cancelled) yield* this.#announce(kind)
      return cancelled
    })
  }

  /**
   * Removes a job that isn't running and whatever it made: it fails the
   * job first, so the worker never takes it, runs `cleanup`, and only then
   * drops the job, so if cleanup fails the job still shows what's left.
   * Refuses a job the worker has taken. Callers hold the instance's lanes.
   */
  discard(
    kind: RelayProvisioningKind,
    instanceId: string,
    cleanup: () => Promise<unknown>
  ) {
    return Effect.gen({ self: this }, function* () {
      const job = yield* this.#state.getProvisioningJob(instanceId)
      if (job?.kind !== kind) return false
      const error = "Deleting it"
      const withdrawn = yield* this.#state.withdrawProvisioningJob(
        kind,
        instanceId,
        error,
        placeholderAt(
          this.#adapters,
          job,
          provisioningState("failed", job.attempt, error, "preparing")
        ),
        Date.now()
      )
      if (!withdrawn) {
        return yield* Effect.fail(
          new Error(
            `Wait for the ${kind === "server" ? "game server" : kind} to finish provisioning before deleting it`
          )
        )
      }
      yield* this.#announce(kind)
      yield* Effect.tryPromise({ try: cleanup, catch: (cause) => cause })
      yield* this.#state.cancelProvisioningJob(kind, instanceId)
      this.#claims.delete(instanceId)
      yield* this.#announce(kind)
      return true
    })
  }

  run() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        yield* Queue.take(this.#wake)
        yield* this.#drain()
      }
    })
  }

  /** Starts jobs that waited out a pause. */
  resume() {
    return Queue.offer(this.#wake, undefined).pipe(Effect.asVoid)
  }

  // Starts queued jobs while the host has room for them. A job that
  // finishes, or is put back, wakes the worker to start the next.
  #drain() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        // Queued jobs wait out a pause.
        if (this.#lanes.paused) return
        if (this.#running.size >= this.#capacity.slots) return
        if (this.#running.size > 0 && this.#capacity.busy()) {
          yield* this.#recheckLater()
          return
        }
        const passedOver = [...this.#running]
          .map((taken) => taken.kind)
          .filter((kind) => this.#adapters[kind].oneAtATime)
        const job = yield* this.#state.claimNextProvisioningJob(
          Date.now(),
          passedOver
        )
        if (!job) {
          // Jobs of a kind passed over may still wait, with their spans.
          if (passedOver.length > 0) return
          // Nothing waits, so only a job being claimed this moment, or one
          // being put back, can still want its noted span.
          const running = new Set(
            [...this.#running].map((taken) => taken.instanceId)
          )
          for (const instanceId of this.#claims.keys()) {
            if (!this.#claiming.has(instanceId) && !running.has(instanceId)) {
              this.#claims.delete(instanceId)
            }
          }
          return
        }
        this.#running.add(job)
        const running = this.#running.size
        yield* this.#run(job, running).pipe(
          // A job that can't be recorded stays running until the Relay
          // restarts and puts it back; the worker carries on with the rest.
          Effect.catch((cause) =>
            Effect.logError("Relay provisioning job stopped", {
              cause,
              instanceId: job.instanceId,
              kind: job.kind,
            })
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              this.#running.delete(job)
              return Queue.offer(this.#wake, undefined)
            })
          ),
          Effect.forkChild
        )
      }
    })
  }

  // Checks the load again in a moment, once, while jobs wait for it to fall.
  #recheckLater() {
    if (this.#recheckScheduled) return Effect.void
    this.#recheckScheduled = true
    return Effect.sleep(BUSY_RECHECK).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          this.#recheckScheduled = false
          return Queue.offer(this.#wake, undefined)
        })
      ),
      Effect.forkChild,
      Effect.asVoid
    )
  }

  // One job, from its wait for the instance's lanes through each phase, in
  // the trace of the request that claimed it.
  #run(job: RelayProvisioningJob, running: number) {
    return Effect.gen({ self: this }, function* () {
      const adapter = adapterFor(this.#adapters, job)
      const claimedBy = this.#claims.get(job.instanceId)
      this.#claims.delete(job.instanceId)
      const refused = yield* this.#lanes
        .run(
          { label: adapter.label, locks: adapter.locks(job.instanceId) },
          this.#provision(job)
        )
        .pipe(
          Effect.as(null),
          Effect.catchTag("LaneRejectedError", (error) =>
            Effect.succeed(error)
          ),
          Effect.withSpan("relay.provisioning.job", {
            attributes: {
              "relay.instance_id": job.instanceId,
              "relay.provisioning.attempt": job.attempt,
              "relay.provisioning.kind": job.kind,
              "relay.provisioning.running": running,
            },
            ...(claimedBy ? { parent: claimedBy } : {}),
          })
        )
      if (!refused) return
      // Refused before it started, as when the Relay was paused or too
      // busy: it goes back in line, and waits for resume or a moment.
      if (claimedBy) this.#claims.set(job.instanceId, claimedBy)
      yield* this.#state.returnProvisioningJob(job.instanceId, Date.now())
      yield* this.#announce(job.kind)
      if (refused.reason !== "paused") yield* Effect.sleep("1 second")
    })
  }

  #provision(job: RelayProvisioningJob) {
    const adapters = this.#adapters
    const state = this.#state
    let failedPhase: WorkPhase = "preparing"
    return Effect.gen({ self: this }, function* () {
      // The adapter reports each phase as it starts; each phase's span runs
      // until the next one starts or the work ends.
      const phases = yield* Queue.unbounded<WorkPhase | null>()
      const work = yield* Effect.tryPromise({
        try: async () => {
          const onPhase = async (phase: WorkPhase) => {
            failedPhase = phase
            await Effect.runPromise(Queue.offer(phases, phase))
            await Effect.runPromise(
              state.updateProvisioningJobPlaceholder(
                job.instanceId,
                placeholderAt(
                  adapters,
                  job,
                  provisioningState(phase, job.attempt)
                ),
                Date.now()
              )
            )
            await Effect.runPromise(this.#announce(job.kind))
          }
          await adapterFor(adapters, job).provision(job, onPhase)
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.ensuring(Queue.offer(phases, null)),
        Effect.forkChild
      )
      let phase = yield* Queue.take(phases)
      while (phase !== null) {
        phase = yield* Queue.take(phases).pipe(
          Effect.withSpan("relay.provisioning.phase", {
            attributes: { "relay.provisioning.phase": phase },
          })
        )
      }
      yield* Fiber.join(work)
      yield* state.completeProvisioningJob(job.instanceId)
      yield* this.#announce(job.kind)
      yield* Effect.annotateCurrentSpan("relay.provisioning.outcome", "succeeded")
    }).pipe(
      Effect.catch((cause) => {
        const message = provisioningErrorMessage(cause)
        return state
          .failProvisioningJob(
            job.instanceId,
            message,
            placeholderAt(
              adapters,
              job,
              provisioningState("failed", job.attempt, message, failedPhase)
            ),
            Date.now()
          )
          .pipe(
            Effect.tap(() => this.#announce(job.kind)),
            Effect.tap(() =>
              Effect.annotateCurrentSpan({
                "relay.provisioning.failed_phase": failedPhase,
                "relay.provisioning.outcome": "failed",
              })
            ),
            Effect.tap(() =>
              Effect.logError("Relay provisioning failed", {
                cause,
                instanceId: job.instanceId,
                kind: job.kind,
              })
            ),
            Effect.asVoid
          )
      })
    )
  }

  #announce(kind: RelayProvisioningKind) {
    const announce = this.#adapters[kind].announce
    if (!announce) return Effect.void
    return Effect.tryPromise(announce).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Relay provisioning announcement failed", {
          cause,
          kind,
        })
      )
    )
  }
}
