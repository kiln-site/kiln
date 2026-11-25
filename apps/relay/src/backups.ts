import { createHash, randomUUID } from "node:crypto"
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  type ReadStream,
} from "node:fs"
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { pipeline } from "node:stream"
import { constants as zlibConstants, createGunzip } from "node:zlib"
import { logException } from "@workspace/telemetry"
import { Deferred, Effect, Fiber, Option, Queue, Result, Schema } from "effect"
import ZipStream from "zip-stream"

import {
  backupArtifactFilename,
  backupExportFilename,
  type BackupArchiveCreateTaskResult,
  type BackupArchiveManifest,
  type BackupCreateTaskInput,
  type BackupCreateTaskResult,
  type BackupDeleteTaskInput,
  type BackupExportTaskResult,
  type BackupFailureCode,
  type BackupResticCreateTaskResult,
  type BackupRestoreTaskInput,
  type BackupTaskCancelRequest,
  type BackupTaskListRequest,
  type BackupTarget,
  type BackupUnfinishedRestore,
  type BackupTaskInput,
  type BackupTaskPhase,
  type BackupTaskResult,
  type RelayBackupTask,
  type RelayInstanceWebRoute,
  type RelayVolume,
  type ResticRepositoryLocation,
} from "@workspace/contracts"

import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { brickSnapshotDirectory, readRecordedBrickSnapshot } from "./bricks.js"
import type { DatabaseDriver } from "./databases.js"
import {
  createCompressedDatabaseBackup,
  dumpCompressedDatabase,
  restoreCompressedDatabaseBackup,
} from "./database-backups.js"
import { createEncryptedPlatformBackup } from "./platform-backups.js"
import { platformBackupKey } from "./platform-backup-key.js"
import { collectPlatformRecovery } from "./platform-recovery.js"
import { restoreUnfinished } from "./platform-restore.js"
import { PlatformError, withPlatformLock } from "./platform-state.js"
import { RelayBackupError } from "./effect/errors.js"
import {
  ensuringPromise,
  promiseEffect,
  recoverPromise,
} from "./effect/promise.js"
import { RelayStateStore, type ScheduledBackupPrune } from "./effect/state.js"
import {
  exclusive,
  LaneRejectedError,
  laneKeys,
  type LaneLock,
} from "./operation-lanes.js"
import type { OperationLanes } from "./operation-lanes.js"
import {
  appLifecycleLocks,
  appStartLocks,
  backupTaskLocks,
} from "./operation-plans.js"
import { backupPathIsExcluded } from "./backups/exclude.js"
import {
  abandonTarRestore,
  createTarBackup,
  finishTarRestore,
  removeLeftoverTarHelpers,
  restoreTarBackup,
  restoreVolumeSnapshot,
  VOLUME_MOUNT,
  type TarSource,
} from "./backups/tar-archives.js"
import {
  readTarRestoreJournal,
  readTarRestoreJournals,
  TAR_RESTORE_RECOVERY_LABEL,
  TarRestoreFences,
  type TarRestoreJournal,
} from "./backups/tar-restore-journal.js"
import { TAR_RESTORE_STAGING_PREFIX } from "./backups/tar-restore-steps.js"
import { resticHelperSpawn } from "./backups/restic-helper.js"
import { DockerEngine } from "./docker-engine.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { backupFailureCode } from "./backups/failure.js"
import {
  backupTaskAttributes,
  type BackupTaskOutcome,
  recordBackupTask,
  recordBackupTaskQueued,
  recordResticSnapshot,
} from "./backups/telemetry.js"
import {
  backupArchivePath,
  backupDestinationFor,
  backupDirectoryPath,
  resticRepositoryKey,
} from "./backups/destinations/index.js"
import type { ResticRepositoryAccess } from "./backups/destinations/s3/restic-bridge.js"
import { UnzippableEntryError, zipTree } from "./backups/zip-tree.js"
import {
  installPreparedInstanceRestore,
  materializeBackupArtifact,
  prepareInstanceRestoreStaging,
  recoverInterruptedRestores,
  requireRestoreSpace,
  restorePortableInstanceBackup,
  settleRestoreJournal,
  type RestoreInstallGate,
} from "./backup-restore.js"
import {
  createResticDriver,
  requiredRepositoryPassword,
  RESTIC_EXIT_REPOSITORY_MISSING,
  resticDriverLocation,
  resticSnapshotSelector,
  translateExcludePatterns,
  validateStagingTree,
  type ResticBackupSource,
  type ResticDriver,
  type ResticDriverLocation,
  type ResticSnapshotSummary,
} from "./restic.js"

const MAX_BACKUP_ENTRIES = 100_000
// One page of the task journal for Hearth stays well inside a control
// message (1 MiB), whatever else the message carries.
const backupTaskPageBytes = 512 * 1024
// A task's warnings are cut to this many on a page, with a last one saying
// how many more there were, so no one task can fill a page alone.
const backupTaskPageWarnings = 50

function withinPage(task: RelayBackupTask): RelayBackupTask {
  const result = task.result
  if (
    !result ||
    !("warnings" in result) ||
    result.warnings.length <= backupTaskPageWarnings
  ) {
    return task
  }
  const kept = result.warnings.slice(0, backupTaskPageWarnings - 1)
  return {
    ...task,
    result: {
      ...result,
      warnings: [
        ...kept,
        `…and ${result.warnings.length - kept.length} more warnings`,
      ],
    },
  }
}
const ZIP_OVERHEAD_RESERVE_BYTES = 64 * 1024 * 1024
const EXPORT_STAGING_SUFFIX = ".files"
const BACKUP_TIMEOUT_REASON =
  "Cancelled after reaching the configured backup timeout"
const EXPORT_SWEEP_INTERVAL = "1 hour"
const RESTIC_CACHE_CLEANUP_TIMEOUT_MS = 30_000
const RESTIC_RECOVERY_TIMEOUT_MS = 30_000
const DEFAULT_EXCLUDES = [
  ".DS_Store",
  "Thumbs.db",
  "session.lock",
  "**/session.lock",
  "*.pid",
  "**/*.pid",
  ".kiln-backup",
  ".kiln-backup/**",
] as const

type BackupProgress = {
  completed: number
  currentArtifactId: string | null
  currentPath: string | null
  phase: BackupTaskPhase
  total: number
}

type BackupOperationTaskResult = Exclude<
  BackupTaskResult,
  BackupCreateTaskResult
>

type ArchiveEntry = {
  absolute: string
  device: number
  inode: number
  mode: number
  modifiedAt: number
  name: string
  size: number
}

type BackupTaskEnd = {
  outcome: BackupTaskOutcome
  failure: BackupFailureCode | null
}

/** What backups of the volumes Apps use need of the App driver. */
export interface BackupApps {
  isRunning(appId: string): Promise<boolean>
  start(appId: string): Promise<void>
  stop(appId: string): Promise<void>
  /** The managed volumes starting the App mounts, by ID. */
  volumes(appId: string): Promise<ReadonlyArray<string>>
}

/** A managed volume as backups find it, by its ID. */
export interface BackupVolumes {
  find(
    id: string
  ): Effect.Effect<
    Pick<
      RelayVolume,
      "dockerName" | "kind" | "mounts" | "name" | "users"
    > | null,
    unknown
  >
}

