import type { BackupTargetKind } from "@workspace/contracts"

import { grantHasPermission, type AccessPermission } from "@/lib/permissions"

/**
 * Who may do what with a target's backups. A backup's contents are its
 * resource's data, so acting on it takes the authority reading or writing
 * that data does. Game servers and databases take `backup.*` on the Relay
 * or on themselves. An App's folder, and a volume its Compose project owns,
 * follow the App's permissions: listing its backups takes `app.read`,
 * making or downloading one `app.files.read`, as reading its files does,
 * and restoring or deleting one `app.files.write`, as replacing them does.
 * App owners hold neither file permission, since an App's files reach the
 * node through its Compose file, so like its configuration only people
 * with App permissions on the Relay back it up. A Kiln volume, shared by
 * design, takes `backup.*` on the Relay. The platform's is an
 * administrator's alone.
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
  "backup.create": "app.files.read",
  "backup.delete": "app.files.write",
  "backup.download": "app.files.read",
  "backup.read": "app.read",
  "backup.restore": "app.files.write",
}

/** The App whose permissions a target's backups follow, if any. */
export function backupTargetApp(target: {
  id: string
  kind: BackupTargetKind
}): string | null {
  if (target.kind === "app") return target.id
  if (target.kind !== "volume") return null
  return /^([a-f0-9]{40})\//u.exec(target.id)?.[1] ?? null
}

/** The App permission a backup action on an App's target takes. */
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
  const appId = backupTargetApp(target)
  if (appId) {
    const permission = appPermissions[action]
    return grants.some(
      (grant) =>
        grant.relayId === target.relayId &&
        grantHasPermission(grant, permission) &&
        (grant.resourceType === "relay" ||
          (grant.resourceType === "app" && grant.resourceId === appId))
    )
  }
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
