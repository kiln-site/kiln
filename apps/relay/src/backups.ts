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
import { basename, dirname, relative, resolve, sep } from "node:path"
import { constants as zlibConstants } from "node:zlib"
import { logException } from "@workspace/telemetry"
import { Deferred, Effect, Fiber, Option, Queue, Result, Schema } from "effect"
import ZipStream from "zip-stream"

import {
  backupArtifactFilename,
  type BackupArchiveCreateTaskResult,
  type BackupArchiveManifest,
  type BackupCreateTaskInput,
  type BackupCreateTaskResult,
  type BackupDeleteTaskInput,
  type BackupExportTaskResult,
  type BackupFailureCode,
  type BackupResticCreateTaskResult,
  type BackupRestoreTaskInput,
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
import { brickSnapshotDirectory, readBrickSnapshot } from "./bricks.js"
import type { DatabaseDriver } from "./databases.js"
import {
  createCompressedDatabaseBackup,
  restoreCompressedDatabaseBackup,
} from "./database-backups.js"
import { createEncryptedPlatformBackup } from "./platform-backups.js"
import { RelayBackupError } from "./effect/errors.js"
import { promiseEffect, recoverPromise } from "./effect/promise.js"
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
  appReplaceLocks,
  appStartLocks,
  backupTaskLocks,
  backupCoverageLocks,
} from "./operation-plans.js"
import { backupPathIsExcluded } from "./backups/exclude.js"
import {
  abandonTarRestore,
  createTarBackup,
  finishTarRestore,
  removeLeftoverTarHelpers,
  restoreTarBackup,
  type TarSource,
} from "./backups/tar-archives.js"
import {
  readTarRestoreJournal,
  readTarRestoreJournals,
  TAR_RESTORE_RECOVERY_LABEL,
  TarRestoreFences,
  type TarRestoreJournal,
} from "./backups/tar-restore-journal.js"
import { DockerEngine } from "./docker-engine.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { backupFailureCode } from "./backups/failure.js"
import {
  backupTaskAttributes,
  type BackupTaskOutcome,
  recordBackupTask,
  recordBackupTaskQueued,
} from "./backups/telemetry.js"
import {
  backupArchivePath,
  backupDestinationFor,
  backupDirectoryPath,
  resticRepositoryString,
} from "./backups/destinations/index.js"
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
  resticRepositoryPath,
  resticSnapshotSelector,
  translateExcludePatterns,
  validateStagingTree,
  type ResticDriver,
  type ResticDriverLocation,
} from "./restic.js"

const MAX_BACKUP_ENTRIES = 100_000
const ZIP_OVERHEAD_RESERVE_BYTES = 64 * 1024 * 1024
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

/** What backups of Apps' folders and their power need of the App driver. */
export interface BackupApps {
  /** The App's folder on the Docker host, or null when it isn't here. */
  hostFolder(appId: string): Promise<string | null>
  isRunning(appId: string): Promise<boolean>
  start(appId: string): Promise<void>
  stop(appId: string): Promise<void>
  /** The managed volumes starting the App mounts, by ID. */
  volumes(appId: string): Promise<ReadonlyArray<string>>
}

