import { accessPermissions, type AccessPermission } from "@workspace/contracts"

export { accessPermissions }
export type { AccessPermission }

export const platformRoles = ["admin", "relay_creator", "user"] as const
export type PlatformRole = (typeof platformRoles)[number]

export const platformPermissions = [
  "platform.appearance.manage-default",
  "platform.backups.manage-storage",
  "platform.backups.manage-limits",
  "platform.bricks.add-catalog",
  "platform.bricks.add-custom",
  "platform.network.override-public-port-range",
] as const
export type PlatformPermission = (typeof platformPermissions)[number]

const platformRolePermissions: Record<
  PlatformRole,
  ReadonlySet<PlatformPermission>
> = {
  admin: new Set(platformPermissions),
  relay_creator: new Set([
    "platform.bricks.add-catalog",
    "platform.bricks.add-custom",
  ]),
  user: new Set(),
}

export function instancePortsWritePermission(
  ports: ReadonlyArray<{ externalPort?: number; id?: string }>
): AccessPermission {
  return ports.some(
    (port) => port.id !== undefined && port.externalPort !== undefined
  )
    ? "instance.network.public-port.write"
    : "instance.network.write"
}

/** Resolved grants carry their expanded permissions; an empty list grants nothing. */
export function grantHasPermission(
  grant: { permissions: readonly string[] },
  permission: AccessPermission
): boolean {
  return grant.permissions.includes(permission)
}

export function platformRoleHasPermission(
  role: PlatformRole,
  permission: PlatformPermission
): boolean {
  return platformRolePermissions[role].has(permission)
}
