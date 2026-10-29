import type { BackupCatalogRecord } from "@/effect/backups"
import type { AccessGrant } from "@/lib/access-control"
import { isPlatformAdmin } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  grantsAllowBackup,
  type BackupAction,
} from "@/lib/backup-target-permissions"

export function hasBackupPermission(
  user: AuthenticatedUser,
  grants: ReadonlyArray<AccessGrant>,
  backup: BackupCatalogRecord,
  permission: BackupAction
): boolean {
  if (isPlatformAdmin(user)) return true
  return grantsAllowBackup(
    grants,
    { id: backup.targetId, kind: backup.targetKind, relayId: backup.relayId },
    permission
  )
}
