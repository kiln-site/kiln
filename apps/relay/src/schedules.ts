import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { Data, Effect, Result, Schedule, Semaphore } from "effect"
import type { Fiber } from "effect"
import { z } from "zod"

import {
  backupArtifactFilename,
  nextScheduleOccurrence,
  resolveScheduleBackupName,
  relayScheduleProjectionSchema,
  scheduleActionAppliesToTarget,
  scheduleActionSupportsTarget,
  scheduleDeterministicUuid,
  scheduleRunSchema,
  scheduleStableId,
  type BackupTaskInput,
  type RelayBackupTask,
  type RelayScheduleDeployment,
  type RelayScheduleAction,
  type RelayScheduleProjection,
  type ScheduleActionAttempt,
  type ScheduleActionType,
  type ScheduleRun,
  type ScheduleTarget,
} from "@workspace/contracts"

import { writeFileAtomic } from "./effect/atomic-file.js"
import { ensuringPromise, promiseEffect } from "./effect/promise.js"

const persistedScheduleSchema = relayScheduleProjectionSchema.safeExtend({
  nextRunAt: z.number().int().nonnegative().nullable(),
})

const persistedStateSchema = z
  .object({
    lastHeartbeatAt: z.number().int().nonnegative(),
    runs: z.array(scheduleRunSchema).max(1_000),
    schedules: z.array(persistedScheduleSchema),
    tombstones: z.record(z.string(), z.number().int().positive()),
    version: z.literal(1),
  })
  .strict()

type PersistedSchedule = z.infer<typeof persistedScheduleSchema>
type PersistedState = z.infer<typeof persistedStateSchema>
type TargetScheduleAction = Exclude<RelayScheduleAction, { type: "wait" }>

interface TargetExecutionState {
  readonly activeKey: string | null
  readonly attempts: Array<ScheduleActionAttempt>
  error: string | null
  failure: string | null
  missing: boolean
  readonly startedAt: number
  readonly target: ScheduleTarget
}

const heartbeatPersistenceIntervalMs = 5_000
const maxRetainedRuns = 1_000
const scheduledBackupPollIntervalMs = 500
const scheduledBackupWaitTimeoutMs = 6 * 60 * 60 * 1_000
const maximumTimerDurationMs = 2_147_483_647
const targetExecutionConcurrency = 8
const scheduleTickIntervalMs = 1_000
const scheduleTickRetryBaseMs = 100
const relayTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

class ScheduleTickError extends Data.TaggedError("ScheduleTickError")<{
  readonly cause: unknown
  readonly message: string
}> {}

class ScheduledBackupWaitError extends Data.TaggedError(
  "ScheduledBackupWaitError"
)<{
  readonly cause?: unknown
  readonly message: string
  readonly taskId: string
}> {}

export interface ScheduleManagerOptions {
  readonly backupPollIntervalMs?: number
  readonly backupWaitTimeoutMs?: number
  readonly enqueueBackup: (input: BackupTaskInput) => Promise<RelayBackupTask>
  readonly findInstance: (instanceId: string) => Promise<object | null>
  readonly forkEffect?: (
    name: string,
    effect: Effect.Effect<void, never>
  ) => Fiber.Fiber<void, unknown>
  readonly getBackup: (taskId: string) => Promise<RelayBackupTask | null>
  readonly listDatabaseIds: () => Promise<ReadonlySet<string>>
  readonly platformTargetId: string
  readonly reportError?: (message: string, cause: unknown) => void
  readonly relayId: string
  readonly runDatabasePower: (
    databaseId: string,
    action: "restart" | "start" | "stop"
  ) => Promise<void>
  readonly runInstancePower: (
    instanceId: string,
    action: "kill" | "restart" | "start" | "stop"
  ) => Promise<void>
  readonly sendConsoleCommand: (
    instanceId: string,
    command: string
  ) => Promise<void>
  readonly stateDirectory: string
  readonly tickIntervalMs?: number
  readonly tickRetryBaseMs?: number
}

