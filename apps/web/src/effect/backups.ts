import { randomBytes, randomUUID } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import type {
  BackupCreateTaskInput,
  BackupDeleteTaskInput,
  BackupRestoreTaskInput,
  BackupTaskPhase,
  BackupTaskStatus,
  BackupTargetKind,
  RelayBackupTask,
} from "@workspace/contracts"
import {
  backupArtifactFilename,
  BACKUP_EXPORT_TTL_MAX_MS,
  BACKUP_EXPORT_TTL_MIN_MS,
  isArchiveCreateTaskResult,
  isResticCreateTaskResult,
  resticS3BucketSchema,
  resticS3RegionSchema,
} from "@workspace/contracts"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import type { DatabaseTransaction } from "@/effect/database"
import {
  BackupLimitError,
  BackupStorageError,
  CredentialError,
} from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets, kilnInstallationId } from "@/lib/environment"
import {
  backupObjectKey,
  deleteS3BackupPrefix,
  isSafeResticObjectPrefix,
  RESTIC_OBJECT_PREFIX_ERROR,
  resticRepositoryObjectPrefix,
} from "@/backups/destinations/s3"
import { loadBackupStorageCredentialEffect } from "@/backups/destinations/s3"

const RESTIC_REPOSITORY_PASSWORD_PURPOSE = "kiln-restic-repository-password"

interface BackupPolicyRow extends RowDataPacket {
  admin_quantity_limit: number | null
  admin_size_limit_bytes: number | string | null
  exclude_patterns: unknown
  quantity_limit: number | null
  size_limit_bytes: number | string | null
  storage_id: string | null
}

interface BackupStorageKeyRow extends RowDataPacket {
  bucket: string
  deleting: boolean | number
  enabled: boolean | number
  endpoint: string
  id: string
  object_prefix: string
  owner_user_id: string | null
  region: string
}

interface BackupArtifactRow extends RowDataPacket {
  backup_id: string
  bytes: number | string | null
  checksum_sha256: string | null
  error: string | null
  filename: string | null
  id: string
  object_key: string | null
  status: "available" | "deleted" | "deleting" | "failed" | "queued" | "running"
  storage_id: string | null
}

interface BackupCopyTaskRow extends RowDataPacket {
  artifact_kind: BackupRow["artifact_kind"]
  backup_id: string
  backup_bytes: number | string | null
  backup_checksum_sha256: string | null
  destination_artifact_id: string
  destination_object_key: string
  destination_storage_id: string
  filename: string
  relay_id: string
  requested_by: string
  source_artifact_id: string
  source_bytes: number | string | null
  source_checksum_sha256: string | null
  source_object_key: string | null
  source_storage_id: string | null
  target_id: string
  target_kind: BackupRow["target_kind"]
  task_id: string
}

interface BackupUsageRow extends RowDataPacket {
  quantity_used: number | string
  size_used: number | string
}

interface BackupRow extends RowDataPacket {
  artifact_kind:
    | "archive"
    | "database_dump"
    | "platform_bundle"
    | "restic_snapshot"
  backup_mode: "full" | "incremental"
  bytes: number | string | null
  checksum_sha256: string | null
  completed_at_ms: number | string | null
  created_by: string | null
  created_at_ms: number | string
  filename: string | null
  id: string
  name: string
  reason: "final_delete" | "manual" | "pre_restore" | "scheduled"
  relay_id: string
  object_key: string | null
  repository_id: string | null
  restic_snapshot_id: string | null
  storage_id: string | null
  status: "available" | "deleted" | "deleting" | "failed" | "queued" | "running"
  target_id: string
  target_kind: "database" | "instance" | "platform"
  task_error: string | null
  task_bytes_completed: number | string
  task_bytes_total: number | string | null
  task_current_artifact_id: string | null
  task_current_path: string | null
  task_id: string
  task_kind: "create" | "delete" | "export" | "restore"
  task_phase: BackupTaskPhase | null
  task_started_at_ms: number | string | null
  task_status: "cancelled" | "failed" | "queued" | "running" | "succeeded"
  task_updated_at_ms: number | string
  warnings: unknown
}

interface DispatchableBackupRow extends RowDataPacket {
  artifact_kind: BackupRow["artifact_kind"]
  backup_id: string
  backup_mode: BackupRow["backup_mode"]
  bytes: number | string | null
  checksum_sha256: string | null
  create_task_id: string | null
  exclude_patterns: unknown
  object_key: string | null
  reason: BackupCreateTaskInput["reason"]
  repository_id: string | null
  reserved_bytes: number | string | null
  restic_snapshot_id: string | null
  storage_id: string | null
  target_id: string
  target_kind: BackupRow["target_kind"]
  task_created_at_ms: number | string
  task_id: string
  task_kind: "create" | "delete" | "export" | "restore"
}

interface KnownBackupTaskRow extends RowDataPacket {
  backup_status: BackupRow["status"]
  bytes_completed: number | string
  id: string
  relay_updated_at_ms: number | string | null
  status: BackupTaskStatus
}

interface ScheduledBackupRepositoryRow extends RowDataPacket {
  id: string
}

interface BackupTaskReconcileState {
  bytesCompleted: number
  relayUpdatedAt: number | null
  status: BackupTaskStatus
}

interface FinalInstanceDeletionRow extends RowDataPacket {
  backup_id: string
  backup_status: BackupRow["status"]
  error: string | null
  relay_id: string
  requested_by: string
  status: "backing_up" | "completed" | "deleting" | "failed"
  target_id: string
  task_error: string | null
}

type FinalDatabaseDeletionRow = FinalInstanceDeletionRow

export interface FinalInstanceDeletion {
  backupId: string
  backupStatus: BackupRow["status"]
  error: string | null
  relayId: string
  requestedBy: string
  status: FinalInstanceDeletionRow["status"]
  targetId: string
  taskError: string | null
}

export type FinalDatabaseDeletion = FinalInstanceDeletion

export interface BackupCatalogRecord {
  artifacts: Array<BackupArtifactRecord>
  artifactKind: BackupRow["artifact_kind"]
  backupMode: BackupRow["backup_mode"]
  bytes: number | null
  checksumSha256: string | null
  completedAt: string | null
  createdBy: string | null
  createdAt: string
  filename: string | null
  id: string
  name: string
  objectKey: string | null
  reason: BackupRow["reason"]
  relayId: string
  resticSnapshotId: string | null
  status: BackupRow["status"]
  storageId: string | null
  targetId: string
  targetKind: BackupRow["target_kind"]
  taskBytesCompleted: number
  taskBytesTotal: number | null
  taskCurrentArtifactId: string | null
  taskCurrentPath: string | null
  taskError: string | null
  taskId: string
  taskKind: BackupRow["task_kind"]
  taskPhase: BackupTaskPhase | null
  taskStartedAt: string | null
  taskStatus: BackupRow["task_status"]
  taskUpdatedAt: string
  warnings: Array<string>
}

export interface BackupArtifactRecord {
  bytes: number | null
  checksumSha256: string | null
  error: string | null
  filename: string | null
  id: string
  objectKey: string | null
  status: BackupArtifactRow["status"]
  storageId: string | null
}

export interface ClaimedBackupCopyTask {
  artifactKind: BackupRow["artifact_kind"]
  backupId: string
  bytes: number | null
  checksumSha256: string | null
  destinationArtifactId: string
  destinationObjectKey: string
  destinationStorageId: string
  filename: string
  relayId: string
  requestedBy: string
  sourceArtifactId: string
  sourceObjectKey: string | null
  sourceStorageId: string | null
  targetId: string
  targetKind: BackupRow["target_kind"]
  taskId: string
}

export interface BackupDispatchArtifact {
  artifactId: string
  objectKey: string | null
  storageId: string | null
}

export interface BackupPolicy {
  adminQuantityLimit: number | null
  adminSizeLimitBytes: number | null
  exclude: Array<string>
  quantityLimit: number | null
  sizeLimitBytes: number | null
  storageId: string | null
}

export interface BackupCreateDispatch extends Omit<
  BackupCreateTaskInput,
  "destination" | "replicas"
> {
  artifacts: Array<BackupDispatchArtifact>
  kind: "create"
  repositoryPassword?: string
}

export interface BackupDeleteDispatch extends Omit<
  BackupDeleteTaskInput,
  "destination" | "replicas"
> {
  artifacts: Array<BackupDispatchArtifact>
  createTaskId?: string
  kind: "delete"
  repositoryPassword?: string
  snapshotId?: string
}

export interface BackupRestoreDispatch {
  artifactId: string
  backupId: string
  bytes?: number
  checksumSha256?: string
  kind: "restore"
  objectKey: string | null
  repositoryPassword?: string
  snapshotId?: string
  storageId: string | null
  target: BackupRestoreTaskInput["target"]
  taskId: string
}

export interface BackupExportDispatch {
  backupId: string
  kind: "export"
  repositoryPassword?: string
  snapshotId: string
  target: { id: string; kind: "instance" }
  taskId: string
  ttlMs: number
}

export type BackupDispatch =
  | BackupCreateDispatch
  | BackupDeleteDispatch
  | BackupExportDispatch
  | BackupRestoreDispatch

