import { randomUUID } from "node:crypto"

import { Clock, Data, Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { invalidateScheduleDeploymentsEffect } from "@/effect/schedule-invalidation"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"

// The rows behind `resource.delete` and `resource.delete.cancel`
// (lib/resource-deletion.server.ts): one per resource. Each change of plan,
// a new attempt at deleting it or keeping it after a failure, starts a new
// attempt number, which names the operation that carries it out. Every write
// an operation makes names its attempt and the statuses it may move from, so
// an older attempt can't change a newer one's record. Asking for a change is
// one row transition, so a retry and a cancel asked at once are decided by
// whichever commits first, and the other is refused.

export type ResourceDeletionKind = "instance" | "database" | "app" | "volume"

export type ResourceDeletionStatus =
  | "pending"
  | "backing_up"
  | "deleting"
  | "failed"
  | "completed"
  | "cancelling"
  | "cancelled"

/** A deletion still running its steps. */
export const unfinishedDeletionStatuses = [
  "pending",
  "backing_up",
  "deleting",
] as const satisfies ReadonlyArray<ResourceDeletionStatus>

export interface ResourceDeletion {
  actor: unknown
  attempt: number
  backupId: string | null
  createdAt: number
  error: string | null
  finalBackup: boolean
  id: string
  kind: ResourceDeletionKind
  relayDeletedAt: number | null
  /**
   * When its Relay was first asked to delete it: from then on what's left
   * of it can only be deleted, never kept.
   */
  relayDeletingAt: number | null
  /** The App's own volumes its Relay was told it may take, once asked. */
  volumeIds: ReadonlyArray<string> | null
  relayId: string
  requestedBy: string
  resourceId: string
  status: ResourceDeletionStatus
  storageId: string | null
  updatedAt: number
}

interface ResourceDeletionRow extends RowDataPacket {
  actor: unknown
  attempt: number
  backup_id: string | null
  created_at: number | string
  error: string | null
  final_backup: number
  id: string
  relay_deleted_at: number | string | null
  relay_deleting_at: number | string | null
  relay_id: string
  requested_by: string
  resource_id: string
  resource_kind: ResourceDeletionKind
  status: ResourceDeletionStatus
  storage_id: string | null
  updated_at: number | string
  volume_ids: unknown
}

/** A change that would name a resource being deleted, or deleted. */
export class ResourceBeingDeletedError extends Data.TaggedError(
  "ResourceBeingDeletedError"
)<{ readonly message: string }> {}

/** A change of plan refused because another is under way or done. */
export class ResourceDeletionConflictError extends Data.TaggedError(
  "ResourceDeletionConflictError"
)<{ readonly message: string }> {}

const columns = [
  "id",
  "relay_id",
  "resource_kind",
  "resource_id",
  "final_backup",
  "storage_id",
  "backup_id",
  "status",
  "error",
  "attempt",
  "relay_deleted_at",
  "relay_deleting_at",
  "volume_ids",
  "requested_by",
  "actor",
  "created_at",
  "updated_at",
]
const select = `SELECT ${columns.join(", ")}
  FROM ${databaseTable("resource_deletion")}`

export const loadResourceDeletionEffect = Effect.fn("resourceDeletions.load")(
  function* (id: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<ResourceDeletionRow>(
      "resource_deletion_load",
      `${select} WHERE id = ? LIMIT 1`,
      [id]
    )
    return rows[0] ? toResourceDeletion(rows[0]) : null
  }
)

/** The deletion of one resource, whatever became of it. */
export const findResourceDeletionEffect = Effect.fn("resourceDeletions.find")(
  function* (relayId: string, kind: ResourceDeletionKind, resourceId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<ResourceDeletionRow>(
      "resource_deletion_find",
      `${select}
        WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
        LIMIT 1`,
      [relayId, kind, resourceId]
    )
    return rows[0] ? toResourceDeletion(rows[0]) : null
  }
)

/** A Relay's deletions of one kind that are running or stopped. */
export const listResourceDeletionsOfKindEffect = Effect.fn(
  "resourceDeletions.listOfKind"
)(function* (relayId: string, kind: ResourceDeletionKind) {
  const database = yield* Database
  const rows = yield* database.queryRows<ResourceDeletionRow>(
    "resource_deletion_list_of_kind",
    `${select}
      WHERE relay_id = ? AND resource_kind = ?
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY created_at ASC, id ASC`,
    [relayId, kind]
  )
  return rows.map(toResourceDeletion)
})

/**
 * Deletions, and keeps after a failed one, whose current attempt has no
 * operation carrying it out: never admitted, as when Hearth stopped between
 * recording the attempt and admitting it, or ended without recording how,
 * as one interrupted for good does. `operationEnded` tells them apart.
 */
export const listResourceDeletionsToReconcileEffect = Effect.fnUntraced(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<
      ResourceDeletionRow & { operation_state: string | null }
    >(
      "resource_deletion_reconcile",
      `SELECT ${columns.map((column) => `deletion.${column}`).join(", ")},
              operation.state AS operation_state
         FROM ${databaseTable("resource_deletion")} deletion
         LEFT JOIN ${databaseTable("operation")} operation
           ON operation.kind = IF(deletion.status = 'cancelling',
                                  'resource.delete.cancel', 'resource.delete')
          AND operation.idempotency_key = CONCAT(deletion.id, ':', deletion.attempt)
        WHERE deletion.status IN ('pending', 'backing_up', 'deleting', 'cancelling')
          AND (operation.id IS NULL
               OR operation.state IN ('succeeded', 'failed', 'cancelled', 'interrupted'))
        ORDER BY deletion.created_at ASC, deletion.id ASC`
    )
    return rows.map((row) => ({
      deletion: toResourceDeletion(row),
      operationEnded: row.operation_state !== null,
    }))
  }
)