export class ScheduleManager {
  readonly #activeTargets = new Set<string>()
  readonly #backupPollIntervalMs: number
  readonly #backupWaitTimeoutMs: number
  readonly #occurrenceFibers = new Set<Fiber.Fiber<void, unknown>>()
  readonly #options: ScheduleManagerOptions
  readonly #semaphore = Semaphore.makeUnsafe(1)
  readonly #statePath: string
  readonly #tickIntervalMs: number
  readonly #tickRetryBaseMs: number
  #lastHeartbeatPersistedAt = 0
  #state: PersistedState

  private constructor(options: ScheduleManagerOptions, state: PersistedState) {
    this.#backupPollIntervalMs =
      options.backupPollIntervalMs ?? scheduledBackupPollIntervalMs
    this.#backupWaitTimeoutMs =
      options.backupWaitTimeoutMs ?? scheduledBackupWaitTimeoutMs
    this.#options = options
    this.#state = state
    this.#statePath = resolve(options.stateDirectory, "schedules.json")
    this.#tickIntervalMs = options.tickIntervalMs ?? scheduleTickIntervalMs
    this.#tickRetryBaseMs = options.tickRetryBaseMs ?? scheduleTickRetryBaseMs
  }

  static async make(options: ScheduleManagerOptions) {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
    const path = resolve(options.stateDirectory, "schedules.json")
    const state = await readScheduleState(path)
    const manager = new ScheduleManager(options, state)
    await manager.#recoverAfterRestart()
    return manager
  }

  run() {
    return promiseEffect(() => this.#tick()).pipe(
      Effect.mapError(
        (cause) =>
          new ScheduleTickError({
            cause,
            message: "Relay schedule tick failed",
          })
      ),
      Effect.retry({
        schedule: Schedule.exponential(`${this.#tickRetryBaseMs} millis`).pipe(
          Schedule.jittered
        ),
        times: 3,
      }),
      Effect.catchTag("ScheduleTickError", (failure) =>
        Effect.sync(() =>
          this.#options.reportError?.(failure.message, failure.cause)
        ).pipe(
          Effect.andThen(
            Effect.logError(failure.message, { cause: failure.cause })
          )
        )
      ),
      Effect.andThen(Effect.sleep(`${this.#tickIntervalMs} millis`)),
      Effect.forever
    )
  }