const reserveBackupCreateEffect = Effect.fn("backups.reserveCreate")(
  function* (input: {
    artifactKind: BackupCreateTaskInput["artifactKind"]
    backupId: string
    createdBy: string
    exclude: ReadonlyArray<string>
    mode?: BackupCreateTaskInput["mode"]
    name: string
    reason?: BackupCreateTaskInput["reason"]
    relayId: string
    requestedMaxBytes: number | null
    storageId?: string | null
    storageIds?: ReadonlyArray<string | null>
    targetId: string
    targetKind: BackupCreateTaskInput["target"]["kind"]
    taskId: string
  }) {
    const database = yield* Database
    return yield* database.transaction("backup_reserve", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `INSERT IGNORE INTO ${databaseTable("backup_policy")}
            (relay_id, target_kind, target_id, exclude_patterns)
           VALUES (?, ?, ?, ?)`,
          [
            input.relayId,
            input.targetKind,
            input.targetId,
            JSON.stringify(input.exclude),
          ]
        )
        const policies = yield* transaction.queryRows<BackupPolicyRow>(
          `SELECT exclude_patterns, quantity_limit, size_limit_bytes, storage_id,
                  admin_quantity_limit, admin_size_limit_bytes
             FROM ${databaseTable("backup_policy")}
            WHERE relay_id = ? AND target_kind = ? AND target_id = ?
            FOR UPDATE`,
          [input.relayId, input.targetKind, input.targetId]
        )
        const policy = policies[0]
        if (!policy) return yield* Effect.die("Backup policy was not created")
        if (input.reason === "final_delete") {
          const activeRestores =
            yield* transaction.queryRows<KnownBackupTaskRow>(
              `SELECT task.id
                 FROM ${databaseTable("backup_task")} task
                 JOIN ${databaseTable("backup")} backup ON backup.id = task.backup_id
                WHERE backup.relay_id = ?
                  AND backup.target_kind = ?
                  AND backup.target_id = ?
                  AND task.task_kind = 'restore'
                  AND task.status IN ('queued', 'running')
                LIMIT 1`,
              [input.relayId, input.targetKind, input.targetId]
            )
          if (activeRestores[0]) {
            return yield* BackupStorageError.make({
              code: "restore_in_progress",
              operation: "backup.finalDelete",
              reason:
                "Wait for the active restore before deleting this resource",
            })
          }
        } else {
          yield* refuseIfFinalDeletionInProgress(transaction, {
            operation: "backup.reserve",
            relayId: input.relayId,
            targetId: input.targetId,
            targetKind: input.targetKind,
          })
        }
        const mode =
          input.reason === "pre_restore" ||
          input.reason === "final_delete" ||
          input.targetKind !== "instance"
            ? "full"
            : (input.mode ?? "incremental")
        const artifactKind =
          mode === "incremental" ? "restic_snapshot" : input.artifactKind
        const requestedStorageIds = deduplicateStorageIds(
          input.storageIds ?? [
            input.storageId === undefined ? policy.storage_id : input.storageId,
          ]
        )
        if (mode === "incremental" && requestedStorageIds.length !== 1) {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "backup.reserve",
            reason: "Incremental backups require exactly one destination",
          })
        }
        const selectedStorageIds = requestedStorageIds
        if (selectedStorageIds.length === 0) {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "backup.reserve",
            reason: "Choose at least one backup destination",
          })
        }
        const lockedStorage = yield* lockBackupStorageRows(
          transaction,
          selectedStorageIds.filter(
            (storageId): storageId is string => storageId !== null
          )
        )
        const artifacts: Array<BackupDispatchArtifact> = []
        for (const storageId of selectedStorageIds) {
          const storage = storageId ? lockedStorage.get(storageId) : undefined
          if (
            storageId &&
            (!storage ||
              !storage.enabled ||
              Boolean(storage.deleting) ||
              (storage.owner_user_id !== null &&
                storage.owner_user_id !== input.createdBy))
          ) {
            return yield* BackupStorageError.make({
              code: "storage_unavailable",
              operation: "backup.reserve",
              reason: "A selected backup destination is unavailable",
            })
          }
          if (mode === "incremental" && storage) {
            const incrementalLocationError =
              incrementalStorageLocationError(storage)
            if (incrementalLocationError) {
              return yield* BackupStorageError.make({
                code: "storage_unavailable",
                operation: "backup.reserve",
                reason: incrementalLocationError,
              })
            }
          }
          artifacts.push({
            artifactId: randomUUID(),
            objectKey:
              storage && mode !== "incremental"
                ? backupObjectKey({
                    artifactKind,
                    backupId: input.backupId,
                    installationId: kilnInstallationId(),
                    objectPrefix: storage.object_prefix,
                    relayId: input.relayId,
                    targetId: input.targetId,
                    targetKind: input.targetKind,
                  })
                : null,
            storageId,
          })
        }
        const primaryArtifact = artifacts[0]
        if (!primaryArtifact) return yield* Effect.die("Backup has no artifact")
        let repositoryId: string | null = null
        let repositoryPassword: string | undefined
        if (mode === "incremental") {
          const repository = yield* loadOrCreateBackupRepository(transaction, {
            destinationObjectPrefix: primaryArtifact.storageId
              ? (lockedStorage.get(primaryArtifact.storageId)?.object_prefix ??
                "")
              : "",
            relayId: input.relayId,
            storageId: primaryArtifact.storageId,
            targetId: input.targetId,
            targetKind: input.targetKind,
          })
          repositoryId = repository.id
          repositoryPassword = repository.password
        }
        const usageRows = yield* transaction.queryRows<BackupUsageRow>(
          `SELECT COUNT(*) AS quantity_used,
                  COALESCE(SUM(
                    CASE
                      WHEN backup.status IN ('available', 'deleting')
                        THEN COALESCE(backup.bytes, 0)
                      ELSE COALESCE((
                        SELECT MAX(task.reserved_bytes)
                          FROM ${databaseTable("backup_task")} task
                         WHERE task.backup_id = backup.id
                           AND task.task_kind = 'create'
                           AND task.status IN ('queued', 'running')
                      ), 0)
                    END
                  ), 0) AS size_used
             FROM ${databaseTable("backup")} backup
            WHERE backup.relay_id = ?
              AND backup.target_kind = ?
              AND backup.target_id = ?
              AND backup.status IN ('queued', 'running', 'available', 'deleting')`,
          [input.relayId, input.targetKind, input.targetId]
        )
        const usage = usageRows[0]
        const quantityUsed = safeDatabaseNumber(
          usage?.quantity_used ?? 0,
          "backup quantity"
        )
        const sizeUsed = safeDatabaseNumber(
          usage?.size_used ?? 0,
          "backup size"
        )
        const userQuantityLimit =
          input.reason === "final_delete" ? null : policy.quantity_limit
        const userSizeLimit =
          input.reason === "final_delete"
            ? null
            : nullableDatabaseNumber(
                policy.size_limit_bytes,
                "backup size limit"
              )
        const quantityLimit = effectiveBackupLimit(
          userQuantityLimit,
          policy.admin_quantity_limit
        )
        const sizeLimit = effectiveBackupLimit(
          userSizeLimit,
          nullableDatabaseNumber(
            policy.admin_size_limit_bytes,
            "admin backup size limit"
          )
        )
        const reservation = yield* Effect.try({
          try: () =>
            backupReservation({
              quantityLimit,
              quantityUsed,
              requestedMaxBytes: input.requestedMaxBytes,
              sizeLimit,
              sizeUsed,
            }),
          catch: (cause) =>
            cause instanceof BackupLimitError
              ? cause
              : BackupStorageError.make({
                  cause,
                  code: "reservation_failed",
                  operation: "backup.reserve",
                  reason: "The backup reservation could not be calculated",
                }),
        })

        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup")}
            (id, relay_id, target_kind, target_id, storage_id, artifact_kind,
             backup_mode, reason, status, name, object_key, repository_id,
             warnings, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                   'queued', ?, ?, ?, JSON_ARRAY(), ?)`,
          [
            input.backupId,
            input.relayId,
            input.targetKind,
            input.targetId,
            primaryArtifact.storageId,
            artifactKind,
            mode,
            input.reason ?? "manual",
            input.name,
            primaryArtifact.objectKey,
            repositoryId,
            input.createdBy,
          ]
        )
        for (const artifact of artifacts) {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_artifact")}
              (id, backup_id, destination_key, storage_id, status, object_key)
             VALUES (?, ?, ?, ?, 'queued', ?)`,
            [
              artifact.artifactId,
              input.backupId,
              mode === "incremental"
                ? "restic"
                : (artifact.storageId ?? "local"),
              artifact.storageId,
              artifact.objectKey,
            ]
          )
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_task")}
            (id, backup_id, task_kind, status, reserved_bytes, requested_by)
           VALUES (?, ?, 'create', 'queued', ?, ?)`,
          [input.taskId, input.backupId, reservation.maxBytes, input.createdBy]
        )
        if (
          input.reason === "final_delete" &&
          input.targetKind === "instance"
        ) {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_final_delete")}
              (relay_id, target_id, backup_id, requested_by, status)
             VALUES (?, ?, ?, ?, 'backing_up')`,
            [input.relayId, input.targetId, input.backupId, input.createdBy]
          )
        }
        if (
          input.reason === "final_delete" &&
          input.targetKind === "database"
        ) {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_final_database_delete")}
              (relay_id, target_id, backup_id, requested_by, status)
             VALUES (?, ?, ?, ?, 'backing_up')`,
            [input.relayId, input.targetId, input.backupId, input.createdBy]
          )
        }
        return {
          artifacts,
          artifactKind,
          backupId: input.backupId,
          exclude: parseExcludes(policy.exclude_patterns),
          kind: "create",
          maxBytes: reservation.maxBytes,
          mode,
          reason: input.reason ?? "manual",
          ...(repositoryPassword ? { repositoryPassword } : {}),
          target: { id: input.targetId, kind: input.targetKind },
          taskId: input.taskId,
        } satisfies BackupCreateDispatch
      })
    )
  }
)

export const reserveInstanceBackupEffect = Effect.fn("backups.reserve")(
  (input: {
    backupId: string
    createdBy: string
    mode?: BackupCreateTaskInput["mode"]
    name: string
    reason?: BackupCreateTaskInput["reason"]
    relayId: string
    requestedMaxBytes: number | null
    storageId?: string | null
    storageIds?: ReadonlyArray<string | null>
    targetId: string
    taskId: string
  }) =>
    reserveBackupCreateEffect({
      ...input,
      artifactKind: "archive",
      exclude: [],
      targetKind: "instance",
    })
)

export const reserveDatabaseBackupEffect = Effect.fn("backups.reserveDatabase")(
  (input: {
    backupId: string
    createdBy: string
    name: string
    reason?: BackupCreateTaskInput["reason"]
    relayId: string
    requestedMaxBytes: number | null
    storageId?: string | null
    storageIds?: ReadonlyArray<string | null>
    targetId: string
    taskId: string
  }) =>
    reserveBackupCreateEffect({
      ...input,
      artifactKind: "database_dump",
      exclude: [],
      targetKind: "database",
    })
)

export const reservePlatformBackupEffect = Effect.fn("backups.reservePlatform")(
  (input: {
    backupId: string
    createdBy: string
    name: string
    relayId: string
    requestedMaxBytes: number | null
    storageId?: string | null
    storageIds?: ReadonlyArray<string | null>
    targetId: string
    taskId: string
  }) =>
    reserveBackupCreateEffect({
      ...input,
      artifactKind: "platform_bundle",
      exclude: [],
      targetKind: "platform",
    })
)

const adoptScheduledBackupTask = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  relayId: string,
  task: RelayBackupTask
) {
  if (
    task.kind !== "create" ||
    task.input.kind !== "create" ||
    task.input.reason !== "scheduled"
  ) {
    return
  }
  const input = task.input
  const catalog = input.catalog
  const artifactId = input.destination.artifactId
  if (!catalog || !artifactId) return
  const repositoryRows =
    input.mode === "incremental"
      ? yield* transaction.queryRows<ScheduledBackupRepositoryRow>(
          `SELECT id
             FROM ${databaseTable("backup_repository")}
            WHERE relay_id = ? AND target_kind = ? AND target_id = ?
              AND storage_id <=> ?
            LIMIT 1
            FOR UPDATE`,
          [relayId, input.target.kind, input.target.id, catalog.storageId]
        )
      : []
  const repositoryId = repositoryRows[0]?.id ?? null
  if (input.mode === "incremental" && !repositoryId) return
  const objectKey =
    input.destination.kind === "s3" ? input.destination.objectKey : null

  yield* transaction.execute(
    `INSERT IGNORE INTO ${databaseTable("backup")}
      (id, relay_id, target_kind, target_id, storage_id, artifact_kind,
       backup_mode, reason, status, name, object_key, repository_id,
       warnings, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 'queued', ?, ?, ?,
             JSON_ARRAY(), NULL, FROM_UNIXTIME(? / 1000))`,
    [
      input.backupId,
      relayId,
      input.target.kind,
      input.target.id,
      catalog.storageId,
      input.artifactKind,
      input.mode,
      catalog.name,
      objectKey,
      repositoryId,
      task.createdAt,
    ]
  )
  yield* transaction.execute(
    `INSERT IGNORE INTO ${databaseTable("backup_artifact")}
      (id, backup_id, destination_key, storage_id, status, object_key,
       created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, FROM_UNIXTIME(? / 1000))`,
    [
      artifactId,
      input.backupId,
      input.mode === "incremental" ? "restic" : (catalog.storageId ?? "local"),
      catalog.storageId,
      objectKey,
      task.createdAt,
    ]
  )
  yield* transaction.execute(
    `INSERT IGNORE INTO ${databaseTable("backup_task")}
      (id, backup_id, task_kind, status, reserved_bytes, requested_by,
       created_at)
     VALUES (?, ?, 'create', 'queued', ?, NULL, FROM_UNIXTIME(? / 1000))`,
    [input.taskId, input.backupId, input.maxBytes, task.createdAt]
  )
})

export const reconcileBackupTaskEffect = Effect.fn("backups.reconcile")(
  function* (task: RelayBackupTask, relayId?: string) {
    const database = yield* Database
    yield* database.transaction("backup_reconcile", (transaction) =>
      Effect.gen(function* () {
        const knownTasks = yield* transaction.queryRows<KnownBackupTaskRow>(
          `SELECT task.id, task.status, task.bytes_completed,
                  backup.status AS backup_status,
                  task.relay_updated_at_ms
             FROM ${databaseTable("backup_task")} task
             JOIN ${databaseTable("backup")} backup ON backup.id = task.backup_id
            WHERE task.id = ? AND task.backup_id = ?
            FOR UPDATE`,
          [task.taskId, task.backupId]
        )
        let knownTask = knownTasks[0]
        if (!knownTask && relayId) {
          yield* adoptScheduledBackupTask(transaction, relayId, task)
          const adoptedTasks = yield* transaction.queryRows<KnownBackupTaskRow>(
            `SELECT task.id, task.status, task.bytes_completed,
                      backup.status AS backup_status,
                      task.relay_updated_at_ms
                 FROM ${databaseTable("backup_task")} task
                 JOIN ${databaseTable("backup")} backup ON backup.id = task.backup_id
                WHERE task.id = ? AND task.backup_id = ?
                FOR UPDATE`,
            [task.taskId, task.backupId]
          )
          knownTask = adoptedTasks[0]
        }
        if (!knownTask) return
        if (
          !shouldApplyRelayBackupTaskSnapshot(
            {
              bytesCompleted: safeDatabaseNumber(
                knownTask.bytes_completed,
                "backup task progress"
              ),
              relayUpdatedAt: nullableDatabaseNumber(
                knownTask.relay_updated_at_ms,
                "Relay backup task update time"
              ),
              status: knownTask.status,
            },
            task
          )
        ) {
          return
        }
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_task")}
              SET status = ?, bytes_completed = ?, bytes_total = ?,
                  phase = ?, current_artifact_id = ?, current_path = ?, error = ?,
                  started_at = FROM_UNIXTIME(? / 1000),
                  finished_at = FROM_UNIXTIME(? / 1000),
                  relay_updated_at_ms = ?
            WHERE id = ? AND backup_id = ?`,
          [
            task.status,
            task.bytesCompleted,
            task.bytesTotal,
            task.phase,
            task.currentArtifactId,
            task.currentPath,
            task.error,
            task.startedAt,
            task.finishedAt,
            task.updatedAt,
            task.taskId,
            task.backupId,
          ]
        )
        if (task.kind === "delete") {
          const active = task.status === "queued" || task.status === "running"
          const outcomes =
            task.result && !("bytes" in task.result)
              ? (task.result.artifacts ?? [])
              : []
          if (active) {
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup")}
                  SET status = 'deleting'
                WHERE id = ?`,
              [task.backupId]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup_artifact")}
                  SET status = 'available'
                WHERE backup_id = ? AND status = 'deleting'`,
              [task.backupId]
            )
            if (task.currentArtifactId) {
              yield* transaction.execute(
                `UPDATE ${databaseTable("backup_artifact")}
                    SET status = 'deleting', error = NULL
                  WHERE id = ? AND backup_id = ? AND status <> 'deleted'`,
                [task.currentArtifactId, task.backupId]
              )
            }
            for (const outcome of outcomes) {
              const artifactStatus =
                outcome.status === "deleted" ? "deleted" : "available"
              yield* transaction.execute(
                `UPDATE ${databaseTable("backup_artifact")}
                    SET status = ?, error = ?,
                        deleted_at = CASE WHEN ? = 'deleted'
                          THEN FROM_UNIXTIME(? / 1000) ELSE NULL END
                  WHERE id = ? AND backup_id = ?`,
                [
                  artifactStatus,
                  outcome.error,
                  artifactStatus,
                  task.updatedAt,
                  outcome.artifactId,
                  task.backupId,
                ]
              )
            }
          } else if (task.status === "succeeded") {
            if (outcomes.length === 0) {
              yield* transaction.execute(
                `UPDATE ${databaseTable("backup_artifact")}
                    SET status = 'deleted', deleted_at = FROM_UNIXTIME(? / 1000)
                  WHERE backup_id = ?`,
                [task.finishedAt ?? Date.now(), task.backupId]
              )
            } else {
              for (const outcome of outcomes) {
                const artifactStatus =
                  outcome.status === "deleted" ? "deleted" : "available"
                yield* transaction.execute(
                  `UPDATE ${databaseTable("backup_artifact")}
                      SET status = ?, error = ?,
                          deleted_at = CASE WHEN ? = 'deleted'
                            THEN FROM_UNIXTIME(? / 1000) ELSE NULL END
                  WHERE id = ? AND backup_id = ?`,
                  [
                    artifactStatus,
                    outcome.error,
                    artifactStatus,
                    task.finishedAt ?? Date.now(),
                    outcome.artifactId,
                    task.backupId,
                  ]
                )
              }
            }
            const remaining = yield* transaction.queryRows<RowDataPacket>(
              `SELECT id FROM ${databaseTable("backup_artifact")}
                WHERE backup_id = ? AND status <> 'deleted' LIMIT 1`,
              [task.backupId]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup")}
                  SET status = ?,
                      deleted_at = CASE WHEN ? = 'deleted'
                        THEN FROM_UNIXTIME(? / 1000) ELSE NULL END
                WHERE id = ?`,
              [
                remaining[0] ? "available" : "deleted",
                remaining[0] ? "available" : "deleted",
                task.finishedAt ?? Date.now(),
                task.backupId,
              ]
            )
          } else if (task.status === "failed" || task.status === "cancelled") {
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup")}
                  SET status = 'available'
                WHERE id = ?`,
              [task.backupId]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup_artifact")}
                  SET status = 'available', error = ?
                WHERE backup_id = ? AND status = 'deleting'`,
              [task.error, task.backupId]
            )
          }
          return
        }
        if (task.kind !== "create") return
        if (
          knownTask.backup_status === "deleting" ||
          knownTask.backup_status === "deleted"
        ) {
          return
        }
        if (task.status === "queued" || task.status === "running") {
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup")}
                SET status = ?,
                    started_at = COALESCE(started_at, FROM_UNIXTIME(? / 1000))
              WHERE id = ?`,
            [task.status, task.startedAt, task.backupId]
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_artifact")}
                SET status = ?
              WHERE backup_id = ? AND status IN ('queued', 'running')`,
            [task.status, task.backupId]
          )
          return
        }
        if (
          task.status === "succeeded" &&
          task.result &&
          (isResticCreateTaskResult(task.result) ||
            isArchiveCreateTaskResult(task.result))
        ) {
          const resticResult = isResticCreateTaskResult(task.result)
            ? task.result
            : null
          const archiveResult = isArchiveCreateTaskResult(task.result)
            ? task.result
            : null
          if (!resticResult && !archiveResult) return
          const filename = archiveResult?.filename ?? null
          const checksum = archiveResult?.checksumSha256 ?? null
          const snapshotId = resticResult?.snapshotId ?? null
          const outcomes = task.result.artifacts ?? []
          if (outcomes.length === 0) {
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup_artifact")}
                  SET status = 'available', filename = ?, bytes = ?,
                      checksum_sha256 = ?, error = NULL,
                      completed_at = FROM_UNIXTIME(? / 1000)
                WHERE backup_id = ?`,
              [
                filename,
                task.result.bytes,
                checksum,
                task.finishedAt ?? Date.now(),
                task.backupId,
              ]
            )
          } else {
            for (const outcome of outcomes) {
              yield* transaction.execute(
                `UPDATE ${databaseTable("backup_artifact")}
                    SET status = ?, filename = ?,
                        bytes = CASE WHEN ? = 'available' THEN ? ELSE NULL END,
                        checksum_sha256 = CASE WHEN ? = 'available' THEN ? ELSE NULL END,
                        error = ?, completed_at = FROM_UNIXTIME(? / 1000)
                  WHERE id = ? AND backup_id = ?`,
                [
                  outcome.status,
                  filename,
                  outcome.status,
                  task.result.bytes,
                  outcome.status,
                  checksum,
                  outcome.error,
                  task.finishedAt ?? Date.now(),
                  outcome.artifactId,
                  task.backupId,
                ]
              )
            }
          }
          const available = yield* transaction.queryRows<RowDataPacket>(
            `SELECT id FROM ${databaseTable("backup_artifact")}
              WHERE backup_id = ? AND status = 'available' LIMIT 1`,
            [task.backupId]
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup")}
                SET status = ?, filename = ?, bytes = ?,
                    checksum_sha256 = ?, restic_snapshot_id = ?, warnings = ?,
                    completed_at = FROM_UNIXTIME(? / 1000)
              WHERE id = ?`,
            [
              available[0] ? "available" : "failed",
              filename,
              task.result.bytes,
              checksum,
              snapshotId,
              JSON.stringify(task.result.warnings),
              task.finishedAt ?? Date.now(),
              task.backupId,
            ]
          )
          return
        }
        if (task.status === "failed" || task.status === "cancelled") {
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup")}
                SET status = 'failed',
                    completed_at = FROM_UNIXTIME(? / 1000)
              WHERE id = ?`,
            [task.finishedAt ?? Date.now(), task.backupId]
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_artifact")}
                SET status = 'failed', error = ?,
                    completed_at = FROM_UNIXTIME(? / 1000)
              WHERE backup_id = ? AND status IN ('queued', 'running')`,
            [task.error, task.finishedAt ?? Date.now(), task.backupId]
          )
        }
      })
    )
  }
)

export const listBackupCatalogEffect = Effect.fn("backups.list")(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<BackupRow>(
    "backup_catalog_list",
    `SELECT backup.id, backup.relay_id, backup.target_kind, backup.target_id,
            backup.artifact_kind, backup.backup_mode, backup.reason,
            backup.status, backup.name, backup.filename, backup.bytes,
            backup.checksum_sha256, backup.restic_snapshot_id, backup.warnings,
            backup.created_by, backup.storage_id, backup.object_key,
            ROUND(UNIX_TIMESTAMP(backup.completed_at) * 1000) AS completed_at_ms,
            ROUND(UNIX_TIMESTAMP(backup.created_at) * 1000) AS created_at_ms,
            task.id AS task_id, task.task_kind AS task_kind,
            task.status AS task_status, task.bytes_completed AS task_bytes_completed,
            task.bytes_total AS task_bytes_total, task.phase AS task_phase,
            task.current_artifact_id AS task_current_artifact_id,
            task.current_path AS task_current_path, task.error AS task_error,
            ROUND(UNIX_TIMESTAMP(task.started_at) * 1000) AS task_started_at_ms,
            ROUND(UNIX_TIMESTAMP(task.updated_at) * 1000) AS task_updated_at_ms
       FROM ${databaseTable("backup")} backup
       JOIN ${databaseTable("backup_task")} task ON task.id = (
         SELECT latest.id
           FROM ${databaseTable("backup_task")} latest
          WHERE latest.backup_id = backup.id
          ORDER BY latest.created_at DESC, latest.id DESC
          LIMIT 1
       )
      WHERE backup.status <> 'deleted'
      ORDER BY backup.created_at DESC, backup.id DESC`
  )
  const artifactRows = yield* database.queryRows<BackupArtifactRow>(
    "backup_artifact_catalog_list",
    `SELECT artifact.id, artifact.backup_id, artifact.storage_id,
            artifact.status, artifact.filename, artifact.object_key,
            artifact.bytes, artifact.checksum_sha256, artifact.error
       FROM ${databaseTable("backup_artifact")} artifact
       JOIN ${databaseTable("backup")} backup ON backup.id = artifact.backup_id
      WHERE backup.status <> 'deleted' AND artifact.status <> 'deleted'
      ORDER BY artifact.created_at ASC, artifact.id ASC`
  )
  const artifactsByBackup = new Map<string, Array<BackupArtifactRecord>>()
  for (const artifact of artifactRows) {
    const records = artifactsByBackup.get(artifact.backup_id) ?? []
    records.push({
      bytes: nullableDatabaseNumber(artifact.bytes, "backup artifact bytes"),
      checksumSha256: artifact.checksum_sha256,
      error: artifact.error,
      filename: artifact.filename,
      id: artifact.id,
      objectKey: artifact.object_key,
      status: artifact.status,
      storageId: artifact.storage_id,
    })
    artifactsByBackup.set(artifact.backup_id, records)
  }
  return rows.map((row) => ({
    artifacts: artifactsByBackup.get(row.id) ?? [],
    artifactKind: row.artifact_kind,
    backupMode: row.backup_mode,
    bytes: nullableDatabaseNumber(row.bytes, "backup bytes"),
    checksumSha256: row.checksum_sha256,
    completedAt: timestampIso(row.completed_at_ms, "backup completed at"),
    createdBy: row.created_by,
    createdAt: requiredTimestampIso(row.created_at_ms, "backup created at"),
    filename: row.filename,
    id: row.id,
    name: row.name,
    objectKey: row.object_key,
    reason: row.reason,
    relayId: row.relay_id,
    resticSnapshotId: row.restic_snapshot_id,
    status: row.status,
    storageId: row.storage_id,
    targetId: row.target_id,
    targetKind: row.target_kind,
    taskBytesCompleted: safeDatabaseNumber(
      row.task_bytes_completed,
      "backup task progress"
    ),
    taskBytesTotal: nullableDatabaseNumber(
      row.task_bytes_total,
      "backup task total"
    ),
    taskCurrentArtifactId: row.task_current_artifact_id,
    taskCurrentPath: row.task_current_path,
    taskError: row.task_error,
    taskId: row.task_id,
    taskKind: row.task_kind,
    taskPhase: row.task_phase,
    taskStartedAt: timestampIso(
      row.task_started_at_ms,
      "backup task started at"
    ),
    taskStatus: row.task_status,
    taskUpdatedAt: requiredTimestampIso(
      row.task_updated_at_ms,
      "backup task updated at"
    ),
    warnings: parseWarnings(row.warnings),
  })) satisfies Array<BackupCatalogRecord>
})

export const listDispatchableBackupTasksEffect = Effect.fn(
  "backups.dispatchable"
)(function* (relayId: string) {
  const database = yield* Database
  yield* database.execute(
    "backup_dependency_failures",
    `UPDATE ${databaseTable("backup_task")} dependent
       JOIN ${databaseTable("backup_task")} dependency
         ON dependency.id = dependent.depends_on_task_id
        SET dependent.status = 'failed',
            dependent.error = 'The pre-restore safety backup did not complete',
            dependent.finished_at = CURRENT_TIMESTAMP(3)
      WHERE dependent.status = 'queued'
        AND dependent.task_kind = 'restore'
        AND dependency.status IN ('failed', 'cancelled')`
  )
  const rows = yield* database.queryRows<DispatchableBackupRow>(
    "backup_dispatchable_list",
    `SELECT backup.id AS backup_id, backup.target_kind, backup.target_id,
            backup.artifact_kind, backup.backup_mode, backup.reason,
            backup.bytes, backup.checksum_sha256, backup.restic_snapshot_id,
            backup.repository_id,
            (
              SELECT create_task.id
                FROM ${databaseTable("backup_task")} create_task
               WHERE create_task.backup_id = backup.id
                 AND create_task.task_kind = 'create'
               ORDER BY create_task.created_at ASC, create_task.id ASC
               LIMIT 1
            ) AS create_task_id,
            task.id AS task_id, task.task_kind, task.reserved_bytes,
            ROUND(UNIX_TIMESTAMP(task.created_at) * 1000) AS task_created_at_ms,
            backup.storage_id, backup.object_key,
            COALESCE(policy.exclude_patterns, JSON_ARRAY()) AS exclude_patterns
       FROM ${databaseTable("backup")} backup
       JOIN ${databaseTable("backup_task")} task
         ON task.backup_id = backup.id
        AND task.task_kind IN ('create', 'restore', 'delete', 'export')
       LEFT JOIN ${databaseTable("backup_policy")} policy
         ON policy.relay_id = backup.relay_id
        AND policy.target_kind = backup.target_kind
        AND policy.target_id = backup.target_id
      WHERE backup.relay_id = ?
        AND (
          (backup.backup_mode = 'full'
            AND ((backup.target_kind = 'instance' AND backup.artifact_kind = 'archive')
              OR (backup.target_kind = 'database' AND backup.artifact_kind = 'database_dump')
              OR (backup.target_kind = 'platform' AND backup.artifact_kind = 'platform_bundle')))
          OR (backup.backup_mode = 'incremental'
            AND backup.target_kind = 'instance'
            AND backup.artifact_kind = 'restic_snapshot')
        )
        AND ((task.task_kind = 'create' AND backup.status = 'queued')
          OR (task.task_kind = 'restore' AND backup.status = 'available')
          OR (task.task_kind = 'delete' AND backup.status = 'deleting')
          OR (task.task_kind = 'export' AND backup.status = 'available'))
        AND task.status = 'queued'
        AND (task.depends_on_task_id IS NULL OR EXISTS (
          SELECT 1
            FROM ${databaseTable("backup_task")} dependency
           WHERE dependency.id = task.depends_on_task_id
             AND dependency.status = 'succeeded'
        ))
      ORDER BY task.created_at ASC, task.id ASC`,
    [relayId]
  )
  const artifactRows = yield* database.queryRows<BackupArtifactRow>(
    "backup_dispatchable_artifacts",
    `SELECT artifact.id, artifact.backup_id, artifact.storage_id,
            artifact.status, artifact.filename, artifact.object_key,
            artifact.bytes, artifact.checksum_sha256, artifact.error
       FROM ${databaseTable("backup_artifact")} artifact
       JOIN ${databaseTable("backup")} backup ON backup.id = artifact.backup_id
      WHERE backup.relay_id = ? AND artifact.status <> 'deleted'
      ORDER BY (artifact.storage_id IS NULL) DESC, artifact.created_at ASC`,
    [relayId]
  )
  const artifactsByBackup = new Map<string, Array<BackupArtifactRow>>()
  for (const artifact of artifactRows) {
    const artifacts = artifactsByBackup.get(artifact.backup_id) ?? []
    artifacts.push(artifact)
    artifactsByBackup.set(artifact.backup_id, artifacts)
  }
  return rows.map((row): BackupDispatch => {
    const artifacts = artifactsByBackup.get(row.backup_id) ?? []
    if (row.task_kind === "restore") {
      const artifact = artifacts.find(
        (candidate) => candidate.status === "available"
      )
      if (row.backup_mode === "incremental") {
        if (!artifact || !row.restic_snapshot_id) {
          throw new Error("Available snapshot is missing restore metadata")
        }
        return {
          artifactId: artifact.id,
          backupId: row.backup_id,
          kind: "restore",
          objectKey: null,
          snapshotId: row.restic_snapshot_id,
          storageId: null,
          target: { id: row.target_id, kind: row.target_kind },
          taskId: row.task_id,
        }
      }
      const bytes = nullableDatabaseNumber(
        artifact?.bytes ?? null,
        "backup artifact bytes"
      )
      if (!artifact || bytes === null || !artifact.checksum_sha256) {
        throw new Error(
          "Available backup is missing restore integrity metadata"
        )
      }
      return {
        backupId: row.backup_id,
        bytes,
        checksumSha256: artifact.checksum_sha256,
        artifactId: artifact.id,
        kind: "restore",
        objectKey: artifact.object_key,
        storageId: artifact.storage_id,
        target: { id: row.target_id, kind: row.target_kind },
        taskId: row.task_id,
      }
    }
    if (row.task_kind === "export") {
      if (!row.restic_snapshot_id) {
        throw new Error("Available snapshot is missing export metadata")
      }
      return {
        backupId: row.backup_id,
        kind: "export",
        snapshotId: row.restic_snapshot_id,
        target: { id: row.target_id, kind: "instance" },
        taskId: row.task_id,
        ttlMs: clampBackupExportTtlMs(
          // Export tasks store the requested TTL (ms) in reserved_bytes.
          nullableDatabaseNumber(row.reserved_bytes, "export ttl") ??
            BACKUP_EXPORT_TTL_MIN_MS
        ),
      }
    }
    if (row.task_kind === "delete") {
      return {
        artifacts: artifacts.map(dispatchArtifact),
        backupId: row.backup_id,
        kind: "delete",
        ...(row.restic_snapshot_id
          ? { snapshotId: row.restic_snapshot_id }
          : row.backup_mode === "incremental" && row.create_task_id
            ? { createTaskId: row.create_task_id }
            : {}),
        target: { id: row.target_id, kind: row.target_kind },
        taskId: row.task_id,
      }
    }
    return {
      artifacts: artifacts.map(dispatchArtifact),
      artifactKind: row.artifact_kind,
      backupId: row.backup_id,
      exclude: parseExcludes(row.exclude_patterns),
      kind: "create",
      maxBytes: nullableDatabaseNumber(
        row.reserved_bytes,
        "backup reservation"
      ),
      mode: row.backup_mode,
      reason: row.reason,
      target: { id: row.target_id, kind: row.target_kind },
      taskId: row.task_id,
    }
  })
})

export const reserveBackupRestoreEffect = Effect.fn("backups.reserveRestore")(
  function* (input: {
    backupId: string
    dependsOnTaskId: string | null
    requestedBy: string
    taskId: string
  }) {
    const database = yield* Database
    return yield* database.transaction(
      "backup_reserve_restore",
      (transaction) =>
        Effect.gen(function* () {
          const rows = yield* transaction.queryRows<BackupRow>(
            `SELECT backup.id, backup.relay_id, backup.target_kind,
                    backup.target_id, backup.storage_id, backup.object_key,
                    backup.bytes, backup.checksum_sha256, backup.backup_mode,
                    backup.artifact_kind, backup.restic_snapshot_id,
                    backup.repository_id
               FROM ${databaseTable("backup")} backup
              WHERE backup.id = ? AND backup.status = 'available'
                AND (
                  (backup.backup_mode = 'full'
                    AND ((backup.target_kind = 'instance' AND backup.artifact_kind = 'archive')
                      OR (backup.target_kind = 'database' AND backup.artifact_kind = 'database_dump')))
                  OR (backup.backup_mode = 'incremental'
                    AND backup.target_kind = 'instance'
                    AND backup.artifact_kind = 'restic_snapshot'
                    AND backup.restic_snapshot_id IS NOT NULL)
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM ${databaseTable("backup_task")} active_task
                   WHERE active_task.backup_id = backup.id
                     AND active_task.task_kind IN ('restore', 'delete')
                     AND active_task.status IN ('queued', 'running')
                )
              FOR UPDATE`,
            [input.backupId]
          )
          const backup = rows[0]
          const artifacts = backup
            ? yield* transaction.queryRows<BackupArtifactRow>(
                `SELECT artifact.id, artifact.backup_id, artifact.storage_id,
                        artifact.status, artifact.filename, artifact.object_key,
                        artifact.bytes, artifact.checksum_sha256, artifact.error
                   FROM ${databaseTable("backup_artifact")} artifact
                  WHERE artifact.backup_id = ? AND artifact.status = 'available'
                  ORDER BY (artifact.storage_id IS NULL) DESC, artifact.created_at ASC
                  FOR UPDATE`,
                [input.backupId]
              )
            : []
          const artifact = artifacts[0]
          const resticRestore =
            backup?.backup_mode === "incremental" &&
            Boolean(backup.restic_snapshot_id)
          const bytes = nullableDatabaseNumber(
            artifact?.bytes ?? null,
            "backup artifact bytes"
          )
          if (
            !backup ||
            !artifact ||
            (!resticRestore && (bytes === null || !artifact.checksum_sha256))
          ) {
            return yield* BackupStorageError.make({
              code: "backup_unavailable",
              operation: "backup.restore",
              reason: "Only complete backups can be restored",
            })
          }
          yield* transaction.queryRows<RowDataPacket>(
            `SELECT relay_id
               FROM ${databaseTable("backup_policy")}
              WHERE relay_id = ? AND target_kind = ? AND target_id = ?
              FOR UPDATE`,
            [backup.relay_id, backup.target_kind, backup.target_id]
          )
          const conflictingTasks =
            yield* transaction.queryRows<KnownBackupTaskRow>(
              `SELECT task.id
                 FROM ${databaseTable("backup_task")} task
                 JOIN ${databaseTable("backup")} active_backup
                   ON active_backup.id = task.backup_id
                WHERE active_backup.relay_id = ?
                  AND active_backup.target_kind = ?
                  AND active_backup.target_id = ?
                  AND task.task_kind = 'restore'
                  AND task.status IN ('queued', 'running')
                LIMIT 1`,
              [backup.relay_id, backup.target_kind, backup.target_id]
            )
          const finalDeletionTable =
            backup.target_kind === "database"
              ? "backup_final_database_delete"
              : "backup_final_delete"
          const finalDeletions = yield* transaction.queryRows<RowDataPacket>(
            `SELECT target_id
                 FROM ${databaseTable(finalDeletionTable)}
                WHERE relay_id = ? AND target_id = ?
                  AND status IN ('backing_up', 'deleting')
                LIMIT 1`,
            [backup.relay_id, backup.target_id]
          )
          if (conflictingTasks[0] || finalDeletions[0]) {
            return yield* BackupStorageError.make({
              code: "restore_in_progress",
              operation: "backup.restore",
              reason:
                "Another restore or final resource deletion is already in progress",
            })
          }
          if (input.dependsOnTaskId) {
            const dependencies =
              yield* transaction.queryRows<KnownBackupTaskRow>(
                `SELECT id
                 FROM ${databaseTable("backup_task")}
                WHERE id = ? AND task_kind = 'create'
                LIMIT 1`,
                [input.dependsOnTaskId]
              )
            if (!dependencies[0]) {
              return yield* BackupStorageError.make({
                code: "invalid_restore_dependency",
                operation: "backup.restore",
                reason: "The pre-restore safety backup was not reserved",
              })
            }
          }
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_task")}
              (id, backup_id, task_kind, status, depends_on_task_id, requested_by)
             VALUES (?, ?, 'restore', 'queued', ?, ?)`,
            [
              input.taskId,
              input.backupId,
              input.dependsOnTaskId,
              input.requestedBy,
            ]
          )
          return {
            artifactId: artifact.id,
            backupId: input.backupId,
            ...(resticRestore
              ? { snapshotId: backup.restic_snapshot_id ?? undefined }
              : {
                  bytes: bytes ?? undefined,
                  checksumSha256: artifact.checksum_sha256 ?? undefined,
                }),
            kind: "restore",
            objectKey: resticRestore ? null : artifact.object_key,
            storageId: resticRestore ? null : artifact.storage_id,
            target: { id: backup.target_id, kind: backup.target_kind },
            taskId: input.taskId,
          } satisfies BackupRestoreDispatch
        })
    )
  }
)

