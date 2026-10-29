import { randomUUID } from "node:crypto"

import { Effect, Result } from "effect"
import { z } from "zod"

import {
  clearFailedFinalDatabaseDeletionEffect,
  getFinalDatabaseDeletionEffect,
  listPendingFinalDatabaseDeletionsEffect,
  reserveDatabaseBackupEffect,
  updateFinalDatabaseDeletionEffect,
  type FinalDatabaseDeletion,
} from "@/effect/backups"
import { deleteManagedDatabaseRecordEffect } from "@/effect/managed-databases"
import { runAppEffect } from "@/effect/runtime"
import { timestampedBackupName } from "@/lib/backup-name"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { resolveAuthorizedBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { relayRpc } from "@/lib/relay-connection"
import type { PersistedRelay } from "@/lib/relay-registry"

const deleteResultSchema = z.object({
  databaseId: z.string(),
  deleted: z.literal(true),
})
const activeFinalDeletions = new Set<string>()

export async function deleteDatabaseWithFinalBackup(input: {
  databaseId: string
  relay: PersistedRelay
  requestedBy: string
  user: AuthenticatedUser
}): Promise<void> {
  const deletion = await ensureFinalDatabaseDeletion(input)
  if (deletion.status === "failed") throw finalBackupFailure(deletion)
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const { reconcileRelayBackups } =
      await import("@/lib/backup-reconciliation")
    await reconcileRelayBackups(input.relay, input.requestedBy)
    const current = await finalDatabaseDeletion(
      input.relay.id,
      input.databaseId
    )
    if (current?.status === "completed") return
    if (current?.status === "failed") throw finalBackupFailure(current)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error(
    "The final backup is still running. Database deletion will continue in the background."
  )
}

export async function deleteDatabaseWithoutFinalBackup(input: {
  databaseId: string
  /** Whether its data volume goes too. Defaults to true. */
  deleteData?: boolean
  relay: PersistedRelay
  requestedBy: string
}): Promise<void> {
  await deleteDatabaseOnRelay(
    input.relay,
    input.databaseId,
    input.requestedBy,
    input.deleteData ?? true
  )
  await runAppEffect(
    "managedDatabases.directDelete",
    deleteManagedDatabaseRecordEffect(input.relay.id, input.databaseId)
  )
}

export async function processFinalDatabaseDeletions(
  relay: PersistedRelay
): Promise<boolean> {
  const pending = await runAppEffect(
    "backups.finalDatabaseDelete.pending",
    listPendingFinalDatabaseDeletionsEffect(relay.id)
  )
  for (const deletion of pending) {
    const key = `${deletion.relayId}:${deletion.targetId}`
    if (activeFinalDeletions.has(key)) continue
    activeFinalDeletions.add(key)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => processFinalDatabaseDeletion(relay, deletion),
        catch: (cause) => cause,
      }).pipe(
        Effect.ensuring(Effect.sync(() => activeFinalDeletions.delete(key)))
      )
    )
  }
  return (
    (
      await runAppEffect(
        "backups.finalDatabaseDelete.pendingAfterRun",
        listPendingFinalDatabaseDeletionsEffect(relay.id)
      )
    ).length > 0
  )
}

export async function ensureFinalDatabaseDeletion(input: {
  databaseId: string
  relay: PersistedRelay
  requestedBy: string
  user: AuthenticatedUser
}): Promise<FinalDatabaseDeletion> {
  const existing = await finalDatabaseDeletion(input.relay.id, input.databaseId)
  if (existing && existing.status !== "failed") return existing
  await requireRelayPermission({
    databaseId: input.databaseId,
    permission: "backup.create",
    relayId: input.relay.id,
    user: input.user,
  })
  const storageIds = await resolveAuthorizedBackupStorageSelection({
    relayId: input.relay.id,
    targetId: input.databaseId,
    targetKind: "database",
    user: input.user,
  })
  if (existing) {
    await runAppEffect(
      "backups.finalDatabaseDelete.retry",
      clearFailedFinalDatabaseDeletionEffect(input.relay.id, input.databaseId)
    )
  }
  const reserved = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          runAppEffect(
            "backups.finalDatabaseDelete.reserve",
            reserveDatabaseBackupEffect({
              backupId: randomUUID(),
              createdBy: input.requestedBy,
              name: timestampedBackupName("final"),
              reason: "final_delete",
              storageIds,
              relayId: input.relay.id,
              requestedMaxBytes: null,
              targetId: input.databaseId,
              taskId: randomUUID(),
            })
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(reserved)) {
    const concurrent = await finalDatabaseDeletion(
      input.relay.id,
      input.databaseId
    )
    if (concurrent) return concurrent
    throw reserved.failure
  }
  publishBackupChange(input.relay.id, reserved.success.backupId)
  const { dispatchBackupTask } = await import("@/lib/backup-reconciliation")
  await deliverSchedules()
  await dispatchBackupTask(input.relay, reserved.success, input.requestedBy)
  const created = await finalDatabaseDeletion(input.relay.id, input.databaseId)
  if (!created) throw new Error("Final database deletion was not persisted")
  return created
}

