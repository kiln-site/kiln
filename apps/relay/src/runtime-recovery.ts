import * as Sentry from "@sentry/node"
import { Clock, Effect, Semaphore } from "effect"
import type {
  RelayDesiredState,
  RelayInstanceRecovery,
} from "@workspace/contracts"

import { commandEffect } from "./command.js"
import type { RelayConfig } from "./config.js"
import {
  INSTANCE_STOP_TIMEOUT_SECONDS,
  type InstancePowerAction,
} from "./power-state.js"
import type {
  RelayRuntimeRecoveryRecord,
  RelayStateStore,
} from "./effect/state.js"

const MAXIMUM_RETRY_DELAY_MS = 60_000
const START_CONFIRMATION_TIMEOUT_MS = 30_000

export interface RuntimeRecoveryObservation {
  readonly dockerRestartConfigured: boolean
  readonly exitCode: number
  readonly finishedAt: string
  readonly installationReady: boolean
  readonly instanceId: string
  readonly managedByRelay: boolean
  readonly oomKilled: boolean
  readonly ready: boolean
  readonly restarting: boolean
  readonly running: boolean
  readonly service: string
  readonly startedAt: string
  readonly transitionActive: boolean
}

export interface RuntimeRecoverySnapshot {
  readonly desiredState: RelayDesiredState
  readonly recovery: RelayInstanceRecovery | null
}

export class RuntimeRecoveryManager {
  readonly #activeStops = new Map<string, symbol>()
  readonly #config: RelayConfig["runtimeRecovery"]
  readonly #activeStarts = new Map<string, symbol>()
  readonly #locks = new Map<string, Semaphore.Semaphore>()
  readonly #records = new Map<string, RelayRuntimeRecoveryRecord>()
  readonly #reportedStopFailures = new Set<string>()
  readonly #state: RelayStateStore["Service"]

  constructor(config: RelayConfig, state: RelayStateStore["Service"]) {
    this.#config = config.runtimeRecovery
    this.#state = state
  }