export class BackupManager {
  readonly #config: RelayConfig
  readonly #findInstance: (
    instanceId: string
  ) => Promise<RelayInstanceConfig | null>
  readonly #isInstanceStopped: (instanceId: string) => Promise<boolean>
  readonly #databases: DatabaseDriver | null
  readonly #apps: BackupApps | null
  readonly #volumes: BackupVolumes | null
  readonly #engine: DockerEngine
  readonly #hostDataDirectory: () => Promise<string>
  readonly #fences: TarRestoreFences
  readonly #lanes: OperationLanes
  readonly #restic: ResticDriver
  readonly #state: RelayStateStore["Service"]
  readonly #wake: Queue.Queue<void>
  readonly #activeCreates = new Map<string, AbortController>()

  private constructor(options: {
    config: RelayConfig
    findInstance: (instanceId: string) => Promise<RelayInstanceConfig | null>
    isInstanceStopped: (instanceId: string) => Promise<boolean>
    databases: DatabaseDriver | null
    apps: BackupApps | null
    volumes: BackupVolumes | null
    hostDataDirectory: () => Promise<string>
    fences: TarRestoreFences
    lanes: OperationLanes
    restic: ResticDriver
    state: RelayStateStore["Service"]
    wake: Queue.Queue<void>
  }) {
    this.#config = options.config
    this.#lanes = options.lanes
    this.#findInstance = options.findInstance
    this.#isInstanceStopped = options.isInstanceStopped
    this.#databases = options.databases
    this.#apps = options.apps
    this.#volumes = options.volumes
    this.#hostDataDirectory = options.hostDataDirectory
    this.#engine = new DockerEngine(options.config.dockerSocket)
    this.#fences = options.fences
    this.#restic = options.restic
    this.#state = options.state
    this.#wake = options.wake
  }

  static make(options: {
    config: RelayConfig
    findInstance: (instanceId: string) => Promise<RelayInstanceConfig | null>
    isInstanceStopped: (instanceId: string) => Promise<boolean>
    databases?: DatabaseDriver
    apps?: BackupApps
    volumes?: BackupVolumes
    /** The Relay's data directory as Docker's host sees it. */
    hostDataDirectory: () => Promise<string>
    /**
     * Each task holds its target's lane while it runs: a backup alongside
     * other work, a restore alone. While the lanes are paused, queued tasks
     * wait; `resume` starts them again.
     */
    lanes: OperationLanes
    /**
     * The targets of unfinished restores, which the lanes already refuse
     * work on. Without them, they're read now and the lanes told.
     */
    fences?: TarRestoreFences
    /** How restic repositories in a bucket are reached: through Hearth. */
    repositoryAccess?: ResticRepositoryAccess
  }) {
    return Effect.gen(function* () {
      const state = yield* RelayStateStore
      const wake = yield* Queue.unbounded<void>()
      let fences = options.fences
      if (!fences) {
        const loaded = yield* promiseEffect(() =>
          TarRestoreFences.load(options.config)
        )
        options.lanes.addRefusal((label, locks) => loaded.refusal(label, locks))
        fences = loaded
      }
      const manager = new BackupManager({
        config: options.config,
        findInstance: options.findInstance,
        isInstanceStopped: options.isInstanceStopped,
        databases: options.databases ?? null,
        apps: options.apps ?? null,
        volumes: options.volumes ?? null,
        hostDataDirectory: options.hostDataDirectory,
        fences,
        lanes: options.lanes,
        restic: createResticDriver({
          binary: options.config.resticPath,
          cacheDirectory: resolve(
            options.config.dataDirectory,
            "restic",
            "cache"
          ),
          repositoryAccess: options.repositoryAccess,
        }),
        state,
        wake,
      })
      const recovered = yield* Effect.tryPromise(() =>
        recoverInterruptedRestores(options.config)
      )
      for (const taskId of recovered) {
        yield* state.completeBackupTask(
          taskId,
          { warnings: ["Restore completed during Relay recovery"] },
          Date.now()
        )
      }
      // Restores of volumes a stop or a failed swap left
      // midway, finished or undone, and Apps a stopped backup left stopped,
      // started again. Neither keeps the Relay from starting when Docker
      // can't answer; a restore that can't finish keeps its target fenced.
      yield* manager.#recoverTarRestores()
      yield* manager.#restartStoppedApps()
      yield* state.requeueInterruptedBackupTasks(Date.now())
      yield* promiseEffect(() => removeStagedExports(options.config))
      yield* promiseEffect(() => sweepExpiredBackupExports(options.config))
      yield* Queue.offer(wake, undefined)
      return manager
    })
  }

  enqueue(input: BackupTaskInput) {
    return Effect.gen({ self: this }, function* () {
      const task = yield* this.#state.enqueueBackupTask(input, Date.now())
      yield* Queue.offer(this.#wake, undefined)
      return task
    })
  }

  get(taskId: string) {
    return this.#state.getBackupTask(taskId)
  }

  /**
   * One page of the backup task journal for Hearth: the tasks changed after
   * `after`, in the order they changed, every task still queued or running,
   * and those Hearth names, all within one control message.
   */
  page(request: BackupTaskListRequest) {
    return Effect.gen({ self: this }, function* () {
      // Pruning is housekeeping: Hearth gets its page regardless.
      yield* this.#state
        .pruneBackupJournal(Date.now())
        .pipe(
          Effect.catch((cause) =>
            logException(cause, { operation: "Backups.pruneJournal" })
          )
        )
      const { changed, current, next } = yield* this.#state.backupTaskPage({
        after: request.after ?? { taskId: "", updatedAt: 0 },
        budgetBytes: backupTaskPageBytes,
        taskIds: request.taskIds ?? [],
      })
      return {
        changed: changed.map(withinPage),
        current: current.map(withinPage),
        next,
      }
    })
  }

  /**
   * Stops the create Hearth names, if this Relay holds that create: for that
   * backup and resource. Answers with the task it holds under the ID.
   */
  cancel(request: BackupTaskCancelRequest) {
    return Effect.gen({ self: this }, function* () {
      const cancelled = yield* this.#state.cancelBackupTask(
        request.taskId,
        Date.now(),
        undefined,
        null,
        { backupId: request.backupId, target: request.target }
      )
      if (cancelled) this.#activeCreates.get(request.taskId)?.abort()
      return yield* this.#state.getBackupTask(request.taskId)
    })
  }

  /**
   * Finishes or abandons a restore of a volume whose swap
   * didn't finish, which fences its target until then. Finishing stops the
   * Apps running on the target first; abandoning keeps what the target
   * holds now.
   */
  resolveTarRestore(taskId: string, action: "abandon" | "finish") {
    return Effect.gen({ self: this }, function* () {
      const journal = (yield* promiseEffect(() =>
        readTarRestoreJournals(this.#config)
      )).find((entry) => entry.taskId === taskId)
      if (!journal) {
        return yield* backupFailure(
          "restore_not_unfinished",
          "restore.resolve",
          "No unfinished restore has this ID"
        )
      }
      yield* this.#settleTarRestore(journal, action, true)
    }).pipe(Effect.withSpan("Backups.resolveTarRestore"))
  }

  /** The restores of volumes fencing their targets. */
  unfinishedTarRestores(): Array<BackupUnfinishedRestore> {
    return this.#fences.list().flatMap((journal) =>
      journal.phase === "staging"
        ? []
        : [
            {
              phase: journal.phase,
              target: journal.target,
              taskId: journal.taskId,
            },
          ]
    )
  }

  /**
   * The worker: runs tasks as they are queued, for as long as the Relay
   * runs. What it does on a timer is forked here, not as the manager is
   * made: a fiber forked there ends when making it does.
   */
  run() {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.forkChild(
        Effect.sleep(EXPORT_SWEEP_INTERVAL).pipe(
          Effect.andThen(
            promiseEffect(() => sweepExpiredBackupExports(this.#config))
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Expired backup exports were not swept", cause)
          ),
          Effect.forever
        )
      )
      while (true) {
        yield* Queue.take(this.#wake)
        yield* this.#drain()
      }
    })
  }

  runPending() {
    return this.#drain()
  }

  /** Starts tasks that waited out a pause. */
  resume() {
    return Queue.offer(this.#wake, undefined).pipe(Effect.asVoid)
  }

  #drain() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        if (this.#lanes.paused) return
        const task = yield* this.#state.claimNextBackupTask(Date.now())
        if (!task) return
        const batch = stoppedBatch(task)
        const outcome = batch
          ? yield* this.#runBatch(task, batch)
          : yield* this.#runTask(task, null)
        if (outcome === "paused") return
      }
    })
  }

  /**
   * Runs one claimed task, waiting its turn in the lanes; or, in a stopped
   * batch's window, inside the locks the batch already holds.
   */
  #runTask(task: RelayBackupTask, window: StoppedWindow | null) {
    return Effect.gen({ self: this }, function* () {
      const controller = new AbortController()
      this.#activeCreates.set(task.taskId, controller)
      const current = yield* this.#state.getBackupTask(task.taskId)
      if (!current || current.status !== "running") controller.abort()
      const startedAt = Date.now()
      yield* recordBackupTaskQueued(
        this.#config.nodeId,
        task,
        startedAt - task.createdAt
      )
      let timedOut = false
      // A restore that has started swapping its files in finishes; before
      // then its deadline stops it. Each side decides synchronously, before
      // it awaits anything, so exactly one wins.
      let installing = false
      let deadlinePassed = false
      const beginInstall = () => {
        if (deadlinePassed || controller.signal.aborted) {
          throw controller.signal.aborted
            ? backupAbortError(controller.signal)
            : new Error(BACKUP_TIMEOUT_REASON)
        }
        installing = true
      }
      const timeoutFiber = yield* Effect.forkChild(
        Effect.sleep(this.#config.backupTimeoutMs).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (installing) return Effect.succeed(false)
              deadlinePassed = true
              return task.kind === "create"
                ? this.#state.cancelBackupTask(
                    task.taskId,
                    Date.now(),
                    BACKUP_TIMEOUT_REASON,
                    "timed_out"
                  )
                : this.#state.failBackupTask(
                    task.taskId,
                    BACKUP_TIMEOUT_REASON,
                    Date.now(),
                    "timed_out"
                  )
            })
          ),
          Effect.tap((stopped) =>
            stopped
              ? Effect.sync(() => {
                  timedOut = true
                  controller.abort()
                })
              : Effect.void
          ),
          Effect.asVoid
        )
      )
      // The Apps whose lifecycles a volume's stopped backup or restore
      // holds, looked up before its turn and checked again once it has
      // it; a lookup that fails fails the task, never locking too little.
      const outcome = yield* (
        window ? Effect.succeed([]) : this.#lockedVolumeApps(task.input)
      )
        .pipe(
          Effect.flatMap((volumeApps) =>
            window
              ? // Its batch holds the locks; it starts unless cancelled.
                Effect.suspend(() =>
                  controller.signal.aborted
                    ? Effect.fail(backupAbortError(controller.signal))
                    : this.#execute(
                        task,
                        controller.signal,
                        beginInstall,
                        window.lockedApps,
                        window
                      )
                )
              : this.#lanes.run(
                  {
                    label: `backup.${task.kind}`,
                    // A task that timed out or was cancelled while it waited
                    // its turn mustn't start, a restore least of all.
                    precondition: () => !controller.signal.aborted,
                    locks: backupTaskLocks(
                      task.input,
                      (reference) => reference,
                      () => volumeApps
                    ),
                  },
                  this.#execute(
                    task,
                    controller.signal,
                    beginInstall,
                    new Set(volumeApps),
                    null
                  )
                )
          )
        )
        .pipe(
          Effect.as<BackupTaskEnd>({ outcome: "succeeded", failure: null }),
          // Withdrawn by a pause before it started: it goes back in line
          // and starts once the Relay is resumed.
          Effect.catch((cause) =>
            cause instanceof LaneRejectedError && cause.reason === "paused"
              ? // Its deadline mustn't cancel it while it goes back.
                Fiber.interrupt(timeoutFiber).pipe(
                  Effect.andThen(
                    this.#state.returnBackupTask(task.taskId, Date.now())
                  ),
                  Effect.as("paused" as const)
                )
              : Effect.fail(cause)
          ),
          Effect.catch((cause) =>
            this.#state
              .failBackupTask(
                task.taskId,
                backupErrorMessage(cause),
                Date.now(),
                backupFailureCode(cause)
              )
              .pipe(
                Effect.flatMap((failed): Effect.Effect<BackupTaskEnd> => {
                  // Cancelled by a user, or stopped by its deadline, which
                  // already recorded the timeout.
                  if (!failed && !timedOut) {
                    return Effect.succeed({
                      outcome: "cancelled",
                      failure: null,
                    })
                  }
                  const failure = failed
                    ? backupFailureCode(cause)
                    : "timed_out"
                  return logException(cause, {
                    operation: `Backups.${task.kind}`,
                    attributes: {
                      ...backupTaskAttributes(task),
                      "backup.failure.code": failure,
                      "backup.error.code":
                        cause instanceof RelayBackupError ? cause.code : null,
                    },
                  }).pipe(Effect.as({ outcome: "failed", failure }))
                })
              )
          ),
          Effect.tap((ended) =>
            ended === "paused"
              ? Effect.void
              : Effect.annotateCurrentSpan({
                  "backup.task.outcome": ended.outcome,
                  "backup.failure.code": ended.failure,
                }).pipe(
                  Effect.andThen(
                    recordBackupTask(
                      this.#config.nodeId,
                      task,
                      ended.outcome,
                      ended.failure,
                      Date.now() - startedAt
                    )
                  )
                )
          ),
          Effect.ensuring(
            timeoutFiber ? Fiber.interrupt(timeoutFiber) : Effect.void
          ),
          Effect.ensuring(
            controller
              ? Effect.sync(() => this.#activeCreates.delete(task.taskId))
              : Effect.void
          ),
          // A batch's window closes once every backup in it has left.
          Effect.ensuring(window ? window.leave(task.taskId) : Effect.void),
          Effect.withSpan(`Backups.${task.kind}`, {
            attributes: backupTaskAttributes(task),
          })
        )
      return outcome === "paused" ? ("paused" as const) : undefined
    })
  }

  /**
   * Runs a stopped batch, as backing up an App starts each
   * owned volume's: every backup in it within one stopped window, holding
   * all their locks, so the copies agree. The Apps that use any of them stop
   * once, journaled as a single stopped backup's are, and those that ran
   * start again once every archive is taken. A scheduled batch must arrive
   * completely, since its pieces taken in windows of their own would not
   * agree. So must a batch with a database in it: a database dumped without the batch's volumes
   * would be taken with nothing stopped and still say it was, and a volume
   * archived again after a restart, its database's dump already taken,
   * would be of another stopped window than that dump. A volume that is
   * gone by the batch's turn fails alone, as it would backed up alone, and
   * the rest are still taken.
   */
  #runBatch(leader: RelayBackupTask, batch: { id: string; size: number }) {
    return Effect.gen({ self: this }, function* () {
      const claimed = [leader]
      for (let wait = 0; claimed.length < batch.size && wait < 20; wait += 1) {
        claimed.push(
          ...(yield* this.#state.claimBatchBackupTasks(batch.id, Date.now()))
        )
        if (claimed.length < batch.size) yield* Effect.sleep("250 millis")
      }
      if (
        claimed.length !== batch.size &&
        // A schedule's batch is queued whole at once, here on the Relay,
        // or sent by Hearth a task after another when it goes to a bucket.
        // One still short of a member after this wait is taken for broken,
        // not still arriving: its pieces wouldn't be of one moment.
        (claimed.some(
          (member) =>
            member.input.kind === "create" &&
            member.input.reason === "scheduled"
        ) ||
          // Whether or not the database is among those here now.
          (yield* this.#state.batchHoldsDatabase(batch.id)))
      ) {
        for (const member of claimed) {
          yield* this.#state.failBackupTask(
            member.taskId,
            "This backup's batch is incomplete; no backups were started",
            Date.now()
          )
        }
        return undefined
      }
      const members: Array<RelayBackupTask> = []
      for (const member of claimed) {
        const found =
          member.input.kind === "create" &&
          member.input.target.kind === "volume"
            ? yield* Effect.result(this.#requiredVolume(member.input.target.id))
            : null
        if (
          found &&
          Result.isFailure(found) &&
          found.failure.code === "volume_not_found"
        ) {
          yield* this.#state.failBackupTask(
            member.taskId,
            backupErrorMessage(found.failure),
            Date.now()
          )
        } else members.push(member)
      }
      const [first] = members
      if (!first) return undefined
      const prepared = yield* Effect.result(this.#batchLocks(members))
      if (Result.isFailure(prepared)) {
        for (const member of members) {
          yield* this.#state.failBackupTask(
            member.taskId,
            backupErrorMessage(prepared.failure),
            Date.now()
          )
        }
        return undefined
      }
      const { lockedApps, locks } = prepared.success
      const window = yield* this.#stoppedWindow(first, members, lockedApps)
      const run = yield* Effect.result(
        this.#lanes.run(
          { label: "backup.batch", locks },
          Effect.gen({ self: this }, function* () {
            yield* Effect.forEach(
              members,
              (member) => this.#runTask(member, window),
              {
                concurrency: "unbounded",
                discard: true,
              }
            )
          })
        )
      )
      if (Result.isSuccess(run)) return undefined
      // Withdrawn by a pause before it started: back in line.
      const paused =
        run.failure instanceof LaneRejectedError &&
        run.failure.reason === "paused"
      for (const member of members) {
        yield* paused
          ? this.#state.returnBackupTask(member.taskId, Date.now())
          : this.#state
              .failBackupTask(
                member.taskId,
                backupErrorMessage(run.failure),
                Date.now()
              )
              .pipe(Effect.asVoid)
      }
      return paused ? ("paused" as const) : undefined
    }).pipe(Effect.withSpan("Backups.batch"))
  }

  // Every lock a batch's backups take, and the Apps whose lifecycles they
  // hold, looked up before its turn.
  #batchLocks(members: ReadonlyArray<RelayBackupTask>) {
    return Effect.gen({ self: this }, function* () {
      const lockedApps = new Set<string>()
      const locks: Array<LaneLock> = []
      for (const member of members) {
        const apps = yield* this.#lockedVolumeApps(member.input)
        for (const appId of apps) lockedApps.add(appId)
        locks.push(
          ...(yield* promiseEffect(async () =>
            backupTaskLocks(
              member.input,
              (reference) => reference,
              () => apps
            )
          ))
        )
      }
      return { lockedApps: lockedApps as ReadonlySet<string>, locks }
    })
  }

  // A batch's stopped window: the first backup to need it stops every App
  // that uses any of the batch's targets; the last to leave starts again
  // those that ran.
  #stoppedWindow(
    leader: RelayBackupTask,
    members: ReadonlyArray<RelayBackupTask>,
    lockedApps: ReadonlySet<string>
  ) {
    return Effect.gen({ self: this }, function* () {
      let stopped: ReadonlyArray<StoppedApp> = []
      const begin = yield* Effect.cached(
        Effect.gen({ self: this }, function* () {
          // Checked again now the batch holds its locks, before anything
          // stops: an App that began using one of its targets since they
          // were looked up holds no lock here, so stopping it could race
          // its own start or deployment. The whole window fails instead.
          const consumers = new Set<string>()
          for (const member of members) {
            // A volume has Apps to stop. A database of
            // the batch has none: it is dumped once theirs are stopped.
            if (
              member.input.kind !== "create" ||
              member.input.target.kind !== "volume"
            ) {
              continue
            }
            yield* this.#requireLockedApps(member.input.target, lockedApps)
            const source = yield* this.#tarSource(member.input.target, true)
            for (const appId of source.consumers) consumers.add(appId)
          }
          if ([...consumers].some((appId) => !lockedApps.has(appId))) {
            return yield* backupFailure(
              "volume_users_changed",
              "lookup",
              "The Apps using what this backup covers changed while it waited its turn; run it again"
            )
          }
          stopped = yield* this.#stopApps(leader.taskId, [...consumers], true)
        })
      )
      const done = yield* Deferred.make<ReadonlyArray<string>>()
      const left = new Set<string>()
      // Nothing stops until every backup here is ready for it: each first
      // stores what it can while the Apps still run.
      const ready = new Set<string>()
      const allReady = yield* Deferred.make<void>()
      const readyIfLast = Effect.suspend(() =>
        members.every(({ taskId }) => ready.has(taskId) || left.has(taskId))
          ? Deferred.succeed(allReady, undefined)
          : Effect.void
      )
      let restarting = false
      const finishIfLast = Effect.suspend(() => {
        if (restarting || left.size < members.length) return Effect.void
        restarting = true
        return this.#startApps(leader.taskId, stopped).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.flatMap((warnings) => Deferred.succeed(done, warnings)),
          Effect.asVoid
        )
      })
      return {
        arrive: (taskId: string) =>
          Effect.suspend(() => {
            left.add(taskId)
            return finishIfLast.pipe(Effect.andThen(Deferred.await(done)))
          }),
        begin: (taskId: string) =>
          Effect.suspend(() => {
            ready.add(taskId)
            return readyIfLast.pipe(
              Effect.andThen(Deferred.await(allReady)),
              Effect.andThen(begin)
            )
          }),
        leave: (taskId: string) =>
          Effect.suspend(() => {
            left.add(taskId)
            return Effect.andThen(readyIfLast, finishIfLast)
          }),
        lockedApps,
      } satisfies StoppedWindow
    })
  }

  /**
   * Backs up a volume through Docker. Stopped, it stops
   * each App that uses it first, recording which in a journal so a Relay
   * that stops midway starts them again, and starts them again after,
   * unless it's a final backup. An App that won't start again is a warning
   * on the backup, which succeeded.
   */
  #createTar(
    taskId: string,
    input: BackupCreateTaskInput,
    signal: AbortSignal,
    lockedApps: ReadonlySet<string>,
    window: StoppedWindow | null
  ) {
    return Effect.gen({ self: this }, function* () {
      const final = input.reason === "final_delete"
      const consistency =
        input.consistency === "stopped" || final ? "stopped" : "live"
      if (consistency === "stopped") {
        yield* this.#requireLockedApps(input.target, lockedApps)
      }
      const { consumers, manifestVolume, source } = yield* this.#tarSource(
        input.target,
        consistency === "stopped"
      )
      // A final backup is of the resource being deleted, which its freeze
      // already stopped, and it never starts what it stopped again: one that
      // finds another App using what it backs up, as one deployed since the
      // deletion planned it, is refused before it stops anything.
      if (final) {
        if (consumers.length > 0) {
          return yield* backupFailure(
            "volume_users_changed",
            "lookup",
            "Another App began using this volume after its deletion planned to back it up; nothing was stopped or deleted. Try the deletion again."
          )
        }
      }
      const progress: BackupProgress = {
        completed: 0,
        currentArtifactId: null,
        currentPath: null,
        phase: "preparing",
        total: 0,
      }
      const progressFiber = yield* Effect.forkChild(
        Effect.sleep("500 millis").pipe(
          Effect.andThen(
            Effect.suspend(() =>
              this.#state
                .updateBackupTaskProgress(
                  taskId,
                  progress.completed,
                  progress.total || null,
                  progress.phase,
                  progress.currentPath,
                  progress.currentArtifactId,
                  Date.now()
                )
                .pipe(Effect.asVoid)
            )
          ),
          Effect.forever
        )
      )
      const destination = backupArchivePath(this.#config, input.backupId)
      const archive = Effect.tryPromise({
        try: async () => {
          const directory = backupDirectoryPath(this.#config)
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await cleanupBackupPartials(directory, input.backupId)
          await rm(destination, { force: true })
          const maximumBytes = archiveMaximumBytes(input)
          await requireBackupSpace(directory, 0, maximumBytes)
          const partial = resolve(
            directory,
            `.${input.backupId}.${randomUUID()}.partial`
          )
          progress.phase = "archiving"
          return Effect.runPromise(
            promiseEffect(() =>
              createTarBackup({
                config: this.#config,
                engine: this.#engine,
                exclude: input.exclude,
                manifest: {
                  artifactKind: "tar_archive",
                  backupId: input.backupId,
                  consistency,
                  createdAt: new Date().toISOString(),
                  formatVersion: 1,
                  mode: "full",
                  target: input.target,
                  volume: manifestVolume,
                },
                maxBytes: maximumBytes,
                partial,
                progress,
                signal,
                source,
              })
            ).pipe(
              Effect.tap(() =>
                promiseEffect(() => rename(partial, destination))
              ),
              Effect.ensuring(
                promiseEffect(() => rm(partial, { force: true })).pipe(
                  Effect.ignore
                )
              )
            )
          )
        },
        catch: (cause) =>
          cause instanceof RelayBackupError
            ? cause
            : RelayBackupError.make({
                code: "archive_failed",
                operation: "create.archive",
                reason: backupErrorMessage(cause),
                cause,
              }),
      })
      // The Apps it stopped start again however the archive went, before
      // the upload, which can take a while.
      // In a batch, its window stops and starts them, around every
      // backup's archive.
      if (window && consistency === "stopped") yield* window.begin(taskId)
      const stopped =
        consistency === "stopped" && !window
          ? yield* this.#stopApps(taskId, consumers, !final)
          : []
      const archived = yield* Effect.result(archive)
      const restarted = window
        ? yield* window.arrive(taskId)
        : stopped.length > 0 && !final
          ? yield* this.#startApps(taskId, stopped)
          : []
      if (Result.isFailure(archived))
        return yield* Effect.fail(archived.failure)
      progress.phase = "finalizing"
      return yield* storeCreatedBackup(
        this.#config,
        input,
        {
          bytes: archived.success.bytes,
          checksumSha256: archived.success.checksumSha256,
          consistency,
          filename: backupArtifactFilename(input.backupId, "tar_archive"),
          warnings: [...archived.success.warnings, ...restarted].slice(
            0,
            1_000
          ),
        },
        progress,
        signal
      ).pipe(Effect.ensuring(Fiber.interrupt(progressFiber)))
    }).pipe(
      Effect.onError(() =>
        promiseEffect(() =>
          rm(backupArchivePath(this.#config, input.backupId), { force: true })
        ).pipe(Effect.ignore)
      )
    )
  }

  /**
   * Restores a volume through Docker. Nothing that uses it may run: every
   * container that mounts it is stopped first.
   */
  #restoreTar(
    input: BackupRestoreTaskInput & {
      kind: "restore"
      target: BackupTarget & { kind: "volume" }
    },
    signal: AbortSignal,
    beginInstall: RestoreInstallGate,
    lockedApps: ReadonlySet<string>
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* this.#requireLockedApps(input.target, lockedApps)
      const { source } = yield* this.#tarSource(input.target, false, true)
      const mounted = yield* this.#requiredVolume(input.target.id, true)
      const running = mounted.mounts.filter((mount) => mount.running)
      if (running.length > 0) {
        return yield* backupFailure(
          "volume_in_use",
          "restore.preflight",
          running.length === 1
            ? `Stop ${running[0]!.container}, which mounts this volume, before restoring it`
            : `Stop the ${running.length} containers that mount this volume before restoring it`
        )
      }
      const temporary = resolve(
        this.#config.dataDirectory,
        "restores",
        `${input.taskId}.tar.gz`
      )
      return yield* Effect.tryPromise({
        try: async () => {
          const from = input.source
          if (from.kind === "restic") {
            return this.#restoreVolumeSnapshot(
              { ...input, source: from },
              {
                beginInstall,
                lockedApps,
                signal,
                source,
                target: input.target,
              }
            )
          }
          const archive = await materializeBackupArtifact(
            this.#config,
            input,
            temporary
          )
          return restoreTarBackup({
            archive,
            backupId: input.archive?.backupId ?? input.backupId,
            madeOf: input.archive
              ? { id: input.archive.targetId, kind: input.target.kind }
              : input.target,
            beginInstall,
            config: this.#config,
            consumers: [...lockedApps],
            engine: this.#engine,
            fences: this.#fences,
            signal,
            source,
            target: input.target,
            taskId: input.taskId,
          })
        },
        catch: (cause) =>
          cause instanceof RelayBackupError
            ? cause
            : RelayBackupError.make({
                code: "restore_failed",
                operation: "restore",
                reason: backupErrorMessage(cause),
                cause,
              }),
      }).pipe(
        Effect.ensuring(
          promiseEffect(() => rm(temporary, { force: true })).pipe(
            Effect.ignore
          )
        )
      )
    })
  }

  // What Docker mounts for a volume, the Apps a stopped
  // backup stops, and the volume as its manifest records it. A stopped
  // backup of a volume a container other than an App's runs from is
  // refused: Kiln can't stop and start it as its owner would.
  #tarSource(target: BackupTarget, stopping: boolean, restoring = false) {
    return Effect.gen({ self: this }, function* () {
      const volume = yield* this.#requiredVolume(target.id, restoring)
      const others = volume.mounts.filter(
        (mount) => mount.running && mount.kind !== "app"
      )
      if (stopping && others.length > 0) {
        return yield* backupFailure(
          "volume_in_use",
          "lookup",
          `${others[0]!.container} mounts this volume and isn't an App's; stop it before a stopped backup`
        )
      }
      return {
        consumers: [
          ...new Set(
            volume.mounts.flatMap((mount) =>
              mount.kind === "app" && mount.resourceId ? [mount.resourceId] : []
            )
          ),
        ],
        manifestVolume: {
          dockerName: volume.dockerName,
          kind: "kiln" as const,
          name: volume.name,
        },
        source: { kind: "volume", name: volume.dockerName } satisfies TarSource,
      }
    })
  }

  /**
   * A volume's files, which restic reads in a helper. Stopped, they are read
   * twice: once while everything runs, which stores nearly all of it, and
   * again once it's stopped, which reads what changed since. Then what was
   * stopped starts again, as after a full backup.
   */
  #volumeSnapshotSource(
    input: BackupCreateTaskInput,
    lockedApps: ReadonlySet<string>,
    window: StoppedWindow | null
  ) {
    return Effect.gen({ self: this }, function* () {
      const stopped = input.consistency === "stopped"
      if (stopped) yield* this.#requireLockedApps(input.target, lockedApps)
      const { consumers, source } = yield* this.#tarSource(
        input.target,
        stopped
      )
      const { excludes, warnings } = translateExcludePatterns(
        input.exclude.map(volumeExcludePattern)
      )
      const files = {
        cwd: "/",
        excludes: [
          ...excludes,
          // A restore's staging folder, if one was left behind.
          `${VOLUME_MOUNT}/${TAR_RESTORE_STAGING_PREFIX}*`,
        ],
        paths: [VOLUME_MOUNT.slice(1)],
        spawn: this.#helperSpawn(source, true),
      }
      return {
        logicalBytes: async () => 0,
        reusable: window === null,
        take: async (backup, progress) => {
          if (!stopped) return backup(files)
          await backup(files, "before")
          progress.completed = 0
          const stoppedApps = await Effect.runPromise(
            window
              ? window
                  .begin(input.taskId)
                  .pipe(Effect.as<ReadonlyArray<StoppedApp>>([]))
              : this.#stopApps(input.taskId, consumers, true)
          )
          const taken = await Effect.runPromise(
            Effect.result(promiseEffect(() => backup(files)))
          )
          const restarted = await Effect.runPromise(
            window
              ? window.arrive(input.taskId)
              : stoppedApps.length > 0
                ? this.#startApps(input.taskId, stoppedApps)
                : Effect.succeed([])
          )
          if (Result.isFailure(taken)) throw taken.failure
          return {
            ...taken.success,
            warnings: [...taken.success.warnings, ...restarted],
          }
        },
        warnings,
      } satisfies SnapshotSource
    })
  }

  // Restores a volume from a snapshot: restic puts it in a folder of the
  // volume's, which then takes the place of what it holds.
  async #restoreVolumeSnapshot(
    input: BackupRestoreTaskInput & { source: { kind: "restic" } },
    restore: {
      beginInstall: RestoreInstallGate
      lockedApps: ReadonlySet<string>
      signal: AbortSignal
      source: TarSource
      target: BackupTarget & { kind: "volume" }
    }
  ) {
    const password = requiredRepositoryPassword(
      input.source.repositoryPassword,
      "restore.restic"
    )
    const targetId = input.archive?.targetId ?? input.target.id
    return ensuringPromise(
      () =>
        restoreVolumeSnapshot({
          beginInstall: restore.beginInstall,
          config: this.#config,
          consumers: [...restore.lockedApps],
          engine: this.#engine,
          fences: this.#fences,
          restore: (folder, excludes) =>
            this.#restic.restore({
              excludes,
              location: resticDriverLocation(
                this.#config,
                targetId,
                input.source.repository
              ),
              password,
              selector: input.source.snapshotId,
              signal: restore.signal,
              spawn: this.#helperSpawn(restore.source, false),
              target: folder,
            }),
          source: restore.source,
          target: restore.target,
          taskId: input.taskId,
        }),
      () =>
        Effect.runPromise(
          cleanupResticCache(this.#config, this.#restic, {
            password,
            repository: input.source.repository,
            targetId,
          })
        )
    )
  }

  #helperSpawn(source: TarSource, readOnly: boolean) {
    return resticHelperSpawn({
      config: this.#config,
      engine: this.#engine,
      hostDataDirectory: this.#hostDataDirectory,
      readOnly,
      source,
    })
  }

  // A database's dump from its snapshot, gzipped as a full backup's is.
  async #dumpSnapshotFile(
    input: BackupRestoreTaskInput,
    destination: string,
    signal: AbortSignal
  ): Promise<string> {
    const { source } = input
    if (source.kind !== "restic") return destination
    const password = requiredRepositoryPassword(
      source.repositoryPassword,
      "restore.restic"
    )
    const targetId = input.archive?.targetId ?? input.target.id
    const location = resticDriverLocation(
      this.#config,
      targetId,
      source.repository
    )
    return ensuringPromise(
      async () => {
        await this.#restic.dump({
          destination,
          file: DATABASE_DUMP_FILE,
          format: { compression: "gzip" },
          location,
          password,
          selector: source.snapshotId,
          signal,
        })
        return destination
      },
      () =>
        Effect.runPromise(
          cleanupResticCache(this.#config, this.#restic, {
            password,
            repository: source.repository,
            targetId,
          })
        )
    )
  }

  // What an incremental backup of a target takes a snapshot of.
  #snapshotSource(
    input: BackupCreateTaskInput,
    lockedApps: ReadonlySet<string>,
    window: StoppedWindow | null
  ) {
    return Effect.gen({ self: this }, function* () {
      const { target } = input
      if (target.kind === "volume") {
        return yield* this.#volumeSnapshotSource(input, lockedApps, window)
      }
      if (target.kind === "database") {
        if (!this.#databases) {
          return yield* backupFailure(
            "database_driver_unavailable",
            "create.database",
            "The database backup driver is unavailable"
          )
        }
        return databaseSnapshotSource(
          this.#config,
          this.#databases,
          input,
          input.consistency === "stopped" ? window : null
        )
      }
      if (target.kind === "instance") {
        const instance = yield* Effect.tryPromise({
          try: () => this.#findInstance(target.id),
          catch: (cause) =>
            RelayBackupError.make({
              code: "instance_lookup_failed",
              operation: "create.lookup",
              reason: "The backup target could not be loaded",
              cause,
            }),
        })
        if (!instance) {
          return yield* backupFailure(
            "instance_not_found",
            "create.lookup",
            "The backup target no longer exists on this Relay"
          )
        }
        return instanceSnapshotSource(
          this.#config,
          input,
          instance,
          yield* this.#state.listInstanceRoutes(target.id)
        )
      }
      return yield* backupFailure(
        "unsupported_backup",
        "create",
        "This Relay has no incremental backups of that"
      )
    })
  }

  #requiredVolume(id: string, restoring = false) {
    return Effect.gen({ self: this }, function* () {
      const volume = this.#volumes
        ? yield* this.#volumes.find(id).pipe(
            Effect.mapError((cause) =>
              RelayBackupError.make({
                code: "volume_lookup_failed",
                operation: "lookup",
                reason: backupErrorMessage(cause),
                cause,
              })
            )
          )
        : null
      // Only volumes Kiln manages have IDs to back up by; the Relay's own
      // data volume is the platform backup's.
      if (!volume || volume.kind === "relay") {
        return yield* backupFailure(
          "volume_not_found",
          "lookup",
          restoring
            ? "The volume no longer exists on this Relay; a backup restores only into the volume it was taken from"
            : "The volume no longer exists on this Relay"
        )
      }
      return volume
    })
  }

  // The Apps whose lifecycles a volume's stopped backup or restore holds:
  // its owner, and every App that uses it.
  #volumeApps(volumeId: string) {
    return Effect.gen({ self: this }, function* () {
      const volume = this.#volumes
        ? yield* this.#volumes.find(volumeId).pipe(
            Effect.mapError((cause) =>
              RelayBackupError.make({
                code: "volume_lookup_failed",
                operation: "lookup",
                reason: `The Apps using the volume couldn't be found: ${backupErrorMessage(cause)}`,
                cause,
              })
            )
          )
        : null
      return [...new Set(volume?.users.map((user) => user.appId) ?? [])]
    })
  }

  // The volume Apps a task's locks must hold, before it waits its turn.
  #lockedVolumeApps(
    input: BackupTaskInput
  ): Effect.Effect<ReadonlyArray<string>, RelayBackupError> {
    if (
      (input.kind === "create" &&
        input.target.kind === "volume" &&
        (input.consistency === "stopped" || input.reason === "final_delete")) ||
      (input.kind === "restore" && input.target.kind === "volume")
    ) {
      return this.#volumeApps(input.target.id)
    }
    return Effect.succeed([])
  }

  // Once a task has its locks, the Apps using its volume must still be ones
  // they hold: one that began using it while the task waited would start,
  // stop, or deploy beside it.
  #requireLockedApps(target: BackupTarget, lockedApps: ReadonlySet<string>) {
    return Effect.gen({ self: this }, function* () {
      if (target.kind !== "volume") return
      const apps = yield* this.#volumeApps(target.id)
      if (apps.some((appId) => !lockedApps.has(appId))) {
        return yield* backupFailure(
          "volume_users_changed",
          "lookup",
          "The Apps using this volume changed while the task waited its turn; run it again"
        )
      }
    })
  }

  // Stops each running App, journaling them first, with the power intent
  // each had, when they start again after. One that won't stop fails the
  // backup, and those stopped before it start again.
  #stopApps(taskId: string, apps: ReadonlyArray<string>, restart: boolean) {
    return Effect.gen({ self: this }, function* () {
      const running: Array<string> = []
      for (const appId of apps) {
        if (yield* promiseEffect(() => this.#apps!.isRunning(appId))) {
          running.push(appId)
        }
      }
      if (running.length === 0) return []
      const revisions = yield* this.#state.listAppPowerRevisions(running)
      const entries = running.map((appId): StoppedApp => ({
        appId,
        revision: revisions.get(appId) ?? 0,
      }))
      if (restart) yield* this.#journalStoppedApps(taskId, entries)
      const stopped: Array<StoppedApp> = []
      for (const entry of entries) {
        const result = yield* Effect.result(
          promiseEffect(() => this.#apps!.stop(entry.appId))
        )
        if (Result.isSuccess(result)) {
          stopped.push(entry)
          continue
        }
        // One whose stop failed may be partly stopped, so it starts again
        // with the others.
        if (restart) yield* this.#startApps(taskId, [...stopped, entry])
        return yield* Effect.fail(
          RelayBackupError.make({
            code: "app_stop_failed",
            operation: "create.stop",
            reason: `An App couldn't be stopped for the backup: ${backupErrorMessage(result.failure)}`,
            cause: result.failure,
          })
        )
      }
      return stopped
    })
  }

  // Starts Apps a backup stopped again, answering a warning for each that
  // won't. Those that won't stay journaled, for the Relay to start when it
  // next starts; the rest are forgotten, as is one whose power a person has
  // changed since.
  #startApps(taskId: string, apps: ReadonlyArray<StoppedApp>) {
    return Effect.gen({ self: this }, function* () {
      const warnings: Array<string> = []
      const unstarted: Array<StoppedApp> = []
      for (const entry of apps) {
        if (!(yield* this.#stillOwed(entry))) continue
        const started = yield* Effect.result(
          promiseEffect(() => this.#apps!.start(entry.appId))
        )
        if (Result.isFailure(started)) {
          unstarted.push(entry)
          warnings.push(
            backupWarning(
              `App ${entry.appId} couldn't be started again after the backup: ${backupErrorMessage(started.failure)}`
            )
          )
        }
      }
      yield* this.#keepStoppedApps(taskId, unstarted)
      return warnings
    })
  }

  /**
   * Starts, as the Relay starts, the Apps stopped backups still owe a
   * start, each in its lifecycle lane, unless a person has changed its
   * power since the backup stopped it: what they chose stands.
   */
  #restartStoppedApps() {
    return Effect.gen({ self: this }, function* () {
      if (!this.#apps) return
      for (const { apps, taskId } of yield* this.#readStoppedApps()) {
        const unstarted: Array<StoppedApp> = []
        for (const entry of apps) {
          const { appId } = entry
          // As a person's start does, it waits for any restore of a
          // volume the App mounts.
          yield* promiseEffect(() => this.#apps!.volumes(appId)).pipe(
            Effect.flatMap((volumes) =>
              this.#lanes.run(
                {
                  label: "backup.app.restart",
                  locks: appStartLocks(appId, volumes),
                },
                Effect.gen({ self: this }, function* () {
                  if (!(yield* this.#stillOwed(entry))) return
                  yield* promiseEffect(() => this.#apps!.start(appId))
                })
              )
            ),
            Effect.catch((cause) => {
              unstarted.push(entry)
              return Effect.logWarning(
                "An App a stopped backup stopped couldn't be started again",
                { appId, cause }
              )
            })
          )
        }
        yield* this.#keepStoppedApps(taskId, unstarted)
      }
    }).pipe(Effect.ignore)
  }

  // Whether a start is still owed: no one has changed the App's power since.
  #stillOwed(entry: StoppedApp) {
    return this.#state
      .listAppPowerRevisions([entry.appId])
      .pipe(
        Effect.map(
          (revisions) => (revisions.get(entry.appId) ?? 0) === entry.revision
        )
      )
  }

  #journalStoppedApps(taskId: string, apps: ReadonlyArray<StoppedApp>) {
    const directory = stoppedAppsDirectory(this.#config)
    return promiseEffect(async () => {
      await mkdir(directory, { mode: 0o700, recursive: true })
      await Effect.runPromise(
        writeFileAtomic(
          resolve(directory, `${taskId}.json`),
          `${JSON.stringify(apps)}\n`,
          0o600
        )
      )
    })
  }

  // Every task's journal of the Apps it stopped and still owes a start.
  #readStoppedApps() {
    const directory = stoppedAppsDirectory(this.#config)
    return Effect.gen(function* () {
      const names = yield* promiseEffect(async () => {
        await mkdir(directory, { mode: 0o700, recursive: true })
        return readdir(directory)
      })
      const journals: Array<{ apps: Array<StoppedApp>; taskId: string }> = []
      for (const name of names.sort()) {
        if (!name.endsWith(".json")) continue
        const text = yield* promiseEffect(() =>
          readFile(resolve(directory, name), "utf8")
        )
        const apps = Option.getOrElse(
          decodeStoppedApps(
            Result.getOrElse(
              Result.try((): unknown => JSON.parse(text)),
              () => null
            )
          ),
          () => []
        )
        journals.push({
          apps: [...apps],
          taskId: name.slice(0, -".json".length),
        })
      }
      return journals
    })
  }

  // Keeps only the Apps a task still owes a start, forgetting it once none.
  #keepStoppedApps(taskId: string, apps: ReadonlyArray<StoppedApp>) {
    if (apps.length > 0) {
      return this.#journalStoppedApps(taskId, apps).pipe(Effect.ignore)
    }
    return promiseEffect(() =>
      rm(resolve(stoppedAppsDirectory(this.#config), `${taskId}.json`), {
        force: true,
      })
    ).pipe(Effect.ignore)
  }

  /**
   * Settles every restore of a volume a stop or a failed
   * swap left unfinished, as the Relay starts. One that can't finish now,
   * as when something runs on its target, keeps it fenced.
   */
  #recoverTarRestores() {
    return Effect.gen({ self: this }, function* () {
      yield* promiseEffect(() =>
        removeLeftoverTarHelpers(this.#config, this.#engine)
      )
      const journals = yield* promiseEffect(() =>
        readTarRestoreJournals(this.#config)
      )
      for (const journal of journals) {
        yield* this.#settleTarRestore(journal, "finish", false).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "An unfinished volume restore couldn't be settled; its target stays fenced",
              { cause, taskId: journal.taskId }
            )
          )
        )
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Couldn't settle unfinished volume restores", {
          cause,
        })
      )
    )
  }

  /**
   * Finishes or abandons one unfinished restore, holding the locks its
   * restore held, with nothing running on its target: Apps running on it
   * are stopped when `stopApps`, as when someone asks for it, or keep it
   * from finishing; any other container keeps it from finishing.
   */
  #settleTarRestore(
    journal: TarRestoreJournal,
    action: "abandon" | "finish",
    stopApps: boolean
  ) {
    return Effect.gen({ self: this }, function* () {
      const { target } = journal
      const apps = new Set([
        ...journal.consumers,
        ...(yield* this.#volumeApps(target.id)),
      ])
      const locks: ReadonlyArray<LaneLock> = [
        exclusive(laneKeys.volume(target.id)),
        ...[...apps].flatMap((appId) => appLifecycleLocks(appId)),
      ]
      yield* this.#lanes.run(
        { label: TAR_RESTORE_RECOVERY_LABEL, locks },
        Effect.gen({ self: this }, function* () {
          // The discovery read only chose the locks. Another recovery may
          // have advanced or removed the journal while this one waited.
          const current = yield* promiseEffect(() =>
            readTarRestoreJournal(this.#config, journal.taskId)
          )
          if (!current) return
          if (
            current.target.kind !== target.kind ||
            current.target.id !== target.id ||
            JSON.stringify(current.source) !== JSON.stringify(journal.source) ||
            current.consumers.some((id) => !journal.consumers.includes(id))
          ) {
            return yield* backupFailure(
              "restore_journal_changed",
              "restore.resolve",
              "The restore target changed while waiting for its recovery locks"
            )
          }
          journal = current
          if (action === "abandon") {
            yield* promiseEffect(() =>
              abandonTarRestore(
                this.#config,
                this.#engine,
                journal,
                this.#fences
              )
            )
            yield* this.#state.failBackupTask(
              journal.taskId,
              "The restore was abandoned partway; its target keeps what it held then",
              Date.now()
            )
            return
          }
          if (journal.phase !== "staging") {
            yield* this.#quietTarTarget(journal, stopApps)
          }
          const finished = yield* promiseEffect(() =>
            finishTarRestore(this.#config, this.#engine, journal, this.#fences)
          )
          if (finished) {
            const task = yield* this.#state.getBackupTask(journal.taskId)
            const how = stopApps
              ? "Finished when asked, after its swap stopped"
              : null
            // restic sets those last, which finishing the swap doesn't.
            const warning =
              task?.input.kind === "restore" &&
              task.input.source.kind === "restic"
                ? `${how ?? "Finished after the Relay restarted"}. The volume's own folder keeps the extended attributes it had`
                : how
            yield* this.#state.completeRecoveredRestore(
              journal.taskId,
              Date.now(),
              warning
            )
          }
        })
      )
    })
  }

  // Nothing may run on a restore's target while it's swapped in.
  #quietTarTarget(journal: TarRestoreJournal, stopApps: boolean) {
    return Effect.gen({ self: this }, function* () {
      const { target } = journal
      if (!this.#apps) {
        return yield* backupFailure(
          "app_driver_unavailable",
          "lookup",
          "The App backup driver is unavailable"
        )
      }
      const runningApps: Array<string> = []
      const others: Array<string> = []
      const volume = yield* this.#requiredVolume(target.id, true)
      for (const mount of volume.mounts) {
        if (!mount.running) continue
        if (mount.kind === "app" && mount.resourceId) {
          runningApps.push(mount.resourceId)
        } else others.push(mount.container)
      }
      if (others.length > 0) {
        return yield* backupFailure(
          "volume_in_use",
          "restore.recover",
          `Stop ${others[0]!}, which mounts this volume, so its restore can finish`
        )
      }
      if (runningApps.length === 0) return
      if (!stopApps) {
        return yield* backupFailure(
          "app_running",
          "restore.recover",
          "An App runs on what the restore was swapping in; stop it so the restore can finish"
        )
      }
      for (const appId of new Set(runningApps)) {
        yield* promiseEffect(() => this.#apps!.stop(appId))
      }
    })
  }

  #execute(
    task: RelayBackupTask,
    signal: AbortSignal,
    beginInstall: RestoreInstallGate,
    lockedApps: ReadonlySet<string>,
    window: StoppedWindow | null
  ) {
    return Effect.gen({ self: this }, function* () {
      const createSignal = signal
      if (task.input.kind === "export") {
        const result = yield* runResticExport(
          this.#config,
          this.#restic,
          task.input,
          task.taskId,
          (progress) =>
            this.#state.updateBackupTaskProgress(
              task.taskId,
              progress.completed,
              progress.total,
              progress.phase,
              progress.currentPath,
              progress.currentArtifactId,
              Date.now()
            ),
          createSignal
        )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          Date.now()
        )
        if (!completed) {
          return yield* backupFailure(
            "task_state_changed",
            "export.complete",
            "The backup task was no longer running when export completed"
          )
        }
        return
      }
      if (task.input.kind === "prune") {
        yield* runResticPrune(
          this.#config,
          this.#restic,
          task.input,
          (progress) =>
            this.#state.updateBackupTaskProgress(
              task.taskId,
              progress.completed,
              progress.total,
              progress.phase,
              progress.currentPath,
              progress.currentArtifactId,
              Date.now()
            ),
          createSignal
        )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          { warnings: [] },
          Date.now()
        )
        if (!completed) {
          return yield* backupFailure(
            "task_state_changed",
            "prune.complete",
            "The backup task was no longer running when prune completed"
          )
        }
        return
      }
      if (task.input.kind === "restore") {
        const input = task.input
        const target = input.target
        if (target.kind === "volume") {
          const result = yield* this.#restoreTar(
            { ...input, target: { ...target, kind: target.kind } },
            signal,
            beginInstall,
            lockedApps
          )
          const completed = yield* this.#state.completeBackupTask(
            task.taskId,
            result,
            Date.now()
          )
          if (!completed) {
            return yield* backupFailure(
              "task_state_changed",
              "restore.complete",
              "The backup task was no longer running when restore completed"
            )
          }
          return
        }
        if (input.target.kind === "database") {
          if (!this.#databases) {
            return yield* backupFailure(
              "database_driver_unavailable",
              "restore.lookup",
              "The database backup driver is unavailable"
            )
          }
          const temporary = resolve(
            this.#config.dataDirectory,
            "restores",
            `${input.taskId}.dmp.gz`
          )
          const artifact = yield* Effect.tryPromise({
            try: () =>
              input.source.kind === "restic"
                ? this.#dumpSnapshotFile(input, temporary, signal)
                : materializeBackupArtifact(this.#config, input, temporary),
            catch: (cause) =>
              RelayBackupError.make({
                code: "database_restore_download_failed",
                operation: "restore.database.verify",
                reason: backupErrorMessage(cause),
                cause,
              }),
          }).pipe(Effect.withSpan("Backups.restore.fetch"))
          const result = yield* Effect.tryPromise({
            try: () =>
              restoreCompressedDatabaseBackup(
                this.#databases!,
                input.target.id,
                artifact
              ),
            catch: (cause) =>
              cause instanceof RelayBackupError
                ? cause
                : RelayBackupError.make({
                    code: "database_restore_failed",
                    operation: "restore.database",
                    reason: backupErrorMessage(cause),
                    cause,
                  }),
          }).pipe(
            Effect.withSpan("Backups.database.import"),
            Effect.ensuring(
              // A local archive is restored where it's kept, not from here.
              promiseEffect(() => rm(temporary, { force: true })).pipe(
                Effect.ignore
              )
            )
          )
          const completed = yield* this.#state.completeBackupTask(
            task.taskId,
            result,
            Date.now()
          )
          if (!completed) {
            return yield* backupFailure(
              "task_state_changed",
              "restore.complete",
              "The backup task was no longer running when restore completed"
            )
          }
          return
        }
        if (input.target.kind !== "instance") {
          return yield* backupFailure(
            "unsupported_restore",
            "restore",
            "This Relay currently supports instance archive restores"
          )
        }
        const instance = yield* Effect.tryPromise({
          try: () => this.#findInstance(input.target.id),
          catch: (cause) =>
            RelayBackupError.make({
              code: "instance_lookup_failed",
              operation: "restore.lookup",
              reason: "The restore target could not be loaded",
              cause,
            }),
        })
        if (!instance) {
          return yield* backupFailure(
            "instance_not_found",
            "restore.lookup",
            "The restore target no longer exists on this Relay"
          )
        }
        const stopped = yield* Effect.tryPromise({
          try: () => this.#isInstanceStopped(input.target.id),
          catch: (cause) =>
            RelayBackupError.make({
              code: "instance_state_failed",
              operation: "restore.preflight",
              reason: "The Relay could not verify the server power state",
              cause,
            }),
        })
        if (!stopped) {
          return yield* backupFailure(
            "instance_running",
            "restore.preflight",
            "Stop the server before restoring a backup"
          )
        }
        const result = yield* (
          input.source.kind === "restic"
            ? runResticRestore(
                this.#config,
                this.#restic,
                input,
                instance,
                createSignal,
                beginInstall
              )
            : Effect.tryPromise({
                try: () =>
                  restorePortableInstanceBackup(
                    this.#config,
                    { ...input, kind: "restore" },
                    instance,
                    beginInstall
                  ),
                catch: (cause) =>
                  cause instanceof RelayBackupError
                    ? cause
                    : RelayBackupError.make({
                        code: "restore_failed",
                        operation: "restore",
                        reason: backupErrorMessage(cause),
                        cause,
                      }),
              })
        ).pipe(
          Effect.withSpan("Backups.restore.files", {
            attributes: {
              // Made as another backup, or of another server.
              "backup.restore.source_differs": input.archive !== undefined,
            },
          })
        )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          Date.now()
        )
        if (!completed) {
          return yield* backupFailure(
            "task_state_changed",
            "restore.complete",
            "The backup task was no longer running when restore completed"
          )
        }
        return
      }
      if (task.input.kind === "delete") {
        let deleteUpdatedAt = Date.now() - 1
        const nextDeleteUpdatedAt = () => {
          deleteUpdatedAt = Math.max(Date.now(), deleteUpdatedAt + 1)
          return deleteUpdatedAt
        }
        const { prune, result } =
          task.input.destination.kind === "restic"
            ? yield* runResticForget(
                this.#config,
                this.#restic,
                task.input,
                createSignal
              )
            : {
                prune: undefined,
                result: yield* deleteBackupArtifacts(
                  this.#config,
                  task.input,
                  (currentArtifactId, progress) =>
                    this.#state.updateBackupTaskOperationProgress(
                      task.taskId,
                      currentArtifactId,
                      progress,
                      nextDeleteUpdatedAt()
                    )
                ),
              }
        // The forgotten snapshot's data goes in one prune shared with the
        // repository's other deletes; see `scheduleBackupPrune`.
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          nextDeleteUpdatedAt(),
          prune
        )
        if (!completed) {
          return yield* backupFailure(
            "task_state_changed",
            "delete.complete",
            "The backup task was no longer running when deletion completed"
          )
        }
        return
      }
      const input = task.input
      if (input.artifactKind === "tar_archive" && input.mode === "full") {
        const result = yield* this.#createTar(
          task.taskId,
          input,
          signal,
          lockedApps,
          window
        )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          Date.now()
        )
        if (!completed) {
          yield* promiseEffect(() =>
            rm(backupArchivePath(this.#config, input.backupId), { force: true })
          ).pipe(Effect.ignore)
          return yield* backupFailure(
            "task_state_changed",
            "create.complete",
            "The backup task was no longer running when the archive completed"
          )
        }
        return
      }
      if (
        input.target.kind === "platform" &&
        input.artifactKind === "platform_bundle" &&
        input.mode === "full"
      ) {
        const progress: BackupProgress = {
          completed: 0,
          currentArtifactId: null,
          currentPath: null,
          phase: "preparing",
          total: 0,
        }
        const progressFiber = yield* Effect.forkChild(
          Effect.sleep("500 millis").pipe(
            Effect.andThen(
              Effect.suspend(() =>
                this.#state
                  .updateBackupTaskProgress(
                    task.taskId,
                    progress.completed,
                    progress.total || null,
                    progress.phase,
                    progress.currentPath,
                    progress.currentArtifactId,
                    Date.now()
                  )
                  .pipe(Effect.asVoid)
              )
            ),
            Effect.forever
          )
        )
        const destination = backupArchivePath(this.#config, input.backupId)
        yield* promiseEffect(() =>
          mkdir(backupDirectoryPath(this.#config), {
            recursive: true,
            mode: 0o700,
          })
        )
        yield* promiseEffect(() => rm(destination, { force: true }))
        progress.phase = "dumping"
        const platformFailure = (cause: unknown) =>
          RelayBackupError.make({
            code: "platform_backup_failed",
            operation: "create.platform",
            reason: backupErrorMessage(cause),
            cause,
          })
        // Holding the lock, so a restore on the host, by another process,
        // isn't dumped partway and kept as a whole backup.
        const result = yield* withPlatformLock(
          this.#config.dataDirectory,
          Effect.gen({ self: this }, function* () {
            if (yield* restoreUnfinished(this.#config, this.#state)) {
              return yield* new PlatformError({
                reason:
                  "A restore of Kiln hasn't finished, so there may be only part of its database. Run it again first.",
              })
            }
            const [key, recovery] = yield* Effect.all([
              platformBackupKey(this.#config, this.#state),
              collectPlatformRecovery(this.#config, this.#state),
            ])
            return yield* Effect.tryPromise({
              try: () =>
                createEncryptedPlatformBackup(
                  { ...this.#config, platformBackupKey: key },
                  input,
                  destination,
                  progress,
                  createSignal,
                  recovery
                ),
              catch: (cause) => cause,
            })
          })
        ).pipe(
          Effect.mapError(platformFailure),
          Effect.withSpan("Backups.platform.dump"),
          Effect.flatMap((created) =>
            storeCreatedBackup(
              this.#config,
              input,
              created,
              progress,
              createSignal
            )
          ),
          Effect.onError(() =>
            promiseEffect(() => rm(destination, { force: true })).pipe(
              Effect.ignore
            )
          ),
          Effect.ensuring(Fiber.interrupt(progressFiber))
        )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          Date.now()
        )
        if (!completed) {
          yield* promiseEffect(() => rm(destination, { force: true })).pipe(
            Effect.ignore
          )
          return yield* backupFailure(
            "task_state_changed",
            "create.complete",
            "The backup task was no longer running when the platform bundle completed"
          )
        }
        return
      }
      if (
        input.target.kind === "database" &&
        input.artifactKind === "database_dump" &&
        input.mode === "full"
      ) {
        if (!this.#databases) {
          return yield* backupFailure(
            "database_driver_unavailable",
            "create.database",
            "The database backup driver is unavailable"
          )
        }
        // In a stopped batch, it is dumped within the batch's window: once
        // every App that uses the batch's volumes is stopped, so it and
        // their archives are taken while those Apps write nothing. The
        // window starts them again when the last of the batch has left.
        if (window && input.consistency === "stopped") {
          yield* window.begin(task.taskId)
        }
        const progress: BackupProgress = {
          completed: 0,
          currentArtifactId: null,
          currentPath: null,
          phase: "dumping",
          total: 0,
        }
        const progressFiber = yield* Effect.forkChild(
          Effect.sleep("500 millis").pipe(
            Effect.andThen(
              Effect.suspend(() =>
                this.#state
                  .updateBackupTaskProgress(
                    task.taskId,
                    progress.completed,
                    progress.total || null,
                    progress.phase,
                    progress.currentPath,
                    progress.currentArtifactId,
                    Date.now()
                  )
                  .pipe(Effect.asVoid)
              )
            ),
            Effect.forever
          )
        )
        const destination = backupArchivePath(this.#config, input.backupId)
        yield* promiseEffect(() =>
          mkdir(backupDirectoryPath(this.#config), {
            recursive: true,
            mode: 0o700,
          })
        )
        yield* promiseEffect(() => rm(destination, { force: true }))
        const result = yield* Effect.tryPromise({
          try: () =>
            createCompressedDatabaseBackup(
              this.#databases!,
              input,
              destination,
              progress,
              createSignal
            ),
          catch: (cause) =>
            RelayBackupError.make({
              code: "database_backup_failed",
              operation: "create.database",
              reason: backupErrorMessage(cause),
              cause,
            }),
        }).pipe(
          Effect.withSpan("Backups.database.dump"),
          // In a batch's window it waits, its dump taken, until every
          // archive of the batch is, as each of them does: none is finished
          // before all are taken, so a Relay that stops midway runs the
          // whole batch again rather than part of it in another window.
          // What starting the Apps again left to say is said on it too.
          Effect.flatMap((created) =>
            window && input.consistency === "stopped"
              ? window.arrive(task.taskId).pipe(
                  Effect.map((restarted) => ({
                    ...created,
                    warnings: [...created.warnings, ...restarted],
                  }))
                )
              : Effect.succeed(created)
          ),
          Effect.flatMap((created) =>
            storeCreatedBackup(
              this.#config,
              input,
              created,
              progress,
              createSignal
            )
          ),
          Effect.onError(() =>
            promiseEffect(() => rm(destination, { force: true })).pipe(
              Effect.ignore
            )
          ),
          Effect.ensuring(Fiber.interrupt(progressFiber))
        )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          Date.now()
        )
        if (!completed) {
          yield* promiseEffect(() => rm(destination, { force: true })).pipe(
            Effect.ignore
          )
          return yield* backupFailure(
            "task_state_changed",
            "create.complete",
            "The backup task was no longer running when the dump completed"
          )
        }
        return
      }
      if (
        input.destination.kind === "restic" &&
        input.mode === "incremental" &&
        input.artifactKind === "restic_snapshot"
      ) {
        const destination = input.destination
        const result = yield* runResticCreate(
          this.#config,
          this.#restic,
          yield* this.#snapshotSource(input, lockedApps, window),
          input,
          (progress) =>
            this.#state.updateBackupTaskProgress(
              task.taskId,
              progress.completed,
              progress.total || null,
              progress.phase,
              progress.currentPath,
              progress.currentArtifactId,
              Date.now()
            ),
          createSignal
        ).pipe(
          // Data a failed backup uploaded belongs to no snapshot; prune it,
          // unless storage or the repository itself refused the work, which
          // a prune would hit too.
          Effect.tapError((cause) =>
            destination.repositoryPassword &&
            !refusedByStorage(backupFailureCode(cause))
              ? this.#state.scheduleBackupPrune(
                  resticPruneFor(this.#config, {
                    repository: destination.repository,
                    repositoryPassword: destination.repositoryPassword,
                    target: input.target,
                  }),
                  Date.now()
                )
              : Effect.void
          )
        )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          Date.now()
        )
        if (!completed) {
          const cleaned = yield* Effect.result(
            runResticForget(
              this.#config,
              this.#restic,
              {
                backupId: input.backupId,
                destination: {
                  ...input.destination,
                  snapshotId: result.snapshotId,
                },
                kind: "delete",
                target: input.target,
                taskId: randomUUID(),
              },
              AbortSignal.timeout(RESTIC_RECOVERY_TIMEOUT_MS)
            ).pipe(
              Effect.flatMap(({ prune }) =>
                prune
                  ? this.#state.scheduleBackupPrune(prune, Date.now())
                  : Effect.void
              )
            )
          )
          if (Result.isFailure(cleaned)) {
            yield* Effect.logError(
              "Could not forget a restic snapshot completed after cancellation",
              {
                backupId: input.backupId,
                cause: cleaned.failure,
                snapshotId: result.snapshotId,
                taskId: task.taskId,
              }
            )
          }
          return yield* backupFailure(
            "task_state_changed",
            "create.complete",
            "The backup task was no longer running when the snapshot completed"
          )
        }
        return
      }
      if (
        input.target.kind !== "instance" ||
        input.artifactKind !== "archive" ||
        input.mode !== "full"
      ) {
        return yield* backupFailure(
          "unsupported_backup",
          "create",
          "This Relay currently supports full instance archives"
        )
      }
      const instance = yield* Effect.tryPromise({
        try: () => this.#findInstance(input.target.id),
        catch: (cause) =>
          RelayBackupError.make({
            code: "instance_lookup_failed",
            operation: "create.lookup",
            reason: "The backup target could not be loaded",
            cause,
          }),
      })
      if (!instance) {
        return yield* backupFailure(
          "instance_not_found",
          "create.lookup",
          "The backup target no longer exists on this Relay"
        )
      }

      const progress: BackupProgress = {
        completed: 0,
        currentArtifactId: null,
        currentPath: null,
        phase: "preparing",
        total: 0,
      }
      const progressFiber = yield* Effect.forkChild(
        Effect.sleep("500 millis").pipe(
          Effect.andThen(
            Effect.suspend(() =>
              this.#state
                .updateBackupTaskProgress(
                  task.taskId,
                  progress.completed,
                  progress.total || null,
                  progress.phase,
                  progress.currentPath,
                  progress.currentArtifactId,
                  Date.now()
                )
                .pipe(Effect.asVoid)
            )
          ),
          Effect.forever
        )
      )
      const result = yield* Effect.tryPromise({
        try: async () =>
          createPortableInstanceBackup(
            this.#config,
            input,
            instance,
            progress,
            createSignal,
            await Effect.runPromise(this.#state.listInstanceRoutes(instance.id))
          ),
        catch: (cause) =>
          cause instanceof RelayBackupError
            ? cause
            : RelayBackupError.make({
                code: "archive_failed",
                operation: "create.archive",
                reason: backupErrorMessage(cause),
                cause,
              }),
      }).pipe(
        Effect.tap((archived) =>
          Effect.annotateCurrentSpan({
            "backup.bytes": archived.bytes,
            "backup.warnings": archived.warnings.length,
          })
        ),
        Effect.withSpan("Backups.archive"),
        Effect.flatMap((archived) =>
          storeCreatedBackup(
            this.#config,
            input,
            archived,
            progress,
            createSignal
          )
        ),
        Effect.onError(() =>
          promiseEffect(() =>
            rm(backupArchivePath(this.#config, input.backupId), { force: true })
          ).pipe(Effect.ignore)
        ),
        Effect.ensuring(Fiber.interrupt(progressFiber))
      )
      const completed = yield* this.#state.completeBackupTask(
        task.taskId,
        result,
        Date.now()
      )
      if (!completed) {
        yield* promiseEffect(() =>
          rm(backupArchivePath(this.#config, input.backupId), { force: true })
        ).pipe(Effect.ignore)
        return yield* backupFailure(
          "task_state_changed",
          "create.complete",
          "The backup task was no longer running when the archive completed"
        )
      }
    })
  }
}

/**
 * The stopped window a batch's backups share: `begin` waits until every one
 * of them is ready, then stops what uses any of them, once; `arrive` waits, once a backup's archive is taken, until
 * every backup's is, then answers the warnings starting things again left;
 * `leave` counts a backup that won't arrive, as one that failed first.
 */
interface StoppedWindow {
  readonly arrive: (taskId: string) => Effect.Effect<ReadonlyArray<string>>
  readonly begin: (taskId: string) => Effect.Effect<void, unknown>
  readonly leave: (taskId: string) => Effect.Effect<void>
  readonly lockedApps: ReadonlySet<string>
}

// The batch a claimed task opens a stopped window for, if any.
function stoppedBatch(
  task: RelayBackupTask
): { id: string; size: number } | null {
  return task.input.kind === "create" &&
    task.input.consistency === "stopped" &&
    task.input.batch
    ? task.input.batch
    : null
}

/**
 * An App a stopped backup stopped, with the revision of its power intent
 * then: a start is owed only while no one has changed its power since.
 */
const StoppedAppSchema = Schema.Struct({
  appId: Schema.String,
  revision: Schema.Number,
})
type StoppedApp = typeof StoppedAppSchema.Type
const decodeStoppedApps = Schema.decodeUnknownOption(
  Schema.Array(StoppedAppSchema)
)

// Where a stopped backup records the Apps it stopped, by task.
function stoppedAppsDirectory(config: RelayConfig): string {
  return resolve(config.dataDirectory, "backup-state", "stopped")
}

// The most a full archive may take: the task's own limit, and each
// destination's.
function archiveMaximumBytes(input: BackupCreateTaskInput): number | null {
  return [input.destination, ...(input.replicas ?? [])].reduce<number | null>(
    (limit, destination) => {
      if (destination.kind === "restic") return limit
      const destinationLimit = backupDestinationFor(
        destination.kind
      ).maximumFullBackupBytes
      if (destinationLimit === null) return limit
      return Math.min(limit ?? destinationLimit, destinationLimit)
    },
    input.maxBytes
  )
}

async function createPortableInstanceBackup(
  config: RelayConfig,
  input: BackupCreateTaskInput,
  instance: RelayInstanceConfig,
  progress: BackupProgress,
  signal: AbortSignal,
  webRoutes: ReadonlyArray<RelayInstanceWebRoute>
): Promise<BackupArchiveCreateTaskResult> {
  signal.throwIfAborted()
  const configuredRoot = await realpath(config.rootDirectory)
  const instanceRoot = await realpath(
    resolve(configuredRoot, instance.directory)
  )
  requireContained(configuredRoot, instanceRoot)
  const backupDirectory = backupDirectoryPath(config)
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
  const destination = backupArchivePath(config, input.backupId)
  const maximumBytes = archiveMaximumBytes(input)
  const patterns = [...DEFAULT_EXCLUDES, ...input.exclude]
  let warnings: Array<string> = []

  await cleanupBackupPartials(backupDirectory, input.backupId)
  await rm(destination, { force: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporary = resolve(
      backupDirectory,
      `.${input.backupId}.${randomUUID()}.partial`
    )
    const result = await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          progress.phase = "collecting"
          progress.currentPath = null
          const collected = await collectBackupEntries(
            instanceRoot,
            patterns,
            progress,
            signal
          )
          signal.throwIfAborted()
          progress.completed = 0
          progress.total = collected.entries.reduce(
            (total, entry) => total + entry.size,
            0
          )
          await requireBackupSpace(
            backupDirectory,
            progress.total,
            maximumBytes
          )
          const manifest = await instanceBackupManifest(
            config,
            input,
            instance,
            webRoutes
          )
          const written = await writeBackupArchive(
            temporary,
            collected.entries,
            maximumBytes,
            progress,
            signal,
            manifest
          )
          warnings = [...collected.warnings, ...written.warnings]
          if (written.changed.length > 0 && attempt === 0) {
            return null
          }
          if (written.changed.length > 0) {
            warnings.push(
              backupWarning(
                `${written.changed.length} file${written.changed.length === 1 ? "" : "s"} changed while being archived: ${written.changed.slice(0, 10).join(", ")}`
              )
            )
          }
          progress.phase = "finalizing"
          progress.currentPath = null
          signal.throwIfAborted()
          await rename(temporary, destination)
          return {
            bytes: written.bytes,
            checksumSha256: written.checksumSha256,
            filename: backupArtifactFilename(input.backupId, "archive"),
            warnings: warnings.slice(0, 1_000),
          } satisfies BackupArchiveCreateTaskResult
        },
        catch: (cause) =>
          cause instanceof RelayBackupError
            ? cause
            : RelayBackupError.make({
                code: "archive_failed",
                operation: "create.archive",
                reason: backupErrorMessage(cause),
                cause,
              }),
      }).pipe(
        Effect.ensuring(
          promiseEffect(() => rm(temporary, { force: true })).pipe(
            Effect.ignore
          )
        )
      )
    )
    if (result) return result
  }
  throw RelayBackupError.make({
    code: "archive_failed",
    operation: "create.archive",
    reason: "The archive could not be completed",
  })
}

