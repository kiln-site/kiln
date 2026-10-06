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
import { Effect, Fiber, Queue, Result } from "effect"
import { minimatch } from "minimatch"
import ZipStream from "zip-stream"

import {
  backupArtifactFilename,
  type BackupArchiveCreateTaskResult,
  type BackupArchiveManifest,
  type BackupCreateTaskInput,
  type BackupCreateTaskResult,
  type BackupDeleteTaskInput,
  type BackupExportTaskResult,
  type BackupResticCreateTaskResult,
  type BackupTaskInput,
  type BackupTaskPhase,
  type BackupTaskResult,
  type RelayBackupTask,
  type RelayInstanceWebRoute,
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
import { promiseEffect } from "./effect/promise.js"
import { RelayStateStore } from "./effect/state.js"
import {
  backupArchivePath,
  backupDestinationFor,
  backupDirectoryPath,
} from "./backups/destinations/index.js"
import {
  installPreparedInstanceRestore,
  materializeBackupArtifact,
  prepareInstanceRestoreStaging,
  recoverInterruptedRestores,
  requireRestoreSpace,
  restorePortableInstanceBackup,
  settleRestoreJournal,
} from "./backup-restore.js"
import {
  createResticDriver,
  requiredRepositoryPassword,
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
const RESTIC_RECOVERY_PRUNE_TIMEOUT_MS = 30_000
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

export class BackupManager {
  readonly #config: RelayConfig
  readonly #findInstance: (
    instanceId: string
  ) => Promise<RelayInstanceConfig | null>
  readonly #isInstanceStopped: (instanceId: string) => Promise<boolean>
  readonly #databases: DatabaseDriver | null
  readonly #restic: ResticDriver
  readonly #state: RelayStateStore["Service"]
  readonly #wake: Queue.Queue<void>
  readonly #activeCreates = new Map<string, AbortController>()

  private constructor(options: {
    config: RelayConfig
    findInstance: (instanceId: string) => Promise<RelayInstanceConfig | null>
    isInstanceStopped: (instanceId: string) => Promise<boolean>
    databases: DatabaseDriver | null
    restic: ResticDriver
    state: RelayStateStore["Service"]
    wake: Queue.Queue<void>
  }) {
    this.#config = options.config
    this.#findInstance = options.findInstance
    this.#isInstanceStopped = options.isInstanceStopped
    this.#databases = options.databases
    this.#restic = options.restic
    this.#state = options.state
    this.#wake = options.wake
  }

  static make(options: {
    config: RelayConfig
    findInstance: (instanceId: string) => Promise<RelayInstanceConfig | null>
    isInstanceStopped: (instanceId: string) => Promise<boolean>
    databases?: DatabaseDriver
  }) {
    return Effect.gen(function* () {
      const state = yield* RelayStateStore
      const wake = yield* Queue.unbounded<void>()
      const manager = new BackupManager({
        config: options.config,
        findInstance: options.findInstance,
        isInstanceStopped: options.isInstanceStopped,
        databases: options.databases ?? null,
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

  #drain() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const task = yield* this.#state.claimNextBackupTask(Date.now())
        if (!task) return
        const controller = new AbortController()
        this.#activeCreates.set(task.taskId, controller)
        const current = yield* this.#state.getBackupTask(task.taskId)
        if (!current || current.status !== "running") controller.abort()
        const timeoutFiber = yield* Effect.forkChild(
          Effect.sleep(this.#config.backupTimeoutMs).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                task.kind === "create"
                  ? this.#state.cancelBackupTask(
                      task.taskId,
                      Date.now(),
                      BACKUP_TIMEOUT_REASON
                    )
                  : this.#state.failBackupTask(
                      task.taskId,
                      BACKUP_TIMEOUT_REASON,
                      Date.now()
                    )
              )
            ),
            Effect.tap((stopped) =>
              stopped ? Effect.sync(() => controller.abort()) : Effect.void
            ),
            Effect.asVoid
          )
        )
        yield* this.#execute(task, controller.signal).pipe(
          Effect.catch((cause) =>
            this.#state
              .failBackupTask(
                task.taskId,
                backupErrorMessage(cause),
                Date.now()
              )
              .pipe(
                Effect.tap((failed) =>
                  failed
                    ? Effect.logError("Relay backup task failed", {
                        backupId: task.backupId,
                        cause,
                        taskId: task.taskId,
                      })
                    : Effect.void
                ),
                Effect.asVoid
              )
          ),
          Effect.ensuring(
            timeoutFiber ? Fiber.interrupt(timeoutFiber) : Effect.void
          ),
          Effect.ensuring(
            controller
              ? Effect.sync(() => this.#activeCreates.delete(task.taskId))
              : Effect.void
          )
        )
      }
    })
  }

  #execute(task: RelayBackupTask, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const createSignal = signal ?? new AbortController().signal
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
              createSignal
            )
          : Effect.tryPromise({
              try: () =>
                restorePortableInstanceBackup(
                  this.#config,
                  { ...input, kind: "restore" },
                  instance
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
        const result =
          task.input.destination.kind === "restic"
            ? yield* runResticForget(
                this.#config,
                this.#restic,
                task.input,
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
                createSignal,
                () => createSignal
              )
            : yield* deleteBackupArtifacts(
                this.#config,
                task.input,
                (currentArtifactId, progress) =>
                  this.#state.updateBackupTaskOperationProgress(
                    task.taskId,
                    currentArtifactId,
                    progress,
                    nextDeleteUpdatedAt()
                  )
              )
        const completed = yield* this.#state.completeBackupTask(
          task.taskId,
          result,
          nextDeleteUpdatedAt()
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
              () => Effect.succeed(false),
              AbortSignal.timeout(RESTIC_RECOVERY_TIMEOUT_MS),
              () => AbortSignal.timeout(RESTIC_RECOVERY_PRUNE_TIMEOUT_MS)
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
  const maximumBytes = [input.destination, ...(input.replicas ?? [])].reduce<
    number | null
  >((limit, destination) => {
    if (destination.kind === "restic") return limit
    const destinationLimit = backupDestinationFor(
      destination.kind
    ).maximumFullBackupBytes
    if (destinationLimit === null) return limit
    return Math.min(limit ?? destinationLimit, destinationLimit)
  }, input.maxBytes)
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
        webRoutes: [...webRoutes],
      },
      startup: {
        limits: instance.limits,
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
          status: "failed",
        })
      }
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
      return yield* backupFailure(
        "backup_storage_failed",
        "create.store",
        "The backup archive could not be stored in any destination"
      )
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
    const outcomes: Array<{
      artifactId: string
      error: string | null
      status: "deleted" | "failed"
    }> = []
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
  return destination.kind === "local"
    ? backupDestinationFor("local").deleteFullBackup({
        backupId: input.backupId,
        config,
        destination,
      })
    : backupDestinationFor("s3").deleteFullBackup({
        backupId: input.backupId,
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
      warnings: translated.warnings,
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
    warnings: translated.warnings,
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
  await pruneResticAfterRecovery(restic, input)
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
  if (snapshots.length > 0) await pruneResticAfterRecovery(restic, input)
}

async function pruneResticAfterRecovery(
  restic: ResticDriver,
  input: {
    backupId: string
    location: ResticDriverLocation
    password: string
    taskId: string
  }
): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        restic.prune({
          location: input.location,
          password: input.password,
          signal: AbortSignal.timeout(RESTIC_RECOVERY_PRUNE_TIMEOUT_MS),
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Could not prune restic recovery data", {
          backupId: input.backupId,
          cause,
          taskId: input.taskId,
        })
      )
    )
  )
}