  initialize(): Effect.Effect<void, unknown> {
    return this.#state.listRuntimeRecoveries().pipe(
      Effect.tap((records) =>
        Effect.sync(() => {
          this.#records.clear()
          this.#reportedStopFailures.clear()
          for (const record of records) {
            this.#records.set(record.instanceId, record)
          }
        })
      ),
      Effect.asVoid,
      Effect.withSpan("relay.runtimeRecovery.initialize")
    )
  }

  reconcile(
    observations: ReadonlyArray<RuntimeRecoveryObservation>
  ): Effect.Effect<ReadonlyMap<string, RuntimeRecoverySnapshot>, unknown> {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.forEach(
          observations,
          (observation) =>
            this.#lock(observation.instanceId).withPermit(
              this.#reconcileObservation(observation, now)
            ),
          { concurrency: "unbounded" }
        )
      ),
      Effect.map(
        (entries) =>
          new Map(
            entries.map(([instanceId, snapshot]) => [instanceId, snapshot])
          )
      ),
      Effect.withSpan("relay.runtimeRecovery.reconcile")
    )
  }

  recordProvisioned(
    instanceId: string,
    desiredState: RelayDesiredState
  ): Effect.Effect<void, unknown> {
    return this.#lock(instanceId)
      .withPermit(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            this.#persist(initialRecoveryRecord(instanceId, desiredState, now))
          ),
          Effect.asVoid
        )
      )
      .pipe(Effect.withSpan("relay.runtimeRecovery.recordProvisioned"))
  }

  recordPowerAction(
    instanceId: string,
    action: InstancePowerAction
  ): Effect.Effect<RelayRuntimeRecoveryRecord | null, unknown> {
    return this.#lock(instanceId)
      .withPermit(
        Effect.flatMap(Clock.currentTimeMillis, (now) => {
          const previous = this.#records.get(instanceId) ?? null
          const desiredState: RelayDesiredState =
            action === "stop" || action === "kill" ? "stopped" : "running"
          const next = {
            ...(previous ??
              initialRecoveryRecord(instanceId, desiredState, now)),
            attempts: 0,
            desiredState,
            nextAttemptAt: null,
            phase: "idle" as const,
            stopPending: false,
            updatedAt: now,
          }
          return this.#persist(next).pipe(Effect.as(previous))
        })
      )
      .pipe(Effect.withSpan("relay.runtimeRecovery.recordPowerAction"))
  }

  restore(
    instanceId: string,
    previous: RelayRuntimeRecoveryRecord | null
  ): Effect.Effect<void, unknown> {
    return this.#lock(instanceId)
      .withPermit(
        previous
          ? this.#persist(previous).pipe(Effect.asVoid)
          : this.#delete(instanceId)
      )
      .pipe(Effect.withSpan("relay.runtimeRecovery.restore"))
  }

  forget(instanceId: string): Effect.Effect<void, unknown> {
    return this.#lock(instanceId)
      .withPermit(this.#delete(instanceId))
      .pipe(Effect.withSpan("relay.runtimeRecovery.forget"))
  }

  snapshot(instanceId: string): RuntimeRecoverySnapshot | null {
    const record = this.#records.get(instanceId)
    return record ? recoverySnapshot(record, this.#config.maxRetries) : null
  }

  #reconcileObservation(
    observation: RuntimeRecoveryObservation,
    now: number
  ): Effect.Effect<readonly [string, RuntimeRecoverySnapshot], unknown> {
    return Effect.suspend(() => {
      const existing = this.#records.get(observation.instanceId)
      if (!observation.managedByRelay) {
        const snapshot = unmanagedSnapshot(
          observation.running || observation.restarting
        )
        return existing
          ? this.#delete(observation.instanceId).pipe(
              Effect.as([observation.instanceId, snapshot] as const)
            )
          : Effect.succeed([observation.instanceId, snapshot] as const)
      }
      if (!existing) {
        const preserveRunningIntent =
          observation.running ||
          (observation.installationReady &&
            (observation.restarting ||
              (observation.dockerRestartConfigured &&
                observation.exitCode !== 0)))
        const desiredState = preserveRunningIntent ? "running" : "stopped"
        const initial = initialRecoveryRecord(
          observation.instanceId,
          desiredState,
          now,
          preserveRunningIntent ? null : observation.startedAt
        )
        if (
          desiredState === "running" &&
          !observation.running &&
          !observation.restarting
        ) {
          return this.#recordExit(initial, observation, now)
        }
        return this.#persist(initial).pipe(
          Effect.map((record) => this.#entry(record))
        )
      }

      if (observation.transitionActive) {
        return Effect.succeed(this.#entry(existing))
      }

      if (existing.desiredState === "stopped") {
        const enforceStoppedIntent =
          observation.running && existing.stopPending
            ? this.#scheduleCompensatingStop(observation)
            : Effect.void
        const stopPending = observation.running ? existing.stopPending : false
        if (
          existing.phase === "idle" &&
          existing.attempts === 0 &&
          existing.nextAttemptAt === null &&
          stopPending === existing.stopPending
        ) {
          return enforceStoppedIntent.pipe(Effect.as(this.#entry(existing)))
        }
        return this.#persist({
          ...existing,
          attempts: 0,
          nextAttemptAt: null,
          phase: "idle",
          stopPending,
          updatedAt: now,
        }).pipe(
          Effect.tap(() => enforceStoppedIntent),
          Effect.map((record) => this.#entry(record))
        )
      }

      if (observation.running) {
        return this.#reconcileRunning(existing, observation, now)
      }

      if (!observation.installationReady) {
        return this.#persist({
          ...existing,
          desiredState: "stopped",
          lastStartedAt: observation.startedAt,
          nextAttemptAt: null,
          phase: "idle",
          updatedAt: now,
        }).pipe(Effect.map((record) => this.#entry(record)))
      }

      if (observation.restarting) {
        return Effect.succeed(this.#entry(existing))
      }

      if (
        existing.phase === "pending" &&
        existing.nextAttemptAt !== null &&
        existing.nextAttemptAt <= now
      ) {
        return this.#requestRestart(existing, observation, now)
      }

      if (
        existing.phase === "restarting" &&
        existing.lastStartedAt === observation.startedAt
      ) {
        if (this.#activeStarts.has(observation.instanceId)) {
          return Effect.succeed(this.#entry(existing))
        }
        if (existing.nextAttemptAt === null) {
          return this.#persist({
            ...existing,
            nextAttemptAt: now + START_CONFIRMATION_TIMEOUT_MS,
            updatedAt: now,
          }).pipe(Effect.map((record) => this.#entry(record)))
        }
        if (existing.nextAttemptAt > now) {
          return Effect.succeed(this.#entry(existing))
        }
        return this.#recordStartFailure(
          existing,
          observation,
          new Error("Docker start completed without starting the container"),
          now
        )
      }

      if (existing.lastStartedAt === observation.startedAt) {
        return Effect.succeed(this.#entry(existing))
      }

      return this.#recordExit(existing, observation, now)
    })
  }

  #reconcileRunning(
    existing: RelayRuntimeRecoveryRecord,
    observation: RuntimeRecoveryObservation,
    now: number
  ): Effect.Effect<readonly [string, RuntimeRecoverySnapshot], unknown> {
    const startedAt = Date.parse(observation.startedAt)
    const stable =
      Number.isFinite(startedAt) && now - startedAt >= this.#config.stabilityMs
    if (stable && (existing.attempts > 0 || existing.phase !== "idle")) {
      return this.#persist({
        ...existing,
        attempts: 0,
        nextAttemptAt: null,
        phase: "idle",
        stopPending: false,
        updatedAt: now,
      }).pipe(
        Effect.tap(() =>
          Effect.logInfo("Server recovery window reset", {
            instanceId: observation.instanceId,
          })
        ),
        Effect.map((record) => this.#entry(record))
      )
    }

    if (observation.ready && existing.phase === "restarting") {
      return this.#persist({
        ...existing,
        nextAttemptAt: null,
        phase: "monitoring",
        stopPending: false,
        updatedAt: now,
      }).pipe(
        Effect.tap(() =>
          Effect.logInfo("Server recovered after an unexpected exit", {
            attempt: existing.attempts,
            instanceId: observation.instanceId,
          })
        ),
        Effect.map((record) => this.#entry(record))
      )
    }

    if (existing.phase === "failed") {
      return this.#persist({
        ...existing,
        nextAttemptAt: null,
        phase: observation.ready ? "monitoring" : "restarting",
        stopPending: false,
        updatedAt: now,
      }).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay observed a manually restarted server", {
            instanceId: observation.instanceId,
          })
        ),
        Effect.map((record) => this.#entry(record))
      )
    }

    if (existing.phase === "pending") {
      const phase = observation.ready ? "monitoring" : "restarting"
      return this.#persist({
        ...existing,
        nextAttemptAt: null,
        phase,
        stopPending: false,
        updatedAt: now,
      }).pipe(Effect.map((record) => this.#entry(record)))
    }

    if (existing.stopPending) {
      return this.#persist({
        ...existing,
        stopPending: false,
        updatedAt: now,
      }).pipe(Effect.map((record) => this.#entry(record)))
    }

    return Effect.succeed(this.#entry(existing))
  }

  #recordExit(
    existing: RelayRuntimeRecoveryRecord,
    observation: RuntimeRecoveryObservation,
    now: number
  ): Effect.Effect<readonly [string, RuntimeRecoverySnapshot], unknown> {
    const reason = recoveryReason(observation)
    const runtimeMs = runtimeDurationMs(observation)
    const exited = {
      ...existing,
      lastExitAt: finishedAtMs(observation.finishedAt, now),
      lastExitCode: observation.exitCode,
      lastOomKilled: observation.oomKilled,
      lastReason: reason,
      lastRuntimeMs: runtimeMs,
      lastStartedAt: observation.startedAt,
      updatedAt: now,
    }
    if (existing.attempts >= this.#config.maxRetries) {
      return this.#exhaust(exited, observation)
    }

    const attempt = existing.attempts + 1
    const scheduled = {
      ...exited,
      attempts: attempt,
      nextAttemptAt: now + retryDelayMs(attempt, this.#config.initialDelayMs),
      phase: "pending" as const,
    }
    return this.#persist(scheduled).pipe(
      Effect.tap(() =>
        Effect.logWarning("Server exited unexpectedly; recovery scheduled", {
          attempt,
          exitCode: observation.exitCode,
          instanceId: observation.instanceId,
          maxAttempts: this.#config.maxRetries,
          oomKilled: observation.oomKilled,
          reason,
          runtimeMs,
        })
      ),
      Effect.map((record) => this.#entry(record)),
      Effect.withSpan("relay.runtimeRecovery.schedule", {
        attributes: {
          "kiln.recovery.attempt": attempt,
          "kiln.recovery.exit_code": observation.exitCode,
          "kiln.recovery.instance_id": observation.instanceId,
          "kiln.recovery.reason": reason,
        },
      })
    )
  }

  #requestRestart(
    existing: RelayRuntimeRecoveryRecord,
    observation: RuntimeRecoveryObservation,
    now: number
  ): Effect.Effect<readonly [string, RuntimeRecoverySnapshot], unknown> {
    const token = Symbol(observation.instanceId)
    const requested = {
      ...existing,
      nextAttemptAt: now + START_CONFIRMATION_TIMEOUT_MS,
      phase: "restarting" as const,
      updatedAt: now,
    }
    return this.#persist(requested).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.#activeStarts.set(observation.instanceId, token)
        })
      ),
      Effect.tap(() =>
        this.#performRestart(observation, now, token).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (this.#activeStarts.get(observation.instanceId) === token) {
                this.#activeStarts.delete(observation.instanceId)
              }
            })
          ),
          Effect.forkDetach({ startImmediately: true })
        )
      ),
      Effect.tap(() =>
        Effect.logInfo("Server recovery start requested", {
          attempt: existing.attempts,
          instanceId: observation.instanceId,
          maxAttempts: this.#config.maxRetries,
        })
      ),
      Effect.map((record) => this.#entry(record)),
      Effect.withSpan("relay.runtimeRecovery.requestRestart", {
        attributes: {
          "kiln.recovery.attempt": existing.attempts,
          "kiln.recovery.instance_id": observation.instanceId,
        },
      })
    )
  }

  #performRestart(
    observation: RuntimeRecoveryObservation,
    requestedAt: number,
    token: symbol
  ): Effect.Effect<void, never> {
    return startContainer(observation.service).pipe(
      Effect.tap(() =>
        Effect.logInfo("Docker accepted the server recovery start", {
          instanceId: observation.instanceId,
        })
      ),
      Effect.matchEffect({
        onFailure: (cause) =>
          this.#recordRestartFailure(observation, requestedAt, token, cause),
        onSuccess: () => this.#enforceDesiredStateAfterStart(observation),
      }),
      Effect.withSpan("relay.runtimeRecovery.restartWorker", {
        attributes: {
          "kiln.recovery.instance_id": observation.instanceId,
        },
      }),
      Effect.catch((cause) =>
        Effect.sync(() => {
          Sentry.captureException(cause, {
            tags: {
              "kiln.instance_id": observation.instanceId,
              "kiln.recovery": "worker_failed",
            },
          })
        }).pipe(
          Effect.andThen(
            Effect.logError("Server recovery worker failed", {
              instanceId: observation.instanceId,
            })
          )
        )
      )
    )
  }

  #recordRestartFailure(
    observation: RuntimeRecoveryObservation,
    requestedAt: number,
    token: symbol,
    cause: unknown
  ): Effect.Effect<void, unknown> {
    return this.#lock(observation.instanceId).withPermit(
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const current = this.#records.get(observation.instanceId)
        if (
          !current ||
          this.#activeStarts.get(observation.instanceId) !== token ||
          current.desiredState !== "running" ||
          current.phase !== "restarting" ||
          current.updatedAt !== requestedAt
        ) {
          return Effect.void
        }
        return this.#recordStartFailure(current, observation, cause, now).pipe(
          Effect.asVoid
        )
      })
    )
  }

  #enforceDesiredStateAfterStart(
    observation: RuntimeRecoveryObservation
  ): Effect.Effect<void, unknown> {
    return this.#lock(observation.instanceId).withPermit(
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const current = this.#records.get(observation.instanceId)
        if (!current || current.desiredState !== "stopped") return Effect.void
        return this.#persist({
          ...current,
          stopPending: true,
          updatedAt: now,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#reportedStopFailures.delete(observation.instanceId)
            })
          ),
          Effect.andThen(this.#scheduleCompensatingStop(observation))
        )
      })
    )
  }

  #scheduleCompensatingStop(
    observation: RuntimeRecoveryObservation
  ): Effect.Effect<void, never> {
    return Effect.suspend(() => {
      if (this.#activeStops.has(observation.instanceId)) return Effect.void
      const token = Symbol(observation.instanceId)
      this.#activeStops.set(observation.instanceId, token)
      return this.#performCompensatingStop(observation, token).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#activeStops.get(observation.instanceId) === token) {
              this.#activeStops.delete(observation.instanceId)
            }
          })
        ),
        Effect.forkDetach({ startImmediately: true }),
        Effect.asVoid
      )
    })
  }

  #performCompensatingStop(
    observation: RuntimeRecoveryObservation,
    token: symbol
  ): Effect.Effect<void, never> {
    return this.#lock(observation.instanceId)
      .withPermit(
        Effect.sync(
          () =>
            this.#activeStops.get(observation.instanceId) === token &&
            this.#records.get(observation.instanceId)?.stopPending === true &&
            this.#records.get(observation.instanceId)?.desiredState ===
              "stopped"
        )
      )
      .pipe(
        Effect.flatMap((shouldStop) =>
          shouldStop
            ? stopContainer(observation.service).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    this.#reportedStopFailures.delete(observation.instanceId)
                  }).pipe(
                    Effect.andThen(
                      Effect.logInfo(
                        "Stopped server to enforce stopped intent",
                        {
                          instanceId: observation.instanceId,
                        }
                      )
                    )
                  )
                )
              )
            : Effect.void
        ),
        Effect.withSpan("relay.runtimeRecovery.compensatingStop", {
          attributes: {
            "kiln.recovery.instance_id": observation.instanceId,
          },
        }),
        Effect.catch((cause) =>
          Effect.sync(() => {
            const shouldReport = !this.#reportedStopFailures.has(
              observation.instanceId
            )
            this.#reportedStopFailures.add(observation.instanceId)
            if (shouldReport) {
              Sentry.captureException(cause, {
                tags: {
                  "kiln.instance_id": observation.instanceId,
                  "kiln.recovery": "intent_enforcement_failed",
                },
              })
            }
            return shouldReport
          }).pipe(
            Effect.flatMap((shouldReport) =>
              shouldReport
                ? Effect.logError(
                    "Could not enforce stopped server intent; Relay will retry",
                    { instanceId: observation.instanceId }
                  )
                : Effect.logDebug("Stopped intent retry failed", {
                    instanceId: observation.instanceId,
                  })
            )
          )
        )
      )
  }

  #recordStartFailure(
    existing: RelayRuntimeRecoveryRecord,
    observation: RuntimeRecoveryObservation,
    cause: unknown,
    now: number
  ): Effect.Effect<readonly [string, RuntimeRecoverySnapshot], unknown> {
    if (existing.attempts >= this.#config.maxRetries) {
      return this.#exhaust(
        {
          ...existing,
          lastReason: "start_failed",
          nextAttemptAt: null,
          updatedAt: now,
        },
        observation,
        cause
      )
    }
    const attempt = existing.attempts + 1
    return this.#persist({
      ...existing,
      attempts: attempt,
      lastReason: "start_failed",
      nextAttemptAt: now + retryDelayMs(attempt, this.#config.initialDelayMs),
      phase: "pending",
      updatedAt: now,
    }).pipe(
      Effect.tap(() =>
        Effect.logWarning("Server recovery start failed; retry scheduled", {
          attempt,
          instanceId: observation.instanceId,
          maxAttempts: this.#config.maxRetries,
        })
      ),
      Effect.map((record) => this.#entry(record))
    )
  }

  #exhaust(
    existing: RelayRuntimeRecoveryRecord,
    observation: RuntimeRecoveryObservation,
    cause?: unknown
  ): Effect.Effect<readonly [string, RuntimeRecoverySnapshot], unknown> {
    const failed = {
      ...existing,
      nextAttemptAt: null,
      phase: "failed" as const,
    }
    return this.#persist(failed).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const context = {
            extra: {
              attempts: failed.attempts,
              exitCode: failed.lastExitCode,
              oomKilled: failed.lastOomKilled,
              reason: failed.lastReason,
              runtimeMs: failed.lastRuntimeMs,
            },
            tags: {
              "kiln.instance_id": observation.instanceId,
              "kiln.recovery": "exhausted",
            },
          }
          if (cause) Sentry.captureException(cause, context)
          else
            Sentry.captureMessage(
              "Server automatic recovery exhausted",
              context
            )
        })
      ),
      Effect.tap(() =>
        Effect.logError("Server automatic recovery exhausted", {
          attempts: failed.attempts,
          exitCode: failed.lastExitCode,
          instanceId: observation.instanceId,
          oomKilled: failed.lastOomKilled,
          reason: failed.lastReason,
        })
      ),
      Effect.map((record) => this.#entry(record)),
      Effect.withSpan("relay.runtimeRecovery.exhaust", {
        attributes: {
          "kiln.recovery.attempts": failed.attempts,
          "kiln.recovery.instance_id": observation.instanceId,
          "kiln.recovery.reason": failed.lastReason ?? "unknown",
        },
      })
    )
  }

  #persist(
    record: RelayRuntimeRecoveryRecord
  ): Effect.Effect<RelayRuntimeRecoveryRecord, unknown> {
    return this.#state.setRuntimeRecovery(record).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.#records.set(record.instanceId, record)
          if (record.desiredState === "running" || !record.stopPending) {
            this.#reportedStopFailures.delete(record.instanceId)
          }
        })
      ),
      Effect.as(record)
    )
  }

  #delete(instanceId: string): Effect.Effect<void, unknown> {
    return this.#state.deleteRuntimeRecovery(instanceId).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.#records.delete(instanceId)
          this.#reportedStopFailures.delete(instanceId)
        })
      )
    )
  }

  #entry(
    record: RelayRuntimeRecoveryRecord
  ): readonly [string, RuntimeRecoverySnapshot] {
    return [
      record.instanceId,
      recoverySnapshot(record, this.#config.maxRetries),
    ]
  }

  #lock(instanceId: string): Semaphore.Semaphore {
    const existing = this.#locks.get(instanceId)
    if (existing) return existing
    const created = Semaphore.makeUnsafe(1)
    this.#locks.set(instanceId, created)
    return created
  }
}

