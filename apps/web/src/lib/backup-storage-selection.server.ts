import type { BackupTargetKind } from "@workspace/contracts"

import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { getBackupPolicyEffect } from "@/effect/backups"
import { runAppEffect } from "@/effect/runtime"

// Resolve the policy once so authorization and reservation use the same destination.
export async function resolveBackupStorageSelection(input: {
  relayId: string
  targetId: string
  targetKind: Exclude<BackupTargetKind, "platform">
  storageId?: string | null
  storageIds?: ReadonlyArray<string | null>
}): Promise<Array<string | null>> {
  if (input.storageIds !== undefined) return [...input.storageIds]
  if (input.storageId !== undefined) return [input.storageId]
  const policy = await runAppEffect(
    "backups.resolveStoragePolicy",
    getBackupPolicyEffect(input.relayId, input.targetKind, input.targetId)
  )
  return [policy.storageId]
}

export async function resolveAuthorizedBackupStorageSelection(
  input: Parameters<typeof resolveBackupStorageSelection>[0] & {
    user: AuthenticatedUser
  }
): Promise<Array<string | null>> {
  const storageIds = await resolveBackupStorageSelection(input)
  await Promise.all(
    [...new Set(storageIds)].map(async (storageId) => {
      if (storageId === null) return
      const storage = await runAppEffect(
        "backups.loadSelectedStorage",
        loadBackupStorageEffect(storageId)
      )
      if (
        !storage ||
        !storage.enabled ||
        storage.deleting ||
        (storage.ownerUserId !== null && storage.ownerUserId !== input.user.id)
      ) {
        throw new Error("Backup destination is unavailable")
      }
      // A personal destination is the user's to download from.
      if (storage.ownerUserId !== null) {
        await requireBackupTargetPermission(
          input.user,
          input.relayId,
          { id: input.targetId, kind: input.targetKind },
          "backup.download"
        )
      }
    })
  )
  return storageIds
}