async function processFinalDatabaseDeletion(
  relay: PersistedRelay,
  deletion: FinalDatabaseDeletion
): Promise<void> {
  if (deletion.status === "backing_up") {
    if (deletion.backupStatus === "failed") {
      await updateFinalDeletion(
        deletion,
        "failed",
        ["backing_up"],
        deletion.taskError ??
          "The final backup failed; the database was not deleted"
      )
      await deliverSchedules()
      return
    }
    if (deletion.backupStatus !== "available") return
    if (
      !(await updateFinalDeletion(deletion, "deleting", ["backing_up"], null))
    )
      return
  }
  const result = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => deleteFinalizedDatabase(relay, deletion),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(result)) {
    await updateFinalDeletion(
      deletion,
      "deleting",
      ["deleting"],
      errorMessage(result.failure)
    )
  }
}

async function deleteFinalizedDatabase(
  relay: PersistedRelay,
  deletion: FinalDatabaseDeletion
): Promise<void> {
  await deleteDatabaseOnRelay(relay, deletion.targetId, deletion.requestedBy)
  await runAppEffect(
    "managedDatabases.finalDelete",
    deleteManagedDatabaseRecordEffect(relay.id, deletion.targetId)
  )
  await updateFinalDeletion(deletion, "completed", ["deleting"], null)
}

// Deletes the database on the Relay. Only the Relay saying it has nothing
// of the database left (no container, network, or volume) counts as already
// deleted; any other failure leaves Hearth's record for a retry.
async function deleteDatabaseOnRelay(
  relay: PersistedRelay,
  databaseId: string,
  requestedBy: string,
  deleteData = true
): Promise<void> {
  const removed = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          relayRpc(
            relay,
            "database.delete",
            { databaseId, deleteData },
            180_000,
            requestedBy
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isSuccess(removed)) {
    deleteResultSchema.parse(removed.success)
    return
  }
  if (
    !(
      removed.failure instanceof Error &&
      removed.failure.message.includes("Database not found")
    )
  ) {
    throw removed.failure
  }
}

function finalDatabaseDeletion(relayId: string, databaseId: string) {
  return runAppEffect(
    "backups.finalDatabaseDelete.load",
    getFinalDatabaseDeletionEffect(relayId, databaseId)
  )
}

function updateFinalDeletion(
  deletion: FinalDatabaseDeletion,
  status: FinalDatabaseDeletion["status"],
  from: ReadonlyArray<FinalDatabaseDeletion["status"]>,
  error: string | null
) {
  return runAppEffect(
    "backups.finalDatabaseDelete.update",
    updateFinalDatabaseDeletionEffect({
      error: error?.slice(0, 4_096) ?? null,
      from,
      relayId: deletion.relayId,
      status,
      targetId: deletion.targetId,
    })
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Database deletion failed"
}

function finalBackupFailure(deletion: FinalDatabaseDeletion): Error {
  return new Error(
    deletion.error ?? "The final backup failed; the database was not deleted"
  )
}

// Scheduled backups stop while it's being deleted, and resume if its
// deletion stops: reserving its final backup, or recording it failed, marked
// its schedules owed (`invalidateScheduleDeploymentsEffect`).
async function deliverSchedules() {
  const { deliverPendingSchedules } =
    await import("@/server/schedule-deployment.server")
  deliverPendingSchedules()
}
