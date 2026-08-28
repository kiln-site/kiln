import { randomUUID } from "node:crypto"

import { Effect, Result } from "effect"
import { z } from "zod"

import {
  relayControlDeadlineMs,
  relaySnapshotSchema,
} from "@workspace/contracts"

import {
  clearFailedFinalInstanceDeletionEffect,
  getFinalInstanceDeletionEffect,
  listPendingFinalInstanceDeletionsEffect,
  purgeInstanceBackupRepositoriesEffect,
  reserveInstanceBackupEffect,
  updateFinalInstanceDeletionEffect,
  type FinalInstanceDeletion,
} from "@/effect/backups"
import { runAppEffect } from "@/effect/runtime"
import { deleteInstanceDomainEffect } from "@/server/domains.server"
import { finalizeInstanceDeletionEffect } from "@/server/instance-deletion-cleanup"
import { timestampedBackupName } from "@/lib/backup-name"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { relayRpc } from "@/lib/relay-connection"
import type { PersistedRelay } from "@/lib/relay-registry"

const deleteResultSchema = z.object({
  deleted: z.literal(true),
  instanceId: z.string(),
})

const activeFinalDeletions = new Set<string>()

export async function ensureFinalInstanceDeletion(input: {
  instanceId: string
  relay: PersistedRelay
  requestedBy: string
  storageId?: string | null
}): Promise<FinalInstanceDeletion> {
  const existing = await finalDeletion(input.relay.id, input.instanceId)
  if (existing?.status !== "failed") {
    if (existing) return existing
  } else {
    await runAppEffect(
      "backups.finalDelete.retry",
      clearFailedFinalInstanceDeletionEffect(input.relay.id, input.instanceId)
    )
  }
  const reserved = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          runAppEffect(
            "backups.finalDelete.reserve",
            reserveInstanceBackupEffect({
              backupId: randomUUID(),
              createdBy: input.requestedBy,
              name: timestampedBackupName("final"),
              reason: "final_delete",
              relayId: input.relay.id,
              requestedMaxBytes: null,
              ...(input.storageId === undefined
                ? {}
                : { storageId: input.storageId }),
              targetId: input.instanceId,
              taskId: randomUUID(),
            })
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(reserved)) {
    const concurrent = await finalDeletion(input.relay.id, input.instanceId)
    if (concurrent) return concurrent
    throw reserved.failure
  }
  publishBackupChange(input.relay.id)
  const backup = reserved.success
  const { dispatchBackupTask } = await import("@/lib/backup-reconciliation")
  await dispatchBackupTask(input.relay, backup, input.requestedBy)
  const created = await finalDeletion(input.relay.id, input.instanceId)
  if (!created) throw new Error("Final server deletion was not persisted")
  return created
}

export async function deleteInstanceWithFinalBackup(input: {
  instanceId: string
  relay: PersistedRelay
  requestedBy: string
  storageId?: string | null
}): Promise<void> {
  const deletion = await ensureFinalInstanceDeletion(input)
  if (deletion.status === "failed") throw finalBackupFailure(deletion)
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const { reconcileRelayBackups } =
      await import("@/lib/backup-reconciliation")
    await reconcileRelayBackups(input.relay, input.requestedBy)
    const current = await finalDeletion(input.relay.id, input.instanceId)
    if (current?.status === "completed") return
    if (current?.status === "failed") throw finalBackupFailure(current)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error(
    "The final backup is still running. Server deletion will continue in the background."
  )
}

export async function deleteInstanceWithoutFinalBackup(input: {
  instanceId: string
  relay: PersistedRelay
  requestedBy: string
}): Promise<void> {
  const existing = await finalDeletion(input.relay.id, input.instanceId)
  if (existing?.status === "completed") return
  if (existing && existing.status !== "failed") {
    throw new Error(
      "The final backup is already running. Wait for it to finish before changing the deletion plan."
    )
  }
  if (existing) {
    const cleared = await runAppEffect(
      "backups.finalDelete.skipFailed",
      clearFailedFinalInstanceDeletionEffect(input.relay.id, input.instanceId)
    )
    if (!cleared) {
      throw new Error("The server deletion plan changed. Try deleting again.")
    }
  }
  await deleteInstanceResources(input)
}

