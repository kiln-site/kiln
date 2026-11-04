import type { BackupTargetKind } from "@workspace/contracts"

import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { runAppEffect } from "@/effect/runtime"

// Whether this person may send a target's backup to these destinations. The
// Relay's own storage (null) needs nothing more than taking the backup.
export async function requireBackupStorageSelection(input: {
  relayId: string
  storageIds: ReadonlyArray<string | null>
  targetId: string
  targetKind: Exclude<BackupTargetKind, "platform">
  user: AuthenticatedUser
}): Promise<void> {
  await Promise.all(
    [...new Set(input.storageIds)].map(async (storageId) => {
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
}