/**
 * Records that someone asked to delete a resource. A new one starts at its
 * first attempt. One that failed or was cancelled starts its next attempt
 * from the top, for whoever asked this time. A game server keeps a final
 * backup it already has while it stayed frozen, and so stopped, since: after
 * a failure, never after keeping it. One still running, or done, is returned
 * as it is; one being kept is refused until that settles.
 *
 * A retry names the failed attempt it read (`retryOf`) and goes ahead only
 * while the deletion is still that attempt, failed: one kept, or retried by
 * someone else, since it looked is refused, rather than deleting a resource
 * someone chose to keep. A refused request writes nothing.
 *
 * The row is written before it's read: two first requests at once would
 * otherwise each lock the gap where it goes and deadlock inserting it.
 */
export const requestResourceDeletionRowEffect = Effect.fn(
  "resourceDeletions.request"
)(function* (input: {
  finalBackup: boolean
  kind: ResourceDeletionKind
  relayId: string
  resourceId: string
  retryOf?: number
  storageId: string | null
  user: AuthenticatedUser
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction(
    "resource_deletion_request",
    (transaction) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const actor = JSON.stringify(input.user)
        // On the resource's existing row, a no-op that locks it.
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("resource_deletion")}
          (id, relay_id, resource_kind, resource_id, final_backup,
           storage_id, backup_id, status, error, attempt, relay_deleted_at,
           requested_by, actor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, 1, NULL, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
          [
            id,
            input.relayId,
            input.kind,
            input.resourceId,
            input.finalBackup,
            input.finalBackup ? input.storageId : null,
            input.user.id,
            actor,
            now,
            now,
          ]
        )
        const [existing] = yield* transaction.queryRows<ResourceDeletionRow>(
          `${select}
          WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
          LIMIT 1
          FOR UPDATE`,
          [input.relayId, input.kind, input.resourceId]
        )
        if (!existing) return yield* Effect.die("The deletion was not recorded")
        if (
          input.retryOf !== undefined &&
          (existing.id === id ||
            existing.status !== "failed" ||
            Number(existing.attempt) !== input.retryOf)
        ) {
          return yield* new ResourceDeletionConflictError({
            message:
              "Its deletion changed since you looked, as when someone kept it. Reload to see where it is now.",
          })
        }
        if (existing.id === id) {
          yield* invalidateSchedulesOf(transaction, existing)
          return toResourceDeletion(existing)
        }
        if (existing.status === "cancelling") {
          return yield* new ResourceDeletionConflictError({
            message:
              "It's still being kept after its last deletion stopped. Try again once that finishes.",
          })
        }
        if (existing.status !== "failed" && existing.status !== "cancelled") {
          return toResourceDeletion(existing)
        }
        let backupId: string | null = null
        if (
          existing.status === "failed" &&
          existing.resource_kind === "instance" &&
          input.finalBackup &&
          existing.backup_id
        ) {
          const [backup] = yield* transaction.queryRows<
            RowDataPacket & { status: string }
          >(
            `SELECT status FROM ${databaseTable("backup")} WHERE id = ? LIMIT 1`,
            [existing.backup_id]
          )
          if (backup?.status === "available") backupId = existing.backup_id
        }
        yield* transaction.execute(
          `UPDATE ${databaseTable("resource_deletion")}
            SET attempt = attempt + 1, status = 'pending', error = NULL,
                final_backup = ?, storage_id = ?, backup_id = ?,
                requested_by = ?, actor = ?, updated_at = ?
          WHERE id = ?`,
          [
            input.finalBackup,
            input.finalBackup ? input.storageId : null,
            backupId,
            input.user.id,
            actor,
            now,
            existing.id,
          ]
        )
        yield* invalidateSchedulesOf(transaction, existing)
        const [row] = yield* transaction.queryRows<ResourceDeletionRow>(
          `${select} WHERE id = ? LIMIT 1`,
          [existing.id]
        )
        if (!row) return yield* Effect.die("The deletion was not recorded")
        return toResourceDeletion(row)
      })
  )
})