// A route as the manifest records it: the options it adds to the format
// older Relays read appear only when set, and a route without a label is
// named for its hostname, as those Relays require.
function backupWebRoute(route: RelayInstanceWebRoute) {
  return {
    hostname: route.hostname,
    id: route.id,
    name: route.name || route.hostname.slice(0, 32),
    path: route.path,
    stripPrefix: route.stripPrefix,
    targetPort: route.targetPort,
    ...(route.httpsRedirect ? {} : { httpsRedirect: false as const }),
    ...(route.redirect ? { redirect: route.redirect } : {}),
    ...(route.www === "none" ? {} : { www: route.www }),
  }
}

/** What a game server is set up as, kept with its files in each backup. */
async function instanceBackupSetup(
  config: RelayConfig,
  instance: RelayInstanceConfig,
  webRoutes: ReadonlyArray<RelayInstanceWebRoute>
): Promise<Extract<BackupArchiveManifest, { formatVersion: 3 }>["server"]> {
  // As it is on disk, so a restore keeps the checksum that names it.
  const recipe = instance.brickSnapshotSha256
    ? await readRecordedBrickSnapshot(
        brickSnapshotDirectory(config.dataDirectory),
        instance.brickSnapshotSha256
      )
    : null
  return {
    brick: {
      consoleStopCommands: [...(instance.brickConsoleStopCommands ?? [])],
      format: instance.brickFormat ?? null,
      id: instance.brickId ?? null,
      networkMode: instance.brickNetworkMode ?? null,
      primaryPort: instance.brickPrimaryPort ?? null,
      primaryPortProtocol: instance.brickPrimaryPortProtocol ?? null,
      readiness: instance.brickReadiness ?? null,
      recipe,
      snapshotSha256: instance.brickSnapshotSha256 ?? null,
      source: instance.brickSource ?? null,
      supportsSrv: instance.brickSupportsSrv ?? false,
    },
    game: instance.game,
    implementation: instance.implementation,
    javaVersion: instance.javaVersion,
    name: instance.name,
    network: {
      connectAddress: instance.connectAddress,
      ports: instance.ports,
      publicHost: instance.publicHost ?? null,
      publicPort: instance.publicPort ?? null,
      webRoutes: webRoutes.map(backupWebRoute),
    },
    startup: {
      // Backups keep the format older Relays restore, where 0 is no limit.
      limits: {
        diskBytes: instance.limits.diskBytes ?? 0,
        memoryBytes: instance.limits.memoryBytes ?? 0,
      },
      variables: instance.variables ?? {},
    },
    version: instance.version,
  }
}

