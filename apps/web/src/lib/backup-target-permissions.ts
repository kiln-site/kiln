import type { BackupTargetKind } from "@workspace/contracts"

import { grantHasPermission, type AccessPermission } from "@/lib/permissions"

/**
 * Who may do what with a target's backups. A backup's contents are its
 * resource's data, so acting on it takes the authority reading or writing
 * that data does. Game servers and databases take `backup.*` on the Relay
 * or on themselves. A Kiln volume, shared by design, takes `backup.*` on
 * the Relay. The platform's is an administrator's alone. An App is no
 * target: what a schedule that names one takes of it follows what its
 * files take (`appBackupPermission`).
 *
 * Stopping Apps for a backup, and restoring what Apps use, take more,
 * which only the server checks (`backup-target-access.server`).
 */
export type BackupAction =
  | "backup.create"
  | "backup.delete"
  | "backup.download"
  | "backup.read"
  | "backup.restore"

const appPermissions: Record<BackupAction, AccessPermission> = {
  "backup.create": "instance.files.read",
  "backup.delete": "instance.files.write",
  "backup.download": "instance.files.read",
  "backup.read": "app.read",
  "backup.restore": "instance.files.write",
}

/** The App permission a backup action on an App takes. */
export function appBackupPermission(action: BackupAction): AccessPermission {
  return appPermissions[action]
}

/**
 * Whether grants allow an action on a target's backups, for someone who
 * isn't a platform administrator.
 */
export function grantsAllowBackup(
  grants: ReadonlyArray<{
    permissions: readonly string[]
    relayId: string
    resourceId: string
    resourceType: string
  }>,
  target: { id: string; kind: BackupTargetKind; relayId: string },
  action: BackupAction
): boolean {
  if (target.kind === "platform") return false
  return grants.some(
    (grant) =>
      grant.relayId === target.relayId &&
      grantHasPermission(grant, action) &&
      (grant.resourceType === "relay" ||
        ((target.kind === "instance" || target.kind === "database") &&
          grant.resourceType === target.kind &&
          grant.resourceId === target.id))
  )
}
