import { randomBytes, randomUUID } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Result } from "effect"

import type {
  BackupConsistency,
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
  backupFailureCodeFromMessage,
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
import { invalidateScheduleDeploymentsEffect } from "@/effect/schedule-invalidation"
import { kilnInstallationId } from "@/effect/installation"
import {
  BackupLimitError,
  BackupStorageError,
  CredentialError,
} from "@/effect/errors"
import { backupTargetApp } from "@/lib/backup-target-permissions"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"
import {
  backupObjectKey,
  deleteS3BackupPrefix,
  isSafeResticObjectPrefix,
  RESTIC_OBJECT_PREFIX_ERROR,
  resticRepositoryObjectPrefix,
} from "@/backups/destinations/s3"
import { loadBackupStorageCredentialEffect } from "@/backups/destinations/s3"

const RESTIC_REPOSITORY_PASSWORD_PURPOSE = "kiln-restic-repository-password"
// Running copy tasks untouched this long are treated as abandoned.
const BACKUP_COPY_STALE_MS = 15 * 60 * 1000
// The backups that count against a target's quantity limit.
const COUNTED_BACKUP_STATUSES = "('queued', 'running', 'available', 'deleting')"

interface BackupPolicyRow extends RowDataPacket {
  admin_quantity_limit: number | null
  admin_retention_days: number | null
  admin_size_limit_bytes: number | string | null
  exclude_patterns: unknown
  quantity_limit: number | null
  retention_days: number | null
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
  error_code: string | null
  filename: string | null
  id: string
  object_key: string | null
  status: "available" | "deleted" | "deleting" | "failed" | "queued" | "running"
  storage_id: string | null
}

interface BackupCopyTaskRow extends RowDataPacket {
  archive_id: string
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

interface BackupQuantityRow extends RowDataPacket {
  quantity_used: number | string
}

interface BackupUsageRow extends BackupQuantityRow {
  quantity_available: number | string | null
}

interface BackupRow extends RowDataPacket {
  artifact_kind:
    | "archive"
    | "database_dump"
    | "platform_bundle"
    | "restic_snapshot"
    | "tar_archive"
  backup_mode: "full" | "incremental"
  bytes: number | string | null
  checksum_sha256: string | null
  completed_at_ms: number | null
  created_by: string | null
  created_at_ms: number
  filename: string | null
  id: string
  linked_from_backup_id: string | null
  linked_from_target_id: string | null
  name: string
  reason: "final_delete" | "manual" | "pre_restore" | "scheduled"
  relay_id: string
  object_key: string | null
  repository_id: string | null
  restic_snapshot_id: string | null
  storage_id: string | null
  status: "available" | "deleted" | "deleting" | "failed" | "queued" | "running"
  target_id: string
  target_kind: BackupTargetKind
  task_error: string | null
  task_error_code: string | null
  task_bytes_completed: number | string
  task_bytes_total: number | string | null
  task_current_artifact_id: string | null
  task_current_path: string | null
  task_id: string
  task_kind: "create" | "delete" | "export" | "restore"
  task_phase: BackupTaskPhase | null
  task_started_at_ms: number | null
  task_status: "cancelled" | "failed" | "queued" | "running" | "succeeded"
  task_updated_at_ms: number
  warnings: unknown
}

interface BackupCatalogPageRow extends BackupRow {
  order_value: number | string | null
  relay_present: boolean | number
}

export interface BackupCatalogPageInput {
  /** Where the user may read backups of game servers, databases, and Kiln volumes. */
  allowedScopes: ReadonlyArray<{
    relayId: string
    resourceType: "relay" | "instance" | "database"
    resourceId: string
  }>
  /**
   * Where the user may read Apps, whose folders' and own volumes' backups
   * follow them: every App on a Relay, when `appId` is null.
   */
  appScopes: ReadonlyArray<{ appId: string | null; relayId: string }>
  backupId?: string
  cursor: { id: string; value: number | string | null } | null
  direction: "asc" | "desc"
  isAdmin: boolean
  limit: number
  scope:
    | {
        kind: BackupTargetKind
        relayId: string
        targetId: string
      }
    | { kind: BackupTargetKind }
    | null
  search: string
  sort: "createdAt" | "name" | "size" | "target"
  status: "active" | "available" | "failed" | null
  userId: string
}

export interface BackupCatalogPageRecord {
  orderValue: number | string | null
  record: BackupCatalogRecord
  relayPresent: boolean
}

interface DispatchableBackupRow extends RowDataPacket {
  artifact_kind: BackupRow["artifact_kind"]
  backup_id: string
  backup_mode: BackupRow["backup_mode"]
  bytes: number | string | null
  checksum_sha256: string | null
  consistency: BackupConsistency | null
  create_task_id: string | null
  exclude_patterns: unknown
  linked_from_backup_id: string | null
  linked_from_target_id: string | null
  object_key: string | null
  reason: BackupCreateTaskInput["reason"]
  repository_id: string | null
  reserved_bytes: number | string | null
  restic_snapshot_id: string | null
  storage_id: string | null
  target_id: string
  target_kind: BackupRow["target_kind"]
  task_created_at_ms: number
  task_id: string
  task_kind: "create" | "delete" | "export" | "restore"
}

interface KnownBackupTaskRow extends RowDataPacket {
  task_kind?: string
  backup_mode: BackupRow["backup_mode"]
  backup_status: BackupRow["status"]
  reason?: string
  repository_id?: string | null
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
  /**
   * The backup and server a linked backup's archive was made as: a copied
   * game server's record of the original's archive. Null for its own.
   */
  linkedFrom: { backupId: string; targetId: string } | null
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
  taskErrorCode: string | null
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
  errorCode: string | null
  filename: string | null
  id: string
  objectKey: string | null
  status: BackupArtifactRow["status"]
  storageId: string | null
}

export interface ClaimedBackupCopyTask {
  /** The backup the archive was made as; a linked backup shares another's. */
  archiveId: string
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

/**
 * What a target keeps: its newest backups, up to a number of them, the
 * space they take together, and an age. Each has a platform administrator's
 * ceiling; the lower applies, and `null` keeps without that limit. Older
 * backups are deleted (see `expiredBackupsEffect`).
 */
export interface BackupPolicy {
  adminQuantityLimit: number | null
  adminRetentionDays: number | null
  adminSizeLimitBytes: number | null
  exclude: Array<string>
  quantityLimit: number | null
  retentionDays: number | null
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
  archive?: BackupRestoreTaskInput["archive"]
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
    /** An App's folder or a volume's; absent is live. */
    consistency?: BackupConsistency
    createdBy: string
    /** The deletion a final-delete backup is for, which records it. */
    deletionId?: string
    exclude: ReadonlyArray<string>
    /**
     * The final backup the deletion took before this one, of an App's
     * folder or one of its volumes; null or absent for its first.
     */
    previousFinalBackupId?: string | null
    mode?: BackupCreateTaskInput["mode"]
    name: string
    reason?: BackupCreateTaskInput["reason"]
    relayId: string
    requestedMaxBytes: number | null
    storageId?: string | null
    storageIds?: ReadonlyArray<string | null>
    targetId: string
    targetKind: BackupRow["target_kind"]
    taskId: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction("backup_reserve", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `INSERT IGNORE INTO ${databaseTable("backup_policy")}
            (relay_id, target_kind, target_id, exclude_patterns, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.relayId,
            input.targetKind,
            input.targetId,
            JSON.stringify(input.exclude),
            now,
            now,
          ]
        )
        const policies = yield* transaction.queryRows<BackupPolicyRow>(
          `SELECT exclude_patterns, quantity_limit, size_limit_bytes, storage_id,
                  admin_quantity_limit, admin_size_limit_bytes,
            retention_days, admin_retention_days
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
            now,
            relayId: input.relayId,
            storageId: primaryArtifact.storageId,
            targetId: input.targetId,
            targetKind: input.targetKind,
          })
          repositoryId = repository.id
          repositoryPassword = repository.password
        }
        // Retention makes room by deleting older backups once this one is
        // kept, so a new backup is refused only where backups are turned off
        // (a ceiling of none), and can't outgrow all the space kept.
        // Final-deletion backups pass the owner's own limits.
        const quantityLimit = effectiveBackupLimit(
          input.reason === "final_delete" ? null : policy.quantity_limit,
          policy.admin_quantity_limit
        )
        const sizeLimit = effectiveBackupLimit(
          input.reason === "final_delete"
            ? null
            : nullableDatabaseNumber(
                policy.size_limit_bytes,
                "backup size limit"
              ),
          nullableDatabaseNumber(
            policy.admin_size_limit_bytes,
            "admin backup size limit"
          )
        )
        const reservation = yield* Effect.try({
          try: () =>
            backupReservation({
              quantityLimit,
              requestedMaxBytes: input.requestedMaxBytes,
              sizeLimit,
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
             consistency, warnings, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                   'queued', ?, ?, ?, ?, JSON_ARRAY(), ?, ?, ?)`,
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
            input.consistency ?? null,
            input.createdBy,
            now,
            now,
          ]
        )
        for (const artifact of artifacts) {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_artifact")}
              (id, backup_id, destination_key, storage_id, status, object_key,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
            [
              artifact.artifactId,
              input.backupId,
              mode === "incremental"
                ? "restic"
                : (artifact.storageId ?? "local"),
              artifact.storageId,
              artifact.objectKey,
              now,
              now,
            ]
          )
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_task")}
            (id, backup_id, task_kind, status, reserved_bytes, requested_by,
             created_at, updated_at)
           VALUES (?, ?, 'create', 'queued', ?, ?, ?, ?)`,
          [
            input.taskId,
            input.backupId,
            reservation.maxBytes,
            input.createdBy,
            now,
            now,
          ]
        )
        if (input.reason === "final_delete") {
          // Recorded on its deletion in the same transaction, so the
          // deletion follows this backup by its ID and never takes two. An
          // App's parts are taken one after another, each replacing the one
          // before, which it names.
          const recorded = input.deletionId
            ? yield* transaction.execute(
                `UPDATE ${databaseTable("resource_deletion")}
                    SET backup_id = ?, status = 'backing_up', updated_at = ?
                  WHERE id = ? AND relay_id = ? AND backup_id <=> ?
                    AND status IN ('pending', 'backing_up')`,
                [
                  input.backupId,
                  now,
                  input.deletionId,
                  input.relayId,
                  input.previousFinalBackupId ?? null,
                ]
              )
            : null
          if (!recorded || recorded.affectedRows !== 1) {
            return yield* BackupStorageError.make({
              code: "reservation_failed",
              operation: "backup.finalDelete",
              reason: "This deletion isn't waiting for a final backup",
            })
          }
        }
        return {
          artifacts,
          artifactKind,
          backupId: input.backupId,
          ...(input.consistency ? { consistency: input.consistency } : {}),
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
    /** The deletion a final-delete backup is for. */
    deletionId?: string
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
    /** The deletion a final-delete backup is for. */
    deletionId?: string
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

/**
 * Reserves a backup of an App's folder or a volume, archived through Docker
 * on its Relay, live or with what uses it stopped. Always full.
 */
export const reserveResourceBackupEffect = Effect.fn("backups.reserveResource")(
  (input: {
    backupId: string
    consistency: BackupConsistency
    createdBy: string
    /** The deletion a final-delete backup is for. */
    deletionId?: string
    name: string
    /** The final backup of the same deletion before this one. */
    previousFinalBackupId?: string | null
    reason?: BackupCreateTaskInput["reason"]
    relayId: string
    requestedMaxBytes: number | null
    storageIds?: ReadonlyArray<string | null>
    targetId: string
    targetKind: "app" | "volume"
    taskId: string
  }) =>
    reserveBackupCreateEffect({
      ...input,
      artifactKind: "tar_archive",
      exclude: [],
      mode: "full",
    })
)

/**
 * Whether one target's scheduled backup may run, decided as a manual
 * backup's reservation decides it: not while the target is being deleted,
 * not where backups are turned off for it (a quantity or size ceiling of
 * none), and only to a destination that's enabled, not being deleted, and
 * shared or the schedule owner's. The Relay runs scheduled backups on its
 * own, so Hearth decides this when it sends the schedule, and sends it again
 * when any of it changes (`invalidateScheduleDeploymentsEffect`). Also the most an
 * admitted one may write.
 */
export const scheduledBackupAdmissionEffect = Effect.fn(
  "backups.scheduledAdmission"
)(function* (input: {
  mode: "full" | "incremental"
  /** Who owns the schedule; a personal destination must be theirs. */
  owner: string | null
  relayId: string
  storageId: string | null
  targetId: string
  targetKind: BackupTargetKind
}) {
  const database = yield* Database
  const admitted = (maxBytes: number | null) => ({ maxBytes, refusal: null })
  const refused = (refusal: string) => ({ maxBytes: null, refusal })
  return yield* database.transaction(
    "backup_scheduled_admission",
    (transaction) =>
      Effect.gen(function* () {
        const deleting = yield* Effect.result(
          refuseIfFinalDeletionInProgress(transaction, {
            operation: "backup.scheduled",
            relayId: input.relayId,
            targetId: input.targetId,
            targetKind: input.targetKind,
          })
        )
        if (Result.isFailure(deleting)) {
          return refused("it's being permanently deleted")
        }
        const [policy] = yield* transaction.queryRows<BackupPolicyRow>(
          `SELECT quantity_limit, size_limit_bytes, admin_quantity_limit,
                  admin_size_limit_bytes
             FROM ${databaseTable("backup_policy")}
            WHERE relay_id = ? AND target_kind = ? AND target_id = ?`,
          [input.relayId, input.targetKind, input.targetId]
        )
        const quantityLimit = effectiveBackupLimit(
          policy?.quantity_limit ?? null,
          policy?.admin_quantity_limit ?? null
        )
        const sizeLimit = effectiveBackupLimit(
          nullableDatabaseNumber(
            policy?.size_limit_bytes ?? null,
            "backup size limit"
          ),
          nullableDatabaseNumber(
            policy?.admin_size_limit_bytes ?? null,
            "admin backup size limit"
          )
        )
        if (quantityLimit === 0 || sizeLimit === 0) {
          return refused("backups are turned off for it")
        }
        if (input.storageId) {
          const storage = (yield* lockBackupStorageRows(transaction, [
            input.storageId,
          ])).get(input.storageId)
          if (!storage) return refused("its backup destination is gone")
          if (!storage.enabled) {
            return refused("its backup destination is disabled")
          }
          if (storage.deleting) {
            return refused("its backup destination is being deleted")
          }
          if (
            storage.owner_user_id !== null &&
            storage.owner_user_id !== input.owner
          ) {
            return refused(
              "its backup destination is someone else's personal one"
            )
          }
          if (input.mode === "incremental") {
            const locationError = incrementalStorageLocationError(storage)
            if (locationError) return refused(locationError)
          }
        }
        return admitted(sizeLimit)
      })
  )
})

const adoptScheduledBackupTask = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  relayId: string,
  task: RelayBackupTask,
  now: number
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
  // An incremental one names the repository Hearth sent with its schedule;
  // one from before that is found by its target and destination. Without
  // its repository's password a snapshot can't be restored, so one whose
  // repository is gone is cataloged as failed, not left out.
  const repositoryRows =
    input.mode === "incremental"
      ? catalog.repositoryId
        ? yield* transaction.queryRows<ScheduledBackupRepositoryRow>(
            `SELECT id
               FROM ${databaseTable("backup_repository")}
              WHERE id = ? AND relay_id = ? AND target_kind = ?
                AND target_id = ?
              LIMIT 1
              FOR UPDATE`,
            [catalog.repositoryId, relayId, input.target.kind, input.target.id]
          )
        : yield* transaction.queryRows<ScheduledBackupRepositoryRow>(
            `SELECT id
               FROM ${databaseTable("backup_repository")}
              WHERE relay_id = ? AND target_kind = ? AND target_id = ?
                AND storage_key = ?
              LIMIT 1
              FOR UPDATE`,
            [
              relayId,
              input.target.kind,
              input.target.id,
              catalog.storageId ?? "local",
            ]
          )
      : []
  const repositoryId = repositoryRows[0]?.id ?? null
  const orphaned = input.mode === "incremental" && !repositoryId
  const objectKey =
    input.destination.kind === "s3" ? input.destination.objectKey : null

  yield* transaction.execute(
    `INSERT IGNORE INTO ${databaseTable("backup")}
      (id, relay_id, target_kind, target_id, storage_id, artifact_kind,
       backup_mode, reason, status, name, object_key, repository_id,
       warnings, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?,
             JSON_ARRAY(), NULL, ?, ?)`,
    [
      input.backupId,
      relayId,
      input.target.kind,
      input.target.id,
      catalog.storageId,
      input.artifactKind,
      input.mode,
      orphaned ? "failed" : "queued",
      catalog.name,
      objectKey,
      repositoryId,
      task.createdAt,
      now,
    ]
  )
  yield* transaction.execute(
    `INSERT IGNORE INTO ${databaseTable("backup_artifact")}
      (id, backup_id, destination_key, storage_id, status, object_key,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      artifactId,
      input.backupId,
      input.mode === "incremental" ? "restic" : (catalog.storageId ?? "local"),
      catalog.storageId,
      orphaned ? "failed" : "queued",
      objectKey,
      task.createdAt,
      now,
    ]
  )
  yield* transaction.execute(
    `INSERT IGNORE INTO ${databaseTable("backup_task")}
      (id, backup_id, task_kind, status, reserved_bytes, requested_by,
       error, created_at, updated_at)
     VALUES (?, ?, 'create', ?, ?, NULL, ?, ?, ?)`,
    [
      input.taskId,
      input.backupId,
      orphaned ? "failed" : "queued",
      input.maxBytes,
      orphaned
        ? "Its repository was gone when it finished, so it can't be restored"
        : null,
      task.createdAt,
      now,
    ]
  )
})

export const reconcileBackupTaskEffect = Effect.fn("backups.reconcile")(
  function* (task: RelayBackupTask, relayId?: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    let changed = false
    yield* database.transaction("backup_reconcile", (transaction) =>
      Effect.gen(function* () {
        const knownTasks = yield* transaction.queryRows<KnownBackupTaskRow>(
          `SELECT task.id, task.status, task.bytes_completed,
                  backup.status AS backup_status, backup.backup_mode,
                  backup.repository_id, backup.reason, task.task_kind,
                  task.relay_updated_at_ms
             FROM ${databaseTable("backup_task")} task
             JOIN ${databaseTable("backup")} backup ON backup.id = task.backup_id
            WHERE task.id = ? AND task.backup_id = ?
            FOR UPDATE`,
          [task.taskId, task.backupId]
        )
        let knownTask = knownTasks[0]
        if (!knownTask && relayId) {
          yield* adoptScheduledBackupTask(transaction, relayId, task, now)
          changed = true
          const adoptedTasks = yield* transaction.queryRows<KnownBackupTaskRow>(
            `SELECT task.id, task.status, task.bytes_completed,
                      backup.status AS backup_status, backup.backup_mode,
                      backup.repository_id, backup.reason, task.task_kind,
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
        // A scheduled snapshot whose repository was gone when it was
        // cataloged stays failed: it can't be restored, whatever the Relay
        // says of it.
        if (
          knownTask.task_kind === "create" &&
          knownTask.reason === "scheduled" &&
          knownTask.backup_mode === "incremental" &&
          !knownTask.repository_id
        ) {
          return
        }
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
        changed = true
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_task")}
              SET status = ?, bytes_completed = ?, bytes_total = ?,
                  phase = ?, current_artifact_id = ?, current_path = ?, error = ?,
                  error_code = ?, started_at = ?, finished_at = ?,
                  relay_updated_at_ms = ?,
                  updated_at = ?
            WHERE id = ? AND backup_id = ?`,
          [
            task.status,
            task.bytesCompleted,
            task.bytesTotal,
            task.phase,
            task.currentArtifactId,
            task.currentPath,
            task.error,
            task.errorCode ?? null,
            task.startedAt,
            task.finishedAt,
            task.updatedAt,
            now,
            task.taskId,
            task.backupId,
          ]
        )
        if (task.kind === "delete") {
          // Once deleted, a backup stays deleted whatever an older or retried
          // delete task reports afterwards.
          if (knownTask.backup_status === "deleted") return
          const active = task.status === "queued" || task.status === "running"
          const outcomes =
            task.result && !("bytes" in task.result)
              ? (task.result.artifacts ?? [])
              : []
          if (active) {
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup")}
                  SET status = 'deleting', updated_at = ?
                WHERE id = ?`,
              [now, task.backupId]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup_artifact")}
                  SET status = 'available', updated_at = ?
                WHERE backup_id = ? AND status = 'deleting'`,
              [now, task.backupId]
            )
            if (task.currentArtifactId) {
              yield* transaction.execute(
                `UPDATE ${databaseTable("backup_artifact")}
                    SET status = 'deleting', error = NULL, error_code = NULL,
                        updated_at = ?
                  WHERE id = ? AND backup_id = ? AND status <> 'deleted'`,
                [now, task.currentArtifactId, task.backupId]
              )
            }
            for (const outcome of outcomes) {
              const artifactStatus =
                outcome.status === "deleted" ? "deleted" : "available"
              yield* transaction.execute(
                `UPDATE ${databaseTable("backup_artifact")}
                    SET status = ?, error = ?, error_code = ?,
                        deleted_at = CASE WHEN ? = 'deleted'
                          THEN ? ELSE NULL END,
                        updated_at = ?
                  WHERE id = ? AND backup_id = ?`,
                [
                  artifactStatus,
                  outcome.error,
                  outcome.errorCode ?? null,
                  artifactStatus,
                  task.updatedAt,
                  now,
                  outcome.artifactId,
                  task.backupId,
                ]
              )
            }
          } else if (task.status === "succeeded") {
            // A forgotten restic snapshot leaves nothing behind in any of
            // the backup's artifacts, whichever one the Relay reported.
            if (
              outcomes.length === 0 ||
              knownTask.backup_mode === "incremental"
            ) {
              yield* transaction.execute(
                `UPDATE ${databaseTable("backup_artifact")}
                    SET status = 'deleted', deleted_at = ?, updated_at = ?
                  WHERE backup_id = ?`,
                [task.finishedAt ?? now, now, task.backupId]
              )
            } else {
              for (const outcome of outcomes) {
                const artifactStatus =
                  outcome.status === "deleted" ? "deleted" : "available"
                yield* transaction.execute(
                  `UPDATE ${databaseTable("backup_artifact")}
                      SET status = ?, error = ?, error_code = ?,
                          deleted_at = CASE WHEN ? = 'deleted'
                            THEN ? ELSE NULL END,
                          updated_at = ?
                  WHERE id = ? AND backup_id = ?`,
                  [
                    artifactStatus,
                    outcome.error,
                    outcome.errorCode ?? null,
                    artifactStatus,
                    task.finishedAt ?? now,
                    now,
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
                        THEN ? ELSE NULL END,
                      updated_at = ?
                WHERE id = ?`,
              [
                remaining[0] ? "available" : "deleted",
                remaining[0] ? "available" : "deleted",
                task.finishedAt ?? now,
                now,
                task.backupId,
              ]
            )
          } else if (task.status === "failed" || task.status === "cancelled") {
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup")}
                  SET status = 'available', updated_at = ?
                WHERE id = ?`,
              [now, task.backupId]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup_artifact")}
                  SET status = 'available', error = ?, error_code = ?,
                      updated_at = ?
                WHERE backup_id = ? AND status = 'deleting'`,
              [task.error, task.errorCode ?? null, now, task.backupId]
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
                SET status = ?, started_at = COALESCE(started_at, ?),
                    updated_at = ?
              WHERE id = ?`,
            [task.status, task.startedAt, now, task.backupId]
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_artifact")}
                SET status = ?, updated_at = ?
              WHERE backup_id = ? AND status IN ('queued', 'running')`,
            [task.status, now, task.backupId]
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
          // A restic snapshot is one copy of the data, so every artifact of an
          // incremental backup shares its outcome.
          const outcomes =
            knownTask.backup_mode === "incremental"
              ? []
              : (task.result.artifacts ?? [])
          if (outcomes.length === 0) {
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup_artifact")}
                  SET status = 'available', filename = ?, bytes = ?,
                      checksum_sha256 = ?, error = NULL, error_code = NULL,
                      completed_at = ?,
                      updated_at = ?
                WHERE backup_id = ?`,
              [
                filename,
                task.result.bytes,
                checksum,
                task.finishedAt ?? now,
                now,
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
                        error = ?, error_code = ?, completed_at = ?,
                        updated_at = ?
                  WHERE id = ? AND backup_id = ?`,
                [
                  outcome.status,
                  filename,
                  outcome.status,
                  task.result.bytes,
                  outcome.status,
                  checksum,
                  outcome.error,
                  outcome.errorCode ?? null,
                  task.finishedAt ?? now,
                  now,
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
                    completed_at = ?, updated_at = ?
              WHERE id = ?`,
            [
              available[0] ? "available" : "failed",
              filename,
              task.result.bytes,
              checksum,
              snapshotId,
              JSON.stringify(task.result.warnings),
              task.finishedAt ?? now,
              now,
              task.backupId,
            ]
          )
          return
        }
        if (task.status === "failed" || task.status === "cancelled") {
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup")}
                SET status = 'failed', completed_at = ?, updated_at = ?
              WHERE id = ?`,
            [task.finishedAt ?? now, now, task.backupId]
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_artifact")}
                SET status = 'failed', error = ?, error_code = ?,
                    completed_at = ?, updated_at = ?
              WHERE backup_id = ? AND status IN ('queued', 'running')`,
            [
              task.error,
              task.errorCode ?? null,
              task.finishedAt ?? now,
              now,
              task.backupId,
            ]
          )
        }
      })
    )
    return changed
  }
)

const backupCatalogColumns = `backup.id, backup.relay_id, backup.target_kind, backup.target_id,
            backup.artifact_kind, backup.backup_mode, backup.reason,
            backup.status, backup.name, backup.filename, backup.bytes,
            backup.checksum_sha256, backup.restic_snapshot_id, backup.warnings,
            backup.created_by, backup.storage_id, backup.object_key,
            backup.linked_from_backup_id, backup.linked_from_target_id,
            backup.completed_at AS completed_at_ms,
            backup.created_at AS created_at_ms,
            task.id AS task_id, task.task_kind AS task_kind,
            task.status AS task_status, task.bytes_completed AS task_bytes_completed,
            task.bytes_total AS task_bytes_total, task.phase AS task_phase,
            task.current_artifact_id AS task_current_artifact_id,
            task.current_path AS task_current_path, task.error AS task_error,
            task.error_code AS task_error_code,
            task.started_at AS task_started_at_ms,
            task.updated_at AS task_updated_at_ms`

const latestBackupTaskJoin = `JOIN ${databaseTable("backup_task")} task ON task.id = (
         SELECT latest.id
           FROM ${databaseTable("backup_task")} latest
          WHERE latest.backup_id = backup.id
          ORDER BY latest.created_at DESC, latest.id DESC
          LIMIT 1
       )`

const backupActiveSql = `(backup.status IN ('queued', 'running', 'deleting')
  OR (backup.status = 'available' AND task.status IN ('queued', 'running'))
  OR EXISTS (
    SELECT 1 FROM ${databaseTable("backup_artifact")} active_artifact
     WHERE active_artifact.backup_id = backup.id
       AND active_artifact.status IN ('queued', 'running', 'deleting')
  ))`

const backupFailedSql = `(backup.status = 'failed' OR EXISTS (
  SELECT 1 FROM ${databaseTable("backup_artifact")} failed_artifact
   WHERE failed_artifact.backup_id = backup.id
     AND failed_artifact.status = 'failed'
))`

const backupDisplayBytesSql = `(CASE
  WHEN backup.bytes IS NOT NULL THEN backup.bytes
  WHEN task.bytes_total IS NOT NULL
    AND (task.phase = 'uploading'
      OR (task.phase = 'finalizing' AND task.current_artifact_id IS NOT NULL))
    AND EXISTS (
      SELECT 1 FROM ${databaseTable("backup_artifact")} remote_artifact
       WHERE remote_artifact.backup_id = backup.id
         AND remote_artifact.storage_id IS NOT NULL
         AND remote_artifact.status <> 'deleted'
    )
    AND (task.current_artifact_id IS NOT NULL OR (
      SELECT COUNT(*) FROM ${databaseTable("backup_artifact")} remote_count
       WHERE remote_count.backup_id = backup.id
         AND remote_count.storage_id IS NOT NULL
         AND remote_count.status <> 'deleted'
    ) <= 1)
  THEN task.bytes_total
  ELSE NULL
END)`

const backupTargetSortSql = `(CASE backup.target_kind
  WHEN 'platform' THEN COALESCE(relay.name, '')
  WHEN 'instance' THEN COALESCE(instance.source_name, '')
  WHEN 'database' THEN COALESCE(managed_database.name, '')
  ELSE ''
END)`

export const listBackupCatalogEffect = Effect.fn("backups.list")(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<BackupRow>(
    "backup_catalog_list",
    `SELECT ${backupCatalogColumns}
       FROM ${databaseTable("backup")} backup
       ${latestBackupTaskJoin}
      WHERE backup.status <> 'deleted'
      ORDER BY backup.created_at DESC, backup.id DESC`
  )
  const artifactRows = yield* database.queryRows<BackupArtifactRow>(
    "backup_artifact_catalog_list",
    `SELECT artifact.id, artifact.backup_id, artifact.storage_id,
            artifact.status, artifact.filename, artifact.object_key,
            artifact.bytes, artifact.checksum_sha256, artifact.error,
            artifact.error_code
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
      errorCode: artifact.error_code ?? null,
      filename: artifact.filename,
      id: artifact.id,
      objectKey: artifact.object_key,
      status: artifact.status,
      storageId: artifact.storage_id,
    })
    artifactsByBackup.set(artifact.backup_id, records)
  }
  return rows.map((row) =>
    backupCatalogRecordFromRow(row, artifactsByBackup.get(row.id) ?? [])
  ) satisfies Array<BackupCatalogRecord>
})

function backupCatalogRecordFromRow(
  row: BackupRow,
  artifacts: Array<BackupArtifactRecord>
): BackupCatalogRecord {
  return {
    artifacts,
    artifactKind: row.artifact_kind,
    backupMode: row.backup_mode,
    bytes: nullableDatabaseNumber(row.bytes, "backup bytes"),
    checksumSha256: row.checksum_sha256,
    completedAt: timestampIso(row.completed_at_ms, "backup completed at"),
    createdBy: row.created_by,
    createdAt: requiredTimestampIso(row.created_at_ms, "backup created at"),
    filename: row.filename,
    id: row.id,
    linkedFrom:
      row.linked_from_backup_id && row.linked_from_target_id
        ? {
            backupId: row.linked_from_backup_id,
            targetId: row.linked_from_target_id,
          }
        : null,
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
    taskErrorCode: row.task_error_code,
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
  }
}

export const getBackupCatalogRecordEffect = Effect.fn("backups.get")(function* (
  backupId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<BackupRow>(
    "backup_catalog_get",
    `SELECT ${backupCatalogColumns}
       FROM ${databaseTable("backup")} backup
       ${latestBackupTaskJoin}
      WHERE backup.id = ? AND backup.status <> 'deleted'
      LIMIT 1`,
    [backupId]
  )
  const row = rows[0]
  if (!row) return null
  const artifacts = yield* database.queryRows<BackupArtifactRow>(
    "backup_artifact_catalog_get",
    `SELECT id, backup_id, storage_id, status, filename, object_key,
            bytes, checksum_sha256, error, error_code
       FROM ${databaseTable("backup_artifact")}
      WHERE backup_id = ? AND status <> 'deleted'
      ORDER BY created_at ASC, id ASC`,
    [backupId]
  )
  return backupCatalogRecordFromRow(row, artifacts.map(backupArtifactFromRow))
})

// Backups that follow an App: its folder's, and those of volumes its Compose
// project owns, whose IDs are `<App ID>/<key>`.
const appBackupSql = `(backup.target_kind = 'app'
  OR (backup.target_kind = 'volume' AND backup.target_id LIKE '%/%'))`

export const listBackupCatalogPageEffect = Effect.fn("backups.page")(function* (
  input: BackupCatalogPageInput
) {
  const database = yield* Database
  const clauses = ["backup.status <> 'deleted'"]
  const values: Array<boolean | null | number | string> = []

  if (!input.isAdmin) {
    if (input.allowedScopes.length === 0 && input.appScopes.length === 0) {
      return { hasMore: false, items: [] as Array<BackupCatalogPageRecord> }
    }
    const relayScopes = new Set(
      input.allowedScopes.flatMap((scope) =>
        scope.resourceType === "relay" ? [scope.relayId] : []
      )
    )
    const scopeClauses: string[] = []
    const seen = new Set<string>()
    for (const scope of input.allowedScopes) {
      if (scope.resourceType !== "relay" && relayScopes.has(scope.relayId))
        continue
      const key = JSON.stringify([
        scope.relayId,
        scope.resourceType,
        scope.resourceId,
      ])
      if (seen.has(key)) continue
      seen.add(key)
      if (scope.resourceType === "relay") {
        // An App's backups follow the App, not the Relay's backup grants.
        scopeClauses.push(`(backup.relay_id = ? AND NOT ${appBackupSql})`)
        values.push(scope.relayId)
      } else {
        scopeClauses.push(
          "(backup.relay_id = ? AND backup.target_kind = ? AND backup.target_id = ?)"
        )
        values.push(scope.relayId, scope.resourceType, scope.resourceId)
      }
    }
    const appRelays = new Set(
      input.appScopes.flatMap((scope) =>
        scope.appId === null ? [scope.relayId] : []
      )
    )
    for (const scope of input.appScopes) {
      if (scope.appId === null) {
        scopeClauses.push(`(backup.relay_id = ? AND ${appBackupSql})`)
        values.push(scope.relayId)
      } else if (!appRelays.has(scope.relayId)) {
        scopeClauses.push(`(backup.relay_id = ? AND (
            (backup.target_kind = 'app' AND backup.target_id = ?)
            OR (backup.target_kind = 'volume' AND backup.target_id LIKE ?)))`)
        values.push(scope.relayId, scope.appId, `${scope.appId}/%`)
      }
    }
    clauses.push(
      `backup.target_kind <> 'platform' AND (${scopeClauses.join(" OR ")})`
    )
  }

  if (input.backupId) {
    clauses.push("backup.id = ?")
    values.push(input.backupId)
  }
  if (input.scope) {
    clauses.push("backup.target_kind = ?")
    values.push(input.scope.kind)
    if ("relayId" in input.scope) {
      clauses.push("backup.relay_id = ?")
      values.push(input.scope.relayId)
      if (input.scope.kind !== "platform") {
        clauses.push("backup.target_id = ?")
        values.push(input.scope.targetId)
      }
    }
  }
  if (input.search) {
    const pattern = `%${escapeBackupSearch(input.search)}%`
    clauses.push(`(
        LOWER(backup.name) LIKE ? ESCAPE '\\\\'
        OR LOWER(CAST(backup.id AS CHAR)) LIKE ? ESCAPE '\\\\'
        OR LOWER(CAST(backup.target_id AS CHAR)) LIKE ? ESCAPE '\\\\'
        OR LOWER(CAST(backup.relay_id AS CHAR)) LIKE ? ESCAPE '\\\\'
        OR LOWER(COALESCE(relay.name, '')) LIKE ? ESCAPE '\\\\'
        OR LOWER(COALESCE(instance.source_name, '')) LIKE ? ESCAPE '\\\\'
        OR LOWER(COALESCE(managed_database.name, '')) LIKE ? ESCAPE '\\\\'
      )`)
    values.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern)
  }
  if (input.status === "active") clauses.push(backupActiveSql)
  if (input.status === "failed") {
    clauses.push(`NOT ${backupActiveSql}`, backupFailedSql)
  }
  if (input.status === "available") {
    clauses.push(
      `NOT ${backupActiveSql}`,
      `NOT ${backupFailedSql}`,
      "backup.status = 'available'"
    )
  }

  const order = backupCatalogOrder(input.sort)
  if (input.cursor) {
    clauses.push(
      backupCatalogCursorClause(order.sql, input.direction, input.cursor.value)
    )
    if (input.cursor.value === null) {
      values.push(input.cursor.id)
    } else if (input.sort === "size") {
      values.push(input.cursor.value, input.cursor.value, input.cursor.id)
    } else {
      values.push(input.cursor.value, input.cursor.value, input.cursor.id)
    }
  }

  const direction = input.direction === "asc" ? "ASC" : "DESC"
  const nullOrder = input.sort === "size" ? `${order.sql} IS NULL ASC, ` : ""
  values.push(input.limit + 1)
  const rows = yield* database.queryRows<BackupCatalogPageRow>(
    "backup_catalog_page",
    `SELECT ${backupCatalogColumns},
              relay.id IS NOT NULL AS relay_present,
              ${order.selectSql} AS order_value
         FROM ${databaseTable("backup")} backup
         ${latestBackupTaskJoin}
         LEFT JOIN ${databaseTable("relay")} relay
           ON relay.id = backup.relay_id
         LEFT JOIN ${databaseTable("instance")} instance
           ON backup.target_kind = 'instance'
          AND instance.relay_id = backup.relay_id
          AND instance.instance_id = backup.target_id
         LEFT JOIN ${databaseTable("database")} managed_database
           ON backup.target_kind = 'database'
          AND managed_database.relay_id = backup.relay_id
          AND managed_database.database_id = backup.target_id
        WHERE ${clauses.map((clause) => `(${clause})`).join(" AND ")}
        ORDER BY ${nullOrder}${order.sql} ${direction}, backup.id ${direction}
        LIMIT ?`,
    values
  )
  const pageRows = rows.slice(0, input.limit)
  const backupIds = pageRows.map((row) => row.id)
  const artifactsByBackup = new Map<string, Array<BackupArtifactRecord>>()
  if (backupIds.length > 0) {
    const placeholders = backupIds.map(() => "?").join(", ")
    const artifactRows = yield* database.queryRows<BackupArtifactRow>(
      "backup_artifact_catalog_page",
      `SELECT id, backup_id, storage_id, status, filename, object_key,
                bytes, checksum_sha256, error, error_code
           FROM ${databaseTable("backup_artifact")}
          WHERE backup_id IN (${placeholders}) AND status <> 'deleted'
          ORDER BY created_at ASC, id ASC`,
      backupIds
    )
    for (const artifactRow of artifactRows) {
      const artifacts = artifactsByBackup.get(artifactRow.backup_id) ?? []
      artifacts.push(backupArtifactFromRow(artifactRow))
      artifactsByBackup.set(artifactRow.backup_id, artifacts)
    }
  }
  return {
    hasMore: rows.length > input.limit,
    items: pageRows.map((row) => ({
      orderValue: backupOrderValue(row.order_value, input.sort),
      record: backupCatalogRecordFromRow(
        row,
        artifactsByBackup.get(row.id) ?? []
      ),
      relayPresent: Boolean(row.relay_present),
    })),
  }
})

function backupArtifactFromRow(row: BackupArtifactRow): BackupArtifactRecord {
  return {
    bytes: nullableDatabaseNumber(row.bytes, "backup artifact bytes"),
    checksumSha256: row.checksum_sha256,
    error: row.error,
    errorCode: row.error_code ?? null,
    filename: row.filename,
    id: row.id,
    objectKey: row.object_key,
    status: row.status,
    storageId: row.storage_id,
  }
}

function escapeBackupSearch(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

function backupCatalogOrder(sort: BackupCatalogPageInput["sort"]): {
  selectSql: string
  sql: string
} {
  if (sort === "name") {
    const sql = "LOWER(backup.name) COLLATE utf8mb4_bin"
    return { selectSql: sql, sql }
  }
  if (sort === "target") {
    const sql = `LOWER(${backupTargetSortSql}) COLLATE utf8mb4_bin`
    return { selectSql: sql, sql }
  }
  if (sort === "size") {
    return { selectSql: backupDisplayBytesSql, sql: backupDisplayBytesSql }
  }
  // backup.created_at stores epoch milliseconds, so the raw column is both the
  // cursor value and the seek predicate, keeping the (created_at, id) index.
  return { selectSql: "backup.created_at", sql: "backup.created_at" }
}

function backupCatalogCursorClause(
  orderSql: string,
  direction: BackupCatalogPageInput["direction"],
  cursorValue: number | string | null
): string {
  const operator = direction === "asc" ? ">" : "<"
  if (cursorValue === null) {
    return `${orderSql} IS NULL AND backup.id ${operator} ?`
  }
  return `(${orderSql} ${operator} ?
    OR (${orderSql} = ? AND backup.id ${operator} ?)
    ${orderSql === backupDisplayBytesSql ? `OR ${orderSql} IS NULL` : ""})`
}

function backupOrderValue(
  value: number | string | null,
  sort: BackupCatalogPageInput["sort"]
): number | string | null {
  if (value === null || sort === "name" || sort === "target") return value
  return safeDatabaseNumber(value, "backup order value")
}

export const listDispatchableBackupTasksEffect = Effect.fn(
  "backups.dispatchable"
)(function* (relayId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "backup_dependency_failures",
    `UPDATE ${databaseTable("backup_task")} dependent
       JOIN ${databaseTable("backup_task")} dependency
         ON dependency.id = dependent.depends_on_task_id
        SET dependent.status = 'failed',
            dependent.error = 'The pre-restore safety backup did not complete',
            dependent.finished_at = ?,
            dependent.updated_at = ?
      WHERE dependent.status = 'queued'
        AND dependent.task_kind = 'restore'
        AND dependency.status IN ('failed', 'cancelled')`,
    [now, now]
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
            task.created_at AS task_created_at_ms,
            backup.storage_id, backup.object_key,
            backup.linked_from_backup_id, backup.linked_from_target_id,
            backup.consistency,
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
              OR (backup.target_kind = 'platform' AND backup.artifact_kind = 'platform_bundle')
              OR (backup.target_kind IN ('app', 'volume') AND backup.artifact_kind = 'tar_archive')))
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
            artifact.bytes, artifact.checksum_sha256, artifact.error,
            artifact.error_code
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
    const archive = linkedArchive(row)
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
        ...archive,
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
        ...archive,
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
      ...(row.consistency ? { consistency: row.consistency } : {}),
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

// The archive identity a linked backup's tasks name, so the Relay finds and
// checks the archive it shares with the backup it was made as.
function linkedArchive(row: {
  linked_from_backup_id: string | null
  linked_from_target_id: string | null
}) {
  return row.linked_from_backup_id && row.linked_from_target_id
    ? {
        archive: {
          backupId: row.linked_from_backup_id,
          targetId: row.linked_from_target_id,
        },
      }
    : {}
}

export const reserveBackupRestoreEffect = Effect.fn("backups.reserveRestore")(
  function* (input: {
    backupId: string
    dependsOnTaskId: string | null
    requestedBy: string
    taskId: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction(
      "backup_reserve_restore",
      (transaction) =>
        Effect.gen(function* () {
          const rows = yield* transaction.queryRows<BackupRow>(
            `SELECT backup.id, backup.relay_id, backup.target_kind,
                    backup.target_id, backup.storage_id, backup.object_key,
                    backup.bytes, backup.checksum_sha256, backup.backup_mode,
                    backup.artifact_kind, backup.restic_snapshot_id,
                    backup.repository_id, backup.linked_from_backup_id,
                    backup.linked_from_target_id
               FROM ${databaseTable("backup")} backup
              WHERE backup.id = ? AND backup.status = 'available'
                AND (
                  (backup.backup_mode = 'full'
                    AND ((backup.target_kind = 'instance' AND backup.artifact_kind = 'archive')
                      OR (backup.target_kind = 'database' AND backup.artifact_kind = 'database_dump')
                      OR (backup.target_kind IN ('app', 'volume') AND backup.artifact_kind = 'tar_archive')))
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
                        artifact.bytes, artifact.checksum_sha256, artifact.error,
            artifact.error_code
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
          if (conflictingTasks[0]) {
            return yield* BackupStorageError.make({
              code: "restore_in_progress",
              operation: "backup.restore",
              reason: "Another restore is already in progress",
            })
          }
          yield* refuseIfFinalDeletionInProgress(transaction, {
            operation: "backup.restore",
            relayId: backup.relay_id,
            targetId: backup.target_id,
            targetKind: backup.target_kind,
          })
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
              (id, backup_id, task_kind, status, depends_on_task_id, requested_by,
               created_at, updated_at)
             VALUES (?, ?, 'restore', 'queued', ?, ?, ?, ?)`,
            [
              input.taskId,
              input.backupId,
              input.dependsOnTaskId,
              input.requestedBy,
              now,
              now,
            ]
          )
          return {
            ...linkedArchive(backup),
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
  function* (input: {
    backupId: string
    // Null when Hearth deletes it itself, as retention does.
    requestedBy: string | null
    taskId: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction("backup_reserve_delete", (transaction) =>
      Effect.gen(function* () {
        // Deletes of backups sharing an archive queue on the backup it was
        // made as, so each sees whether the others still hold it. Every read
        // before the sharing check below locks, so that check reads after
        // this wait rather than from an earlier snapshot.
        const [linked] = yield* transaction.queryRows<
          RowDataPacket & { linked_from_backup_id: string | null }
        >(
          `SELECT linked_from_backup_id
             FROM ${databaseTable("backup")}
            WHERE id = ?
            FOR UPDATE`,
          [input.backupId]
        )
        if (linked?.linked_from_backup_id) {
          const [original] = yield* transaction.queryRows<RowDataPacket>(
            `SELECT id FROM ${databaseTable("backup")} WHERE id = ? FOR UPDATE`,
            [linked.linked_from_backup_id]
          )
          // Forgotten, as with its Relay: the first record still linked to
          // the archive stands in for it.
          if (!original) {
            yield* transaction.queryRows<RowDataPacket>(
              `SELECT id FROM ${databaseTable("backup")}
                WHERE linked_from_backup_id = ?
                ORDER BY id
                LIMIT 1
                FOR UPDATE`,
              [linked.linked_from_backup_id]
            )
          }
        }
        const rows = yield* transaction.queryRows<BackupRow>(
          `SELECT backup.id, backup.relay_id, backup.target_kind,
                  backup.target_id, backup.storage_id, backup.object_key,
                  backup.restic_snapshot_id, backup.backup_mode,
                  backup.linked_from_backup_id, backup.linked_from_target_id
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
        // A linked backup shares its archive with the backup it was made as,
        // and each stored copy of it, a Relay's own file or an S3 object,
        // goes with the last backup that still lists it. Ones another keeps
        // are only marked deleted here.
        const shared = yield* transaction.queryRows<
          RowDataPacket & { id: string }
        >(
          `SELECT artifact.id
             FROM ${databaseTable("backup_artifact")} artifact
            WHERE artifact.backup_id = ? AND artifact.status <> 'deleted'
              AND EXISTS (
                SELECT 1
                  FROM ${databaseTable("backup")} other
                  JOIN ${databaseTable("backup_artifact")} other_artifact
                    ON other_artifact.backup_id = other.id
                 WHERE other.id <> ?
                   AND COALESCE(other.linked_from_backup_id, other.id) = ?
                   AND other.status IN ('available', 'deleting')
                   AND other_artifact.status <> 'deleted'
                   AND ((artifact.storage_id IS NULL
                         AND other_artifact.storage_id IS NULL
                         AND other.relay_id = ?)
                     OR (other_artifact.storage_id = artifact.storage_id
                         AND other_artifact.object_key <=> artifact.object_key))
              )`,
          [
            input.backupId,
            input.backupId,
            backup.linked_from_backup_id ?? input.backupId,
            backup.relay_id,
          ]
        )
        if (shared.length > 0) {
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_artifact")}
                SET status = 'deleted', deleted_at = ?, updated_at = ?
              WHERE id IN (${shared.map(() => "?").join(", ")})`,
            [now, now, ...shared.map((artifact) => artifact.id)]
          )
          const [kept] = yield* transaction.queryRows<RowDataPacket>(
            `SELECT 1 FROM ${databaseTable("backup_artifact")}
              WHERE backup_id = ? AND status <> 'deleted'
              LIMIT 1`,
            [input.backupId]
          )
          if (!kept) {
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup")}
                  SET status = 'deleted', deleted_at = ?, updated_at = ?
                WHERE id = ?`,
              [now, now, input.backupId]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("backup_task")}
                (id, backup_id, task_kind, status, requested_by, started_at,
                 finished_at, created_at, updated_at)
               VALUES (?, ?, 'delete', 'succeeded', ?, ?, ?, ?, ?)`,
              [
                input.taskId,
                input.backupId,
                input.requestedBy,
                now,
                now,
                now,
                now,
              ]
            )
            return null
          }
        }
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")}
              SET status = 'deleting', updated_at = ?
            WHERE id = ?`,
          [now, input.backupId]
        )
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_task")}
            (id, backup_id, task_kind, status, requested_by, created_at,
             updated_at)
           VALUES (?, ?, 'delete', 'queued', ?, ?, ?)`,
          [input.taskId, input.backupId, input.requestedBy, now, now]
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
                      artifact.bytes, artifact.checksum_sha256, artifact.error,
            artifact.error_code
                 FROM ${databaseTable("backup_artifact")} artifact
                WHERE artifact.backup_id = ? AND artifact.status <> 'deleted'
                ORDER BY (artifact.storage_id IS NULL) DESC, artifact.created_at ASC`,
            [input.backupId]
          )).map(dispatchArtifact),
          ...linkedArchive(backup),
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
        `DELETE FROM ${databaseTable("resource_deletion")}
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
          `DELETE FROM ${databaseTable("resource_deletion")}
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
    const now = yield* Clock.currentTimeMillis
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
            created_at: number
            finished_at: number | null
            id: string
            reserved_bytes: number | string | null
            status: BackupRow["task_status"]
          } & RowDataPacket
        >(
          `SELECT task.id, task.status, task.reserved_bytes, task.created_at,
                  task.finished_at
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
          const expiresAt =
            (latest.finished_at ?? latest.created_at) + storedTtl
          if (
            canReuseBackupExport({
              remainingMs: expiresAt - now,
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
            (id, backup_id, task_kind, status, reserved_bytes, requested_by,
             created_at, updated_at)
           VALUES (?, ?, 'export', 'queued', ?, ?, ?, ?)`,
          // reserved_bytes holds the export TTL in milliseconds, not a byte count.
          [input.taskId, input.backupId, ttlMs, input.requestedBy, now, now]
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
  const now = yield* Clock.currentTimeMillis
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
          now,
          relayId: input.relayId,
          storageId: input.storageId,
          targetId: input.targetId,
          targetKind: "instance",
        })
        return {
          id: repository.id,
          objectPrefix: repository.objectPrefix,
          password: repository.password,
          storageId: repository.storageId,
        }
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
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction(
    "backup_purge_instance_repositories",
    (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")}
              SET status = 'deleted', completed_at = COALESCE(completed_at, ?),
                  updated_at = ?
            WHERE relay_id = ? AND target_kind = 'instance' AND target_id = ?
              AND backup_mode = 'incremental' AND status <> 'deleted'`,
          [now, now, relayId, targetId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_artifact")} artifact
             JOIN ${databaseTable("backup")} backup ON backup.id = artifact.backup_id
              SET artifact.status = 'deleted',
                  artifact.deleted_at = COALESCE(artifact.deleted_at, ?),
                  artifact.updated_at = ?
            WHERE backup.relay_id = ? AND backup.target_kind = 'instance'
              AND backup.target_id = ? AND backup.backup_mode = 'incremental'
              AND artifact.status <> 'deleted'`,
          [now, now, relayId, targetId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")}
            SET repository_id = NULL, updated_at = ?
          WHERE relay_id = ? AND target_kind = 'instance' AND target_id = ?
            AND status = 'deleted'`,
          [now, relayId, targetId]
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
    const now = yield* Clock.currentTimeMillis
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
                    artifact.bytes, artifact.checksum_sha256, artifact.error,
            artifact.error_code
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
                    error = NULL, error_code = NULL, completed_at = NULL,
                    deleted_at = NULL,
                    updated_at = ?
              WHERE id = ?`,
            [objectKey, input.filename, now, artifactId]
          )
        } else {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_artifact")}
              (id, backup_id, destination_key, storage_id, status, filename,
               object_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
            [
              artifactId,
              input.backupId,
              input.storageId,
              input.storageId,
              input.filename,
              objectKey,
              now,
              now,
            ]
          )
        }
        const taskId = randomUUID()
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_copy_task")}
            (id, backup_id, source_artifact_id, destination_artifact_id,
             status, requested_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             id = VALUES(id), source_artifact_id = VALUES(source_artifact_id),
             status = 'queued', requested_by = VALUES(requested_by),
             error = NULL, started_at = NULL, finished_at = NULL,
             updated_at = VALUES(updated_at)`,
          [
            taskId,
            input.backupId,
            input.sourceArtifactId,
            artifactId,
            input.requestedBy,
            now,
            now,
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
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<{ id: string } & RowDataPacket>(
    "backup_copy_runnable_list",
    `SELECT id
       FROM ${databaseTable("backup_copy_task")}
      WHERE status = 'queued'
         OR (status = 'running' AND updated_at < ?)
      ORDER BY created_at ASC, id ASC`,
    [now - BACKUP_COPY_STALE_MS]
  )
  return rows.map((row) => row.id)
})

export const claimBackupCopyTaskEffect = Effect.fn("backups.claimCopy")(
  function* (taskId: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction("backup_copy_claim", (transaction) =>
      Effect.gen(function* () {
        const task = (yield* transaction.queryRows<BackupCopyTaskRow>(
          `SELECT task.id AS task_id, task.backup_id, task.requested_by,
                    COALESCE(backup.linked_from_backup_id, backup.id)
                      AS archive_id,
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
                    AND task.updated_at < ?))
                AND source.status = 'available'
                AND destination.storage_id IS NOT NULL
                AND destination.object_key IS NOT NULL
              LIMIT 1
              FOR UPDATE`,
          [taskId, now - BACKUP_COPY_STALE_MS]
        ))[0]
        if (!task) return null
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_copy_task")}
              SET status = 'running', error = NULL, started_at = ?,
                  finished_at = NULL, updated_at = ?
            WHERE id = ?`,
          [now, now, task.task_id]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_artifact")}
              SET status = 'running', error = NULL, error_code = NULL,
                  updated_at = ?
            WHERE id = ?`,
          [now, task.destination_artifact_id]
        )
        return {
          archiveId: task.archive_id,
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
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction("backup_copy_complete", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_artifact")}
              SET status = ?, filename = ?, bytes = ?, checksum_sha256 = ?,
                  error = ?, error_code = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND backup_id = ?`,
          [
            input.ok ? "available" : "failed",
            input.filename,
            input.ok ? input.bytes : null,
            input.ok ? input.checksumSha256 : null,
            input.error,
            input.error ? backupFailureCodeFromMessage(input.error) : null,
            now,
            now,
            input.artifactId,
            input.backupId,
          ]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_copy_task")}
              SET status = ?, error = ?, finished_at = ?, updated_at = ?
            WHERE id = ?`,
          [
            input.ok ? "succeeded" : "failed",
            input.error,
            now,
            now,
            input.taskId,
          ]
        )
      })
    )
  }
)

export const renameBackupEffect = Effect.fn("backups.rename")(
  function* (input: { backupId: string; name: string }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "backup_rename",
      `UPDATE ${databaseTable("backup")}
        SET name = ?, updated_at = ?
      WHERE id = ? AND status <> 'deleted'`,
      [input.name, now, input.backupId]
    )
    return result.affectedRows > 0
  }
)

export const updateBackupLimitsEffect = Effect.fn("backups.updateLimits")(
  function* (input: {
    admin: boolean
    quantityLimit: number | null
    relayId: string
    retentionDays: number | null
    sizeLimitBytes: number | null
    targetId: string
    targetKind: BackupTargetKind
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const prefix = input.admin ? "admin_" : ""
    const quantityColumn = `${prefix}quantity_limit`
    const sizeColumn = `${prefix}size_limit_bytes`
    const daysColumn = `${prefix}retention_days`
    yield* database.transaction("backup_limits_update", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_policy")}
        (relay_id, target_kind, target_id, exclude_patterns,
         ${quantityColumn}, ${sizeColumn}, ${daysColumn}, created_at,
         updated_at)
       VALUES (?, ?, ?, JSON_ARRAY(), ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         ${quantityColumn} = VALUES(${quantityColumn}),
         ${sizeColumn} = VALUES(${sizeColumn}),
         ${daysColumn} = VALUES(${daysColumn}),
         updated_at = VALUES(updated_at)`,
          [
            input.relayId,
            input.targetKind,
            input.targetId,
            input.quantityLimit,
            input.sizeLimitBytes,
            input.retentionDays,
            now,
            now,
          ]
        )
        // Turning backups off, or on, or capping their size decides what
        // the target's scheduled backups may do.
        yield* invalidateScheduleDeploymentsEffect(transaction, {
          relayId: input.relayId,
          target: { id: input.targetId, kind: input.targetKind },
        })
      })
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
            admin_quantity_limit, admin_size_limit_bytes,
            retention_days, admin_retention_days
       FROM ${databaseTable("backup_policy")}
      WHERE relay_id = ? AND target_kind = ? AND target_id = ?
      LIMIT 1`,
    [relayId, targetKind, targetId]
  )
  const policy = rows[0]
  return {
    adminQuantityLimit: policy?.admin_quantity_limit ?? null,
    adminRetentionDays: policy?.admin_retention_days ?? null,
    adminSizeLimitBytes: nullableDatabaseNumber(
      policy?.admin_size_limit_bytes ?? null,
      "admin backup size limit"
    ),
    exclude: parseExcludes(policy?.exclude_patterns ?? []),
    quantityLimit: policy?.quantity_limit ?? null,
    retentionDays: policy?.retention_days ?? null,
    sizeLimitBytes: nullableDatabaseNumber(
      policy?.size_limit_bytes ?? null,
      "backup size limit"
    ),
    storageId: policy?.storage_id ?? null,
  } satisfies BackupPolicy
})

// How many backups a target keeps against its quantity limit, counted and
// limited as a new backup's reservation is.
export const getBackupUsageEffect = Effect.fn("backups.getUsage")(function* (
  relayId: string,
  targetKind: BackupTargetKind,
  targetId: string
) {
  const database = yield* Database
  const [usageRows, policyRows] = yield* Effect.all([
    database.queryRows<BackupUsageRow>(
      "backup_usage_get",
      `SELECT COUNT(*) AS quantity_used,
              SUM(backup.status = 'available') AS quantity_available
         FROM ${databaseTable("backup")} backup
        WHERE backup.relay_id = ?
          AND backup.target_kind = ?
          AND backup.target_id = ?
          AND backup.status IN ${COUNTED_BACKUP_STATUSES}`,
      [relayId, targetKind, targetId]
    ),
    database.queryRows<BackupPolicyRow>(
      "backup_usage_policy_get",
      `SELECT exclude_patterns, quantity_limit, size_limit_bytes, storage_id,
              admin_quantity_limit, admin_size_limit_bytes,
            retention_days, admin_retention_days
         FROM ${databaseTable("backup_policy")}
        WHERE relay_id = ? AND target_kind = ? AND target_id = ?
        LIMIT 1`,
      [relayId, targetKind, targetId]
    ),
  ])
  const policy = policyRows[0]
  return {
    // Finished backups that can be restored.
    quantityAvailable: safeDatabaseNumber(
      usageRows[0]?.quantity_available ?? 0,
      "available backup quantity"
    ),
    quantityLimit: effectiveBackupLimit(
      policy?.quantity_limit ?? null,
      policy?.admin_quantity_limit ?? null
    ),
    quantityUsed: safeDatabaseNumber(
      usageRows[0]?.quantity_used ?? 0,
      "backup quantity"
    ),
  }
})

export const updateBackupExcludesEffect = Effect.fn("backups.updateExcludes")(
  function* (input: {
    exclude: ReadonlyArray<string>
    relayId: string
    targetId: string
    targetKind: BackupTargetKind
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "backup_excludes_update",
      `INSERT INTO ${databaseTable("backup_policy")}
        (relay_id, target_kind, target_id, exclude_patterns, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE exclude_patterns = VALUES(exclude_patterns),
         updated_at = VALUES(updated_at)`,
      [
        input.relayId,
        input.targetKind,
        input.targetId,
        JSON.stringify(input.exclude),
        now,
        now,
      ]
    )
  }
)

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
  requestedMaxBytes: number | null
  sizeLimit: number | null
}): { maxBytes: number | null } {
  if (input.quantityLimit === 0 || input.sizeLimit === 0) {
    throw BackupLimitError.make({
      kind: input.quantityLimit === 0 ? "quantity" : "size",
      limit: 0,
      used: 0,
    })
  }
  return {
    maxBytes:
      input.requestedMaxBytes === null
        ? input.sizeLimit
        : input.sizeLimit === null
          ? input.requestedMaxBytes
          : Math.min(input.requestedMaxBytes, input.sizeLimit),
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
    now: number
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
         object_prefix, password_ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.relayId,
      input.targetKind,
      input.targetId,
      input.storageId,
      storageKey,
      objectPrefix,
      ciphertext,
      input.now,
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
    targetKind: BackupTargetKind
  }
) {
  if (input.targetKind === "platform") return
  // An App's own volume is deleted with its App.
  const owner =
    input.targetKind === "volume"
      ? backupTargetApp({ id: input.targetId, kind: input.targetKind })
      : null
  const rows = yield* transaction.queryRows<RowDataPacket>(
    `SELECT id
       FROM ${databaseTable("resource_deletion")}
      WHERE relay_id = ?
        AND ((resource_kind = ? AND resource_id = ?)
          OR (resource_kind = 'app' AND resource_id = ?))
        AND (status IN ('pending', 'backing_up', 'deleting', 'cancelling')
          -- Its Relay began deleting it: what's left of it only goes.
          OR (relay_deleting_at IS NOT NULL AND status <> 'completed'))
      LIMIT 1
      FOR UPDATE`,
    [input.relayId, input.targetKind, input.targetId, owner ?? ""]
  )
  if (rows[0]) {
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

interface LinkableBackupRow extends RowDataPacket {
  archive_id: string
  archive_target_id: string
  id: string
}

/**
 * Links a game server's full-archive backups to its copy, so they restore
 * there: each gets a record of the copy's own that shares the original's
 * stored archive. Archives in S3 link to a copy on any Relay; ones kept on
 * the old server's Relay only to a copy on that Relay, since they aren't
 * the copy's Relay's to keep. Incremental backups don't link: their
 * repository is the old server's. Returns how many backups were linked.
 */
export const linkInstanceBackupsEffect = Effect.fn("backups.link")(
  function* (input: {
    readonly from: { readonly instanceId: string; readonly relayId: string }
    readonly linkedBy: string
    readonly to: { readonly instanceId: string; readonly relayId: string }
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const sameRelay = input.from.relayId === input.to.relayId
    return yield* database.transaction("backup_link", (transaction) =>
      Effect.gen(function* () {
        // Skipping an archive the copy already links, so linking again, as
        // a migration resumed mid-step does, adds nothing.
        const backups = yield* transaction.queryRows<LinkableBackupRow>(
          `SELECT source.id,
                COALESCE(source.linked_from_backup_id, source.id) AS archive_id,
                COALESCE(source.linked_from_target_id, source.target_id)
                  AS archive_target_id
           FROM ${databaseTable("backup")} source
          WHERE source.relay_id = ? AND source.target_kind = 'instance'
            AND source.target_id = ?
            AND source.backup_mode = 'full' AND source.artifact_kind = 'archive'
            AND source.status = 'available'
            AND NOT EXISTS (
              SELECT 1 FROM ${databaseTable("backup")} linked
               WHERE linked.relay_id = ? AND linked.target_kind = 'instance'
                 AND linked.target_id = ?
                 AND linked.linked_from_backup_id
                   = COALESCE(source.linked_from_backup_id, source.id)
            )
          FOR UPDATE`,
          [
            input.from.relayId,
            input.from.instanceId,
            input.to.relayId,
            input.to.instanceId,
          ]
        )
        let linked = 0
        for (const backup of backups) {
          const artifacts = (yield* transaction.queryRows<BackupArtifactRow>(
            `SELECT artifact.id, artifact.backup_id, artifact.storage_id,
                  artifact.status, artifact.filename, artifact.object_key,
                  artifact.bytes, artifact.checksum_sha256, artifact.error,
                  artifact.error_code
             FROM ${databaseTable("backup_artifact")} artifact
            WHERE artifact.backup_id = ? AND artifact.status = 'available'
            ORDER BY (artifact.storage_id IS NULL) DESC, artifact.created_at ASC`,
            [backup.id]
          )).filter((artifact) => sameRelay || artifact.storage_id !== null)
          const primary = artifacts[0]
          if (!primary) continue
          const id = randomUUID()
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup")}
             (id, relay_id, target_kind, target_id, storage_id, artifact_kind,
              backup_mode, reason, status, name, filename, object_key, bytes,
              checksum_sha256, warnings, created_by, started_at, completed_at,
              created_at, updated_at, linked_from_backup_id,
              linked_from_target_id)
           SELECT ?, ?, 'instance', ?, ?, artifact_kind, backup_mode, reason,
                  'available', name, ?, ?, bytes, checksum_sha256, warnings,
                  created_by, started_at, completed_at, created_at, ?, ?, ?
             FROM ${databaseTable("backup")} WHERE id = ?`,
            [
              id,
              input.to.relayId,
              input.to.instanceId,
              primary.storage_id,
              primary.filename,
              primary.object_key,
              now,
              backup.archive_id,
              backup.archive_target_id,
              backup.id,
            ]
          )
          for (const artifact of artifacts) {
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("backup_artifact")}
               (id, backup_id, destination_key, storage_id, status, filename,
                object_key, bytes, checksum_sha256, completed_at, created_at,
                updated_at)
             SELECT ?, ?, destination_key, storage_id, 'available', filename,
                    object_key, bytes, checksum_sha256, completed_at,
                    created_at, ?
               FROM ${databaseTable("backup_artifact")} WHERE id = ?`,
              [randomUUID(), id, now, artifact.id]
            )
          }
          // The record lists by its latest task, so it gets the create task
          // the original finished with.
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("backup_task")}
             (id, backup_id, task_kind, status, bytes_completed, bytes_total,
              requested_by, started_at, finished_at, created_at, updated_at)
           VALUES (?, ?, 'create', 'succeeded', 0, NULL, ?, ?, ?, ?, ?)`,
            [randomUUID(), id, input.linkedBy, now, now, now, now]
          )
          linked += 1
        }
        return linked
      })
    )
  }
)

/**
 * How many of a game server's backups would link to a copy on another
 * Relay, or on its own, and how many wouldn't.
 */
export const countLinkableInstanceBackupsEffect = Effect.fn(
  "backups.countLinkable"
)(function* (relayId: string, instanceId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & {
      anywhere: number | string
      here: number | string
      total: number | string
    }
  >(
    "backup_count_linkable",
    `SELECT COUNT(*) AS total,
            SUM(backup.backup_mode = 'full'
                AND backup.artifact_kind = 'archive') AS here,
            SUM(backup.backup_mode = 'full'
                AND backup.artifact_kind = 'archive'
                AND EXISTS (
                  SELECT 1 FROM ${databaseTable("backup_artifact")} artifact
                   WHERE artifact.backup_id = backup.id
                     AND artifact.status = 'available'
                     AND artifact.storage_id IS NOT NULL
                )) AS anywhere
       FROM ${databaseTable("backup")} backup
      WHERE backup.relay_id = ? AND backup.target_kind = 'instance'
        AND backup.target_id = ? AND backup.status = 'available'`,
    [relayId, instanceId]
  )
  const row = rows[0]
  return {
    anywhere: Number(row?.anywhere ?? 0),
    here: Number(row?.here ?? 0),
    total: Number(row?.total ?? 0),
  }
})