async function instanceBackupManifest(
  config: RelayConfig,
  input: BackupCreateTaskInput,
  instance: RelayInstanceConfig,
  webRoutes: ReadonlyArray<RelayInstanceWebRoute>
): Promise<BackupArchiveManifest> {
  return {
    artifactKind: "archive",
    backupId: input.backupId,
    createdAt: new Date().toISOString(),
    formatVersion: 3,
    mode: "full",
    server: await instanceBackupSetup(config, instance, webRoutes),
    target: input.target,
  }
}

function storeCreatedBackup(
  config: RelayConfig,
  input: BackupCreateTaskInput,
  result: BackupArchiveCreateTaskResult,
  progress: BackupProgress,
  signal: AbortSignal
) {
  return Effect.gen(function* () {
    progress.phase = "uploading"
    progress.currentArtifactId = null
    progress.currentPath = null
    const destinations = [input.destination, ...(input.replicas ?? [])]
    progress.completed = 0
    progress.total = result.bytes
    const outcomes: NonNullable<BackupArchiveCreateTaskResult["artifacts"]> = []
    let available = 0
    let lastFailure: unknown = null
    let lastUploadedArtifactId: string | null = null
    for (const destination of destinations) {
      signal.throwIfAborted()
      if (destination.kind === "restic") continue
      progress.completed = 0
      progress.currentArtifactId = destination.artifactId ?? null
      const uploaded = yield* Effect.result(
        destination.kind === "s3"
          ? uploadBackupArtifact(
              config,
              { ...input, destination },
              result,
              signal,
              (bytes) => {
                progress.completed = Math.min(
                  progress.total,
                  progress.completed + bytes
                )
              }
            )
          : backupDestinationFor("local").saveFullBackup({
              backupId: input.backupId,
              config,
              destination,
              onChunk: (bytes) => {
                progress.completed = Math.min(
                  progress.total,
                  progress.completed + bytes
                )
              },
              result,
              signal,
            })
      )
      if (Result.isSuccess(uploaded)) {
        available += 1
        progress.completed = progress.total
        lastUploadedArtifactId = destination.artifactId ?? null
        if (destination.artifactId) {
          outcomes.push({
            artifactId: destination.artifactId,
            error: null,
            status: "available",
          })
        }
      } else if (destination.artifactId) {
        outcomes.push({
          artifactId: destination.artifactId,
          error: backupErrorMessage(uploaded.failure),
          errorCode: backupFailureCode(uploaded.failure),
          status: "failed",
        })
      }
      if (Result.isFailure(uploaded)) lastFailure = uploaded.failure
    }
    if (
      !destinations.some(
        (destination) =>
          destination.kind !== "restic" &&
          backupDestinationFor(destination.kind).retainsFullBackupLocally
      )
    ) {
      yield* promiseEffect(() =>
        rm(backupArchivePath(config, input.backupId), { force: true })
      ).pipe(Effect.ignore)
    }
    if (available === 0) {
      // Says why, so the task is classified by the destination's failure.
      return yield* RelayBackupError.make({
        code: "backup_storage_failed",
        operation: "create.store",
        reason: `The backup archive could not be stored in any destination: ${backupErrorMessage(lastFailure)}`,
        cause: lastFailure,
      })
    }
    signal.throwIfAborted()
    progress.phase = "finalizing"
    progress.currentArtifactId = lastUploadedArtifactId
    yield* Effect.annotateCurrentSpan({
      "backup.artifacts.stored": available,
      "backup.artifacts.failed": outcomes.length - available,
    })
    return { ...result, artifacts: outcomes }
  }).pipe(
    Effect.withSpan("Backups.store", {
      attributes: {
        "backup.bytes": result.bytes,
        "backup.destinations": 1 + (input.replicas?.length ?? 0),
      },
    })
  )
}