  close() {
    for (const fiber of this.#occurrenceFibers) fiber.interruptUnsafe()
    this.#occurrenceFibers.clear()
  }

  apply(projection: RelayScheduleProjection) {
    return this.#serialized(async () => {
      const input = relayScheduleProjectionSchema.parse(projection)
      const tombstoneRevision = this.#state.tombstones[input.id] ?? 0
      const current = this.#state.schedules.find(
        (schedule) => schedule.id === input.id
      )
      if (tombstoneRevision >= input.revision) {
        return deployment(input.id, tombstoneRevision, null)
      }
      if (current && current.revision > input.revision) {
        return deployment(current.id, current.revision, current.nextRunAt)
      }
      const nextRunAt = input.enabled
        ? nextScheduleOccurrence(
            input.cron,
            relayTimezone,
            Date.now()
          ).getTime()
        : null
      const stored: PersistedSchedule = { ...input, nextRunAt }
      this.#state.schedules = [
        ...this.#state.schedules.filter((schedule) => schedule.id !== input.id),
        stored,
      ]
      delete this.#state.tombstones[input.id]
      await this.#persist()
      return deployment(input.id, input.revision, nextRunAt)
    })
  }

  remove(input: { revision: number; scheduleId: string }) {
    return this.#serialized(async () => {
      const scheduleId = z.uuid().parse(input.scheduleId)
      const revision = z.number().int().positive().parse(input.revision)
      const current = this.#state.schedules.find(
        (schedule) => schedule.id === scheduleId
      )
      const appliedRevision = Math.max(
        revision,
        current?.revision ?? 0,
        this.#state.tombstones[scheduleId] ?? 0
      )
      this.#state.schedules = this.#state.schedules.filter(
        (schedule) => schedule.id !== scheduleId
      )
      this.#state.tombstones[scheduleId] = appliedRevision
      await this.#persist()
      return deployment(scheduleId, appliedRevision, null)
    })
  }

  async runNow(input: { revision: number; scheduleId: string }) {
    const occurrence = await this.#serialized(async () => {
      const scheduleId = z.uuid().parse(input.scheduleId)
      const revision = z.number().int().positive().parse(input.revision)
      const schedule = this.#state.schedules.find(
        (candidate) => candidate.id === scheduleId
      )
      if (!schedule) throw new Error("Schedule is not deployed on this Relay")
      if (schedule.revision !== revision) {
        throw new Error("Schedule deployment is out of date")
      }
      const latestScheduledAt = this.#state.runs.reduce(
        (latest, run) =>
          run.scheduleId === scheduleId
            ? Math.max(latest, run.scheduledAt)
            : latest,
        0
      )
      const scheduledAt = Math.max(Date.now(), latestScheduledAt + 1)
      const { nextRunAt: _, ...definition } = schedule
      const run = scheduleRunSchema.parse({
        finishedAt: scheduledAt,
        id: scheduleStableId(schedule.id, scheduledAt, this.#options.relayId),
        revision: schedule.revision,
        scheduleId: schedule.id,
        scheduledAt,
        startedAt: scheduledAt,
        status: "running",
        targetRuns: [],
      })
      this.#upsertRun(run)
      await this.#persist()
      return { definition, run, scheduledAt }
    })
    this.#launchOccurrence(occurrence.definition, occurrence.scheduledAt)
    return occurrence.run
  }

  overview(scheduleIds?: ReadonlyArray<string>) {
    const allowed = scheduleIds
      ? new Set(scheduleIds.map((id) => z.uuid().parse(id)))
      : null
    const deployments: Array<RelayScheduleDeployment> = this.#state.schedules
      .filter((schedule) => !allowed || allowed.has(schedule.id))
      .map((schedule) =>
        deployment(schedule.id, schedule.revision, schedule.nextRunAt)
      )
    const runs = this.#state.runs.filter(
      (run) => !allowed || allowed.has(run.scheduleId)
    )
    return { deployments, runs }
  }

  async #recoverAfterRestart() {
    const now = Date.now()
    this.#state.runs = this.#state.runs.map((run) =>
      run.status === "running"
        ? { ...run, finishedAt: now, status: "interrupted" }
        : run
    )
    for (const schedule of this.#state.schedules) {
      if (
        !schedule.enabled ||
        schedule.nextRunAt === null ||
        schedule.nextRunAt > now
      ) {
        continue
      }
      const run = scheduleRunSchema.parse({
        finishedAt: now,
        id: scheduleStableId(
          schedule.id,
          schedule.nextRunAt,
          this.#options.relayId
        ),
        revision: schedule.revision,
        scheduleId: schedule.id,
        scheduledAt: schedule.nextRunAt,
        startedAt: now,
        status: "missed",
        targetRuns: [],
      })
      this.#upsertRun(run)
      schedule.nextRunAt = nextScheduleOccurrence(
        schedule.cron,
        relayTimezone,
        now
      ).getTime()
    }
    this.#state.lastHeartbeatAt = now
    await this.#persist()
  }

  async #tick() {
    const due = await this.#serialized(async () => {
      const now = Date.now()
      const persistHeartbeat =
        now - this.#lastHeartbeatPersistedAt >= heartbeatPersistenceIntervalMs
      const hasDueSchedule = this.#state.schedules.some(
        (schedule) =>
          schedule.enabled &&
          schedule.nextRunAt !== null &&
          schedule.nextRunAt <= now
      )
      if (!hasDueSchedule && !persistHeartbeat) {
        this.#state.lastHeartbeatAt = now
        return []
      }

      const previousState = hasDueSchedule ? structuredClone(this.#state) : null
      const previousHeartbeatAt = this.#state.lastHeartbeatAt
      const previousHeartbeatPersistedAt = this.#lastHeartbeatPersistedAt
      const claimed: Array<{
        definition: RelayScheduleProjection
        scheduledAt: number
      }> = []
      const result = await Effect.runPromise(
        Effect.result(
          promiseEffect(async () => {
            for (const schedule of this.#state.schedules) {
              if (
                !schedule.enabled ||
                schedule.nextRunAt === null ||
                schedule.nextRunAt > now
              ) {
                continue
              }
              const scheduledAt = schedule.nextRunAt
              const { nextRunAt: _, ...definition } = schedule
              claimed.push({ definition, scheduledAt })
              schedule.nextRunAt = nextScheduleOccurrence(
                schedule.cron,
                relayTimezone,
                now
              ).getTime()
              const running = scheduleRunSchema.parse({
                finishedAt: now,
                id: scheduleStableId(
                  schedule.id,
                  scheduledAt,
                  this.#options.relayId
                ),
                revision: schedule.revision,
                scheduleId: schedule.id,
                scheduledAt,
                startedAt: now,
                status: "running",
                targetRuns: [],
              })
              this.#upsertRun(running)
            }
            this.#state.lastHeartbeatAt = now
            if (claimed.length > 0 || persistHeartbeat) {
              await this.#persist()
              this.#lastHeartbeatPersistedAt = now
            }
            return claimed
          })
        )
      )
      if (Result.isFailure(result)) {
        if (previousState) this.#state = previousState
        else this.#state.lastHeartbeatAt = previousHeartbeatAt
        this.#lastHeartbeatPersistedAt = previousHeartbeatPersistedAt
        throw result.failure
      }
      return result.success
    })
    for (const occurrence of due) {
      this.#launchOccurrence(occurrence.definition, occurrence.scheduledAt)
    }
  }

  #launchOccurrence(definition: RelayScheduleProjection, scheduledAt: number) {
    const effect = Effect.tryPromise({
      try: (signal) => this.#executeOccurrence(definition, scheduledAt, signal),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          const message = `Scheduled occurrence ${definition.id} failed`
          this.#options.reportError?.(message, cause)
        }).pipe(
          Effect.andThen(
            Effect.logError(`Scheduled occurrence ${definition.id} failed`, {
              cause,
              scheduleId: definition.id,
              scheduledAt,
            })
          )
        )
      )
    )
    const fiber = this.#options.forkEffect
      ? this.#options.forkEffect("relay.schedules.occurrence", effect)
      : Effect.runFork(effect)
    this.#occurrenceFibers.add(fiber)
    fiber.addObserver(() => this.#occurrenceFibers.delete(fiber))
  }

  async #executeOccurrence(
    schedule: RelayScheduleProjection,
    scheduledAt: number,
    signal?: AbortSignal
  ) {
    const startedAt = Date.now()
    const targetStates = schedule.targets.map(
      (target): TargetExecutionState => {
        const activeKey = `${target.kind}:${target.id}`
        const overlapping = this.#activeTargets.has(activeKey)
        if (!overlapping) this.#activeTargets.add(activeKey)
        return {
          activeKey: overlapping ? null : activeKey,
          attempts: [],
          error: null,
          failure: null,
          missing: false,
          startedAt: Date.now(),
          target,
        }
      }
    )
    const sequenceAttempts: Array<ScheduleActionAttempt> = []
    let sequenceFailure: string | null = null
    const targetRuns = await ensuringPromise(
      async () => {
        await Effect.runPromise(
          Effect.forEach(
            targetStates,
            (state) =>
              state.activeKey === null
                ? Effect.void
                : Effect.result(
                    promiseEffect(() => this.#targetExists(state.target))
                  ).pipe(
                    Effect.map((exists) => {
                      if (Result.isFailure(exists)) {
                        state.failure = errorMessage(exists.failure)
                        state.error = state.failure
                      } else if (!exists.success) {
                        state.missing = true
                        state.error = "Target no longer exists"
                      }
                    })
                  ),
            { concurrency: targetExecutionConcurrency }
          ),
          signal ? { signal } : undefined
        )

        // Actions execute as ordered phases. A wait pauses the sequence once;
        // target work is still bounded by the normal concurrency limit.
        for (const action of schedule.actions) {
          if (action.type === "wait") {
            const actionStartedAt = Date.now()
            const canContinue = targetStates.some(
              (state) =>
                state.activeKey !== null && !state.failure && !state.missing
            )
            if (sequenceFailure || !canContinue) {
              sequenceAttempts.push(
                sequenceAttempt({
                  action,
                  error: sequenceFailure
                    ? "A previous sequence action failed"
                    : "No targets can continue",
                  scheduledAt,
                  scheduleId: schedule.id,
                  startedAt: actionStartedAt,
                  status: "not_run",
                })
              )
              continue
            }
            const waitResult = await Effect.runPromise(
              Effect.result(
                promiseEffect(() =>
                  waitForDuration(
                    waitDurationMs(action.duration, action.unit),
                    signal
                  )
                )
              )
            )
            if (Result.isSuccess(waitResult)) {
              sequenceAttempts.push(
                sequenceAttempt({
                  action,
                  error: null,
                  scheduledAt,
                  scheduleId: schedule.id,
                  startedAt: actionStartedAt,
                  status: "succeeded",
                })
              )
            } else {
              sequenceFailure = errorMessage(waitResult.failure)
              sequenceAttempts.push(
                sequenceAttempt({
                  action,
                  error: sequenceFailure,
                  scheduledAt,
                  scheduleId: schedule.id,
                  startedAt: actionStartedAt,
                  status: "failed",
                })
              )
            }
            continue
          }

          await Effect.runPromise(
            Effect.forEach(
              targetStates,
              (state) =>
                promiseEffect(() =>
                  this.#executeTargetAction(
                    schedule,
                    action,
                    state,
                    scheduledAt,
                    sequenceFailure,
                    signal
                  )
                ),
              { concurrency: targetExecutionConcurrency }
            ),
            signal ? { signal } : undefined
          )
        }
        return targetStates.map((state) =>
          targetRun(schedule.id, scheduledAt, state)
        )
      },
      () => {
        // Reservation spans waits so another occurrence cannot interleave with
        // an ordered Stop -> Wait -> Start sequence.
        for (const state of targetStates) {
          if (state.activeKey !== null) {
            this.#activeTargets.delete(state.activeKey)
          }
        }
      }
    )
    const sequenceFailed = sequenceAttempts.some(
      (entry) => entry.status === "failed" || entry.status === "interrupted"
    )
    const targetStatus = aggregateRunStatus(
      targetRuns.map((target) => target.status)
    )
    const run = scheduleRunSchema.parse({
      finishedAt: Date.now(),
      id: scheduleStableId(schedule.id, scheduledAt, this.#options.relayId),
      revision: schedule.revision,
      scheduleId: schedule.id,
      scheduledAt,
      startedAt,
      sequenceAttempts,
      status: sequenceFailed
        ? targetStatus === "succeeded" || targetStatus === "partial"
          ? "partial"
          : "failed"
        : targetStatus,
      targetRuns,
    })
    await this.#serialized(async () => {
      this.#upsertRun(run)
      await this.#persist()
    })
  }

  async #executeTargetAction(
    schedule: RelayScheduleProjection,
    action: TargetScheduleAction,
    state: TargetExecutionState,
    scheduledAt: number,
    sequenceFailure: string | null,
    signal?: AbortSignal
  ) {
    if (state.activeKey === null) return
    const actionStartedAt = Date.now()
    if (sequenceFailure) {
      state.attempts.push(
        attempt({
          action,
          error: "A previous sequence action failed",
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "not_run",
          target: state.target,
        })
      )
      return
    }
    if (state.failure) {
      state.attempts.push(
        attempt({
          action,
          error: "A previous action failed",
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "not_run",
          target: state.target,
        })
      )
      return
    }
    if (state.missing) {
      state.attempts.push(
        attempt({
          action,
          error: "Target no longer exists",
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "skipped_missing",
          target: state.target,
        })
      )
      return
    }
    if (!scheduleActionSupportsTarget(action, state.target)) {
      state.attempts.push(
        attempt({
          action,
          error: null,
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "skipped_unsupported",
          target: state.target,
        })
      )
      return
    }
    if (!scheduleActionAppliesToTarget(action, state.target)) {
      state.attempts.push(
        attempt({
          action,
          error: null,
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "skipped_policy",
          target: state.target,
        })
      )
      return
    }
    const executed = await Effect.runPromise(
      Effect.result(
        promiseEffect(() =>
          this.#executeAction(
            schedule,
            action,
            state.target,
            scheduledAt,
            signal
          )
        )
      )
    )
    if (Result.isFailure(executed)) {
      state.failure = errorMessage(executed.failure)
      state.error = state.failure
    }
    state.attempts.push(
      attempt({
        action,
        error: state.failure,
        scheduledAt,
        scheduleId: schedule.id,
        startedAt: actionStartedAt,
        status: state.failure ? "failed" : "succeeded",
        target: state.target,
      })
    )
  }

  async #targetExists(target: ScheduleTarget) {
    if (target.kind === "relay") return target.id === this.#options.relayId
    if (target.kind === "instance") {
      return (await this.#options.findInstance(target.id)) !== null
    }
    return (await this.#options.listDatabaseIds()).has(target.id)
  }

  async #executeAction(
    schedule: RelayScheduleProjection,
    action: TargetScheduleAction,
    target: ScheduleTarget,
    scheduledAt: number,
    signal?: AbortSignal
  ) {
    if (action.type === "console_command" && target.kind === "instance") {
      await this.#options.sendConsoleCommand(target.id, action.command)
      return
    }
    if (action.type === "power") {
      if (target.kind === "instance") {
        await this.#options.runInstancePower(target.id, action.action)
        return
      }
      if (target.kind === "database") {
        if (action.action === "kill") {
          throw new Error("Kill is not supported for databases")
        }
        await this.#options.runDatabasePower(target.id, action.action)
        return
      }
    }
    if (action.type === "backup") {
      const execution = action.executions.find(
        (candidate) =>
          candidate.targetId === target.id &&
          candidate.targetKind === target.kind
      )
      const deployedDestination =
        execution?.destination ??
        (action.mode === "full" && action.destination.kind === "local"
          ? ({ kind: "local" } as const)
          : null)
      if (!deployedDestination) {
        throw new Error("Scheduled backup destination is not deployed")
      }
      const backupId = scheduleDeterministicUuid(
        "schedule-backup",
        schedule.id,
        scheduledAt,
        target.kind,
        target.id,
        action.id
      )
      const runId = scheduleStableId(
        schedule.id,
        scheduledAt,
        this.#options.relayId
      )
      const taskId = scheduleDeterministicUuid("task", backupId)
      const artifactId = scheduleDeterministicUuid("artifact", backupId)
      const targetKind = target.kind === "relay" ? "platform" : target.kind
      const artifactKind =
        action.mode === "incremental"
          ? ("restic_snapshot" as const)
          : targetKind === "instance"
            ? ("archive" as const)
            : targetKind === "database"
              ? ("database_dump" as const)
              : ("platform_bundle" as const)
      const destination =
        deployedDestination.kind === "s3"
          ? {
              accessKeyId: deployedDestination.accessKeyId,
              allowPrivateNetwork: deployedDestination.allowPrivateNetwork,
              artifactId,
              bucket: deployedDestination.bucket,
              endpoint: deployedDestination.endpoint,
              forcePathStyle: deployedDestination.forcePathStyle,
              kind: "s3" as const,
              objectKey: `${deployedDestination.objectKeyPrefix}/${backupId}/${backupArtifactFilename(backupId, artifactKind)}`,
              region: deployedDestination.region,
              secretAccessKey: deployedDestination.secretAccessKey,
            }
          : { ...deployedDestination, artifactId }
      const input: BackupTaskInput = {
        artifactKind,
        backupId,
        catalog: {
          name: resolveScheduleBackupName(action.name, {
            backupId,
            instanceId: target.kind === "instance" ? target.id : "",
            runId,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            timestamp: scheduledAt,
          }),
          storageId:
            action.destination.kind === "storage"
              ? action.destination.storageId
              : null,
        },
        destination,
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: action.mode,
        reason: "scheduled",
        target: {
          id:
            targetKind === "platform"
              ? this.#options.platformTargetId
              : target.id,
          kind: targetKind,
        },
        taskId,
      }
      const queued = await this.#options.enqueueBackup(input)
      await Effect.runPromise(
        this.#waitForBackup(queued),
        signal ? { signal } : undefined
      )
    }
  }

  #waitForBackup(initial: RelayBackupTask) {
    const pollIntervalMs = this.#backupPollIntervalMs
    const waitTimeoutMs = this.#backupWaitTimeoutMs
    const getBackup = this.#options.getBackup
    const poll = Effect.gen(function* () {
      let task: RelayBackupTask | null = initial
      while (task.status === "queued" || task.status === "running") {
        yield* Effect.sleep(`${pollIntervalMs} millis`)
        task = yield* Effect.tryPromise({
          try: () => getBackup(initial.taskId),
          catch: (cause) =>
            new ScheduledBackupWaitError({
              cause,
              message: "Could not inspect the scheduled backup",
              taskId: initial.taskId,
            }),
        })
        if (!task) {
          return yield* new ScheduledBackupWaitError({
            message: "Scheduled backup disappeared from the queue",
            taskId: initial.taskId,
          })
        }
      }
      if (task.status !== "succeeded") {
        return yield* new ScheduledBackupWaitError({
          message: task.error ?? `Scheduled backup ${task.status}`,
          taskId: initial.taskId,
        })
      }
    })
    return poll.pipe(
      Effect.timeoutOrElse({
        duration: `${waitTimeoutMs} millis`,
        orElse: () =>
          Effect.fail(
            new ScheduledBackupWaitError({
              message: "Scheduled backup timed out",
              taskId: initial.taskId,
            })
          ),
      })
    )
  }

  #upsertRun(run: ScheduleRun) {
    this.#state.runs = [
      run,
      ...this.#state.runs.filter((candidate) => candidate.id !== run.id),
    ].slice(0, maxRetainedRuns)
  }

  #serialized<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    return Effect.runPromise(
      this.#semaphore.withPermit(promiseEffect(operation))
    )
  }

  #persist() {
    return Effect.runPromise(
      writeFileAtomic(this.#statePath, JSON.stringify(this.#state), 0o600)
    )
  }
}

