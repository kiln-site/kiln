import { randomUUID } from "node:crypto"

import { Effect, Result } from "effect"
import { z } from "zod"

import { relayManagedDatabaseSchema } from "@workspace/contracts"

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
  relay: PersistedRelay
  requestedBy: string
}): Promise<void> {
  await deleteDatabaseOnRelay(input.relay, input.databaseId, input.requestedBy)
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

async function ensureFinalDatabaseDeletion(input: {
  databaseId: string
  relay: PersistedRelay
  requestedBy: string
}): Promise<FinalDatabaseDeletion> {
  const existing = await finalDatabaseDeletion(input.relay.id, input.databaseId)
  if (existing?.status !== "failed") {
    if (existing) return existing
  } else {
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
  publishBackupChange(input.relay.id)
  const { dispatchBackupTask } = await import("@/lib/backup-reconciliation")
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

async function deleteDatabaseOnRelay(
  relay: PersistedRelay,
  databaseId: string,
  requestedBy: string
): Promise<void> {
  const removed = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          relayRpc(
            relay,
            "database.delete",
            { databaseId, deleteData: true },
            180_000,
            requestedBy
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(removed)) {
    const databases = z
      .array(relayManagedDatabaseSchema)
      .parse(await relayRpc(relay, "database.list", {}, 15_000, requestedBy))
    if (databases.some((database) => database.id === databaseId)) {
      throw removed.failure
    }
  } else {
    deleteResultSchema.parse(removed.success)
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
