import { Effect, Queue } from "effect"

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

type WorkPhase = ProvisioningWorkPhase

/** How one kind of instance provisions. */
export interface ProvisioningAdapter<Kind extends RelayProvisioningKind> {
  readonly kind: Kind
  /** Names the lane work, as in `instance.provision`. */
  readonly label: string
  /** What a job holds for the whole create. */
  readonly locks: (instanceId: string) => ReadonlyArray<LaneLock>
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
  readonly #lanes: OperationLanes
  readonly #state: RelayStateStore["Service"]
  readonly #wake: Queue.Queue<void>

  private constructor(options: {
    adapters: ProvisioningAdapters
    lanes: OperationLanes
    state: RelayStateStore["Service"]
    wake: Queue.Queue<void>
  }) {
    this.#adapters = options.adapters
    this.#lanes = options.lanes
    this.#state = options.state
    this.#wake = options.wake
  }

  static make(options: {
    adapters: ProvisioningAdapters
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
      const job = yield* this.#state.claimProvisioningJob(
        kind,
        instanceId,
        Date.now()
      )
      if (!job)
        return yield* Effect.fail(new Error("Provisioning job not found"))
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
    })
  }

  cancel(kind: RelayProvisioningKind, instanceId: string) {
    return Effect.gen({ self: this }, function* () {
      const cancelled = yield* this.#state.cancelProvisioningJob(
        kind,
        instanceId
      )
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

  #drain() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        // Queued jobs wait out a pause.
        if (this.#lanes.paused) return
        const job = yield* this.#state.claimNextProvisioningJob(Date.now())
        if (!job) return
        const adapter = adapterFor(this.#adapters, job)
        const refused = yield* this.#lanes
          .run(
            { label: adapter.label, locks: adapter.locks(job.instanceId) },
            this.#provision(job)
          )
          .pipe(
            Effect.as(null),
            Effect.catchTag("LaneRejectedError", (error) =>
              Effect.succeed(error)
            )
          )
        if (!refused) continue
        // Refused before it started, as when the Relay was paused or too
        // busy: it goes back in line, and waits for resume or a moment.
        yield* this.#state.returnProvisioningJob(job.instanceId, Date.now())
        yield* this.#announce(job.kind)
        if (refused.reason === "paused") return
        yield* Effect.sleep("1 second")
      }
    })
  }

  #provision(job: RelayProvisioningJob) {
    const adapters = this.#adapters
    const state = this.#state
    let failedPhase: WorkPhase = "preparing"
    return Effect.tryPromise({
      try: async () => {
        const onPhase = async (phase: WorkPhase) => {
          failedPhase = phase
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
        await Effect.runPromise(state.completeProvisioningJob(job.instanceId))
        await Effect.runPromise(this.#announce(job.kind))
      },
      catch: (cause) => cause,
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