/** A managed volume as backups find it, by its ID. */
export interface BackupVolumes {
  ownedAppVolumeIds(
    appId: string
  ): Effect.Effect<ReadonlyArray<string>, unknown>
  find(
    id: string
  ): Effect.Effect<
    Pick<
      RelayVolume,
      "dockerName" | "kind" | "mounts" | "name" | "owner" | "users"
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
        fences,
        lanes: options.lanes,
        restic: createResticDriver({
          cacheDirectory: resolve(
            options.config.dataDirectory,
            "restic",
            "cache"
          ),
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
      // Restores of Apps' folders and volumes a stop or a failed swap left
      // midway, finished or undone, and Apps a stopped backup left stopped,
      // started again. Neither keeps the Relay from starting when Docker
      // can't answer; a restore that can't finish keeps its target fenced.
      yield* manager.#recoverTarRestores()
      yield* manager.#restartStoppedApps()
      yield* state.requeueInterruptedBackupTasks(Date.now())
      yield* promiseEffect(() => sweepExpiredBackupExports(options.config))
      yield* Effect.forkChild(
        Effect.sleep(EXPORT_SWEEP_INTERVAL).pipe(
          Effect.andThen(
            promiseEffect(() => sweepExpiredBackupExports(options.config))
          ),
          Effect.forever
        )
      )
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

  list(updatedAfter?: number) {
    return this.#state
      .listBackupTasks(updatedAfter)
      .pipe(
        Effect.map((tasks) => tasks.filter((task) => task.kind !== "prune"))
      )
  }

  cancel(taskId: string) {
    return Effect.gen({ self: this }, function* () {
      const cancelled = yield* this.#state.cancelBackupTask(taskId, Date.now())
      if (cancelled) this.#activeCreates.get(taskId)?.abort()
      return yield* this.#state.getBackupTask(taskId)
    })
  }

  /**
   * Finishes or abandons a restore of an App's folder or a volume whose swap
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

  /** The restores of Apps' folders and volumes fencing their targets. */
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

  run() {
    return Effect.gen({ self: this }, function* () {
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
                    // A task may name its game server by short ID or name.
                    locks: backupTaskLocks(
                      task.input,
                      (reference) =>
                        /^[a-f0-9]{40}$/u.test(reference)
                          ? reference
                          : recoverPromise(
                              async () =>
                                (await this.#findInstance(reference))?.id ??
                                reference,
                              () => reference
                            ),
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
   * Runs a stopped batch, as backing up an App starts its folder's and each
   * owned volume's: every backup in it within one stopped window, holding
   * all their locks, so the copies agree. The Apps that use any of them stop
   * once, journaled as a single stopped backup's are, and those that ran
   * start again once every archive is taken. Coverage-bearing batches must
   * arrive completely: no fragment may succeed before coverage is checked.
   */
  #runBatch(leader: RelayBackupTask, batch: { id: string; size: number }) {
    return Effect.gen({ self: this }, function* () {
      const members = [leader]
      for (let wait = 0; members.length < batch.size && wait < 20; wait += 1) {
        members.push(
          ...(yield* this.#state.claimBatchBackupTasks(batch.id, Date.now()))
        )
        if (members.length < batch.size) yield* Effect.sleep("250 millis")
      }
      if (
        members.length !== batch.size &&
        members.some(
          (member) => member.input.kind === "create" && member.input.appCoverage
        )
      ) {
        for (const member of members) {
          yield* this.#state.failBackupTask(
            member.taskId,
            "App backup batch is incomplete; no backups were started",
            Date.now()
          )
        }
        return undefined
      }
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
      const window = yield* this.#stoppedWindow(leader, members, lockedApps)
      const run = yield* Effect.result(
        this.#lanes.run(
          { label: "backup.batch", locks },
          Effect.gen({ self: this }, function* () {
            yield* this.#admitAppCoverage(
              members.map((member) => member.input),
              locks
            )
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
        if (
          member.input.kind === "create" &&
          member.input.target.kind === "app"
        ) {
          lockedApps.add(member.input.target.id)
        }
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
            if (member.input.kind !== "create") continue
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
        begin,
        leave: (taskId: string) =>
          Effect.suspend(() => {
            left.add(taskId)
            return finishIfLast
          }),
        lockedApps,
      } satisfies StoppedWindow
    })
  }

  /**
   * Backs up an App's folder or a volume through Docker. Stopped, it stops
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
        const deleting = finalBackupOwner(input.target)
        const other = consumers.find((appId) => appId !== deleting)
        if (other !== undefined) {
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
      if (window && consistency === "stopped") yield* window.begin
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
   * Restores an App's folder or a volume through Docker. Nothing that uses
   * it may run: an App's folder needs the App stopped, and a volume every
   * container that mounts it.
   */
  #restoreTar(
    input: BackupRestoreTaskInput & {
      kind: "restore"
      target: BackupTarget & { kind: "app" | "volume" }
    },
    signal: AbortSignal,
    beginInstall: RestoreInstallGate,
    lockedApps: ReadonlySet<string>
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* this.#requireLockedApps(input.target, lockedApps)
      const { source } = yield* this.#tarSource(input.target, false, true)
      if (input.target.kind === "app") {
        const running = yield* promiseEffect(() =>
          this.#apps!.isRunning(input.target.id)
        )
        if (running) {
          return yield* backupFailure(
            "app_running",
            "restore.preflight",
            "Stop the App before restoring its folder"
          )
        }
      } else {
        const volume = yield* this.#requiredVolume(input.target.id, true)
        const running = volume.mounts.filter((mount) => mount.running)
        if (running.length > 0) {
          return yield* backupFailure(
            "volume_in_use",
            "restore.preflight",
            running.length === 1
              ? `Stop ${running[0]!.container}, which mounts this volume, before restoring it`
              : `Stop the ${running.length} containers that mount this volume before restoring it`
          )
        }
      }
      const temporary = resolve(
        this.#config.dataDirectory,
        "restores",
        `${input.taskId}.tar.gz`
      )
      return yield* Effect.tryPromise({
        try: async () => {
          const archive = await materializeBackupArtifact(
            this.#config,
            input,
            temporary
          )
          return restoreTarBackup({
            archive,
            backupId: input.archive?.backupId ?? input.backupId,
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

  // What Docker mounts for an App's folder or a volume, the Apps a stopped
  // backup stops, and the volume as its manifest records it. A stopped
  // backup of a volume a container other than an App's runs from is
  // refused: Kiln can't stop and start it as its owner would.
  #tarSource(target: BackupTarget, stopping: boolean, restoring = false) {
    return Effect.gen({ self: this }, function* () {
      if (target.kind === "app") {
        if (!this.#apps) {
          return yield* backupFailure(
            "app_driver_unavailable",
            "lookup",
            "The App backup driver is unavailable"
          )
        }
        const folder = yield* promiseEffect(() =>
          this.#apps!.hostFolder(target.id)
        )
        if (!folder) {
          return yield* backupFailure(
            "app_not_found",
            "lookup",
            "The App no longer exists on this Relay"
          )
        }
        return {
          consumers: [target.id],
          manifestVolume: null,
          source: { kind: "bind", path: folder } satisfies TarSource,
        }
      }
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
          kind: volume.kind === "app" ? ("app" as const) : ("kiln" as const),
          name: volume.name,
        },
        source: { kind: "volume", name: volume.dockerName } satisfies TarSource,
      }
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
    const owner = /^([a-f0-9]{40})\//u.exec(volumeId)?.[1]
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
      return [
        ...new Set([
          ...(owner ? [owner] : []),
          ...(volume?.users.map((user) => user.appId) ?? []),
        ]),
      ]
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
              `App ${entry.appId.slice(0, 8)} couldn't be started again after the backup: ${backupErrorMessage(started.failure)}`
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
   * Settles every restore of an App's folder or a volume a stop or a failed
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
              "An unfinished volume or App folder restore couldn't be settled; its target stays fenced",
              { cause, taskId: journal.taskId }
            )
          )
        )
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Couldn't settle unfinished volume and App folder restores",
          { cause }
        )
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
      let locks: ReadonlyArray<LaneLock>
      if (target.kind === "app") {
        locks = appReplaceLocks(target.id)
      } else {
        const apps = new Set([
          ...journal.consumers,
          ...(yield* this.#volumeApps(target.id)),
        ])
        locks = [
          exclusive(laneKeys.volume(target.id)),
          ...[...apps].flatMap((appId) => appLifecycleLocks(appId)),
        ]
      }
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
            yield* this.#state.completeRecoveredRestore(
              journal.taskId,
              Date.now(),
              stopApps ? "Finished when asked, after its swap stopped" : null
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
      if (target.kind === "app") {
        const found = yield* promiseEffect(() =>
          this.#apps!.hostFolder(target.id)
        )
        if (
          found &&
          (yield* promiseEffect(() => this.#apps!.isRunning(target.id)))
        ) {
          runningApps.push(target.id)
        }
      } else {
        const volume = yield* this.#requiredVolume(target.id, true)
        for (const mount of volume.mounts) {
          if (!mount.running) continue
          if (mount.kind === "app" && mount.resourceId) {
            runningApps.push(mount.resourceId)
          } else others.push(mount.container)
        }
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

  // The batch's target locks are already held. Take only the missing
  // lifecycle locks as a nested operation, so a queued replacement waiting
  // on this batch cannot deadlock admission. Release them before copying or
  // uploading: later deployments may change the inventory after this start.
  #admitAppCoverage(
    inputs: ReadonlyArray<BackupTaskInput>,
    held: ReadonlyArray<LaneLock>
  ) {
    const byApp = new Map<string, BackupTaskInput>()
    for (const input of inputs) {
      if (input.kind === "create" && input.appCoverage) {
        byApp.set(input.appCoverage.appId, input)
      }
    }
    const locks = [...byApp.values()]
      .flatMap(backupCoverageLocks)
      .filter(
        (lock) =>
          !held.some(
            (current) =>
              current.key === lock.key && current.mode === "exclusive"
          )
      )
    const validate = Effect.forEach(
      byApp.values(),
      (input) => this.#validateAppCoverage(input),
      { discard: true }
    )
    return locks.length === 0
      ? validate
      : this.#lanes.runNested({ label: "backup.coverage", locks }, validate)
  }

  #validateAppCoverage(input: BackupTaskInput) {
    return Effect.gen({ self: this }, function* () {
      if (input.kind !== "create" || !input.appCoverage) return
      const { appId, volumeIds } = input.appCoverage
      const owned = this.#volumes
        ? yield* this.#volumes.ownedAppVolumeIds(appId)
        : null
      const projected = new Set(volumeIds)
      if (
        !owned ||
        owned.length !== projected.size ||
        owned.some((id) => !projected.has(id))
      ) {
        return yield* backupFailure(
          "volume_users_changed",
          "lookup",
          "App backup coverage changed; waiting for Hearth to refresh the schedule"
        )
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
      if (!window) yield* this.#admitAppCoverage([task.input], [])
      const createSignal = signal
      if (task.input.kind === "export") {
        const result = yield* runResticExport(
          this.#config,
          this.#restic,
          this.#findInstance,
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
        if (target.kind === "app" || target.kind === "volume") {
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
              materializeBackupArtifact(this.#config, input, temporary),
            catch: (cause) =>
              RelayBackupError.make({
                code: "database_restore_download_failed",
                operation: "restore.database.verify",
                reason: backupErrorMessage(cause),
                cause,
              }),
          })
          const result = yield* Effect.tryPromise({
            try: () =>
              restoreCompressedDatabaseBackup(
                this.#databases!,
                input.target.id,
                artifact
              ),
            catch: (cause) =>
              RelayBackupError.make({
                code: "database_restore_failed",
                operation: "restore.database",
                reason: backupErrorMessage(cause),
                cause,
              }),
          }).pipe(
            Effect.ensuring(
              input.source.kind === "remote"
                ? promiseEffect(() => rm(temporary, { force: true })).pipe(
                    Effect.ignore
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
        const result = yield* input.source.kind === "restic"
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
        const result = yield* Effect.tryPromise({
          try: () =>
            createEncryptedPlatformBackup(
              this.#config,
              input,
              destination,
              progress,
              createSignal
            ),
          catch: (cause) =>
            RelayBackupError.make({
              code: "platform_backup_failed",
              operation: "create.platform",
              reason: backupErrorMessage(cause),
              cause,
            }),
        }).pipe(
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
        input.artifactKind === "restic_snapshot" &&
        input.target.kind === "instance"
      ) {
        const destination = input.destination
        const result = yield* runResticCreate(
          this.#config,
          this.#restic,
          this.#findInstance,
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
                this.#state.scheduleBackupPrune(prune, Date.now())
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
 * The stopped window a batch's backups share: `begin` stops what uses any
 * of them, once; `arrive` waits, once a backup's archive is taken, until
 * every backup's is, then answers the warnings starting things again left;
 * `leave` counts a backup that won't arrive, as one that failed first.
 */
interface StoppedWindow {
  readonly arrive: (taskId: string) => Effect.Effect<ReadonlyArray<string>>
  readonly begin: Effect.Effect<void, unknown>
  readonly leave: (taskId: string) => Effect.Effect<void>
  readonly lockedApps: ReadonlySet<string>
}

// The batch a claimed task opens a stopped window for, if any.
function stoppedBatch(
  task: RelayBackupTask
): { id: string; size: number } | null {
  return task.input.kind === "create" &&
    (task.input.consistency === "stopped" || task.input.appCoverage) &&
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
    ...(route.primary ? { primary: true as const } : {}),
    ...(route.redirect ? { redirect: route.redirect } : {}),
    ...(route.www === "none" ? {} : { www: route.www }),
  }
}

async function instanceBackupManifest(
  config: RelayConfig,
  input: BackupCreateTaskInput,
  instance: RelayInstanceConfig,
  webRoutes: ReadonlyArray<RelayInstanceWebRoute>
): Promise<BackupArchiveManifest> {
  const recipe = instance.brickSnapshotSha256
    ? await readBrickSnapshot(
        brickSnapshotDirectory(config.dataDirectory),
        instance.brickSnapshotSha256
      )
    : null
  return {
    artifactKind: "archive",
    backupId: input.backupId,
    createdAt: new Date().toISOString(),
    formatVersion: 3,
    mode: "full",
    server: {
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
        tailscale: instance.tailscale,
        variables: instance.variables ?? {},
      },
      version: instance.version,
    },
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
    return { ...result, artifacts: outcomes }
  })
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
  return backupDestinationFor("s3").saveFullBackup({
    backupId: input.backupId,
    config,
    destination: input.destination,
    onChunk,
    result,
    signal,
  })
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

export async function removeResticRepository(
  config: RelayConfig,
  targetId: string
): Promise<void> {
  await rm(resticRepositoryPath(config, targetId), {
    force: true,
    recursive: true,
  })
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
  findInstance: (instanceId: string) => Promise<RelayInstanceConfig | null>,
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
    const instance = yield* Effect.tryPromise({
      try: () => findInstance(input.target.id),
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
    const result = yield* Effect.tryPromise({
      try: () =>
        createResticSnapshot(
          config,
          restic,
          input,
          instance,
          password,
          progress,
          signal
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
    return result
  })
}

async function createResticSnapshot(
  config: RelayConfig,
  restic: ResticDriver,
  input: BackupCreateTaskInput,
  instance: RelayInstanceConfig,
  password: string,
  progress: BackupProgress,
  signal: AbortSignal
): Promise<BackupResticCreateTaskResult> {
  const location = resticDriverLocation(
    config,
    input.target.id,
    input.destination.kind === "restic"
      ? input.destination.repository
      : undefined
  )
  const translated = translateExcludePatterns([
    ...DEFAULT_EXCLUDES,
    ...input.exclude,
  ])
  const exists = await restic.catConfig({ location, password, signal })
  if (exists === "missing") await restic.init({ location, password, signal })
  const existing = await restic.snapshotsByTag({
    location,
    password,
    signal,
    tag: `task:${input.taskId}`,
  })
  const reuse = existing[0]
  if (reuse) {
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
        ...translated.warnings,
        // restic's report of files it couldn't read went with the process.
        "Recovered after the Relay restarted, so files restic couldn't read, if any, aren't listed",
      ],
    }
  }
  if (location.kind === "local") {
    // Worst case a snapshot stores one full compressed copy of the instance;
    // deduplicated runs use far less, so this is a conservative preflight.
    await mkdir(location.path, { recursive: true, mode: 0o700 })
    await requireBackupSpace(
      location.path,
      await directoryLogicalBytes(
        resolve(config.rootDirectory, instance.directory),
        signal
      ),
      input.maxBytes
    )
  }
  const summary = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          restic.backup({
            cwd: config.rootDirectory,
            excludes: translated.excludes,
            location,
            onProgress: (update) => {
              progress.completed = update.bytesCompleted
              progress.total = update.bytesTotal ?? progress.total
              if (input.maxBytes !== null && progress.total > input.maxBytes) {
                throw backupTooLarge()
              }
            },
            password,
            path: instance.directory,
            signal,
            tags: [`task:${input.taskId}`, `backup:${input.backupId}`],
          }),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(summary)) {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          forgetTaskSnapshotsAfterFailedCreate(restic, {
            backupId: input.backupId,
            location,
            password,
            tag: `task:${input.taskId}`,
            taskId: input.taskId,
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
  await rejectOverLimitSnapshot(restic, {
    backupId: input.backupId,
    location,
    maxBytes: input.maxBytes,
    password,
    snapshotId: summary.success.snapshotId,
    taskId: input.taskId,
    totalBytes: summary.success.totalBytesProcessed,
  })
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
    warnings: [...translated.warnings, ...summary.success.warnings],
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

async function forgetTaskSnapshotsAfterFailedCreate(
  restic: ResticDriver,
  input: {
    backupId: string
    location: ResticDriverLocation
    password: string
    tag: string
    taskId: string
  }
): Promise<void> {
  const signal = AbortSignal.timeout(RESTIC_RECOVERY_TIMEOUT_MS)
  const snapshots = await restic.snapshotsByTag({
    location: input.location,
    password: input.password,
    signal,
    tag: input.tag,
  })
  for (const snapshot of snapshots) {
    await restic.forget({
      location: input.location,
      password: input.password,
      signal,
      snapshotId: snapshot.id,
    })
  }
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
                    location: resticDriverLocation(
                      config,
                      input.target.id,
                      source.repository
                    ),
                    password,
                    signal,
                    snapshotId: source.snapshotId,
                  })
                ).totalSize
              )
              await restic.restore({
                location: resticDriverLocation(
                  config,
                  input.target.id,
                  source.repository
                ),
                password,
                selector: resticSnapshotSelector(
                  source.snapshotId,
                  instance.directory
                ),
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
            targetId: input.target.id,
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
    yield* Effect.tryPromise({
      try: async () => {
        if (destination.createTaskId) {
          const snapshots = await restic.snapshotsByTag({
            location,
            password,
            signal,
            tag: `task:${destination.createTaskId}`,
          })
          for (const snapshot of snapshots) {
            await restic.forget({
              location,
              password,
              signal,
              snapshotId: snapshot.id,
            })
          }
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
    })
    yield* promiseEffect(() => removeBackupExport(config, input.backupId))
    return {
      prune: resticPruneFor(config, {
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
    (code.startsWith("storage_") || code.startsWith("repository_"))
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
    repositoryKey: resticRepositoryString(
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
  findInstance: (instanceId: string) => Promise<RelayInstanceConfig | null>,
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
    const instance = yield* Effect.tryPromise({
      try: () => findInstance(input.target.id),
      catch: (cause) =>
        RelayBackupError.make({
          code: "instance_lookup_failed",
          operation: "export.lookup",
          reason: "The export target could not be loaded",
          cause,
        }),
    })
    if (!instance) {
      return yield* backupFailure(
        "instance_not_found",
        "export.lookup",
        "The export target no longer exists on this Relay"
      )
    }
    const destination = backupExportPath(config, input.backupId)
    const partial = backupExportPartialPath(config, input.backupId, taskId)
    const existing = yield* promiseEffect(() =>
      reuseValidExport(destination, Date.now() + input.ttlMs)
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
    const result = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(backupExportDirectoryPath(config), {
          recursive: true,
          mode: 0o700,
        })
        await rm(partial, { force: true })
        const stats = await restic.stats({
          location: resticDriverLocation(
            config,
            input.target.id,
            input.repository
          ),
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
        const dumped = await restic.dumpZip({
          destination: partial,
          location: resticDriverLocation(
            config,
            input.target.id,
            input.repository
          ),
          onProgress: (bytes) => {
            progress.completed = bytes
          },
          password,
          selector: resticSnapshotSelector(
            input.snapshotId,
            instance.directory
          ),
          signal,
        })
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
          filename: backupArtifactFilename(input.backupId, "restic_snapshot"),
          warnings: [],
        } satisfies BackupExportTaskResult
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
  expiresAt: number
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
    filename: backupArtifactFilename(
      /([0-9a-f-]{36})\.zip$/iu.exec(basename(destination))?.[1] ??
        basename(destination).replace(/\.zip$/u, ""),
      "restic_snapshot"
    ),
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
  const filesystem = await statfs(directory)
  const available = BigInt(filesystem.bavail) * BigInt(filesystem.bsize)
  const estimate = BigInt(logicalBytes + ZIP_OVERHEAD_RESERVE_BYTES)
  const required =
    maxBytes === null
      ? estimate
      : estimate < BigInt(maxBytes)
        ? estimate
        : BigInt(maxBytes)
  if (available < required) {
    throw RelayBackupError.make({
      code: "insufficient_space",
      operation,
      reason: "The Relay does not have enough free space to stage this backup",
    })
  }
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

// The resource a final backup's deletion is of, the only App it may find
// using what it backs up: the App itself, or the App whose Compose project
// made the volume. A Kiln volume being deleted has none.
function finalBackupOwner(target: BackupTarget): string | null {
  if (target.kind === "app") return target.id
  if (target.kind !== "volume") return null
  return /^([a-f0-9]{40})\//u.exec(target.id)?.[1] ?? null
}