/**
 * Records that someone wants to keep a resource whose deletion failed
 * before the Relay deleted it, as a new attempt, before anything is let go:
 * from here no retry can start, and its final backup is no longer one a
 * retry may reuse, since the resource changes once it's let go. Fails if
 * the deletion isn't one that can be kept.
 */
export const requestResourceKeepRowEffect = Effect.fn(
  "resourceDeletions.requestKeep"
)(function* (relayId: string, kind: ResourceDeletionKind, resourceId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction("resource_deletion_keep", (transaction) =>
    Effect.gen(function* () {
      const result = yield* transaction.execute(
        `UPDATE ${databaseTable("resource_deletion")}
            SET status = 'cancelling', attempt = attempt + 1, backup_id = NULL,
                error = NULL, updated_at = ?
          WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
            AND status = 'failed' AND relay_deleted_at IS NULL
            AND relay_deleting_at IS NULL`,
        [now, relayId, kind, resourceId]
      )
      if (result.affectedRows !== 1) {
        const [current] = yield* transaction.queryRows<ResourceDeletionRow>(
          `${select}
            WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
            LIMIT 1`,
          [relayId, kind, resourceId]
        )
        return yield* new ResourceDeletionConflictError({
          message:
            current?.relay_deleting_at != null ||
            current?.relay_deleted_at != null
              ? "Deleting it has already started; finish deleting it"
              : "Only a deletion that stopped before the Relay deleted anything can be cancelled",
        })
      }
      const [row] = yield* transaction.queryRows<ResourceDeletionRow>(
        `${select}
          WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
          LIMIT 1`,
        [relayId, kind, resourceId]
      )
      if (!row) return yield* Effect.die("The deletion was not recorded")
      return toResourceDeletion(row)
    })
  )
})

/**
 * Moves an attempt to `status` from one of `from`, by default a deletion
 * still running. Returns whether it did: a newer attempt, or one already
 * elsewhere, is left alone.
 */
export const recordResourceDeletionStatusEffect = Effect.fn(
  "resourceDeletions.recordStatus"
)(function* (input: {
  attempt: number
  error?: string | null
  from?: ReadonlyArray<ResourceDeletionStatus>
  id: string
  status: ResourceDeletionStatus
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const from = input.from ?? unfinishedDeletionStatuses
  return yield* database.transaction(
    "resource_deletion_status",
    (transaction) =>
      Effect.gen(function* () {
        const result = yield* transaction.execute(
          `UPDATE ${databaseTable("resource_deletion")}
            SET status = ?, error = ?, updated_at = ?
          WHERE id = ? AND attempt = ?
            AND status IN (${from.map(() => "?").join(", ")})`,
          [
            input.status,
            input.error?.slice(0, 4_096) ?? null,
            now,
            input.id,
            input.attempt,
            ...from,
          ]
        )
        if (result.affectedRows === 0) return false
        // Stopped or done: its scheduled backups run again, or find it gone.
        if (!isUnfinished(input.status)) {
          const [row] = yield* transaction.queryRows<ResourceDeletionRow>(
            `${select} WHERE id = ? LIMIT 1`,
            [input.id]
          )
          if (row) yield* invalidateSchedulesOf(transaction, row)
        }
        return true
      })
  )
})

const isUnfinished = (status: ResourceDeletionStatus) =>
  (
    unfinishedDeletionStatuses as ReadonlyArray<ResourceDeletionStatus>
  ).includes(status)

/**
 * Marks the schedules backing up a resource owed to its Relay, in the
 * transaction that starts or ends its deletion: a resource being deleted
 * isn't backed up on schedule (`scheduledBackupAdmissionEffect`).
 * `deliverPendingSchedules` sends them once it commits.
 */
const invalidateSchedulesOf = (
  transaction: DatabaseTransaction,
  row: Pick<ResourceDeletionRow, "relay_id" | "resource_id" | "resource_kind">
) =>
  invalidateScheduleDeploymentsEffect(transaction, {
    relayId: row.relay_id,
    target: { id: row.resource_id, kind: row.resource_kind },
  })

/**
 * Records, before the Relay is asked to delete the resource, that it's
 * being asked, and which of an App's own volumes it may take. Its first
 * record stays: a retry finishes that deletion, with those volumes, and is
 * never kept instead.
 */
export const recordRelayDeletingEffect = Effect.fn(
  "resourceDeletions.recordRelayDeleting"
)(function* (input: { id: string; volumeIds: ReadonlyArray<string> }) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "resource_deletion_relay_deleting",
    `UPDATE ${databaseTable("resource_deletion")}
        SET relay_deleting_at = COALESCE(relay_deleting_at, ?),
            volume_ids = COALESCE(volume_ids, CAST(? AS JSON)),
            updated_at = ?
      WHERE id = ?`,
    [now, JSON.stringify(input.volumeIds), now, input.id]
  )
})

