import { access, readFile, rename, unlink } from "node:fs/promises"
import { resolve } from "node:path"

import { Data, Effect, Result, Schedule, Semaphore } from "effect"
import type { Fiber } from "effect"
import { z } from "zod"

import {
  backupArtifactFilename,
  type BackupTaskInput,
  type RelayBackupTask,
} from "@workspace/contracts"
import {
  nextScheduleOccurrence,
  resolveScheduleBackupName,
  relayScheduleProjectionSchema,
  scheduleActionAppliesToTarget,
  scheduleActionSupportsTarget,
  scheduleDeterministicUuid,
  scheduleRunSchema,
  scheduleStableId,
  type RelayScheduleAction,
  type RelayScheduleProjection,
  type ScheduleActionAttempt,
  type ScheduleActionType,
  type ScheduleRun,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"

import {
  legacyScheduleStateSchema,
  relayTimezone,
  type RelayScheduleState,
} from "./effect/schedule-state.js"
import { ensuringPromise, promiseEffect } from "./effect/promise.js"
import { LaneRejectedError } from "./operation-lanes.js"

type TargetScheduleAction = Exclude<RelayScheduleAction, { type: "wait" }>

interface TargetExecutionState {
  readonly activeKey: string | null
  readonly attempts: Array<ScheduleActionAttempt>
  /** The game server's power intent when the occurrence began. */
  readonly powerIntent: string
  error: string | null
  failure: string | null
  missing: boolean
  readonly startedAt: number
  readonly target: ScheduleTarget
}

const scheduleBatchSize = 32
const scheduledBackupPollIntervalMs = 500
const scheduledBackupWaitTimeoutMs = 6 * 60 * 60 * 1_000
const maximumTimerDurationMs = 2_147_483_647
const targetExecutionConcurrency = 8
const scheduleTickIntervalMs = 1_000

class ScheduledBackupWaitError extends Data.TaggedError(
  "ScheduledBackupWaitError"
)<{
  readonly cause?: unknown
  readonly message: string
  readonly taskId: string
}> {}

export interface ScheduleManagerOptions {
  readonly enqueueBackup: (input: BackupTaskInput) => Promise<RelayBackupTask>
  readonly findInstance: (instanceId: string) => Promise<object | null>
  readonly forkEffect?: (
    name: string,
    effect: Effect.Effect<void, never>
  ) => Fiber.Fiber<void, unknown>
  readonly getBackup: (taskId: string) => Promise<RelayBackupTask | null>
  readonly listDatabaseIds: () => Promise<ReadonlySet<string>>
  // Read per run: Hearth can give the Relay its installation ID at any time.
  readonly platformTargetId: () => string
  readonly reportError?: (message: string, cause: unknown) => void
  readonly relayId: string
  readonly runDatabasePower: (
    databaseId: string,
    action: "restart" | "start" | "stop"
  ) => Promise<void>
  /**
   * Runs a power step unless someone changed the server's power since
   * `powerIntent` was read, in which case it rejects with a superseded
   * LaneRejectedError.
   */
  readonly runInstancePower: (
    instanceId: string,
    action: "kill" | "restart" | "start" | "stop",
    powerIntent: string
  ) => Promise<void>
  /**
   * A token that changes whenever someone changes a game server's power or
   * replaces it, read when an occurrence begins.
   */
  readonly instancePowerIntent: (instanceId: string) => string
  readonly sendConsoleCommand: (
    instanceId: string,
    command: string
  ) => Promise<void>
  readonly state: RelayScheduleState
  readonly stateDirectory: string
}

export class ScheduleManager {
  readonly #activeTargets = new Set<string>()
  readonly #occurrenceFibers = new Set<Fiber.Fiber<void, unknown>>()
  readonly #options: ScheduleManagerOptions
  readonly #semaphore = Semaphore.makeUnsafe(1)
  readonly #bootAt = Date.now()
  #nextRunAt: number | null | undefined
  #nextClaimAttemptAt = 0
  #claimFailures = 0

  private constructor(options: ScheduleManagerOptions) {
    this.#options = options
  }

  static async make(options: ScheduleManagerOptions) {
    const manager = new ScheduleManager(options)
    const path = resolve(options.stateDirectory, "schedules.json")
    const legacy = await readScheduleState(path)
    if (legacy) {
      await Effect.runPromise(options.state.importLegacy(legacy))
      // The import trusts any file it finds to be newer than SQLite, so the
      // Relay must not start with an imported file still in place. The first
      // archive is kept; a file an older Relay wrote after a downgrade is
      // already merged and is only retired.
      const archive = `${path}.migrated`
      await Effect.runPromise(
        promiseEffect(() => access(archive)).pipe(
          Effect.matchEffect({
            onSuccess: () => promiseEffect(() => unlink(path)),
            onFailure: (cause) =>
              hasErrorCode(cause, "ENOENT")
                ? promiseEffect(() => rename(path, archive))
                : Effect.fail(cause),
          })
        )
      )
    }
    await Effect.runPromise(options.state.interruptRuns(manager.#bootAt))
    return manager
  }

  run() {
    return promiseEffect(() => this.#tick()).pipe(
      Effect.catch((cause) => Effect.sync(() => this.#claimFailed(cause))),
      Effect.andThen(Effect.sleep(`${scheduleTickIntervalMs} millis`)),
      Effect.forever
    )
  }

  close() {
    for (const fiber of this.#occurrenceFibers) fiber.interruptUnsafe()
    this.#occurrenceFibers.clear()
  }

  apply(projection: RelayScheduleProjection) {
    const input = relayScheduleProjectionSchema.parse(projection)
    const nextRunAt = input.enabled
      ? nextScheduleOccurrence(input.cron, relayTimezone, Date.now()).getTime()
      : null
    return this.#serialized(async () => {
      const applied = await Effect.runPromise(
        this.#options.state.apply(input, nextRunAt)
      )
      this.#nextRunAt = undefined
      return applied
    })
  }

  remove(input: { revision: number; scheduleId: string }) {
    return this.#serialized(async () => {
      const removed = await Effect.runPromise(
        this.#options.state.remove({
          revision: z.number().int().positive().parse(input.revision),
          scheduleId: z.uuid().parse(input.scheduleId),
        })
      )
      this.#nextRunAt = undefined
      return removed
    })
  }

  runNow(input: { revision: number; scheduleId: string }) {
    return this.#serialized(async () => {
      if (this.#occurrenceFibers.size >= scheduleBatchSize) {
        throw new Error(
          "Relay schedule execution capacity reached; try again later"
        )
      }
      const occurrence = await Effect.runPromise(
        this.#options.state.runNow(
          {
            revision: z.number().int().positive().parse(input.revision),
            scheduleId: z.uuid().parse(input.scheduleId),
          },
          Date.now(),
          this.#options.relayId
        )
      )
      if ("error" in occurrence) throw new Error(occurrence.error)
      this.#launchOccurrence(occurrence.definition, occurrence.scheduledAt)
      return occurrence.run
    })
  }

  overview(scheduleIds?: ReadonlyArray<string>) {
    return Effect.runPromise(
      this.#options.state.overview(scheduleIds?.map((id) => z.uuid().parse(id)))
    )
  }

  // Storage failures affect every schedule, so one backoff covers them all.
  #claimFailed(cause: unknown) {
    if (this.#claimFailures++ === 0) {
      this.#options.reportError?.("Relay schedule claim failed", cause)
    }
    this.#nextClaimAttemptAt =
      Date.now() +
      Math.min(60_000, 1_000 * 2 ** Math.min(this.#claimFailures - 1, 6))
  }

  #tick() {
    return this.#serialized(async () => {
      const now = Date.now()
      if (now < this.#nextClaimAttemptAt) return
      if (this.#nextRunAt === undefined) {
        this.#nextRunAt = await Effect.runPromise(
          this.#options.state.nextRunAt()
        )
      }
      if (this.#nextRunAt === null || this.#nextRunAt > now) {
        this.#claimFailures = 0
        return
      }
      this.#nextRunAt = undefined
      while (true) {
        const available = scheduleBatchSize - this.#occurrenceFibers.size
        if (available <= 0) return
        const due = await Effect.runPromise(
          this.#options.state.claimDue(
            now,
            this.#bootAt,
            this.#options.relayId,
            available
          )
        )
        for (const occurrence of due.occurrences) {
          if (occurrence.run.status === "running")
            this.#launchOccurrence(occurrence.definition, occurrence.scheduledAt)
        }
        if (due.failure) return this.#claimFailed(due.failure.cause)
        this.#claimFailures = 0
        if (!due.hasMore) return
      }
    })
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
          powerIntent:
            target.kind === "instance"
              ? this.#options.instancePowerIntent(target.id)
              : "",
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
                state.activeKey !== null &&
                (schedule.continueOnFailure || !state.failure) &&
                !state.missing
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
    // Keep only this executing occurrence alive while its completion is pending.
    // A storage outage must not discard the result or re-execute its actions.
    signal?.throwIfAborted()
    let reported = false
    await Effect.runPromise(
      this.#options.state.completeRun(run).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (reported) return
            reported = true
            this.#options.reportError?.(
              "Relay schedule completion write failed",
              cause
            )
          })
        ),
        Effect.retry({
          schedule: Schedule.min([
            Schedule.exponential("1 second"),
            Schedule.spaced("1 minute"),
          ]),
        })
      ),
      signal ? { signal } : undefined
    )
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
    if (state.failure && !schedule.continueOnFailure) {
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
            state.powerIntent,
            signal
          )
        )
      )
    )
    // Someone changed the server's power while the schedule ran, so its
    // later power steps give way rather than undo that.
    if (
      Result.isFailure(executed) &&
      executed.failure instanceof LaneRejectedError &&
      executed.failure.reason === "superseded"
    ) {
      state.attempts.push(
        attempt({
          action,
          error: "Not run: the server's power was changed during the schedule",
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "not_run",
          target: state.target,
        })
      )
      return
    }
    const failure = Result.isFailure(executed)
      ? errorMessage(executed.failure)
      : null
    // The first failure stays the target's error when later actions continue.
    if (failure && !state.failure) {
      state.failure = failure
      state.error = failure
    }
    state.attempts.push(
      attempt({
        action,
        error: failure,
        scheduledAt,
        scheduleId: schedule.id,
        startedAt: actionStartedAt,
        status: failure ? "failed" : "succeeded",
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
    powerIntent: string,
    signal?: AbortSignal
  ) {
    if (action.type === "console_command" && target.kind === "instance") {
      await this.#options.sendConsoleCommand(target.id, action.command)
      return
    }
    if (action.type === "power") {
      if (target.kind === "instance") {
        await this.#options.runInstancePower(
          target.id,
          action.action,
          powerIntent
        )
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
              ? this.#options.platformTargetId()
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
    const getBackup = this.#options.getBackup
    const poll = Effect.gen(function* () {
      let task: RelayBackupTask | null = initial
      while (task.status === "queued" || task.status === "running") {
        yield* Effect.sleep(`${scheduledBackupPollIntervalMs} millis`)
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
        duration: `${scheduledBackupWaitTimeoutMs} millis`,
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

  #serialized<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    return Effect.runPromise(
      this.#semaphore.withPermit(promiseEffect(operation))
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

function readScheduleState(path: string) {
  return Effect.runPromise(
    promiseEffect(() => readFile(path, "utf8")).pipe(
      Effect.flatMap((contents) =>
        Effect.try({
          try: () => legacyScheduleStateSchema.parse(JSON.parse(contents)),
          catch: (cause) => cause,
        })
      ),
      Effect.catch((cause) =>
        hasErrorCode(cause, "ENOENT") ? Effect.succeed(null) : Effect.fail(cause)
      )
    )
  )
}

function hasErrorCode(cause: unknown, code: string) {
  return cause instanceof Error && "code" in cause && cause.code === code
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unknown schedule error"
}
