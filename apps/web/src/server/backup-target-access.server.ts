import {
  relayVolumesSchema,
  type BackupTarget,
  type BackupTargetKind,
} from "@workspace/contracts"

import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  backupTargetApp,
  grantsAllowBackup,
  type BackupAction,
} from "@/lib/backup-target-permissions"
import { relayRpc } from "@/lib/relay-connection"
import type { PersistedRelay } from "@/lib/relay-registry"
import { grantHasPermission } from "@/lib/permissions"

// Server-only checks of who may act on a target's backups; see
// lib/backup-target-permissions for the rules.

const actionVerbs: Record<BackupAction, string> = {
  "backup.create": "back up",
  "backup.delete": "delete backups of",
  "backup.download": "download backups of",
  "backup.read": "see backups of",
  "backup.restore": "restore",
}

const kindNames: Record<BackupTargetKind, string> = {
  app: "this App",
  database: "this database",
  instance: "this game server",
  platform: "Kiln",
  volume: "this volume",
}

/** Refuses an action on a target's backups the user may not take. */
export async function requireBackupTargetPermission(
  user: AuthenticatedUser,
  relayId: string,
  target: BackupTarget,
  action: BackupAction
): Promise<void> {
  if (isPlatformAdmin(user)) return
  const grants = await listUserGrants(user.id, relayId)
  if (!grantsAllowBackup(grants, { ...target, relayId }, action)) {
    throw new Error(
      `You do not have permission to ${actionVerbs[action]} ${kindNames[target.kind]}`
    )
  }
}

/**
 * The Apps that use an App's folder or a volume, as its Relay says: the App
 * itself, or a volume's owner and every App whose configuration or
 * containers mount it. Fails while the Relay can't tell, rather than
 * answering too few.
 */
export async function backupTargetUsers(
  relay: PersistedRelay,
  target: BackupTarget & { kind: "app" | "volume" },
  userId: string
): Promise<Array<string>> {
  if (target.kind === "app") return [target.id]
  const { protection, volumes } = relayVolumesSchema.parse(
    await relayRpc(relay, "relay.volumes.read", {}, 30_000, userId)
  )
  const volume = volumes.find((candidate) => candidate.id === target.id)
  if (!volume) throw new Error("Volume not found on this Relay")
  if (!protection.ready) {
    throw new Error(
      `The Relay doesn't know yet which Apps use this volume${protection.reason ? `: ${protection.reason}` : ""}`
    )
  }
  return [
    ...new Set([
      ...(volume.owner ? [volume.owner.appId] : []),
      ...volume.users.map((user) => user.appId),
    ]),
  ]
}

/**
 * Refuses unless the user holds `permission` on every App: each App a
 * stopped backup stops and starts again takes `app.manage`, as starting and
 * stopping it does; each App using what a restore replaces takes the
 * permission that writes its files.
 */
export async function requireAppsPermission(
  user: AuthenticatedUser,
  relayId: string,
  appIds: ReadonlyArray<string>,
  permission: "app.files.write" | "app.manage",
  reason: string
): Promise<void> {
  if (isPlatformAdmin(user) || appIds.length === 0) return
  const grants = await listUserGrants(user.id, relayId)
  const denied = appIds.some(
    (appId) =>
      !grants.some(
        (grant) =>
          grant.relayId === relayId &&
          grantHasPermission(grant, permission) &&
          (grant.resourceType === "relay" ||
            (grant.resourceType === "app" && grant.resourceId === appId))
      )
  )
  if (denied) throw new Error(reason)
}

/**
 * Refuses a restore unless the user may restore the target and write the
 * files of every App that uses it.
 */
export async function requireBackupTargetRestore(
  user: AuthenticatedUser,
  relay: PersistedRelay,
  target: BackupTarget & { kind: "app" | "volume" }
): Promise<void> {
  await requireBackupTargetPermission(user, relay.id, target, "backup.restore")
  const owner = backupTargetApp(target)
  const users = (await backupTargetUsers(relay, target, user.id)).filter(
    (appId) => appId !== owner
  )
  await requireAppsPermission(
    user,
    relay.id,
    users,
    "app.files.write",
    "Restoring this volume replaces files every App that uses it reads; you need permission to change each App's files"
  )
}
