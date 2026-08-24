import { Effect, Queue } from "effect"

import type {
  RelayCreateInstance,
  RelayInstance,
  RelayInstanceProvisioning,
} from "@workspace/contracts"

import type { LifecycleDriver } from "./lifecycle.js"
import { RelayStateStore } from "./effect/state.js"

const EFFECT_PROMISE_FAILURE = "An error occurred in Effect.tryPromise"

export function provisioningErrorMessage(cause: unknown): string {
  const messages = errorMessages(cause)
  const combined = messages.join("\n").toLowerCase()

  if (
    combined.includes("all predefined address pools have been fully subnetted")
  ) {
    return "Docker could not create Kiln's private server network because all default address pools are in use. Remove unused Docker networks or expand Docker's default-address-pools, then provision the server again."
  }
  if (combined.includes("no space left on device")) {
    return "The Relay ran out of disk space while building this server. Free disk space on the Relay, then provision the server again."
  }
  if (
    combined.includes("port is already allocated") ||
    combined.includes("address already in use")
  ) {
    return "Docker could not bind a required server port because it is already in use. Free the conflicting port on the Relay, then provision the server again."
  }
  if (
    combined.includes("permission denied") &&
    (combined.includes("docker.sock") || combined.includes("docker daemon"))
  ) {
    return "The Relay does not have permission to use Docker. Restore Docker access for the Relay service, then provision the server again."
  }

  const message = [...messages]
    .reverse()
    .find((candidate) => candidate !== EFFECT_PROMISE_FAILURE)
  if (!message) return "The Relay could not finish provisioning this server."

  const detail = message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => !line.startsWith("Command failed:"))
  return (detail ?? message).slice(0, 2_048)
}

function errorMessages(cause: unknown): Array<string> {
  const messages: Array<string> = []
  const seen = new Set<object>()
  let current = cause

  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) break
    seen.add(current)
    if (
      "message" in current &&
      typeof current.message === "string" &&
      current.message.trim()
    ) {
      messages.push(current.message.trim())
    }
    current = "cause" in current ? current.cause : undefined
  }

  return messages
}

function withPhase(
  instance: RelayInstance,
  phase: RelayInstanceProvisioning["phase"],
  attempt: number,
  error: string | null = null,
  failedPhase?: RelayInstanceProvisioning["failedPhase"]
): RelayInstance {
  const failed = phase === "failed"
  return {
    ...instance,
    observedState: failed ? "failed" : "provisioning",
    provisioning: {
      attempt,
      error,
      ...(failedPhase ? { failedPhase } : {}),
      phase,
    },
    status: failed ? "Provisioning failed" : provisioningStatus(phase),
  }
}

function provisioningStatus(phase: RelayInstanceProvisioning["phase"]): string {
  switch (phase) {
    case "awaiting_claim":
      return "Waiting for Hearth"
    case "queued":
      return "Queued for provisioning"
    case "preparing":
      return "Preparing server"
    case "pulling_image":
      return "Downloading server image"
    case "creating_container":
      return "Creating server"
    case "finalizing":
      return "Finalizing server"
    case "failed":
      return "Provisioning failed"
  }
}

export class ProvisioningManager {
  readonly #lifecycle: LifecycleDriver
  readonly #refreshSnapshot: () => Promise<unknown>
  readonly #state: RelayStateStore["Service"]
  readonly #wake: Queue.Queue<void>

  private constructor(options: {
    lifecycle: LifecycleDriver
    refreshSnapshot: () => Promise<unknown>
    state: RelayStateStore["Service"]
    wake: Queue.Queue<void>
  }) {
    this.#lifecycle = options.lifecycle
    this.#refreshSnapshot = options.refreshSnapshot
    this.#state = options.state
    this.#wake = options.wake
  }

  static make(options: {
    lifecycle: LifecycleDriver
    refreshSnapshot: () => Promise<unknown>
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

  prepare(input: {
    idempotencyKey: string
    instanceId: string
    input: RelayCreateInstance
    placeholder: RelayInstance
  }) {
    return Effect.gen({ self: this }, function* () {
      const job = yield* this.#state.enqueueProvisioningJob(input, Date.now())
      yield* this.#refresh()
      return job.placeholder
    })
  }

  claim(instanceId: string) {
    return Effect.gen({ self: this }, function* () {
      const job = yield* this.#state.claimProvisioningJob(
        instanceId,
        Date.now()
      )
      if (!job)
        return yield* Effect.fail(new Error("Provisioning job not found"))
      const placeholder =
        job.status === "queued"
          ? withPhase(job.placeholder, "queued", job.attempt)
          : job.placeholder
      if (job.status === "queued") {
        yield* this.#state.updateProvisioningJobPlaceholder(
          instanceId,
          placeholder,
          Date.now()
        )
        yield* Queue.offer(this.#wake, undefined)
      }
      yield* this.#refresh()
      return placeholder
    })
  }

  cancel(instanceId: string) {
    return Effect.gen({ self: this }, function* () {
      const cancelled = yield* this.#state.cancelProvisioningJob(instanceId)
      if (cancelled) yield* this.#refresh()
      return cancelled
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

  #drain() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const job = yield* this.#state.claimNextProvisioningJob(Date.now())
        if (!job) return
        let failedPhase: RelayInstanceProvisioning["failedPhase"] = "preparing"
        yield* Effect.tryPromise({
          try: async () => {
            const updatePhase = async (
              phase: RelayInstanceProvisioning["phase"]
            ) => {
              if (
                phase !== "awaiting_claim" &&
                phase !== "queued" &&
                phase !== "failed"
              ) {
                failedPhase = phase
              }
              const placeholder = withPhase(job.placeholder, phase, job.attempt)
              await Effect.runPromise(
                this.#state.updateProvisioningJobPlaceholder(
                  job.instanceId,
                  placeholder,
                  Date.now()
                )
              )
              await Effect.runPromise(this.#refresh())
            }
            const instance = await this.#lifecycle.createInstanceWithId(
              job.instanceId,
              job.input,
              updatePhase
            )
            await Effect.runPromise(
              this.#state.setInstanceName(
                job.instanceId,
                job.input.name ?? instance.name
              )
            )
            await Effect.runPromise(
              this.#state.completeProvisioningJob(job.instanceId)
            )
            await Effect.runPromise(this.#refresh())
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) => {
            const message = provisioningErrorMessage(cause)
            const placeholder = withPhase(
              job.placeholder,
              "failed",
              job.attempt,
              message,
              failedPhase
            )
            return this.#state
              .failProvisioningJob(
                job.instanceId,
                message,
                placeholder,
                Date.now()
              )
              .pipe(
                Effect.tap(() => this.#refresh()),
                Effect.tap(() =>
                  Effect.logError("Relay instance provisioning failed", {
                    cause,
                    instanceId: job.instanceId,
                  })
                ),
                Effect.asVoid
              )
          })
        )
      }
    })
  }

  #refresh() {
    return Effect.tryPromise(() => this.#refreshSnapshot()).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Relay provisioning snapshot refresh failed", {
          cause,
        })
      )
    )
  }
}