/** Records that the Relay no longer has the resource: a retry only cleans up. */
export const recordRelayDeletedEffect = Effect.fn(
  "resourceDeletions.recordRelayDeleted"
)(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "resource_deletion_relay_deleted",
    `UPDATE ${databaseTable("resource_deletion")}
        SET relay_deleted_at = COALESCE(relay_deleted_at, ?), updated_at = ?
      WHERE id = ?`,
    [now, now, id]
  )
})

/**
 * Refuses, inside `transaction`, to let anything new point at a game server
 * or database whose deletion was asked for, or that its Relay has deleted.
 * Each check is a locking read of the resource's deletion key, which under
 * REPEATABLE READ also locks the gap where a missing row would go: a
 * deletion asked for meanwhile waits for this transaction to commit, and its
 * cleanup then finds what it wrote, and one asked for before is seen here.
 * Only a deletion that stopped, or was cancelled, before the Relay was
 * asked to delete anything left the resource in place.
 */
export const refuseResourcesBeingDeleted = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  resources: ReadonlyArray<{
    id: string
    kind: string
    name: string
    relayId: string
  }>
) {
  for (const resource of resources) {
    if (resource.kind !== "instance" && resource.kind !== "database") continue
    const [deletion] = yield* transaction.queryRows<
      RowDataPacket & {
        relay_deleted_at: number | string | null
        relay_deleting_at: number | string | null
        status: ResourceDeletionStatus
      }
    >(
      `SELECT status, relay_deleted_at, relay_deleting_at
         FROM ${databaseTable("resource_deletion")}
        WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
        FOR SHARE`,
      [resource.relayId, resource.kind, resource.id]
    )
    if (!deletion) continue
    if (deletion.relay_deleted_at !== null || deletion.status === "completed") {
      return yield* new ResourceBeingDeletedError({
        message: `${resource.name} was deleted`,
      })
    }
    if (
      deletion.relay_deleting_at !== null ||
      (deletion.status !== "failed" && deletion.status !== "cancelled")
    ) {
      return yield* new ResourceBeingDeletedError({
        message: `${resource.name} is being deleted`,
      })
    }
  }
})

/** How a deletion's final backup is going, by the backup's own record. */
export const finalBackupStateEffect = Effect.fn(
  "resourceDeletions.finalBackupState"
)(function* (backupId: string) {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { status: string; task_error: string | null }
  >(
    "resource_deletion_backup_state",
    `SELECT backup.status,
            (SELECT task.error
               FROM ${databaseTable("backup_task")} task
              WHERE task.backup_id = backup.id AND task.task_kind = 'create'
              ORDER BY task.created_at DESC, task.id DESC
              LIMIT 1) AS task_error
       FROM ${databaseTable("backup")} backup
      WHERE backup.id = ?
      LIMIT 1`,
    [backupId]
  )
  if (!row) return { error: null, state: "missing" as const }
  if (row.status === "available") {
    return { error: null, state: "available" as const }
  }
  if (row.status === "queued" || row.status === "running") {
    return { error: null, state: "running" as const }
  }
  return { error: row.task_error, state: "failed" as const }
})

function toResourceDeletion(row: ResourceDeletionRow): ResourceDeletion {
  return {
    actor: row.actor,
    attempt: Number(row.attempt),
    backupId: row.backup_id,
    createdAt: Number(row.created_at),
    error: row.error,
    finalBackup: Boolean(row.final_backup),
    id: row.id,
    kind: row.resource_kind,
    relayDeletedAt:
      row.relay_deleted_at === null ? null : Number(row.relay_deleted_at),
    relayDeletingAt:
      row.relay_deleting_at === null ? null : Number(row.relay_deleting_at),
    volumeIds: Array.isArray(row.volume_ids)
      ? row.volume_ids.filter((id): id is string => typeof id === "string")
      : null,
    relayId: row.relay_id,
    requestedBy: row.requested_by,
    resourceId: row.resource_id,
    status: row.status,
    storageId: row.storage_id,
    updatedAt: Number(row.updated_at),
  }
}