function uploadBackupArtifact(
  config: RelayConfig,
  input: BackupCreateTaskInput & {
    destination: Extract<BackupCreateTaskInput["destination"], { kind: "s3" }>
  },
  result: BackupArchiveCreateTaskResult,
  signal: AbortSignal,
  onChunk: (bytes: number) => void
) {
  return backupDestinationFor("s3")
    .saveFullBackup({
      backupId: input.backupId,
      config,
      destination: input.destination,
      onChunk,
      result,
      signal,
    })
    .pipe(
      Effect.withSpan("Backups.upload", {
        attributes: {
          "backup.artifact.id": input.destination.artifactId ?? null,
          "backup.bytes": result.bytes,
          "backup.storage.kind": "s3",
        },
      })
    )
}

function deleteBackupArtifacts(
  config: RelayConfig,
  input: BackupDeleteTaskInput & { kind: "delete" },
  updateProgress: (
    currentArtifactId: string | null,
    result: BackupOperationTaskResult
  ) => ReturnType<
    RelayStateStore["Service"]["updateBackupTaskOperationProgress"]
  >
) {
  return Effect.gen(function* () {
    const outcomes: NonNullable<BackupOperationTaskResult["artifacts"]> = []
    for (const destination of [input.destination, ...(input.replicas ?? [])]) {
      const currentArtifactId = destination.artifactId ?? null
      const started = yield* updateProgress(currentArtifactId, {
        artifacts: [...outcomes],
        warnings: [],
      })
      if (!started) {
        return yield* backupFailure(
          "task_state_changed",
          "delete.progress",
          "The backup task was no longer running while deletion was in progress"
        )
      }
      const deleted = yield* Effect.result(
        deleteBackupArtifact(config, { ...input, destination })
      )
      if (!destination.artifactId) {
        if (Result.isFailure(deleted)) {
          return yield* backupFailure(
            "backup_delete_failed",
            "delete",
            backupErrorMessage(deleted.failure)
          )
        }
        continue
      }
      outcomes.push(
        Result.isSuccess(deleted)
          ? {
              artifactId: destination.artifactId,
              error: null,
              status: "deleted",
            }
          : {
              artifactId: destination.artifactId,
              error: backupErrorMessage(deleted.failure),
              errorCode: backupFailureCode(deleted.failure),
              status: "failed",
            }
      )
      const updated = yield* updateProgress(currentArtifactId, {
        artifacts: [...outcomes],
        warnings: [],
      })
      if (!updated) {
        return yield* backupFailure(
          "task_state_changed",
          "delete.progress",
          "The backup task was no longer running while deletion was in progress"
        )
      }
    }
    return { artifacts: outcomes, warnings: [] }
  })
}