function waitDurationMs(
  duration: number,
  unit: Extract<RelayScheduleAction, { type: "wait" }>["unit"]
) {
  const multiplier =
    unit === "milliseconds"
      ? 1
      : unit === "seconds"
        ? 1_000
        : unit === "minutes"
          ? 60_000
          : unit === "hours"
            ? 3_600_000
            : 86_400_000
  return duration * multiplier
}

async function waitForDuration(durationMs: number, signal?: AbortSignal) {
  let remainingMs = durationMs
  while (remainingMs > 0) {
    const chunkMs = Math.min(remainingMs, maximumTimerDurationMs)
    await Effect.runPromise(
      Effect.sleep(`${chunkMs} millis`),
      signal ? { signal } : undefined
    )
    remainingMs -= chunkMs
  }
}

function deployment(
  scheduleId: string,
  acknowledgedRevision: number,
  nextRunAt: number | null
): RelayScheduleDeployment {
  return { acknowledgedRevision, nextRunAt, scheduleId }
}

function attempt(input: {
  action: Pick<RelayScheduleAction, "id" | "type">
  error: string | null
  scheduledAt: number
  scheduleId: string
  startedAt: number
  status:
    | "failed"
    | "not_run"
    | "skipped_missing"
    | "skipped_policy"
    | "skipped_unsupported"
    | "succeeded"
  target: ScheduleTarget
}) {
  return {
    actionId: input.action.id,
    actionType: input.action.type as ScheduleActionType,
    error: input.error,
    finishedAt: Date.now(),
    id: scheduleStableId(
      input.scheduleId,
      input.scheduledAt,
      input.target.kind,
      input.target.id,
      input.action.id
    ),
    startedAt: input.startedAt,
    status: input.status,
  }
}