export const reserveBackupDeleteEffect = Effect.fn("backups.reserveDelete")(
  function* (input: { backupId: string; requestedBy: string; taskId: string }) {
    const database = yield* Database
    return yield* database.transaction("backup_reserve_delete", (transaction) =>
      Effect.gen(function* () {
        const rows = yield* transaction.queryRows<BackupRow>(
          `SELECT backup.id, backup.relay_id, backup.target_kind,
                  backup.target_id, backup.storage_id, backup.object_key,
                  backup.restic_snapshot_id, backup.backup_mode
             FROM ${databaseTable("backup")} backup
            WHERE backup.id = ? AND backup.status IN ('available', 'failed')
              AND NOT EXISTS (
                SELECT 1
                  FROM ${databaseTable("backup_task")} active_task
                 WHERE active_task.backup_id = backup.id
                   AND active_task.task_kind = 'restore'
                   AND active_task.status IN ('queued', 'running')
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM ${databaseTable("backup_copy_task")} active_copy
                 WHERE active_copy.backup_id = backup.id
                   AND active_copy.status IN ('queued', 'running')
              )
            FOR UPDATE`,
          [input.backupId]
        )
        const backup = rows[0]
        if (!backup) {
          return yield* BackupStorageError.make({
            code: "backup_unavailable",
            operation: "backup.delete",
            reason: "Only complete or failed backups can be deleted",
          })
        }
        yield* refuseIfFinalDeletionInProgress(transaction, {
          operation: "backup.delete",
          relayId: backup.relay_id,
          targetId: backup.target_id,
          targetKind: backup.target_kind,
        })
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")}
              SET status = 'deleting'
            WHERE id = ?`,
          [input.backupId]
        )
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_task")}
            (id, backup_id, task_kind, status, requested_by)
           VALUES (?, ?, 'delete', 'queued', ?)`,
          [input.taskId, input.backupId, input.requestedBy]
        )
        const createTask = backup.restic_snapshot_id
          ? null
          : (yield* transaction.queryRows<{ id: string } & RowDataPacket>(
              `SELECT id
                   FROM ${databaseTable("backup_task")}
                  WHERE backup_id = ? AND task_kind = 'create'
                  ORDER BY created_at ASC, id ASC
                  LIMIT 1`,
              [input.backupId]
            ))[0]
        return {
          artifacts: (yield* transaction.queryRows<BackupArtifactRow>(
            `SELECT artifact.id, artifact.backup_id, artifact.storage_id,
                      artifact.status, artifact.filename, artifact.object_key,
                      artifact.bytes, artifact.checksum_sha256, artifact.error
                 FROM ${databaseTable("backup_artifact")} artifact
                WHERE artifact.backup_id = ? AND artifact.status <> 'deleted'
                ORDER BY (artifact.storage_id IS NULL) DESC, artifact.created_at ASC`,
            [input.backupId]
          )).map(dispatchArtifact),
          backupId: input.backupId,
          kind: "delete",
          ...(backup.restic_snapshot_id
            ? { snapshotId: backup.restic_snapshot_id }
            : backup.backup_mode === "incremental" && createTask
              ? { createTaskId: createTask.id }
              : {}),
          target: { id: backup.target_id, kind: backup.target_kind },
          taskId: input.taskId,
        } satisfies BackupDeleteDispatch
      })
    )
  }
)