function deleteBackupArtifact(
  config: RelayConfig,
  input: BackupDeleteTaskInput & { kind: "delete" }
) {
  if (input.destination.kind === "restic") {
    return Effect.succeed({ warnings: [] })
  }
  const destination = input.destination
  // A linked backup's archive is stored under the backup it was made as.
  const backupId = input.archive?.backupId ?? input.backupId
  return destination.kind === "local"
    ? backupDestinationFor("local").deleteFullBackup({
        backupId,
        config,
        destination,
      })
    : backupDestinationFor("s3").deleteFullBackup({
        backupId,
        config,
        destination,
      })
}

function backupExportDirectoryPath(config: RelayConfig): string {
  return resolve(config.dataDirectory, "exports")
}

function backupExportPath(config: RelayConfig, backupId: string): string {
  return resolve(backupExportDirectoryPath(config), `${backupId}.zip`)
}

function backupExportPartialPath(
  config: RelayConfig,
  backupId: string,
  taskId: string
): string {
  return resolve(
    backupExportDirectoryPath(config),
    `.${backupId}.${taskId}.partial`
  )
}

/** Removes the files a Relay that stopped was about to zip. */
async function removeStagedExports(config: RelayConfig): Promise<void> {
  const directory = backupExportDirectoryPath(config)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for await (const entry of await opendir(directory)) {
    if (entry.isDirectory() && entry.name.endsWith(EXPORT_STAGING_SUFFIX)) {
      await rm(resolve(directory, entry.name), { force: true, recursive: true })
    }
  }
}

async function sweepExpiredBackupExports(config: RelayConfig): Promise<void> {
  const now = Date.now()
  const directory = backupExportDirectoryPath(config)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile()) continue
    const path = resolve(directory, entry.name)
    if (entry.name.endsWith(".partial")) {
      await rm(path, { force: true })
      continue
    }
    if (!entry.name.endsWith(".zip")) continue
    const metadata = await optionalLstat(path)
    if (!metadata) continue
    const marker = resolve(directory, `.${entry.name}.expires`)
    const expiresAt = await readExportExpiry(marker)
    if (expiresAt !== null && expiresAt <= now) {
      await rm(path, { force: true })
      await rm(marker, { force: true })
    }
  }
}

