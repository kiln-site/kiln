import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { authenticateCliTokenEffect } from "@/effect/cli-access"
import { runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import {
  isAccountEnabled,
  isAccountVerified,
  type AccountPolicy,
} from "@/lib/account-policy"
import { grantHasPermission } from "@/lib/permissions"
import { loadResourceGrantsEffect } from "@/lib/resource-permissions"

interface UserRow extends RowDataPacket, AccountPolicy {
  id: string
  role: string | null
}

interface InstanceRow extends RowDataPacket {
  instance_id: string
}

export interface SftpAuthorization {
  instances: ReadonlyArray<{ id: string; actions: ReadonlyArray<string> }>
  userId: string
  username: string
}

export async function resolveSftpAuthorization(
  relayId: string,
  username: string,
  credential?: string
): Promise<SftpAuthorization | null> {
  const normalizedUsername = username.trim().toLowerCase()
  if (!normalizedUsername || normalizedUsername.length > 320) return null

  const cliPrincipal = credential
    ? await runAppEffect(
        "cli.sftp.authenticate",
        authenticateCliTokenEffect(credential).pipe(Effect.option)
      )
    : null
  if (
    credential &&
    (cliPrincipal?._tag !== "Some" ||
      cliPrincipal.value.user.email.toLowerCase() !== normalizedUsername)
  ) {
    return null
  }
  const linkedCli = cliPrincipal?._tag === "Some" ? cliPrincipal.value : null
  const user = linkedCli ? linkedCli.user : await findUser(normalizedUsername)
  if (!user || !isAccountEnabled(user) || !isAccountVerified(user)) return null

  const [instances] = await databasePool.query<Array<InstanceRow>>(
    `SELECT instance_id
       FROM ${databaseTable("instance")}
      WHERE relay_id = ?
      ORDER BY instance_id ASC`,
    [relayId]
  )
  if (user.role === "admin") {
    return {
      instances: instances.map((instance) => ({
        actions: sftpFileActions({
          read: true,
          write: linkedCli?.mode !== "read_only",
          delete: linkedCli?.mode !== "read_only",
          chmod: linkedCli?.mode !== "read_only",
        }),
        id: instance.instance_id,
      })),
      userId: user.id,
      username: normalizedUsername,
    }
  }

  const grants = await runAppEffect(
    "sftp.permissions",
    loadResourceGrantsEffect(user.id, relayId)
  )
  const instanceIds = new Set(instances.map((instance) => instance.instance_id))
  const permissions = new Map<string, Set<string>>()
  for (const grant of grants) {
    if (grant.resourceType === "database") continue
    const grantedIds =
      grant.resourceType === "relay" ? instanceIds : [grant.resourceId]
    for (const instanceId of grantedIds) {
      if (!instanceIds.has(instanceId)) continue
      const existing = permissions.get(instanceId) ?? new Set<string>()
      for (const permission of grant.permissions) existing.add(permission)
      permissions.set(instanceId, existing)
    }
  }
  const resolved = new Map<string, Set<string>>()
  for (const [instanceId, selected] of permissions) {
    const grant = { permissions: [...selected] }
    if (!grantHasPermission(grant, "instance.sftp.connect")) continue
    const writable = linkedCli?.mode !== "read_only"
    resolved.set(
      instanceId,
      new Set(
        sftpFileActions({
          read: grantHasPermission(grant, "instance.files.read"),
          write: writable && grantHasPermission(grant, "instance.files.write"),
          delete:
            writable && grantHasPermission(grant, "instance.files.delete"),
          chmod: writable && grantHasPermission(grant, "instance.files.chmod"),
        })
      )
    )
  }
  if (resolved.size === 0) return null
  return {
    instances: [...resolved]
      .map(([id, actions]) => ({ actions: [...actions].sort(), id }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    userId: user.id,
    username: normalizedUsername,
  }
}

async function findUser(username: string): Promise<UserRow | undefined> {
  const [users] = await databasePool.query<Array<UserRow>>(
    `SELECT id, role, status, statusExpiresAt, emailVerifiedAt,
            manuallyVerifiedAt, legacyVerificationRecordedAt
       FROM ${databaseTable("user")}
      WHERE email = ?
      LIMIT 1`,
    [username]
  )
  return users[0]
}

export function sftpFileActions(permissions: {
  read: boolean
  write: boolean
  delete: boolean
  chmod: boolean
}): ReadonlyArray<string> {
  return [
    ...(permissions.read ? ["instance.files.list", "instance.files.read"] : []),
    ...(permissions.write
      ? [
          "instance.files.create",
          "instance.files.write",
          "instance.files.rename",
        ]
      : []),
    ...(permissions.delete ? ["instance.files.delete"] : []),
    ...(permissions.chmod ? ["instance.files.chmod"] : []),
  ]
}