export const forgetBackupEffect = Effect.fn("backups.forget")(function* (
  backupId: string
) {
  const database = yield* Database
  return yield* database.transaction("backup_forget", (transaction) =>
    Effect.gen(function* () {
      const backup = (yield* transaction.queryRows<
        Pick<
          BackupRow,
          "relay_id" | "repository_id" | "target_id" | "target_kind"
        > &
          RowDataPacket
      >(
        `SELECT relay_id, repository_id, target_kind, target_id
             FROM ${databaseTable("backup")}
            WHERE id = ?
            LIMIT 1
            FOR UPDATE`,
        [backupId]
      ))[0]
      if (!backup) return "not_found" as const
      // Pairing locks this same primary-key lookup before inserting, so an
      // absent Relay stays absent until this forget transaction commits.
      const relay = (yield* transaction.queryRows<
        { id: string } & RowDataPacket
      >(
        `SELECT id
             FROM ${databaseTable("relay")}
            WHERE id = ?
            LIMIT 1
            FOR UPDATE`,
        [backup.relay_id]
      ))[0]
      if (relay) return "relay_present" as const
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("backup_download_share")}
          WHERE backup_id = ?`,
        [backupId]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("backup_final_database_delete")}
          WHERE backup_id = ?`,
        [backupId]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("backup_final_delete")}
          WHERE backup_id = ?`,
        [backupId]
      )
      const result = yield* transaction.execute(
        `DELETE FROM ${databaseTable("backup")} WHERE id = ?`,
        [backupId]
      )
      if (backup.repository_id) {
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_repository")}
            WHERE id = ?
              AND NOT EXISTS (
                SELECT 1 FROM ${databaseTable("backup")}
                 WHERE repository_id = ?
              )`,
          [backup.repository_id, backup.repository_id]
        )
      }
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("backup_policy")}
          WHERE relay_id = ? AND target_kind = ? AND target_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ${databaseTable("backup")}
               WHERE relay_id = ? AND target_kind = ? AND target_id = ?
            )`,
        [
          backup.relay_id,
          backup.target_kind,
          backup.target_id,
          backup.relay_id,
          backup.target_kind,
          backup.target_id,
        ]
      )
      return result.affectedRows === 1 ? ("forgotten" as const) : "not_found"
    })
  )
})

export const forgetRelayBackupsEffect = Effect.fn("backups.forgetRelay")(
  function* (relayId: string) {
    const database = yield* Database
    return yield* database.transaction("backup_forget_relay", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_download_share")}
            WHERE backup_id IN (
              SELECT id FROM ${databaseTable("backup")} WHERE relay_id = ?
            )`,
          [relayId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_final_database_delete")}
            WHERE relay_id = ?`,
          [relayId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_final_delete")}
            WHERE relay_id = ?`,
          [relayId]
        )
        const result = yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup")} WHERE relay_id = ?`,
          [relayId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_policy")} WHERE relay_id = ?`,
          [relayId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_repository")} WHERE relay_id = ?`,
          [relayId]
        )
        return result.affectedRows
      })
    )
  }
)