async function readExportExpiry(path: string): Promise<number | null> {
  const contents = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(contents)) return null
  const parsed = Number(contents.success.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function runResticCreate(
  config: RelayConfig,
  restic: ResticDriver,
  source: SnapshotSource,
  input: BackupCreateTaskInput & { kind?: "create" },
  updateProgress: (
    progress: BackupProgress
  ) => ReturnType<RelayStateStore["Service"]["updateBackupTaskProgress"]>,
  signal: AbortSignal
) {
  return Effect.gen(function* () {
    const password = requiredRepositoryPassword(
      input.destination.kind === "restic"
        ? input.destination.repositoryPassword
        : undefined,
      "create.restic"
    )
    const progress: BackupProgress = {
      completed: 0,
      currentArtifactId: input.destination.artifactId ?? null,
      currentPath: null,
      phase: "archiving",
      total: 0,
    }
    const progressFiber = yield* Effect.forkChild(
      Effect.sleep("500 millis").pipe(
        Effect.andThen(
          Effect.suspend(() => updateProgress(progress).pipe(Effect.asVoid))
        ),
        Effect.forever
      )
    )
    let summary: ResticSnapshotSummary | null = null
    const result = yield* Effect.tryPromise({
      try: () =>
        createResticSnapshot(
          config,
          restic,
          input,
          source,
          password,
          progress,
          signal,
          (taken) => {
            summary = taken
          }
        ),
      catch: (cause) =>
        cause instanceof RelayBackupError
          ? cause
          : RelayBackupError.make({
              code: "restic_backup_failed",
              operation: "create.restic",
              reason: backupErrorMessage(cause),
              cause,
            }),
    }).pipe(
      Effect.ensuring(Fiber.interrupt(progressFiber)),
      Effect.ensuring(
        cleanupResticCache(config, restic, {
          password,
          repository:
            input.destination.kind === "restic"
              ? input.destination.repository
              : undefined,
          targetId: input.target.id,
        })
      )
    )
    const unopened: ReadonlyArray<string> =
      input.destination.kind === "restic"
        ? yield* addRecoveryPasswords(
            config,
            restic,
            input.target.id,
            input.destination,
            password,
            signal
          )
        : []
    const taken = summary as ResticSnapshotSummary | null
    yield* Effect.annotateCurrentSpan({
      "restic.snapshot.id": result.snapshotId,
      "restic.snapshot.reused": taken === null,
      "restic.bytes.processed": result.bytes,
      ...(taken
        ? {
            "restic.bytes.added": taken.dataAdded,
            "restic.files.new": taken.filesNew,
            "restic.files.changed": taken.filesChanged,
            "restic.files.unmodified": taken.filesUnmodified,
            "restic.files.processed": taken.totalFilesProcessed,
          }
        : {}),
    })
    if (taken && taken.dataAdded !== null) {
      yield* recordResticSnapshot(config.nodeId, {
        bytesAdded: taken.dataAdded,
        bytesProcessed: result.bytes,
        storageKind:
          input.destination.kind === "restic"
            ? input.destination.repository.kind
            : "local",
      })
    }
    return { ...result, warnings: [...result.warnings, ...unopened] }
  })
}

/** What an incremental backup's snapshots hold, and how they're taken. */
interface SnapshotSource {
  /** About as much as a first snapshot holds, where it's known. */
  readonly logicalBytes: (signal: AbortSignal) => Promise<number>
  /**
   * Whether a snapshot an earlier attempt saved stands for this one. One of a
   * batch is taken in its stopped window with the rest, or it doesn't agree.
   */
  readonly reusable: boolean
  readonly take: (
    /**
     * Takes the snapshot, or one `before` it for it to add to, which isn't
     * kept.
     */
    backup: (
      source: ResticBackupSource,
      before?: "before"
    ) => Promise<ResticSnapshotSummary>,
    progress: BackupProgress,
    signal: AbortSignal
  ) => Promise<ResticSnapshotSummary>
  readonly warnings: ReadonlyArray<string>
}

/** A game server's folder, with its setup beside it. */
function instanceSnapshotSource(
  config: RelayConfig,
  input: BackupCreateTaskInput,
  instance: RelayInstanceConfig,
  webRoutes: ReadonlyArray<RelayInstanceWebRoute>
): SnapshotSource {
  const { excludes, warnings } = translateExcludePatterns([
    ...DEFAULT_EXCLUDES,
    ...input.exclude,
  ])
  return {
    logicalBytes: (signal) =>
      directoryLogicalBytes(
        resolve(config.rootDirectory, instance.directory),
        signal
      ),
    reusable: true,
    take: async (backup) => {
      const setup = await writeInstanceSetup(config, instance, webRoutes)
      return ensuringPromise(
        () =>
          backup({
            cwd: config.rootDirectory,
            // The server's own patterns, which can't leave out its setup.
            excludes: [
              ...excludes,
              `!${SETUP_DIRECTORY}`,
              `!${SETUP_DIRECTORY}/**`,
            ],
            paths: [instance.directory, setup],
          }),
        () =>
          rm(resolve(config.rootDirectory, setup), {
            force: true,
            recursive: true,
          })
      )
    },
    warnings,
  }
}

// A pattern of what a volume holds, as a full backup reads it: one without a
// slash anywhere in it, any other from its root. Left bare, one could name the
// folder restic reads the volume as, and leave out all of it.
function volumeExcludePattern(pattern: string): string {
  const trimmed = pattern.trim()
  return !trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")
    ? trimmed
    : trimmed.includes("/")
      ? `${VOLUME_MOUNT}/${trimmed.replace(/^\/+/u, "")}`
      : `${VOLUME_MOUNT}/**/${trimmed}`
}

// A database's snapshots hold its dump under this name.
const DATABASE_DUMP_FILE = "database.sql"

/**
 * A database's dump, made whole first, so a slow bucket doesn't hold the
 * database's transaction open and a dump that fails leaves no snapshot.
 * restic stores it uncompressed, which is what makes two nights' the same.
 */
function databaseSnapshotSource(
  config: RelayConfig,
  databases: DatabaseDriver,
  input: BackupCreateTaskInput,
  window: StoppedWindow | null
): SnapshotSource {
  return {
    logicalBytes: async () => 0,
    reusable: window === null,
    take: async (backup, progress, signal) => {
      const directory = backupDirectoryPath(config)
      await mkdir(directory, { mode: 0o700, recursive: true })
      await cleanupBackupPartials(directory, input.backupId)
      const dump = resolve(
        directory,
        `.${input.backupId}.${randomUUID()}.partial`
      )
      return ensuringPromise(
        async () => {
          if (window) await Effect.runPromise(window.begin(input.taskId))
          progress.phase = "dumping"
          await dumpCompressedDatabase(databases, input.target.id, dump, {
            maxDumpBytes: input.maxBytes,
            progress,
            signal,
          })
          // As a full one does, it waits for every other of its batch before
          // the Apps start again, and only then is it stored.
          const restarted = window
            ? await Effect.runPromise(window.arrive(input.taskId))
            : []
          progress.phase = "archiving"
          progress.completed = 0
          const taken = await backup({
            filename: DATABASE_DUMP_FILE,
            open: () => {
              const plain = createGunzip()
              // A failed read fails what it's read through.
              pipeline(createReadStream(dump), plain, () => undefined)
              return plain
            },
          })
          return { ...taken, warnings: [...taken.warnings, ...restarted] }
        },
        () => rm(dump, { force: true })
      )
    },
    warnings: [],
  }
}

// A snapshot's servers' setups are beside their folders, out of them, so a
// restore or download of a server's files takes them alone.
const SETUP_DIRECTORY = ".kiln-setup"

/** Writes a game server's setup for a snapshot to take with its files. */
async function writeInstanceSetup(
  config: RelayConfig,
  instance: RelayInstanceConfig,
  webRoutes: ReadonlyArray<RelayInstanceWebRoute>
): Promise<string> {
  const directory = join(SETUP_DIRECTORY, instance.id)
  await mkdir(resolve(config.rootDirectory, directory), {
    recursive: true,
    mode: 0o700,
  })
  await writeFile(
    resolve(config.rootDirectory, directory, "setup.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        formatVersion: 1,
        id: instance.id,
        server: await instanceBackupSetup(config, instance, webRoutes),
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  return directory
}

// What opens the repository without Kiln. The snapshot is taken by now, so
// one that can't be added is left for the next backup.
const addRecoveryPasswords = Effect.fn("Backups.addRecoveryPasswords")(
  function* (
    config: RelayConfig,
    restic: ResticDriver,
    targetId: string,
    destination: Extract<
      BackupCreateTaskInput["destination"],
      { kind: "restic" }
    >,
    password: string,
    signal: AbortSignal
  ) {
    const passwords = destination.recoveryPasswords ?? []
    if (passwords.length === 0) return []
    yield* Effect.tryPromise({
      try: () =>
        restic.addPasswords({
          location: resticDriverLocation(
            config,
            targetId,
            destination.repository
          ),
          password,
          passwords,
          signal,
        }),
      catch: (cause) => cause,
    })
    return []
  },
  Effect.catch((cause) =>
    Effect.logWarning(
      "A backup repository's recovery passwords couldn't be added yet",
      cause
    ).pipe(
      Effect.as([
        "Only Kiln can open this backup until the next one adds its destination's password and Kiln's",
      ])
    )
  )
)

async function createResticSnapshot(
  config: RelayConfig,
  restic: ResticDriver,
  input: BackupCreateTaskInput,
  source: SnapshotSource,
  password: string,
  progress: BackupProgress,
  signal: AbortSignal,
  // What restic said of the snapshot it took, for the task's trace; none
  // when an earlier attempt's is kept.
  onSummary: (summary: ResticSnapshotSummary) => void
): Promise<BackupResticCreateTaskResult> {
  const location = resticDriverLocation(
    config,
    input.target.id,
    input.destination.kind === "restic"
      ? input.destination.repository
      : undefined
  )
  // A snapshot an attempt before a Relay restart saved is kept, not taken
  // again.
  const tag = `task:${input.taskId}`
  const beforeTag = `before:${input.taskId}`
  let addedTo = false
  const existing = await restic.openForBackup({
    location,
    password,
    signal,
    tag,
  })
  const reuse = source.reusable ? existing[0] : undefined
  if (reuse) {
    if (input.consistency === "stopped") {
      await recoverPromise(
        () =>
          forgetTaskSnapshots(restic, {
            location,
            password,
            tags: [beforeTag],
          }),
        () => undefined
      )
    }
    const stats = await restic.stats({
      location,
      password,
      signal,
      snapshotId: reuse.id,
    })
    await rejectOverLimitSnapshot(restic, {
      backupId: input.backupId,
      location,
      maxBytes: input.maxBytes,
      password,
      snapshotId: reuse.id,
      taskId: input.taskId,
      totalBytes: stats.totalSize,
    })
    progress.completed = stats.totalSize
    progress.total = stats.totalSize
    return {
      artifacts: input.destination.artifactId
        ? [
            {
              artifactId: input.destination.artifactId,
              error: null,
              status: "available",
            },
          ]
        : undefined,
      bytes: stats.totalSize,
      snapshotId: reuse.id,
      warnings: [
        ...source.warnings,
        // restic's report of files it couldn't read went with the process.
        "Recovered after the Relay restarted, so files restic couldn't read, if any, aren't listed",
      ],
    }
  }
  if (location.kind === "local") {
    // Worst case a snapshot stores one full compressed copy of its source;
    // deduplicated runs use far less, so this is a conservative preflight.
    await mkdir(location.path, { recursive: true, mode: 0o700 })
    await requireBackupSpace(
      location.path,
      await source.logicalBytes(signal),
      input.maxBytes
    )
  }
  const summary = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          source.take(
            (read, before) => {
              addedTo ||= before !== undefined
              return restic.backup({
                location,
                onProgress: (update) => {
                  progress.completed = update.bytesCompleted
                  progress.total = update.bytesTotal ?? progress.total
                  if (
                    input.maxBytes !== null &&
                    Math.max(progress.total, progress.completed) >
                      input.maxBytes
                  ) {
                    throw backupTooLarge()
                  }
                },
                password,
                signal,
                source: read,
                tags: [before ? beforeTag : tag, `backup:${input.backupId}`],
              })
            },
            progress,
            signal
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(summary)) {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          forgetTaskSnapshots(restic, {
            location,
            password,
            tags: [tag, beforeTag],
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError(
            "Could not forget restic snapshots after a failed create",
            {
              backupId: input.backupId,
              cause,
              taskId: input.taskId,
            }
          )
        )
      )
    )
    throw summary.failure
  }
  // Those earlier attempts saved, and the one it added to. Nothing lists
  // them, so one that stays only takes the space it adds.
  if (existing.length > 0 || addedTo) {
    await recoverPromise(
      () =>
        forgetTaskSnapshots(restic, {
          keep: summary.success.snapshotId,
          location,
          password,
          tags: [tag, beforeTag],
        }),
      () => undefined
    )
  }
  await rejectOverLimitSnapshot(restic, {
    backupId: input.backupId,
    location,
    maxBytes: input.maxBytes,
    password,
    snapshotId: summary.success.snapshotId,
    taskId: input.taskId,
    totalBytes: summary.success.totalBytesProcessed,
  })
  onSummary(summary.success)
  progress.completed = summary.success.totalBytesProcessed
  progress.total = summary.success.totalBytesProcessed
  return {
    artifacts: input.destination.artifactId
      ? [
          {
            artifactId: input.destination.artifactId,
            error: null,
            status: "available",
          },
        ]
      : undefined,
    bytes: summary.success.totalBytesProcessed,
    snapshotId: summary.success.snapshotId,
    warnings: [...source.warnings, ...summary.success.warnings],
  }
}

function backupTooLarge() {
  return RelayBackupError.make({
    code: "backup_too_large",
    operation: "create.restic",
    reason: "The snapshot exceeds the reserved backup size",
  })
}

async function rejectOverLimitSnapshot(
  restic: ResticDriver,
  input: {
    backupId: string
    location: ResticDriverLocation
    maxBytes: number | null
    password: string
    snapshotId: string
    taskId: string
    totalBytes?: number
  }
): Promise<void> {
  if (input.maxBytes === null) return
  const signal = AbortSignal.timeout(RESTIC_RECOVERY_TIMEOUT_MS)
  const totalBytes =
    input.totalBytes ??
    (
      await restic.stats({
        location: input.location,
        password: input.password,
        signal,
        snapshotId: input.snapshotId,
      })
    ).totalSize
  if (totalBytes <= input.maxBytes) return
  await restic.forget({
    location: input.location,
    password: input.password,
    signal,
    snapshotId: input.snapshotId,
  })
  // The failed create queues the prune; see `scheduleBackupPrune`.
  throw backupTooLarge()
}

async function forgetTaskSnapshots(
  restic: ResticDriver,
  input: {
    /** The one that stays. */
    keep?: string
    location: ResticDriverLocation
    password: string
    signal?: AbortSignal
    tags: ReadonlyArray<string>
  }
): Promise<void> {
  const { keep, location, password } = input
  const signal = input.signal ?? AbortSignal.timeout(RESTIC_RECOVERY_TIMEOUT_MS)
  for (const tag of input.tags) {
    for (const { id } of await restic.snapshotsByTag({
      location,
      password,
      signal,
      tag,
    })) {
      if (id === keep) continue
      await restic.forget({ location, password, signal, snapshotId: id })
    }
  }
}

/**
 * The snapshot path a restore or export reads: the server directory it was
 * taken of, which the snapshot itself records when that server isn't the
 * one at hand, as when it's gone or another is restored into.
 */
async function resticSnapshotSource(
  config: RelayConfig,
  restic: ResticDriver,
  input: {
    directory: string | null
    location: ResticDriverLocation
    password: string
    signal: AbortSignal
    snapshotId: string
  }
): Promise<string> {
  if (input.directory) {
    return resticSnapshotSelector(input.snapshotId, input.directory)
  }
  // The server's own, beside its setup's.
  const path = (await restic.snapshotPaths(input)).find(
    (candidate) => !candidate.split("/").includes(SETUP_DIRECTORY)
  )
  // Taken from the Relay's server root with the server's own directory, so
  // the snapshot holds that directory under its path from the root.
  const below = path ? relative(config.rootDirectory, path) : ""
  // Another Relay's server root is elsewhere; a server's folder is in it.
  const directory =
    below.startsWith("..") || isAbsolute(below) ? basename(below) : below
  if (!directory || directory === "..") {
    throw RelayBackupError.make({
      code: "restic_snapshot_path",
      operation: "restore.restic",
      reason: "The snapshot wasn't taken of a game server on this Relay",
    })
  }
  return resticSnapshotSelector(input.snapshotId, directory)
}

function runResticRestore(
  config: RelayConfig,
  restic: ResticDriver,
  input: Extract<BackupTaskInput, { kind: "restore" }>,
  instance: RelayInstanceConfig,
  signal: AbortSignal,
  beginInstall: RestoreInstallGate
) {
  return Effect.tryPromise({
    try: async () => {
      if (input.source.kind !== "restic") {
        throw RelayBackupError.make({
          code: "unsupported_restore_source",
          operation: "restore.restic",
          reason: "This restore is not a restic snapshot",
        })
      }
      const source = input.source
      const password = requiredRepositoryPassword(
        source.repositoryPassword,
        "restore.restic"
      )
      // The repository belongs to the server the snapshot was taken of,
      // which another restored into may not be, and may no longer exist.
      const location = resticDriverLocation(
        config,
        input.archive?.targetId ?? input.target.id,
        source.repository
      )
      const prepared = await prepareInstanceRestoreStaging(
        config,
        instance.directory,
        input.taskId
      )
      const restored = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            try: async () => {
              await requireRestoreSpace(
                dirname(prepared.paths.staging),
                (
                  await restic.stats({
                    location,
                    password,
                    signal,
                    snapshotId: source.snapshotId,
                  })
                ).totalSize
              )
              await restic.restore({
                location,
                password,
                selector: await resticSnapshotSource(config, restic, {
                  directory: input.archive ? null : instance.directory,
                  location,
                  password,
                  signal,
                  snapshotId: source.snapshotId,
                }),
                signal,
                target: prepared.paths.staging,
              })
              const validated = await validateStagingTree(
                prepared.paths.staging,
                instance.limits
              )
              await installPreparedInstanceRestore(prepared, beginInstall)
              return { warnings: validated.warnings }
            },
            catch: (cause) => cause,
          })
        )
      )
      if (Result.isSuccess(restored)) return restored.success
      const completed = await settleRestoreJournal(
        config,
        prepared.journal,
        false
      )
      if (completed) return { warnings: [] }
      throw restored.failure
    },
    catch: (cause) =>
      cause instanceof RelayBackupError
        ? cause
        : RelayBackupError.make({
            code: "restic_restore_failed",
            operation: "restore.restic",
            reason: backupErrorMessage(cause),
            cause,
          }),
  }).pipe(
    Effect.ensuring(
      input.source.kind === "restic" && input.source.repositoryPassword
        ? cleanupResticCache(config, restic, {
            password: input.source.repositoryPassword,
            repository: input.source.repository,
            targetId: input.archive?.targetId ?? input.target.id,
          })
        : Effect.void
    )
  )
}

/**
 * Forgets a backup's restic snapshot. Its data stays in the repository
 * until the returned prune runs.
 */
function runResticForget(
  config: RelayConfig,
  restic: ResticDriver,
  input: BackupDeleteTaskInput & { kind: "delete" },
  signal: AbortSignal
) {
  return Effect.gen(function* () {
    const destination = input.destination
    if (destination.kind !== "restic") {
      return yield* backupFailure(
        "unsupported_delete_destination",
        "delete.restic",
        "This delete is not a restic snapshot"
      )
    }
    const password = requiredRepositoryPassword(
      destination.repositoryPassword,
      "delete.restic"
    )
    const location = resticDriverLocation(
      config,
      input.target.id,
      destination.repository
    )
    const repositoryExists = yield* Effect.tryPromise({
      try: async () => {
        if (destination.createTaskId) {
          // Its create's snapshot, which carries both: a task ID alone
          // could be another backup's in the same repository.
          await forgetTaskSnapshots(restic, {
            location,
            password,
            signal,
            tags: ["task", "before"].map(
              (kind) =>
                `${kind}:${destination.createTaskId},backup:${input.backupId}`
            ),
          })
          return
        }
        if (!destination.snapshotId) {
          throw RelayBackupError.make({
            code: "restic_forget_selector_missing",
            operation: "delete.restic",
            reason: "Restic deletes require a snapshot or create task id",
          })
        }
        await restic.forget({
          location,
          password,
          signal,
          snapshotId: destination.snapshotId,
        })
      },
      catch: (cause) =>
        cause instanceof RelayBackupError
          ? cause
          : RelayBackupError.make({
              code: "restic_forget_failed",
              operation: "delete.restic",
              reason: backupErrorMessage(cause),
              cause,
            }),
    }).pipe(
      // A repository already gone holds no snapshot to forget, and nothing
      // to prune.
      Effect.as(true),
      Effect.catchIf(
        (cause) => cause.exitCode === RESTIC_EXIT_REPOSITORY_MISSING,
        () => Effect.succeed(false)
      )
    )
    yield* promiseEffect(() => removeBackupExport(config, input.backupId))
    return {
      prune: !repositoryExists
        ? undefined
        : resticPruneFor(config, {
            repository: destination.repository,
            repositoryPassword: password,
            target: input.target,
          }),
      result: {
        artifacts: input.destination.artifactId
          ? [
              {
                artifactId: input.destination.artifactId,
                error: null,
                status: "deleted" as const,
              },
            ]
          : undefined,
        warnings: [],
      },
    }
  })
}

function refusedByStorage(code: BackupFailureCode | null): boolean {
  return (
    code !== null &&
    (code === "hearth_unreachable" ||
      code.startsWith("storage_") ||
      code.startsWith("repository_"))
  )
}

/** A prune of one restic repository, to queue with `scheduleBackupPrune`. */
function resticPruneFor(
  config: RelayConfig,
  input: {
    repository: ResticRepositoryLocation
    repositoryPassword: string
    target: BackupTaskInput["target"]
  }
): ScheduledBackupPrune {
  return {
    input: {
      backupId: randomUUID(),
      kind: "prune",
      repository: input.repository,
      repositoryPassword: input.repositoryPassword,
      target: input.target,
      taskId: randomUUID(),
    },
    repositoryKey: resticRepositoryKey(
      resticDriverLocation(config, input.target.id, input.repository)
    ),
  }
}

function runResticPrune(
  config: RelayConfig,
  restic: ResticDriver,
  input: Extract<BackupTaskInput, { kind: "prune" }>,
  updateProgress: (
    progress: BackupProgress
  ) => ReturnType<RelayStateStore["Service"]["updateBackupTaskProgress"]>,
  signal: AbortSignal
) {
  return Effect.gen(function* () {
    const password = requiredRepositoryPassword(
      input.repositoryPassword,
      "prune.restic"
    )
    const progress: BackupProgress = {
      completed: 0,
      currentArtifactId: null,
      currentPath: null,
      phase: "finalizing",
      total: 0,
    }
    const progressFiber = yield* Effect.forkChild(
      Effect.sleep("500 millis").pipe(
        Effect.andThen(
          Effect.suspend(() => updateProgress(progress).pipe(Effect.asVoid))
        ),
        Effect.forever
      )
    )
    yield* Effect.tryPromise({
      try: () =>
        restic.prune({
          location: resticDriverLocation(
            config,
            input.target.id,
            input.repository
          ),
          onProgress: (update) => {
            progress.completed = update.bytesCompleted
            progress.total = update.bytesTotal ?? progress.total
          },
          password,
          signal,
        }),
      catch: (cause) =>
        cause instanceof RelayBackupError
          ? cause
          : RelayBackupError.make({
              code: "restic_prune_failed",
              operation: "prune.restic",
              reason: backupErrorMessage(cause),
              cause,
            }),
    }).pipe(
      // Removed while the prune waited, as when its server was deleted:
      // nothing is left to prune.
      Effect.catchIf(
        (cause) => cause.exitCode === RESTIC_EXIT_REPOSITORY_MISSING,
        () => Effect.void
      ),
      Effect.ensuring(Fiber.interrupt(progressFiber)),
      Effect.ensuring(
        cleanupResticCache(config, restic, {
          password,
          repository: input.repository,
          targetId: input.target.id,
        })
      )
    )
  })
}