function runResticRestore(
  config: RelayConfig,
  restic: ResticDriver,
  input: Extract<BackupTaskInput, { kind: "restore" }>,
  instance: RelayInstanceConfig,
  signal: AbortSignal
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
              await installPreparedInstanceRestore(prepared)
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

function runResticForget(
  config: RelayConfig,
  restic: ResticDriver,
  input: BackupDeleteTaskInput & { kind: "delete" },
  updateProgress: (
    progress: BackupProgress
  ) => ReturnType<RelayStateStore["Service"]["updateBackupTaskProgress"]>,
  signal: AbortSignal,
  pruneSignal: () => AbortSignal
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
    const pruned = yield* Effect.result(
      runResticPrune(
        config,
        restic,
        {
          backupId: randomUUID(),
          kind: "prune",
          repository: destination.repository,
          repositoryPassword: password,
          target: input.target,
          taskId: randomUUID(),
        },
        updateProgress,
        pruneSignal()
      )
    )
    if (Result.isFailure(pruned)) {
      yield* Effect.logError(
        "Could not prune restic after forgetting a snapshot",
        {
          backupId: input.backupId,
          cause: pruned.failure,
          taskId: input.taskId,
        }
      )
    }
    return {
      artifacts: input.destination.artifactId
        ? [
            {
              artifactId: input.destination.artifactId,
              error: null,
              status: "deleted" as const,
            },
          ]
        : undefined,
      warnings: Result.isFailure(pruned)
        ? ["The snapshot was deleted, but unused repository data remains"]
        : [],
    }
  })
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
      Effect.sync(() => {
        console.error("restic cache cleanup failed", cause)
      })
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

function backupPathIsExcluded(
  path: string,
  directory: boolean,
  patterns: ReadonlyArray<string>
): boolean {
  let excluded = false
  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const negated = trimmed.startsWith("!")
    const pattern = negated ? trimmed.slice(1) : trimmed
    if (!pattern) continue
    const candidate = directory ? `${path}/` : path
    const matched = minimatch(candidate, pattern, {
      dot: true,
      matchBase: !pattern.includes("/"),
      nocase: false,
    })
    if (matched) excluded = !negated
  }
  return excluded
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