const startContainer = (service: string): Effect.Effect<void, unknown> =>
  commandEffect("docker", ["start", service], { timeout: 120_000 }).pipe(
    Effect.asVoid
  )

const stopContainer = (service: string): Effect.Effect<void, unknown> =>
  commandEffect(
    "docker",
    ["stop", "--time", String(INSTANCE_STOP_TIMEOUT_SECONDS), service],
    { timeout: (INSTANCE_STOP_TIMEOUT_SECONDS + 15) * 1_000 }
  ).pipe(Effect.asVoid)

function retryDelayMs(attempt: number, initialDelayMs: number): number {
  if (initialDelayMs === 0) return 0
  return Math.min(
    initialDelayMs * 3 ** Math.max(attempt - 1, 0),
    MAXIMUM_RETRY_DELAY_MS
  )
}

function initialRecoveryRecord(
  instanceId: string,
  desiredState: RelayDesiredState,
  now: number,
  lastStartedAt: string | null = null
): RelayRuntimeRecoveryRecord {
  return {
    attempts: 0,
    desiredState,
    instanceId,
    lastExitAt: null,
    lastExitCode: null,
    lastOomKilled: false,
    lastReason: null,
    lastRuntimeMs: null,
    lastStartedAt,
    nextAttemptAt: null,
    phase: "idle",
    stopPending: false,
    updatedAt: now,
  }
}