export type BackupExportReservation =
  | {
      expiresAt: number
      filename: string
      kind: "ready"
    }
  | {
      dispatch: BackupExportDispatch
      kind: "dispatch"
    }

export const reserveBackupExportEffect = Effect.fn("backups.reserveExport")(
  function* (input: {
    backupId: string
    replaceFailed?: boolean
    requestedBy: string
    requireFullTtl?: boolean
    taskId: string
    ttlMs: number
  }) {
    const database = yield* Database
    const ttlMs = clampBackupExportTtlMs(input.ttlMs)
    return yield* database.transaction("backup_reserve_export", (transaction) =>
      Effect.gen(function* () {
        const backups = yield* transaction.queryRows<BackupRow>(
          `SELECT backup.id, backup.relay_id, backup.target_kind,
                  backup.target_id, backup.restic_snapshot_id
             FROM ${databaseTable("backup")} backup
            WHERE backup.id = ? AND backup.status = 'available'
              AND backup.backup_mode = 'incremental'
              AND backup.artifact_kind = 'restic_snapshot'
              AND backup.restic_snapshot_id IS NOT NULL
            FOR UPDATE`,
          [input.backupId]
        )
        const backup = backups[0]
        const snapshotId = backup?.restic_snapshot_id
        if (!backup || !snapshotId) {
          return yield* BackupStorageError.make({
            code: "backup_unavailable",
            operation: "backup.export",
            reason: "Only available incremental snapshots can be exported",
          })
        }
        yield* refuseIfFinalDeletionInProgress(transaction, {
          operation: "backup.export",
          relayId: backup.relay_id,
          targetId: backup.target_id,
          targetKind: backup.target_kind,
        })
        const filename = backupArtifactFilename(backup.id, "restic_snapshot")
        const existing = yield* transaction.queryRows<
          {
            created_at_ms: number | string
            finished_at_ms: number | string | null
            id: string
            reserved_bytes: number | string | null
            status: BackupRow["task_status"]
          } & RowDataPacket
        >(
          `SELECT task.id, task.status, task.reserved_bytes,
                  ROUND(UNIX_TIMESTAMP(task.created_at) * 1000) AS created_at_ms,
                  ROUND(UNIX_TIMESTAMP(task.finished_at) * 1000) AS finished_at_ms
             FROM ${databaseTable("backup_task")} task
            WHERE task.backup_id = ? AND task.task_kind = 'export'
            ORDER BY task.created_at DESC, task.id DESC
            LIMIT 1
            FOR UPDATE`,
          [input.backupId]
        )
        const latest = existing[0]
        const dispatchFor = (taskId: string): BackupExportDispatch => ({
          backupId: backup.id,
          kind: "export",
          snapshotId,
          target: { id: backup.target_id, kind: "instance" },
          taskId,
          ttlMs,
        })
        const pruneOlderExportTasks = (keepTaskId: string) =>
          transaction.execute(
            `DELETE FROM ${databaseTable("backup_task")}
              WHERE backup_id = ? AND task_kind = 'export'
                AND status IN ('succeeded', 'failed', 'cancelled')
                AND id <> ?`,
            [input.backupId, keepTaskId]
          )
        if (latest?.status === "succeeded") {
          const storedTtl = clampBackupExportTtlMs(
            // Export tasks store the requested TTL (ms) in reserved_bytes.
            nullableDatabaseNumber(latest.reserved_bytes, "export ttl") ??
              BACKUP_EXPORT_TTL_MIN_MS
          )
          const completedAt = nullableDatabaseNumber(
            latest.finished_at_ms,
            "export finished at"
          )
          const expiresAt =
            (completedAt ??
              safeDatabaseNumber(latest.created_at_ms, "export task time")) +
            storedTtl
          if (
            canReuseBackupExport({
              remainingMs: expiresAt - Date.now(),
              requestedTtlMs: ttlMs,
              requireFullTtl: input.requireFullTtl !== false,
            })
          ) {
            yield* pruneOlderExportTasks(latest.id)
            return {
              expiresAt,
              filename,
              kind: "ready",
            } satisfies BackupExportReservation
          }
        }
        if (
          latest &&
          (latest.status === "queued" || latest.status === "running")
        ) {
          return {
            dispatch: {
              ...dispatchFor(latest.id),
              ttlMs: clampBackupExportTtlMs(
                // Export tasks store the requested TTL (ms) in reserved_bytes.
                nullableDatabaseNumber(latest.reserved_bytes, "export ttl") ??
                  ttlMs
              ),
            },
            kind: "dispatch",
          } satisfies BackupExportReservation
        }
        if (
          latest &&
          (latest.status === "failed" || latest.status === "cancelled") &&
          input.replaceFailed === false
        ) {
          return yield* BackupStorageError.make({
            code: "backup_unavailable",
            operation: "backup.export",
            reason: "The snapshot export failed",
          })
        }
        yield* pruneOlderExportTasks(input.taskId)
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_task")}
            (id, backup_id, task_kind, status, reserved_bytes, requested_by)
           VALUES (?, ?, 'export', 'queued', ?, ?)`,
          // reserved_bytes holds the export TTL in milliseconds, not a byte count.
          [input.taskId, input.backupId, ttlMs, input.requestedBy]
        )
        return {
          dispatch: dispatchFor(input.taskId),
          kind: "dispatch",
        } satisfies BackupExportReservation
      })
    )
  }
)

export interface BackupRepositorySecret {
  objectPrefix: string | null
  password: string
  storageId: string | null
}

export const ensureBackupRepositoryEffect = Effect.fn(
  "backups.ensureRepository"
)(function* (input: {
  relayId: string
  storageId: string | null
  targetId: string
}) {
  const database = yield* Database
  return yield* database.transaction(
    "backup_repository_ensure",
    (transaction) =>
      Effect.gen(function* () {
        const storage = input.storageId
          ? (yield* lockBackupStorageRows(transaction, [input.storageId])).get(
              input.storageId
            )
          : undefined
        if (
          input.storageId &&
          (!storage || !storage.enabled || Boolean(storage.deleting))
        ) {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "backup.repository.ensure",
            reason: "The selected backup destination is unavailable",
          })
        }
        const repository = yield* loadOrCreateBackupRepository(transaction, {
          destinationObjectPrefix: storage?.object_prefix ?? "",
          relayId: input.relayId,
          storageId: input.storageId,
          targetId: input.targetId,
          targetKind: "instance",
        })
        return {
          objectPrefix: repository.objectPrefix,
          password: repository.password,
          storageId: repository.storageId,
        } satisfies BackupRepositorySecret
      })
  )
})

export const loadBackupRepositoryPasswordEffect = Effect.fn(
  "backups.repositoryPassword"
)(function* (backupId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    {
      object_prefix: string | null
      password_ciphertext: string
      storage_id: string | null
    } & RowDataPacket
  >(
    "backup_repository_password",
    `SELECT repository.password_ciphertext, repository.storage_id,
            repository.object_prefix
       FROM ${databaseTable("backup")} backup
       JOIN ${databaseTable("backup_repository")} repository
         ON repository.id = backup.repository_id
      WHERE backup.id = ?
      LIMIT 1`,
    [backupId]
  )
  const row = rows[0]
  if (!row) {
    return yield* BackupStorageError.make({
      code: "invalid_backup_destination",
      operation: "backup.dispatch",
      reason: "The restic repository is unavailable",
    })
  }
  return {
    objectPrefix: row.object_prefix,
    password: yield* decryptRepositoryPassword(row.password_ciphertext),
    storageId: row.storage_id,
  } satisfies BackupRepositorySecret
})

export const purgeInstanceBackupRepositoriesEffect = Effect.fn(
  "backups.purgeInstanceRepositories"
)(function* (relayId: string, targetId: string) {
  const database = yield* Database
  const repositories = yield* database.queryRows<
    {
      id: string
      object_prefix: string | null
      storage_id: string | null
    } & RowDataPacket
  >(
    "backup_instance_repositories",
    `SELECT id, storage_id, object_prefix
       FROM ${databaseTable("backup_repository")}
      WHERE relay_id = ? AND target_kind = 'instance' AND target_id = ?`,
    [relayId, targetId]
  )
  for (const repository of repositories) {
    if (!repository.storage_id || !repository.object_prefix) continue
    const credential = yield* loadBackupStorageCredentialEffect(
      repository.storage_id
    )
    if (!credential) {
      return yield* BackupStorageError.make({
        code: "storage_unavailable",
        operation: "backup.purgeRepository",
        reason: "The backup destination is unavailable",
      })
    }
    yield* deleteS3BackupPrefix(credential, repository.object_prefix)
  }
  yield* database.transaction(
    "backup_purge_instance_repositories",
    (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")}
              SET status = 'deleted',
                  completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP(3))
            WHERE relay_id = ? AND target_kind = 'instance' AND target_id = ?
              AND backup_mode = 'incremental' AND status <> 'deleted'`,
          [relayId, targetId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_artifact")} artifact
             JOIN ${databaseTable("backup")} backup ON backup.id = artifact.backup_id
              SET artifact.status = 'deleted',
                  artifact.deleted_at = COALESCE(artifact.deleted_at, CURRENT_TIMESTAMP(3))
            WHERE backup.relay_id = ? AND backup.target_kind = 'instance'
              AND backup.target_id = ? AND backup.backup_mode = 'incremental'
              AND artifact.status <> 'deleted'`,
          [relayId, targetId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")}
            SET repository_id = NULL
          WHERE relay_id = ? AND target_kind = 'instance' AND target_id = ?
            AND status = 'deleted'`,
          [relayId, targetId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_repository")}
          WHERE relay_id = ? AND target_kind = 'instance' AND target_id = ?`,
          [relayId, targetId]
        )
      })
  )
})

export const reserveBackupCopyEffect = Effect.fn("backups.reserveCopy")(
  function* (input: {
    artifactKind: BackupRow["artifact_kind"]
    backupId: string
    filename: string | null
    relayId: string
    requestedBy: string
    sourceArtifactId: string
    storageId: string
    targetId: string
    targetKind: BackupRow["target_kind"]
  }) {
    const database = yield* Database
    return yield* database.transaction("backup_copy_reserve", (transaction) =>
      Effect.gen(function* () {
        yield* refuseIfFinalDeletionInProgress(transaction, {
          operation: "backup.copy",
          relayId: input.relayId,
          targetId: input.targetId,
          targetKind: input.targetKind,
        })
        const source = (yield* transaction.queryRows<
          { id: string } & RowDataPacket
        >(
          `SELECT artifact.id
             FROM ${databaseTable("backup")} backup
             JOIN ${databaseTable("backup_artifact")} artifact
               ON artifact.backup_id = backup.id
            WHERE backup.id = ? AND backup.status = 'available'
              AND artifact.id = ? AND artifact.status = 'available'
            LIMIT 1
            FOR UPDATE`,
          [input.backupId, input.sourceArtifactId]
        ))[0]
        if (!source) {
          return yield* BackupStorageError.make({
            code: "backup_unavailable",
            operation: "backup.copy",
            reason: "A successful backup file is required before copying",
          })
        }
        if (input.artifactKind === "restic_snapshot") {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "backup.copy",
            reason: "Incremental snapshots cannot be copied to S3",
          })
        }
        const storage = (yield* transaction.queryRows<BackupStorageKeyRow>(
          `SELECT id, object_prefix, owner_user_id, bucket, region, endpoint,
                  enabled, deleting
               FROM ${databaseTable("backup_storage")}
              WHERE id = ? AND enabled = TRUE AND deleting = FALSE
              LIMIT 1`,
          [input.storageId]
        ))[0]
        if (!storage) {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "backup.copy",
            reason: "The backup destination is unavailable",
          })
        }
        if (
          input.targetKind === "platform"
            ? storage.owner_user_id !== null
            : storage.owner_user_id !== null &&
              storage.owner_user_id !== input.requestedBy
        ) {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "backup.copy",
            reason:
              input.targetKind === "platform"
                ? "Kiln platform backups require platform-owned destinations"
                : "The backup destination is unavailable",
          })
        }
        const existing = (yield* transaction.queryRows<BackupArtifactRow>(
          `SELECT artifact.id, artifact.backup_id, artifact.storage_id,
                    artifact.status, artifact.filename, artifact.object_key,
                    artifact.bytes, artifact.checksum_sha256, artifact.error
               FROM ${databaseTable("backup_artifact")} artifact
              WHERE artifact.backup_id = ? AND artifact.destination_key = ?
              LIMIT 1`,
          [input.backupId, input.storageId]
        ))[0]
        if (
          existing &&
          (existing.status === "available" ||
            existing.status === "queued" ||
            existing.status === "running")
        ) {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "backup.copy",
            reason:
              existing.status === "available"
                ? "This backup is already stored on that destination"
                : "This backup is already copying to that destination",
          })
        }
        const objectKey = backupObjectKey({
          artifactKind: input.artifactKind,
          backupId: input.backupId,
          installationId: kilnInstallationId(),
          objectPrefix: storage.object_prefix,
          relayId: input.relayId,
          targetId: input.targetId,
          targetKind: input.targetKind,
        })
        const artifactId = existing?.id ?? randomUUID()
        if (existing) {
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_artifact")}
                SET status = 'queued', object_key = ?, filename = ?,
                    error = NULL, completed_at = NULL, deleted_at = NULL
              WHERE id = ?`,
            [objectKey, input.filename, artifactId]
          )
        } else {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_artifact")}
              (id, backup_id, destination_key, storage_id, status, filename,
               object_key)
             VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
            [
              artifactId,
              input.backupId,
              input.storageId,
              input.storageId,
              input.filename,
              objectKey,
            ]
          )
        }
        const taskId = randomUUID()
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_copy_task")}
            (id, backup_id, source_artifact_id, destination_artifact_id,
             status, requested_by)
           VALUES (?, ?, ?, ?, 'queued', ?)
           ON DUPLICATE KEY UPDATE
             id = VALUES(id), source_artifact_id = VALUES(source_artifact_id),
             status = 'queued', requested_by = VALUES(requested_by),
             error = NULL, started_at = NULL, finished_at = NULL`,
          [
            taskId,
            input.backupId,
            input.sourceArtifactId,
            artifactId,
            input.requestedBy,
          ]
        )
        return { artifactId, objectKey, taskId }
      })
    )
  }
)

export const listRunnableBackupCopyTaskIdsEffect = Effect.fn(
  "backups.listRunnableCopies"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<{ id: string } & RowDataPacket>(
    "backup_copy_runnable_list",
    `SELECT id
       FROM ${databaseTable("backup_copy_task")}
      WHERE status = 'queued'
         OR (status = 'running' AND updated_at < CURRENT_TIMESTAMP(3) - INTERVAL 15 MINUTE)
      ORDER BY created_at ASC, id ASC`
  )
  return rows.map((row) => row.id)
})

export const claimBackupCopyTaskEffect = Effect.fn("backups.claimCopy")(
  function* (taskId: string) {
    const database = yield* Database
    return yield* database.transaction("backup_copy_claim", (transaction) =>
      Effect.gen(function* () {
        const task = (yield* transaction.queryRows<BackupCopyTaskRow>(
          `SELECT task.id AS task_id, task.backup_id, task.requested_by,
                    task.source_artifact_id, task.destination_artifact_id,
                    backup.relay_id, backup.target_kind, backup.target_id,
                    backup.artifact_kind, backup.bytes AS backup_bytes,
                    backup.checksum_sha256 AS backup_checksum_sha256,
                    source.storage_id AS source_storage_id,
                    source.object_key AS source_object_key,
                    source.bytes AS source_bytes,
                    source.checksum_sha256 AS source_checksum_sha256,
                    destination.storage_id AS destination_storage_id,
                    destination.object_key AS destination_object_key,
                    COALESCE(source.filename, backup.filename) AS filename
               FROM ${databaseTable("backup_copy_task")} task
               JOIN ${databaseTable("backup")} backup ON backup.id = task.backup_id
               JOIN ${databaseTable("backup_artifact")} source
                 ON source.id = task.source_artifact_id
               JOIN ${databaseTable("backup_artifact")} destination
                 ON destination.id = task.destination_artifact_id
              WHERE task.id = ?
                AND (task.status = 'queued'
                  OR (task.status = 'running'
                    AND task.updated_at < CURRENT_TIMESTAMP(3) - INTERVAL 15 MINUTE))
                AND source.status = 'available'
                AND destination.storage_id IS NOT NULL
                AND destination.object_key IS NOT NULL
              LIMIT 1
              FOR UPDATE`,
          [taskId]
        ))[0]
        if (!task) return null
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_copy_task")}
              SET status = 'running', error = NULL,
                  started_at = CURRENT_TIMESTAMP(3), finished_at = NULL
            WHERE id = ?`,
          [task.task_id]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_artifact")}
              SET status = 'running', error = NULL
            WHERE id = ?`,
          [task.destination_artifact_id]
        )
        return {
          artifactKind: task.artifact_kind,
          backupId: task.backup_id,
          bytes: nullableDatabaseNumber(
            task.source_bytes ?? task.backup_bytes,
            "backup copy bytes"
          ),
          checksumSha256:
            task.source_checksum_sha256 ?? task.backup_checksum_sha256,
          destinationArtifactId: task.destination_artifact_id,
          destinationObjectKey: task.destination_object_key,
          destinationStorageId: task.destination_storage_id,
          filename: task.filename,
          relayId: task.relay_id,
          requestedBy: task.requested_by,
          sourceArtifactId: task.source_artifact_id,
          sourceObjectKey: task.source_object_key,
          sourceStorageId: task.source_storage_id,
          targetId: task.target_id,
          targetKind: task.target_kind,
          taskId: task.task_id,
        } satisfies ClaimedBackupCopyTask
      })
    )
  }
)

export const completeBackupCopyTaskEffect = Effect.fn("backups.completeCopy")(
  function* (input: {
    artifactId: string
    backupId: string
    bytes: number | null
    checksumSha256: string | null
    error: string | null
    filename: string | null
    ok: boolean
    taskId: string
  }) {
    const database = yield* Database
    yield* database.transaction("backup_copy_complete", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_artifact")}
              SET status = ?, filename = ?, bytes = ?, checksum_sha256 = ?,
                  error = ?, completed_at = FROM_UNIXTIME(? / 1000)
            WHERE id = ? AND backup_id = ?`,
          [
            input.ok ? "available" : "failed",
            input.filename,
            input.ok ? input.bytes : null,
            input.ok ? input.checksumSha256 : null,
            input.error,
            Date.now(),
            input.artifactId,
            input.backupId,
          ]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_copy_task")}
              SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP(3)
            WHERE id = ?`,
          [input.ok ? "succeeded" : "failed", input.error, input.taskId]
        )
      })
    )
  }
)

export const renameBackupEffect = Effect.fn("backups.rename")(
  function* (input: { backupId: string; name: string }) {
    const database = yield* Database
    const result = yield* database.execute(
      "backup_rename",
      `UPDATE ${databaseTable("backup")}
        SET name = ?
      WHERE id = ? AND status <> 'deleted'`,
      [input.name, input.backupId]
    )
    return result.affectedRows > 0
  }
)

export const updateBackupLimitsEffect = Effect.fn("backups.updateLimits")(
  function* (input: {
    admin: boolean
    quantityLimit: number | null
    relayId: string
    sizeLimitBytes: number | null
    targetId: string
    targetKind: BackupTargetKind
  }) {
    const database = yield* Database
    const quantityColumn = input.admin
      ? "admin_quantity_limit"
      : "quantity_limit"
    const sizeColumn = input.admin
      ? "admin_size_limit_bytes"
      : "size_limit_bytes"
    yield* database.execute(
      "backup_limits_update",
      `INSERT INTO ${databaseTable("backup_policy")}
        (relay_id, target_kind, target_id, exclude_patterns,
         ${quantityColumn}, ${sizeColumn})
       VALUES (?, ?, ?, JSON_ARRAY(), ?, ?)
       ON DUPLICATE KEY UPDATE
         ${quantityColumn} = VALUES(${quantityColumn}),
         ${sizeColumn} = VALUES(${sizeColumn})`,
      [
        input.relayId,
        input.targetKind,
        input.targetId,
        input.quantityLimit,
        input.sizeLimitBytes,
      ]
    )
  }
)

export const getBackupPolicyEffect = Effect.fn("backups.getPolicy")(function* (
  relayId: string,
  targetKind: BackupTargetKind,
  targetId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<BackupPolicyRow>(
    "backup_policy_get",
    `SELECT exclude_patterns, quantity_limit, size_limit_bytes, storage_id,
            admin_quantity_limit, admin_size_limit_bytes
       FROM ${databaseTable("backup_policy")}
      WHERE relay_id = ? AND target_kind = ? AND target_id = ?
      LIMIT 1`,
    [relayId, targetKind, targetId]
  )
  const policy = rows[0]
  return {
    adminQuantityLimit: policy?.admin_quantity_limit ?? null,
    adminSizeLimitBytes: nullableDatabaseNumber(
      policy?.admin_size_limit_bytes ?? null,
      "admin backup size limit"
    ),
    exclude: parseExcludes(policy?.exclude_patterns ?? []),
    quantityLimit: policy?.quantity_limit ?? null,
    sizeLimitBytes: nullableDatabaseNumber(
      policy?.size_limit_bytes ?? null,
      "backup size limit"
    ),
    storageId: policy?.storage_id ?? null,
  } satisfies BackupPolicy
})

export const updateBackupExcludesEffect = Effect.fn("backups.updateExcludes")(
  function* (input: {
    exclude: ReadonlyArray<string>
    relayId: string
    targetId: string
    targetKind: BackupTargetKind
  }) {
    const database = yield* Database
    yield* database.execute(
      "backup_excludes_update",
      `INSERT INTO ${databaseTable("backup_policy")}
        (relay_id, target_kind, target_id, exclude_patterns)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE exclude_patterns = VALUES(exclude_patterns)`,
      [
        input.relayId,
        input.targetKind,
        input.targetId,
        JSON.stringify(input.exclude),
      ]
    )
  }
)

export const getFinalInstanceDeletionEffect = Effect.fn(
  "backups.finalDelete.get"
)(function* (relayId: string, targetId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<FinalInstanceDeletionRow>(
    "backup_final_delete_get",
    `${finalInstanceDeletionSelect}
      WHERE final_delete.relay_id = ? AND final_delete.target_id = ?
      LIMIT 1`,
    [relayId, targetId]
  )
  return rows[0] ? toFinalInstanceDeletion(rows[0]) : null
})

export const listPendingFinalInstanceDeletionsEffect = Effect.fn(
  "backups.finalDelete.listPending"
)(function* (relayId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<FinalInstanceDeletionRow>(
    "backup_final_delete_list_pending",
    `${finalInstanceDeletionSelect}
      WHERE final_delete.relay_id = ?
        AND final_delete.status IN ('backing_up', 'deleting')
      ORDER BY final_delete.created_at ASC, final_delete.target_id ASC`,
    [relayId]
  )
  return rows.map(toFinalInstanceDeletion)
})

export const clearFailedFinalInstanceDeletionEffect = Effect.fn(
  "backups.finalDelete.clearFailed"
)(function* (relayId: string, targetId: string) {
  const database = yield* Database
  const result = yield* database.execute(
    "backup_final_delete_clear_failed",
    `DELETE FROM ${databaseTable("backup_final_delete")}
      WHERE relay_id = ? AND target_id = ? AND status = 'failed'`,
    [relayId, targetId]
  )
  return result.affectedRows > 0
})

export const updateFinalInstanceDeletionEffect = Effect.fn(
  "backups.finalDelete.update"
)(function* (input: {
  error: string | null
  from: ReadonlyArray<FinalInstanceDeletion["status"]>
  relayId: string
  status: FinalInstanceDeletion["status"]
  targetId: string
}) {
  const database = yield* Database
  const placeholders = input.from.map(() => "?").join(", ")
  const result = yield* database.execute(
    "backup_final_delete_update",
    `UPDATE ${databaseTable("backup_final_delete")}
        SET status = ?, error = ?
      WHERE relay_id = ? AND target_id = ?
        AND status IN (${placeholders})`,
    [input.status, input.error, input.relayId, input.targetId, ...input.from]
  )
  return result.affectedRows > 0
})

export const getFinalDatabaseDeletionEffect = Effect.fn(
  "backups.finalDatabaseDelete.get"
)(function* (relayId: string, targetId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<FinalDatabaseDeletionRow>(
    "backup_final_database_delete_get",
    `${finalDatabaseDeletionSelect}
      WHERE final_delete.relay_id = ? AND final_delete.target_id = ?
      LIMIT 1`,
    [relayId, targetId]
  )
  return rows[0] ? toFinalInstanceDeletion(rows[0]) : null
})

export const listPendingFinalDatabaseDeletionsEffect = Effect.fn(
  "backups.finalDatabaseDelete.listPending"
)(function* (relayId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<FinalDatabaseDeletionRow>(
    "backup_final_database_delete_list_pending",
    `${finalDatabaseDeletionSelect}
      WHERE final_delete.relay_id = ?
        AND final_delete.status IN ('backing_up', 'deleting')
      ORDER BY final_delete.created_at ASC, final_delete.target_id ASC`,
    [relayId]
  )
  return rows.map(toFinalInstanceDeletion)
})

export const clearFailedFinalDatabaseDeletionEffect = Effect.fn(
  "backups.finalDatabaseDelete.clearFailed"
)(function* (relayId: string, targetId: string) {
  const database = yield* Database
  const result = yield* database.execute(
    "backup_final_database_delete_clear_failed",
    `DELETE FROM ${databaseTable("backup_final_database_delete")}
      WHERE relay_id = ? AND target_id = ? AND status = 'failed'`,
    [relayId, targetId]
  )
  return result.affectedRows > 0
})

export const updateFinalDatabaseDeletionEffect = Effect.fn(
  "backups.finalDatabaseDelete.update"
)(function* (input: {
  error: string | null
  from: ReadonlyArray<FinalDatabaseDeletion["status"]>
  relayId: string
  status: FinalDatabaseDeletion["status"]
  targetId: string
}) {
  const database = yield* Database
  const placeholders = input.from.map(() => "?").join(", ")
  const result = yield* database.execute(
    "backup_final_database_delete_update",
    `UPDATE ${databaseTable("backup_final_database_delete")}
        SET status = ?, error = ?
      WHERE relay_id = ? AND target_id = ?
        AND status IN (${placeholders})`,
    [input.status, input.error, input.relayId, input.targetId, ...input.from]
  )
  return result.affectedRows > 0
})

const finalInstanceDeletionSelect = `SELECT final_delete.relay_id,
       final_delete.target_id, final_delete.backup_id,
       final_delete.requested_by, final_delete.status, final_delete.error,
       backup.status AS backup_status,
       create_task.error AS task_error
  FROM ${databaseTable("backup_final_delete")} final_delete
  JOIN ${databaseTable("backup")} backup ON backup.id = final_delete.backup_id
  JOIN ${databaseTable("backup_task")} create_task ON create_task.id = (
    SELECT task.id
      FROM ${databaseTable("backup_task")} task
     WHERE task.backup_id = backup.id AND task.task_kind = 'create'
     ORDER BY task.created_at DESC, task.id DESC
     LIMIT 1
  )`

const finalDatabaseDeletionSelect = `SELECT final_delete.relay_id,
       final_delete.target_id, final_delete.backup_id,
       final_delete.requested_by, final_delete.status, final_delete.error,
       backup.status AS backup_status,
       create_task.error AS task_error
  FROM ${databaseTable("backup_final_database_delete")} final_delete
  JOIN ${databaseTable("backup")} backup ON backup.id = final_delete.backup_id
  JOIN ${databaseTable("backup_task")} create_task ON create_task.id = (
    SELECT task.id
      FROM ${databaseTable("backup_task")} task
     WHERE task.backup_id = backup.id AND task.task_kind = 'create'
     ORDER BY task.created_at DESC, task.id DESC
     LIMIT 1
  )`

function toFinalInstanceDeletion(
  row: FinalInstanceDeletionRow
): FinalInstanceDeletion {
  return {
    backupId: row.backup_id,
    backupStatus: row.backup_status,
    error: row.error,
    relayId: row.relay_id,
    requestedBy: row.requested_by,
    status: row.status,
    targetId: row.target_id,
    taskError: row.task_error,
  }
}

export function clampBackupExportTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return BACKUP_EXPORT_TTL_MIN_MS
  return Math.min(
    BACKUP_EXPORT_TTL_MAX_MS,
    Math.max(BACKUP_EXPORT_TTL_MIN_MS, Math.trunc(ttlMs))
  )
}

export function canReuseBackupExport(input: {
  remainingMs: number
  requestedTtlMs: number
  requireFullTtl: boolean
}): boolean {
  if (input.remainingMs <= 0) return false
  if (!input.requireFullTtl) return true
  // Completion-anchored expiry is almost always slightly under the requested
  // TTL, and Relay reuse already extends the staged zip. Accept remaining time
  // at or above the signed-URL floor instead of requiring a full TTL.
  return (
    input.remainingMs >=
    Math.min(input.requestedTtlMs, BACKUP_EXPORT_TTL_MIN_MS)
  )
}

export function effectiveBackupLimit(
  userLimit: number | null,
  adminLimit: number | null
): number | null {
  if (userLimit === null) return adminLimit
  if (adminLimit === null) return userLimit
  return Math.min(userLimit, adminLimit)
}

export function backupReservation(input: {
  quantityLimit: number | null
  quantityUsed: number
  requestedMaxBytes: number | null
  sizeLimit: number | null
  sizeUsed: number
}): { maxBytes: number | null } {
  if (
    input.quantityLimit !== null &&
    input.quantityUsed >= input.quantityLimit
  ) {
    throw BackupLimitError.make({
      kind: "quantity",
      limit: input.quantityLimit,
      used: input.quantityUsed,
    })
  }
  const remaining =
    input.sizeLimit === null
      ? null
      : Math.max(0, input.sizeLimit - input.sizeUsed)
  if (remaining !== null && remaining === 0) {
    throw BackupLimitError.make({
      kind: "size",
      limit: input.sizeLimit ?? 0,
      used: input.sizeUsed,
    })
  }
  return {
    maxBytes:
      input.requestedMaxBytes === null
        ? remaining
        : remaining === null
          ? input.requestedMaxBytes
          : Math.min(input.requestedMaxBytes, remaining),
  }
}

export function shouldApplyRelayBackupTaskSnapshot(
  current: BackupTaskReconcileState,
  incoming: Pick<RelayBackupTask, "bytesCompleted" | "status" | "updatedAt">
): boolean {
  if (
    isTerminalBackupTaskStatus(current.status) &&
    !isTerminalBackupTaskStatus(incoming.status)
  ) {
    return false
  }
  if (current.relayUpdatedAt === null) return true
  if (incoming.updatedAt !== current.relayUpdatedAt) {
    return incoming.updatedAt > current.relayUpdatedAt
  }
  if (incoming.status === current.status) {
    return incoming.bytesCompleted > current.bytesCompleted
  }
  return (
    backupTaskStatusOrder(incoming.status) >
    backupTaskStatusOrder(current.status)
  )
}

function isTerminalBackupTaskStatus(status: BackupTaskStatus): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded"
}

function backupTaskStatusOrder(status: BackupTaskStatus): number {
  switch (status) {
    case "queued":
      return 0
    case "running":
      return 1
    case "cancelled":
    case "failed":
    case "succeeded":
      return 2
  }
}

function deduplicateStorageIds(
  storageIds: ReadonlyArray<string | null>
): Array<string | null> {
  const seen = new Set<string>()
  return storageIds.filter((storageId) => {
    const key = storageId ?? "local"
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dispatchArtifact(artifact: BackupArtifactRow): BackupDispatchArtifact {
  return {
    artifactId: artifact.id,
    objectKey: artifact.object_key,
    storageId: artifact.storage_id,
  }
}

function parseExcludes(value: unknown): Array<string> {
  const parsed = parseJsonArray(value)
  return parsed.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 1_024
  )
}

function parseWarnings(value: unknown): Array<string> {
  return parseJsonArray(value).filter(
    (entry): entry is string => typeof entry === "string"
  )
}

function parseJsonArray(value: unknown): Array<unknown> {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return []
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed : []
}

function nullableDatabaseNumber(
  value: number | string | null,
  label: string
): number | null {
  return value === null ? null : safeDatabaseNumber(value, label)
}

function safeDatabaseNumber(value: number | string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the supported integer range`)
  }
  return parsed
}

function timestampIso(
  value: number | string | null,
  label: string
): string | null {
  return value === null
    ? null
    : new Date(safeDatabaseNumber(value, label)).toISOString()
}

function requiredTimestampIso(
  value: number | string | null,
  label: string
): string {
  const timestamp = timestampIso(value, label)
  if (timestamp === null) throw new Error(`${label} is missing`)
  return timestamp
}

const loadOrCreateBackupRepository = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  input: {
    destinationObjectPrefix: string
    relayId: string
    storageId: string | null
    targetId: string
    targetKind: string
  }
) {
  const storageKey = input.storageId ?? "local"
  const existing = yield* transaction.queryRows<
    {
      id: string
      object_prefix: string | null
      password_ciphertext: string
      storage_id: string | null
    } & RowDataPacket
  >(
    `SELECT id, password_ciphertext, storage_id, object_prefix
         FROM ${databaseTable("backup_repository")}
        WHERE relay_id = ? AND target_kind = ? AND target_id = ?
          AND storage_key = ?
        FOR UPDATE`,
    [input.relayId, input.targetKind, input.targetId, storageKey]
  )
  if (existing[0]) {
    const decrypted = yield* decryptRepositoryPassword(
      existing[0].password_ciphertext
    )
    return {
      id: existing[0].id,
      objectPrefix: existing[0].object_prefix,
      password: decrypted,
      storageId: existing[0].storage_id,
    }
  }
  const password = randomBytes(32).toString("base64url")
  const id = randomUUID()
  const ciphertext = yield* encryptRepositoryPassword(password)
  const objectPrefix = input.storageId
    ? resticRepositoryObjectPrefix({
        installationId: kilnInstallationId(),
        objectPrefix: input.destinationObjectPrefix,
        relayId: input.relayId,
        repositoryId: id,
        targetId: input.targetId,
      })
    : null
  yield* transaction.execute(
    `INSERT INTO ${databaseTable("backup_repository")}
        (id, relay_id, target_kind, target_id, storage_id, storage_key,
         object_prefix, password_ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.relayId,
      input.targetKind,
      input.targetId,
      input.storageId,
      storageKey,
      objectPrefix,
      ciphertext,
    ]
  )
  return { id, objectPrefix, password, storageId: input.storageId }
})

const lockBackupStorageRows = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  storageIds: ReadonlyArray<string>
) {
  const ids = [...new Set(storageIds)].sort()
  const locked = new Map<string, BackupStorageKeyRow>()
  if (ids.length === 0) return locked
  const rows = yield* transaction.queryRows<BackupStorageKeyRow>(
    `SELECT id, object_prefix, owner_user_id, bucket, region, endpoint,
              enabled, deleting
         FROM ${databaseTable("backup_storage")}
        WHERE id IN (${ids.map(() => "?").join(", ")})
        ORDER BY id
        FOR UPDATE`,
    ids
  )
  for (const row of rows) locked.set(row.id, row)
  return locked
})

const refuseIfFinalDeletionInProgress = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  input: {
    operation: string
    relayId: string
    targetId: string
    targetKind: "database" | "instance" | "platform"
  }
) {
  if (input.targetKind === "platform") return
  const table =
    input.targetKind === "database"
      ? "backup_final_database_delete"
      : "backup_final_delete"
  const rows = yield* transaction.queryRows<RowDataPacket>(
    `SELECT backup_id
       FROM ${databaseTable(table)}
      WHERE relay_id = ? AND target_id = ?
        AND status IN ('backing_up', 'deleting')
      LIMIT 1
      FOR UPDATE`,
    [input.relayId, input.targetId]
  )
  if (rows[0]?.backup_id) {
    return yield* BackupStorageError.make({
      code: "final_delete_in_progress",
      operation: input.operation,
      reason: "This resource is being permanently deleted",
    })
  }
})

function incrementalStorageLocationError(
  storage: BackupStorageKeyRow
): string | null {
  const parsedBucket = resticS3BucketSchema.safeParse(storage.bucket)
  if (!parsedBucket.success) {
    return incrementalStorageValidationError(
      parsedBucket.error.issues[0]?.message ?? "The bucket name is invalid"
    )
  }
  const parsedRegion = resticS3RegionSchema.safeParse(storage.region)
  if (!parsedRegion.success) {
    return incrementalStorageValidationError(
      parsedRegion.error.issues[0]?.message ?? "The region is invalid"
    )
  }
  if (!isSafeResticObjectPrefix(storage.object_prefix)) {
    return incrementalStorageValidationError(RESTIC_OBJECT_PREFIX_ERROR)
  }
  return null
}

function incrementalStorageValidationError(reason: string): string {
  return `This destination can't be used for incremental backups. ${reason}. Edit the destination and save it again.`
}

function encryptRepositoryPassword(password: string) {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        password,
        betterAuthSecrets(),
        RESTIC_REPOSITORY_PASSWORD_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        operation: "encrypt_restic_repository_password",
        cause,
      }),
  })
}

function decryptRepositoryPassword(ciphertext: string) {
  return Effect.try({
    try: () =>
      decryptWithKeyring(
        ciphertext,
        betterAuthSecrets(),
        RESTIC_REPOSITORY_PASSWORD_PURPOSE
      ).plaintext,
    catch: (cause) =>
      CredentialError.make({
        operation: "decrypt_restic_repository_password",
        cause,
      }),
  })
}
