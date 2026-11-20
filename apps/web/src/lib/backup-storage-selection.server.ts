import type { BackupTargetKind } from "@workspace/contracts"

import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import {
  backupDestinationRefusal,
  backupDestinationUse,
} from "@/backups/destinations/use"
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
      const use = backupDestinationUse(storage, {
        platformTarget: false,
        userId: input.user.id,
      })
      if (use === "unavailable" || use === "platform_only") {
        throw new Error(backupDestinationRefusal(use))
      }
      // A personal destination is the user's to download from.
      if (use === "personal") {
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