function unmanagedSnapshot(running: boolean): RuntimeRecoverySnapshot {
  return {
    desiredState: running ? "running" : "stopped",
    recovery: null,
  }
}

function recoverySnapshot(
  record: RelayRuntimeRecoveryRecord,
  maxAttempts: number
): RuntimeRecoverySnapshot {
  const visible =
    record.phase === "pending" ||
    record.phase === "restarting" ||
    record.phase === "failed"
  return {
    desiredState: record.desiredState,
    recovery:
      visible && record.lastReason
        ? {
            attempt: record.attempts,
            exitCode: record.lastExitCode,
            maxAttempts,
            nextAttemptAt:
              record.nextAttemptAt === null
                ? null
                : new Date(record.nextAttemptAt).toISOString(),
            oomKilled: record.lastOomKilled,
            phase: record.phase,
            reason: record.lastReason,
            runtimeMs: record.lastRuntimeMs,
          }
        : null,
  }
}

function recoveryReason(
  observation: RuntimeRecoveryObservation
): RelayInstanceRecovery["reason"] {
  if (observation.oomKilled) return "out_of_memory"
  return observation.exitCode === 0 ? "clean_exit" : "process_exit"
}

function runtimeDurationMs(
  observation: RuntimeRecoveryObservation
): number | null {
  const startedAt = Date.parse(observation.startedAt)
  const finishedAt = Date.parse(observation.finishedAt)
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(finishedAt - startedAt, 0)
    : null
}

function finishedAtMs(finishedAt: string, fallback: number): number {
  const parsed = Date.parse(finishedAt)
  return Number.isFinite(parsed) ? parsed : fallback
}
