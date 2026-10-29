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
  scheduleTargetKey,
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
import type {
  ContainerCommandResult,
  ContainerCommandTarget,
} from "./container-commands.js"
import { ensuringPromise, promiseEffect } from "./effect/promise.js"
import { LaneRejectedError } from "./operation-lanes.js"
import type { PowerResourceKind } from "./operation-plans.js"
import type { PowerAction } from "./resource-power.js"

type TargetScheduleAction = Exclude<RelayScheduleAction, { type: "wait" }>

interface TargetExecutionState {
  readonly activeKey: string | null
  readonly attempts: Array<ScheduleActionAttempt>
  /** The target's power intent when the occurrence began. */
  readonly powerIntent: string
  error: string | null
  failure: string | null
  /**
   * A command that may be running, recorded as unknown until it ends, so a
   * restart that interrupts it reports it that way.
   */
  inFlight: ScheduleActionAttempt | null
  missing: boolean
  readonly startedAt: number
  readonly target: ScheduleTarget
}

const scheduleBatchSize = 32
const scheduledBackupPollIntervalMs = 500
const scheduledBackupWaitTimeoutMs = 6 * 60 * 60 * 1_000
const maximumTimerDurationMs = 2_147_483_647
const targetExecutionConcurrency = 8
// How many times a command's record is tried again before it's refused.
const progressWriteRetries = 3
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
  readonly listAppOwnedVolumeIds: (
    appId: string
  ) => Promise<ReadonlyArray<string>>
  readonly listAppIds: () => Promise<ReadonlySet<string>>
  readonly listDatabaseIds: () => Promise<ReadonlySet<string>>
  // Read per run: Hearth can give the Relay its installation ID at any time.
  readonly platformTargetId: () => string
  readonly reportError?: (message: string, cause: unknown) => void
  readonly relayId: string
  /**
   * Runs a command in a database's container or an App's service. It
   * rejects when the command didn't run, and otherwise answers with how it
   * went, which may be unknown.
   */
  readonly runContainerCommand: (
    target: ContainerCommandTarget,
    command: string
  ) => Promise<ContainerCommandResult>
  /**
   * Runs a power step unless someone changed the target's power since
   * `powerIntent` was read, in which case it rejects with a superseded
   * LaneRejectedError.
   */
  readonly runPower: (
    kind: PowerResourceKind,
    id: string,
    action: PowerAction,
    powerIntent: string
  ) => Promise<void>
  /**
   * A token that changes whenever someone changes a game server's, App's,
   * or database's power or replaces it, read when an occurrence begins.
   */
  readonly powerIntent: (kind: PowerResourceKind, id: string) => string
  /** A paused Relay runs no schedule actions; they're recorded as not run. */
  readonly isPaused: () => boolean
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
            this.#launchOccurrence(
              occurrence.definition,
              occurrence.scheduledAt
            )
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
            target.kind === "relay"
              ? ""
              : this.#options.powerIntent(target.kind, target.id),
          error: null,
          failure: null,
          inFlight: null,
          missing: false,
          startedAt: Date.now(),
          target,
        }
      }
    )
    const sequenceAttempts: Array<ScheduleActionAttempt> = []
    let sequenceFailure: string | null = null
    const runId = scheduleStableId(
      schedule.id,
      scheduledAt,
      this.#options.relayId
    )
    // Progress is written whole and in order, so the last write is the
    // latest state of every target. A required write, which a command waits
    // for before it's sent, is tried again briefly; it answers whether it
    // landed.
    const progressPermit = Semaphore.makeUnsafe(1)
    const recordProgress = (required: boolean) =>
      Effect.runPromise(
        progressPermit
          .withPermit(
            Effect.suspend(() =>
              this.#options.state.recordProgress(
                scheduleRunSchema.parse({
                  finishedAt: Date.now(),
                  id: runId,
                  revision: schedule.revision,
                  scheduleId: schedule.id,
                  scheduledAt,
                  sequenceAttempts,
                  startedAt,
                  status: "running",
                  targetRuns: targetStates.map((state) =>
                    targetRun(schedule.id, scheduledAt, state)
                  ),
                })
              )
            )
          )
          .pipe(
            Effect.retry({
              schedule: Schedule.exponential("200 millis"),
              times: required ? progressWriteRetries : 0,
            }),
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.sync(() => {
                this.#options.reportError?.(
                  "Relay schedule progress write failed",
                  cause
                )
                return false
              })
            )
          )
      )
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
                    recordProgress,
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
      id: runId,
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
    recordProgress: (required: boolean) => Promise<boolean>,
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
    if (this.#options.isPaused()) {
      state.attempts.push(
        attempt({
          action,
          error: "Not run: the Relay is paused",
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "not_run",
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
    // Hearth refuses a scheduled backup where it would refuse a manual
    // one, as when backups are off for the target, its destination is
    // disabled, or it's being deleted, and says so in the schedule it sends.
    const refusal =
      action.type === "backup" ? backupRefusal(action, state.target) : null
    if (refusal) {
      state.attempts.push(
        attempt({
          action,
          error: `Not run: ${refusal}`,
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "not_run",
          target: state.target,
        })
      )
      return
    }
    // A command may run from the moment it's sent, so it's recorded as
    // unknown first: a restart before it ends leaves it that way, and the
    // interrupted occurrence never runs again.
    const inContainer =
      action.type === "console_command" && state.target.kind !== "instance"
    if (inContainer) {
      state.inFlight = attempt({
        action,
        error:
          "The Relay stopped before this command finished, so it may have run",
        scheduledAt,
        scheduleId: schedule.id,
        startedAt: actionStartedAt,
        status: "unknown",
        target: state.target,
      })
      // Sent only once a restart would report it, so it can't run unseen.
      if (!(await recordProgress(true))) {
        state.inFlight = null
        const failure =
          "Not run: the Relay couldn't record the command before sending it"
        if (!state.failure) {
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
            status: "failed",
            target: state.target,
          })
        )
        return
      }
    }
    const executed = await ensuringPromise(
      () =>
        Effect.runPromise(
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
        ),
      () => {
        state.inFlight = null
      }
    )
    // Someone changed the target's power while the schedule ran, so its
    // later power steps give way rather than undo that. Or the Relay was
    // paused while the step waited its turn, or the target is being
    // deleted, which refuses every change to it.
    if (
      Result.isFailure(executed) &&
      executed.failure instanceof LaneRejectedError &&
      (executed.failure.reason === "superseded" ||
        executed.failure.reason === "paused" ||
        executed.failure.reason === "refused")
    ) {
      state.attempts.push(
        attempt({
          action,
          error:
            executed.failure.reason === "paused"
              ? "Not run: the Relay is paused"
              : executed.failure.reason === "refused"
                ? `Not run: ${executed.failure.message}`
                : `Not run: ${powerOwner(state.target)} power was changed during the schedule`,
          scheduledAt,
          scheduleId: schedule.id,
          startedAt: actionStartedAt,
          status: "not_run",
          target: state.target,
        })
      )
      if (inContainer) await recordProgress(false)
      return
    }
    const result = Result.isSuccess(executed) ? executed.success : undefined
    const failure = Result.isFailure(executed)
      ? errorMessage(executed.failure)
      : result?.unknown
        ? result.unknown
        : result && result.exitCode !== 0
          ? `The command exited with code ${result.exitCode}`
          : null
    // The first failure stays the target's error when later actions continue.
    if (failure && !state.failure) {
      state.failure = failure
      state.error = failure
    }
    state.attempts.push({
      ...attempt({
        action,
        error: failure,
        scheduledAt,
        scheduleId: schedule.id,
        startedAt: actionStartedAt,
        status: result?.unknown ? "unknown" : failure ? "failed" : "succeeded",
        target: state.target,
      }),
      ...(result && {
        result: {
          exitCode: result.exitCode,
          output: result.output,
          truncated: result.truncated,
        },
      }),
    })
    // A restart later in the occurrence keeps how the command went.
    if (inContainer) await recordProgress(false)
  }

  async #targetExists(target: ScheduleTarget) {
    if (target.kind === "relay") return target.id === this.#options.relayId
    if (target.kind === "instance") {
      return (await this.#options.findInstance(target.id)) !== null
    }
    if (target.kind === "app") {
      return (await this.#options.listAppIds()).has(target.id)
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
  ): Promise<ContainerCommandResult | undefined> {
    if (action.type === "console_command") {
      if (target.kind === "instance") {
        await this.#options.sendConsoleCommand(target.id, action.command)
        return
      }
      if (target.kind === "database") {
        return this.#options.runContainerCommand(
          { id: target.id, kind: "database" },
          action.command
        )
      }
      if (target.kind === "app") {
        const service = action.services?.[scheduleTargetKey(target)]
        if (!service) {
          throw new Error("No service was chosen to run the command")
        }
        return this.#options.runContainerCommand(
          { id: target.id, kind: "app", service },
          action.command
        )
      }
    }
    if (action.type === "power" && target.kind !== "relay") {
      await this.#options.runPower(
        target.kind,
        target.id,
        action.action,
        powerIntent
      )
      return
    }
    if (action.type === "backup") {
      if (target.kind === "app") {
        await this.#backUpApp(schedule, action, target, scheduledAt, signal)
        return
      }
      const execution = backupExecution(action, target)
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
      const destination = scheduledBackupDestination(
        deployedDestination,
        backupId,
        artifactId,
        artifactKind
      )
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
          ...(action.mode === "incremental" && execution?.repositoryId
            ? { repositoryId: execution.repositoryId }
            : {}),
          storageId:
            action.destination.kind === "storage"
              ? action.destination.storageId
              : null,
        },
        destination,
        exclude: [],
        kind: "create",
        maxBytes: execution?.maxBytes ?? null,
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

  /**
   * Backs up an App as Hearth projected it: its folder and each volume its
   * Compose project owns, each a backup of its own, started together.
   * Stopped, they share one stopped window, so the App stops once and its
   * folder and volumes agree.
   */
  async #backUpApp(
    schedule: RelayScheduleProjection,
    action: Extract<TargetScheduleAction, { type: "backup" }>,
    target: ScheduleTarget,
    scheduledAt: number,
    signal?: AbortSignal
  ) {
    const executions = appBackupExecutions(action, target)
    if (
      executions.length === 0 ||
      executions.some((execution) => !execution.destination)
    ) {
      throw new Error("Scheduled backup destination is not deployed")
    }
    const owned = await this.#options.listAppOwnedVolumeIds(target.id)
    const projected = new Set(
      executions
        .filter((execution) => execution.targetKind === "volume")
        .map((execution) => execution.targetId)
    )
    if (
      owned.length !== projected.size ||
      owned.some((id) => !projected.has(id))
    ) {
      throw new Error(
        "App backup coverage changed; waiting for Hearth to refresh the schedule"
      )
    }
    const runId = scheduleStableId(
      schedule.id,
      scheduledAt,
      this.#options.relayId
    )
    const batchId = scheduleDeterministicUuid(
      "schedule-backup-batch",
      schedule.id,
      scheduledAt,
      target.id,
      action.id
    )
    const stopped = action.consistency === "stopped"
    const inputs = executions.map((execution): BackupTaskInput => {
      const backupId = scheduleDeterministicUuid(
        "schedule-backup",
        schedule.id,
        scheduledAt,
        execution.targetKind,
        execution.targetId,
        action.id
      )
      return {
        artifactKind: "tar_archive",
        backupId,
        catalog: {
          batchId,
          name: resolveScheduleBackupName(action.name, {
            backupId,
            instanceId: target.id,
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
        appCoverage: {
          appId: target.id,
          volumeIds: executions
            .filter((entry) => entry.targetKind === "volume")
            .map((entry) => entry.targetId),
        },
        ...(stopped ? { consistency: "stopped" as const } : {}),
        ...(executions.length >= 2
          ? { batch: { id: batchId, size: executions.length } }
          : {}),
        destination: scheduledBackupDestination(
          execution.destination!,
          backupId,
          scheduleDeterministicUuid("artifact", backupId),
          "tar_archive"
        ),
        exclude: [],
        kind: "create",
        maxBytes: execution.maxBytes ?? null,
        mode: "full",
        reason: "scheduled",
        target: {
          id: execution.targetId,
          kind: execution.targetKind === "volume" ? "volume" : "app",
        },
        taskId: scheduleDeterministicUuid("task", backupId),
      }
    })
    // Every member is queued before any is waited for, as a stopped
    // window starts only once its whole batch has arrived.
    const queued = await Promise.all(
      inputs.map((input) => this.#options.enqueueBackup(input))
    )
    await Effect.runPromise(
      Effect.all(
        queued.map((task) => this.#waitForBackup(task)),
        { concurrency: "unbounded", discard: true }
      ),
      signal ? { signal } : undefined
    )
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
    | "unknown"
  target: ScheduleTarget
}): ScheduleActionAttempt {
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
    attempts: state.inFlight
      ? [...state.attempts, state.inFlight]
      : state.attempts,
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
        : state.inFlight
          ? "interrupted"
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
        hasErrorCode(cause, "ENOENT")
          ? Effect.succeed(null)
          : Effect.fail(cause)
      )
    )
  )
}

function hasErrorCode(cause: unknown, code: string) {
  return cause instanceof Error && "code" in cause && cause.code === code
}

function powerOwner(target: ScheduleTarget) {
  return target.kind === "database"
    ? "the database's"
    : target.kind === "app"
      ? "the App's"
      : "the server's"
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unknown schedule error"
}

// What Hearth admitted of a backup step for one target.
function backupExecution(
  action: Extract<TargetScheduleAction, { type: "backup" }>,
  target: ScheduleTarget
) {
  return action.executions.find(
    (candidate) =>
      candidate.targetId === target.id && candidate.targetKind === target.kind
  )
}

// What Hearth admitted of an App's backup: its folder's and each owned
// volume's.
function appBackupExecutions(
  action: Extract<TargetScheduleAction, { type: "backup" }>,
  target: ScheduleTarget
) {
  return action.executions.filter(
    (candidate) =>
      (candidate.targetKind === "app" && candidate.targetId === target.id) ||
      (candidate.targetKind === "volume" && candidate.appId === target.id)
  )
}

// Why Hearth refused a backup step for a target, as it would a manual one.
// An App's is refused whole when any of its backups is.
function backupRefusal(
  action: Extract<TargetScheduleAction, { type: "backup" }>,
  target: ScheduleTarget
): string | null {
  const executions =
    target.kind === "app"
      ? appBackupExecutions(action, target)
      : [backupExecution(action, target)]
  return executions.find((execution) => execution?.refusal)?.refusal ?? null
}

// Where a scheduled backup goes: its local or S3 destination, with the
// artifact's identity and, on S3, its object key.
function scheduledBackupDestination(
  deployed: NonNullable<
    Extract<
      TargetScheduleAction,
      { type: "backup" }
    >["executions"][number]["destination"]
  >,
  backupId: string,
  artifactId: string,
  artifactKind: Extract<BackupTaskInput, { kind: "create" }>["artifactKind"]
) {
  return deployed.kind === "s3"
    ? {
        accessKeyId: deployed.accessKeyId,
        allowPrivateNetwork: deployed.allowPrivateNetwork,
        artifactId,
        bucket: deployed.bucket,
        endpoint: deployed.endpoint,
        forcePathStyle: deployed.forcePathStyle,
        kind: "s3" as const,
        objectKey: `${deployed.objectKeyPrefix}/${backupId}/${backupArtifactFilename(backupId, artifactKind)}`,
        region: deployed.region,
        secretAccessKey: deployed.secretAccessKey,
      }
    : { ...deployed, artifactId }
}
