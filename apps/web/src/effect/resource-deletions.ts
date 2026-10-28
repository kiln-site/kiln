import { randomUUID } from "node:crypto"

import { Clock, Data, Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database, type DatabaseTransaction } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"

// The rows behind `resource.delete` (lib/resource-deletion.server.ts): one
// per resource, reset for each new attempt. Every write an attempt makes
// names its attempt and leaves a finished row alone, so an older attempt
// can't change a newer one's record.

export type ResourceDeletionKind = "instance" | "database"

export type ResourceDeletionStatus =
  | "pending"
  | "backing_up"
  | "deleting"
  | "failed"
  | "completed"
  | "cancelled"

/** A deletion still running: anything that would change the resource waits. */
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
  relay_id: string
  requested_by: string
  resource_id: string
  resource_kind: ResourceDeletionKind
  status: ResourceDeletionStatus
  storage_id: string | null
  updated_at: number | string
}

const select = `SELECT id, relay_id, resource_kind, resource_id, final_backup,
       storage_id, backup_id, status, error, attempt, relay_deleted_at,
       requested_by, actor, created_at, updated_at
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

/** Every deletion still running, as after a restart. */
export const listUnfinishedResourceDeletionsEffect = Effect.fn(
  "resourceDeletions.listUnfinished"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<ResourceDeletionRow>(
    "resource_deletion_list_unfinished",
    `${select}
      WHERE status IN ('pending', 'backing_up', 'deleting')
      ORDER BY created_at ASC, id ASC`
  )
  return rows.map(toResourceDeletion)
})

/**
 * Records that someone asked to delete a resource. A new one starts at its
 * first attempt. One that failed or was cancelled starts its next attempt
 * from the top, for whoever asked this time. A game server keeps a final
 * backup it already has while it stayed frozen, and so stopped, since: after
 * a failure, not a cancel. One still running, or done, is returned as it is.
 */
export const requestResourceDeletionRowEffect = Effect.fn(
  "resourceDeletions.request"
)(function* (input: {
  finalBackup: boolean
  kind: ResourceDeletionKind
  relayId: string
  resourceId: string
  storageId: string | null
  user: AuthenticatedUser
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction(
    "resource_deletion_request",
    (transaction) =>
      Effect.gen(function* () {
        const [existing] = yield* transaction.queryRows<ResourceDeletionRow>(
          `${select}
          WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
          LIMIT 1
          FOR UPDATE`,
          [input.relayId, input.kind, input.resourceId]
        )
        const actor = JSON.stringify(input.user)
        if (!existing) {
          const id = randomUUID()
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("resource_deletion")}
            (id, relay_id, resource_kind, resource_id, final_backup,
             storage_id, backup_id, status, error, attempt, relay_deleted_at,
             requested_by, actor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, 1, NULL, ?, ?, ?, ?)`,
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
        } else if (
          existing.status === "failed" ||
          existing.status === "cancelled"
        ) {
          let backupId: string | null = null
          // Only a game server's: a stopped server is as its backup left it,
          // while a frozen database keeps taking writes from what's
          // connected to it.
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
        }
        const [row] = yield* transaction.queryRows<ResourceDeletionRow>(
          `${select}
          WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
          LIMIT 1`,
          [input.relayId, input.kind, input.resourceId]
        )
        if (!row) return yield* Effect.die("The deletion was not recorded")
        return toResourceDeletion(row)
      })
  )
})

/**
 * Moves an attempt that's still running to `status`. Returns whether it did:
 * a newer attempt, or one already finished, is left alone.
 */
export const recordResourceDeletionStatusEffect = Effect.fn(
  "resourceDeletions.recordStatus"
)(function* (input: {
  attempt: number
  error?: string | null
  id: string
  status: ResourceDeletionStatus
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "resource_deletion_status",
    `UPDATE ${databaseTable("resource_deletion")}
        SET status = ?, error = ?, updated_at = ?
      WHERE id = ? AND attempt = ?
        AND status IN ('pending', 'backing_up', 'deleting')`,
    [
      input.status,
      input.error?.slice(0, 4_096) ?? null,
      now,
      input.id,
      input.attempt,
    ]
  )
  return result.affectedRows > 0
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
 * Marks a failed deletion cancelled, if the Relay deleted nothing of it.
 * Returns whether it did.
 */
export const recordResourceDeletionCancelledEffect = Effect.fn(
  "resourceDeletions.recordCancelled"
)(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "resource_deletion_cancel",
    `UPDATE ${databaseTable("resource_deletion")}
        SET status = 'cancelled', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed' AND relay_deleted_at IS NULL`,
    [now, id]
  )
  return result.affectedRows > 0
})

/** A change that would name a resource being deleted, or deleted. */
export class ResourceBeingDeletedError extends Data.TaggedError(
  "ResourceBeingDeletedError"
)<{ readonly message: string }> {}

/**
 * Refuses, inside `transaction`, to let anything new point at a game server
 * or database whose deletion was asked for. Each check is a locking read of
 * the resource's deletion key, which under REPEATABLE READ also locks the
 * gap where a missing row would go: a deletion asked for meanwhile waits for
 * this transaction to commit, and its cleanup then finds what it wrote, and
 * one asked for before is seen here. A failed or cancelled deletion left the
 * resource in place, so it doesn't count.
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
      RowDataPacket & { status: ResourceDeletionStatus }
    >(
      `SELECT status FROM ${databaseTable("resource_deletion")}
        WHERE relay_id = ? AND resource_kind = ? AND resource_id = ?
        FOR SHARE`,
      [resource.relayId, resource.kind, resource.id]
    )
    if (
      deletion &&
      deletion.status !== "failed" &&
      deletion.status !== "cancelled"
    ) {
      return yield* new ResourceBeingDeletedError({
        message:
          deletion.status === "completed"
            ? `${resource.name} was deleted`
            : `${resource.name} is being deleted`,
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
    relayId: row.relay_id,
    requestedBy: row.requested_by,
    resourceId: row.resource_id,
    status: row.status,
    storageId: row.storage_id,
    updatedAt: Number(row.updated_at),
  }
}