export async function processFinalInstanceDeletions(
  relay: PersistedRelay
): Promise<boolean> {
  const pending = await runAppEffect(
    "backups.finalDelete.pending",
    listPendingFinalInstanceDeletionsEffect(relay.id)
  )
  for (const deletion of pending) {
    const key = `${deletion.relayId}:${deletion.targetId}`
    if (activeFinalDeletions.has(key)) continue
    activeFinalDeletions.add(key)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => processFinalInstanceDeletion(relay, deletion),
        catch: (cause) => cause,
      }).pipe(
        Effect.ensuring(Effect.sync(() => activeFinalDeletions.delete(key)))
      )
    )
  }
  return (
    (
      await runAppEffect(
        "backups.finalDelete.pendingAfterRun",
        listPendingFinalInstanceDeletionsEffect(relay.id)
      )
    ).length > 0
  )
}

export async function finalDeletion(
  relayId: string,
  instanceId: string
): Promise<FinalInstanceDeletion | null> {
  return runAppEffect(
    "backups.finalDelete.load",
    getFinalInstanceDeletionEffect(relayId, instanceId)
  )
}

async function deleteFinalizedInstance(
  relay: PersistedRelay,
  deletion: FinalInstanceDeletion
): Promise<void> {
  const result = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => deleteFinalizedInstanceAttempt(relay, deletion),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(result)) {
    await updateFinalDeletion({
      deletion,
      error: errorMessage(result.failure),
      from: ["deleting"],
      status: "deleting",
    })
  }
}

async function processFinalInstanceDeletion(
  relay: PersistedRelay,
  deletion: FinalInstanceDeletion
): Promise<void> {
  if (deletion.status === "backing_up") {
    if (deletion.backupStatus === "failed") {
      await updateFinalDeletion({
        deletion,
        error:
          deletion.taskError ??
          "The final backup failed; the server was not deleted",
        from: ["backing_up"],
        status: "failed",
      })
      return
    }
    if (deletion.backupStatus !== "available") return
    const claimed = await updateFinalDeletion({
      deletion,
      error: null,
      from: ["backing_up"],
      status: "deleting",
    })
    if (!claimed) return
  }
  await deleteFinalizedInstance(relay, deletion)
}

async function deleteFinalizedInstanceAttempt(
  relay: PersistedRelay,
  deletion: FinalInstanceDeletion
): Promise<void> {
  await deleteInstanceResources({
    instanceId: deletion.targetId,
    relay,
    requestedBy: deletion.requestedBy,
  })
  await updateFinalDeletion({
    deletion,
    error: null,
    from: ["deleting"],
    status: "completed",
  })
}

async function deleteInstanceResources(input: {
  instanceId: string
  relay: PersistedRelay
  requestedBy: string
}): Promise<void> {
  await runAppEffect(
    "domains.instance.finalDelete",
    deleteInstanceDomainEffect(input.relay.id, input.instanceId)
  )
  const relayDeletion = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: async () =>
          deleteResultSchema.parse(
            await relayRpc(
              input.relay,
              "instance.delete",
              { deleteData: true, instanceId: input.instanceId },
              relayControlDeadlineMs("instance.delete"),
              input.requestedBy
            )
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(relayDeletion)) {
    const snapshot = relaySnapshotSchema.parse(
      await relayRpc(
        input.relay,
        "relay.snapshot",
        {},
        15_000,
        input.requestedBy
      )
    )
    if (
      snapshot.instances.some((instance) => instance.id === input.instanceId)
    ) {
      throw relayDeletion.failure
    }
  }
  await runAppEffect(
    "backups.finalDelete.purgeRepositories",
    purgeInstanceBackupRepositoriesEffect(input.relay.id, input.instanceId)
  )
  await runAppEffect(
    "instances.finalDelete.finalize",
    finalizeInstanceDeletionEffect(input.relay.id, input.instanceId)
  )
}

function updateFinalDeletion(input: {
  deletion: FinalInstanceDeletion
  error: string | null
  from: ReadonlyArray<FinalInstanceDeletion["status"]>
  status: FinalInstanceDeletion["status"]
}) {
  return runAppEffect(
    "backups.finalDelete.update",
    updateFinalInstanceDeletionEffect({
      error: input.error?.slice(0, 4_096) ?? null,
      from: input.from,
      relayId: input.deletion.relayId,
      status: input.status,
      targetId: input.deletion.targetId,
    })
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Server deletion failed"
}

function finalBackupFailure(deletion: FinalInstanceDeletion): Error {
  return new Error(
    deletion.error ?? "The final backup failed; the server was not deleted"
  )
}