function sequenceAttempt(input: {
  action: Pick<RelayScheduleAction, "id" | "type">
  error: string | null
  scheduledAt: number
  scheduleId: string
  startedAt: number
  status:
    | "failed"
    | "not_run"
    | "skipped_missing"
    | "skipped_policy"
    | "skipped_unsupported"
    | "succeeded"
}): ScheduleActionAttempt {
  return {
    actionId: input.action.id,
    actionType: input.action.type,
    error: input.error,
    finishedAt: Date.now(),
    id: scheduleStableId(
      input.scheduleId,
      input.scheduledAt,
      "sequence",
      input.action.id
    ),
    startedAt: input.startedAt,
    status: input.status,
  }
}

function targetRun(
  scheduleId: string,
  scheduledAt: number,
  state: TargetExecutionState
): ScheduleRun["targetRuns"][number] {
  const succeeded = state.attempts.some((entry) => entry.status === "succeeded")
  return {
    attempts: state.attempts,
    error: state.error,
    finishedAt: Date.now(),
    id: scheduleStableId(
      scheduleId,
      scheduledAt,
      state.target.kind,
      state.target.id
    ),
    startedAt: state.startedAt,
    status:
      state.activeKey === null
        ? "skipped_overlap"
        : state.failure || state.missing
          ? "failed"
          : succeeded
            ? "succeeded"
            : "noop",
    target: state.target,
  }
}

function aggregateRunStatus(
  statuses: ReadonlyArray<
    "failed" | "interrupted" | "noop" | "skipped_overlap" | "succeeded"
  >
) {
  const failed = statuses.filter(
    (status) => status === "failed" || status === "interrupted"
  ).length
  if (failed === statuses.length && statuses.length > 0)
    return "failed" as const
  if (failed > 0) return "partial" as const
  if (statuses.some((status) => status === "succeeded")) {
    return "succeeded" as const
  }
  return "noop" as const
}

async function readScheduleState(path: string): Promise<PersistedState> {
  const loaded = await Effect.runPromise(
    Effect.result(
      promiseEffect(async () =>
        persistedStateSchema.parse(JSON.parse(await readFile(path, "utf8")))
      )
    )
  )
  if (Result.isFailure(loaded)) {
    const cause = loaded.failure
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return {
        lastHeartbeatAt: Date.now(),
        runs: [],
        schedules: [],
        tombstones: {},
        version: 1,
      }
    }
    throw cause
  }
  return loaded.success
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unknown schedule error"
}