function cleanupResticCache(
  config: RelayConfig,
  restic: ResticDriver,
  input: {
    password: string
    repository: ResticRepositoryLocation | undefined
    targetId: string
  }
) {
  return Effect.tryPromise({
    try: () =>
      restic.cacheCleanup({
        location: resticDriverLocation(
          config,
          input.targetId,
          input.repository
        ),
        password: input.password,
        signal: AbortSignal.timeout(RESTIC_CACHE_CLEANUP_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("restic cache cleanup failed", { cause })
    )
  )
}

function runResticExport(
  config: RelayConfig,
  restic: ResticDriver,
  input: Extract<BackupTaskInput, { kind: "export" }>,
  taskId: string,
  updateProgress: (
    progress: BackupProgress
  ) => ReturnType<RelayStateStore["Service"]["updateBackupTaskProgress"]>,
  signal: AbortSignal
) {
  return Effect.gen(function* () {
    const password = requiredRepositoryPassword(
      input.repositoryPassword,
      "export.restic"
    )
    const location = resticDriverLocation(
      config,
      input.target.id,
      input.repository
    )
    const destination = backupExportPath(config, input.backupId)
    const partial = backupExportPartialPath(config, input.backupId, taskId)
    const staged = resolve(
      backupExportDirectoryPath(config),
      `.${input.backupId}.${taskId}${EXPORT_STAGING_SUFFIX}`
    )
    const existing = yield* promiseEffect(() =>
      reuseValidExport(
        destination,
        Date.now() + input.ttlMs,
        backupExportFilename(input.backupId, input.target.kind)
      )
    )
    if (existing) return existing
    const progress: BackupProgress = {
      completed: 0,
      currentArtifactId: null,
      currentPath: null,
      phase: "archiving",
      total: 0,
    }
    const progressFiber = yield* Effect.forkChild(
      Effect.sleep("500 millis").pipe(
        Effect.andThen(
          Effect.suspend(() => updateProgress(progress).pipe(Effect.asVoid))
        ),
        Effect.forever
      )
    )
    const finishExport = async (dumped: {
      bytes: number
      checksumSha256: string
    }) => {
      await rename(partial, destination)
      const expiresAt = Date.now() + input.ttlMs
      await writeExportExpiry(
        backupExportExpiryPath(config, input.backupId),
        expiresAt
      )
      progress.completed = dumped.bytes
      progress.total = dumped.bytes
      return {
        bytes: dumped.bytes,
        checksumSha256: dumped.checksumSha256,
        expiresAt,
        filename: backupExportFilename(input.backupId, input.target.kind),
        warnings: [],
      } satisfies BackupExportTaskResult
    }
    const result = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(backupExportDirectoryPath(config), {
          recursive: true,
          mode: 0o700,
        })
        await rm(partial, { force: true })
        const stats = await restic.stats({
          location,
          password,
          signal,
          snapshotId: input.snapshotId,
        })
        await requireBackupSpace(
          backupExportDirectoryPath(config),
          stats.totalSize,
          null,
          "export.preflight"
        )
        const onProgress = (bytes: number) => {
          progress.completed = bytes
        }
        if (input.target.kind !== "instance") {
          const database = input.target.kind === "database"
          const dumped = await restic.dump({
            destination: partial,
            format: { compression: "gzip" },
            location,
            onProgress,
            password,
            signal,
            ...(database
              ? { file: DATABASE_DUMP_FILE, selector: input.snapshotId }
              : {
                  selector: resticSnapshotSelector(
                    input.snapshotId,
                    VOLUME_MOUNT
                  ),
                }),
          })
          return finishExport(dumped)
        }
        // Its server may be gone, or another Relay's that it's linked from.
        const selector = await resticSnapshotSource(config, restic, {
          directory: null,
          location,
          password,
          signal,
          snapshotId: input.snapshotId,
        })
        // restic writes a zip a file at a time, each read from the bucket on
        // its own. A restore reads them in bulk, where there's room for the
        // files beside the zip.
        const bulk =
          location.kind === "s3" &&
          (await hasFreeBytes(
            backupExportDirectoryPath(config),
            stats.totalSize * 2 + ZIP_OVERHEAD_RESERVE_BYTES
          ))
        if (bulk) {
          await restic.restore({
            location,
            onProgress: ({ bytesCompleted }) => onProgress(bytesCompleted),
            password,
            selector,
            signal,
            target: staged,
          })
        }
        const zipped = bulk
          ? await Effect.runPromise(
              zipTree(staged, partial, {
                onProgress,
                totalBytes: stats.totalSize,
              }).pipe(
                // restic writes what that can't, as a name with a backslash.
                Effect.catchIf(
                  (cause) => cause instanceof UnzippableEntryError,
                  () => Effect.succeed(null)
                )
              ),
              { signal }
            )
          : null
        if (bulk && !zipped) {
          await rm(staged, { force: true, recursive: true })
        }
        const dumped =
          zipped ??
          (await restic.dump({
            destination: partial,
            format: { archive: "zip" },
            location,
            onProgress,
            password,
            selector,
            signal,
          }))
        return finishExport(dumped)
      },
      catch: (cause) =>
        cause instanceof RelayBackupError
          ? cause
          : RelayBackupError.make({
              code: "restic_export_failed",
              operation: "export.restic",
              reason: backupErrorMessage(cause),
              cause,
            }),
    }).pipe(
      Effect.onError(() =>
        promiseEffect(() => rm(partial, { force: true })).pipe(Effect.ignore)
      ),
      Effect.ensuring(
        promiseEffect(() => rm(staged, { force: true, recursive: true })).pipe(
          Effect.ignore
        )
      ),
      Effect.ensuring(Fiber.interrupt(progressFiber)),
      Effect.ensuring(
        cleanupResticCache(config, restic, {
          password,
          repository: input.repository,
          targetId: input.target.id,
        })
      )
    )
    return result
  })
}

async function removeBackupExport(
  config: RelayConfig,
  backupId: string
): Promise<void> {
  const directory = backupExportDirectoryPath(config)
  await rm(backupExportPath(config, backupId), { force: true })
  await rm(backupExportExpiryPath(config, backupId), { force: true })
  const listing = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => opendir(directory),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(listing)) return
  for await (const entry of listing.success) {
    if (
      entry.isFile() &&
      entry.name.startsWith(`.${backupId}.`) &&
      entry.name.endsWith(".partial")
    ) {
      await rm(resolve(directory, entry.name), { force: true })
    }
  }
}

function backupExportExpiryPath(config: RelayConfig, backupId: string): string {
  return resolve(backupExportDirectoryPath(config), `.${backupId}.zip.expires`)
}

async function reuseValidExport(
  destination: string,
  expiresAt: number,
  filename: string
): Promise<BackupExportTaskResult | null> {
  if (expiresAt <= Date.now()) return null
  const metadata = await optionalLstat(destination)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) return null
  const marker = resolve(
    dirname(destination),
    `.${basename(destination)}.expires`
  )
  const existing = await readExportExpiry(marker)
  const nextExpiresAt = Math.max(existing ?? 0, expiresAt)
  if (nextExpiresAt <= Date.now()) return null
  await writeExportExpiry(marker, nextExpiresAt)
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(destination)) digest.update(chunk)
  return {
    bytes: metadata.size,
    checksumSha256: digest.digest("hex"),
    expiresAt: nextExpiresAt,
    filename,
    warnings: [],
  }
}

async function writeExportExpiry(
  path: string,
  expiresAt: number
): Promise<void> {
  await writeFile(path, `${expiresAt}\n`, { mode: 0o600 })
}

async function cleanupBackupPartials(
  backupDirectory: string,
  backupId: string
): Promise<void> {
  const prefix = `.${backupId}.`
  for await (const entry of await opendir(backupDirectory)) {
    if (
      entry.isFile() &&
      entry.name.startsWith(prefix) &&
      entry.name.endsWith(".partial")
    ) {
      await rm(resolve(backupDirectory, entry.name), { force: true })
    }
  }
}

async function collectBackupEntries(
  root: string,
  patterns: ReadonlyArray<string>,
  progress: BackupProgress,
  signal: AbortSignal
): Promise<{ entries: Array<ArchiveEntry>; warnings: Array<string> }> {
  const entries: Array<ArchiveEntry> = []
  const warnings: Array<string> = []

  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    const children = []
    for await (const child of await opendir(directory)) children.push(child)
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      signal.throwIfAborted()
      const absolute = resolve(directory, child.name)
      requireContained(root, absolute)
      const name = relative(root, absolute).split(sep).join("/")
      progress.currentPath = name
      const inspected = await Effect.runPromise(
        Effect.result(promiseEffect(() => lstat(absolute)))
      )
      if (Result.isFailure(inspected)) {
        const cause = inspected.failure
        if (!isSkippableFilesystemChange(cause)) throw cause
        warnings.push(
          backupWarning(
            `Skipped entry that changed during collection: ${name} (${backupErrorMessage(cause)})`
          )
        )
        continue
      }
      const metadata = inspected.success
      if (backupPathIsExcluded(name, metadata.isDirectory(), patterns)) continue
      if (metadata.isDirectory()) {
        const visited = await Effect.runPromise(
          Effect.result(promiseEffect(() => visit(absolute)))
        )
        if (Result.isFailure(visited)) {
          const cause = visited.failure
          if (!isSkippableFilesystemChange(cause)) throw cause
          warnings.push(
            backupWarning(
              `Skipped directory that changed during collection: ${name} (${backupErrorMessage(cause)})`
            )
          )
        }
        continue
      }
      if (!metadata.isFile()) {
        warnings.push(backupWarning(`Skipped unsupported entry: ${name}`))
        continue
      }
      entries.push({
        absolute,
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        modifiedAt: metadata.mtimeMs,
        name,
        size: metadata.size,
      })
      if (entries.length > MAX_BACKUP_ENTRIES) {
        throw RelayBackupError.make({
          code: "too_many_entries",
          operation: "create.collect",
          reason: `Backups cannot contain more than ${MAX_BACKUP_ENTRIES.toLocaleString("en-US")} files`,
        })
      }
    }
  }

  await visit(root)
  progress.currentPath = null
  return { entries, warnings }
}

async function requireBackupSpace(
  directory: string,
  logicalBytes: number,
  maxBytes: number | null,
  operation = "create.preflight"
): Promise<void> {
  const estimate = logicalBytes + ZIP_OVERHEAD_RESERVE_BYTES
  const required = maxBytes === null ? estimate : Math.min(estimate, maxBytes)
  if (!(await hasFreeBytes(directory, required))) {
    throw RelayBackupError.make({
      code: "insufficient_space",
      operation,
      reason: "The Relay does not have enough free space to stage this backup",
    })
  }
}

async function hasFreeBytes(directory: string, bytes: number) {
  const filesystem = await statfs(directory)
  return BigInt(filesystem.bavail) * BigInt(filesystem.bsize) >= BigInt(bytes)
}

async function directoryLogicalBytes(
  root: string,
  signal: AbortSignal
): Promise<number> {
  let total = 0
  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    for await (const entry of await opendir(directory)) {
      const absolute = resolve(directory, entry.name)
      const child = await lstat(absolute)
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (child.isFile()) total += child.size
    }
  }
  await visit(root)
  return total
}

function writeBackupArchive(
  destination: string,
  entries: ReadonlyArray<ArchiveEntry>,
  maxBytes: number | null,
  progress: BackupProgress,
  signal: AbortSignal,
  manifest: BackupArchiveManifest
): Promise<{
  bytes: number
  changed: Array<string>
  checksumSha256: string
  warnings: Array<string>
}> {
  return new Promise((resolveArchive, reject) => {
    const archive = new ZipStream({
      forceZip64: true,
      zlib: { level: zlibConstants.Z_BEST_SPEED },
    })
    const output = createWriteStream(destination, {
      flags: "wx",
      mode: 0o600,
    })
    const digest = createHash("sha256")
    const changed: Array<string> = []
    const warnings: Array<string> = []
    let activeSource: ReadStream | null = null
    let bytes = 0
    let settled = false

    const ignoreLateStreamError = () => undefined
    const cleanup = () => {
      archive.off("error", failed)
      archive.on("error", ignoreLateStreamError)
      output.off("error", failed)
      output.on("error", ignoreLateStreamError)
      output.off("close", finished)
      archive.off("data", outputChunk)
      activeSource?.off("error", failed)
      activeSource?.on("error", ignoreLateStreamError)
      signal.removeEventListener("abort", aborted)
    }
    const finish = (cause?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (cause) reject(cause)
      else
        resolveArchive({
          bytes,
          changed,
          checksumSha256: digest.digest("hex"),
          warnings,
        })
    }
    const failed = (cause: Error) => {
      if (settled) return
      activeSource?.destroy()
      archive.destroy()
      output.destroy()
      finish(cause)
    }
    const aborted = () => failed(backupAbortError(signal))
    const outputChunk = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (maxBytes !== null && bytes > maxBytes) {
        failed(
          RelayBackupError.make({
            code: "size_limit_exceeded",
            operation: "create.write",
            reason: "The compressed backup exceeds the configured size limit",
          })
        )
        return
      }
      digest.update(chunk)
    }
    const finished = () => finish()
    archive.once("error", failed)
    output.once("error", failed)
    output.once("close", finished)
    archive.on("data", outputChunk)
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) {
      aborted()
      return
    }
    archive.pipe(output)

    const append = (index: number) => {
      Effect.runFork(
        promiseEffect(() => appendEntry(index)).pipe(
          Effect.catch((cause) =>
            Effect.sync(() =>
              failed(
                cause instanceof Error
                  ? cause
                  : new Error("Backup archive entry failed", { cause })
              )
            )
          )
        )
      )
    }
    const appendEntry = async (index: number): Promise<void> => {
      if (settled) return
      const entry = entries[index]
      if (!entry) {
        archive.entry(
          Buffer.from(`${JSON.stringify(manifest)}\n`),
          {
            date: new Date(manifest.createdAt),
            mode: 0o100600,
            name: ".kiln-backup/manifest.json",
          },
          (cause) => {
            if (cause) failed(cause)
            else archive.finalize()
          }
        )
        return
      }
      progress.phase = "archiving"
      progress.currentPath = entry.name
      const openedResult = await Effect.runPromise(
        Effect.result(
          promiseEffect(() =>
            open(entry.absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
          ).pipe(
            Effect.flatMap((handle) =>
              promiseEffect(() => handle.stat()).pipe(
                Effect.map((metadata) => ({ handle, metadata })),
                Effect.onError(() =>
                  promiseEffect(() => handle.close()).pipe(Effect.ignore)
                )
              )
            )
          )
        )
      )
      if (Result.isFailure(openedResult)) {
        const cause = openedResult.failure
        if (!isSkippableFilesystemChange(cause)) throw cause
        changed.push(entry.name)
        warnings.push(
          backupWarning(
            `Skipped entry that changed before it was archived: ${entry.name} (${backupErrorMessage(cause)})`
          )
        )
        progress.completed += entry.size
        append(index + 1)
        return
      }
      const { handle, metadata: opened } = openedResult.success
      if (settled) {
        await handle.close()
        return
      }
      if (
        !opened.isFile() ||
        opened.dev !== entry.device ||
        opened.ino !== entry.inode
      ) {
        await handle.close()
        changed.push(entry.name)
        warnings.push(
          backupWarning(`Skipped entry replaced during backup: ${entry.name}`)
        )
        progress.completed += entry.size
        append(index + 1)
        return
      }
      const source = handle.createReadStream({ signal })
      activeSource = source
      source.once("error", failed)
      source.on("data", (chunk) => {
        progress.completed += Buffer.byteLength(chunk)
      })
      archive.entry(
        source,
        {
          date: new Date(entry.modifiedAt),
          mode: entry.mode,
          name: entry.name,
        },
        async (cause) => {
          source.off("error", failed)
          activeSource = null
          if (cause) {
            failed(cause)
            return
          }
          const inspected = await Effect.runPromise(
            Effect.result(promiseEffect(() => stat(entry.absolute)))
          )
          if (Result.isSuccess(inspected)) {
            const after = inspected.success
            if (
              after.dev !== entry.device ||
              after.ino !== entry.inode ||
              after.size !== entry.size ||
              after.mtimeMs !== entry.modifiedAt
            ) {
              changed.push(entry.name)
            }
          } else {
            warnings.push(
              backupWarning(
                `File vanished after it was archived: ${entry.name} (${backupErrorMessage(inspected.failure)})`
              )
            )
            changed.push(entry.name)
          }
          append(index + 1)
        }
      )
    }
    append(0)
  })
}

function requireContained(root: string, candidate: string): void {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw RelayBackupError.make({
      code: "path_outside_instance",
      operation: "create.path",
      reason: "The backup path resolves outside the instance directory",
    })
  }
}

function backupFailure(code: string, operation: string, reason: string) {
  return Effect.fail(RelayBackupError.make({ code, operation, reason }))
}

function optionalLstat(path: string) {
  return Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => lstat(path),
        catch: (cause) => cause,
      })
    )
  ).then((result) => (Result.isSuccess(result) ? result.success : null))
}

function backupErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Backup operation failed"
}

function backupAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Backup creation cancelled")
}

function backupWarning(message: string): string {
  return message.slice(0, 1_024)
}

function isSkippableFilesystemChange(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false
  return ["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(
    String(cause.code)
  )
}
