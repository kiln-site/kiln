import {
  accessPermissions,
  accessPermissionSupported,
  expandPermissionSelections,
  legacyAccessPermissions,
  type AccessPermission,
  type PermissionScopeType,
  type PermissionSelection,
} from "@workspace/contracts"

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

export const accessRoles = ["owner", "admin", "operator", "viewer"] as const
export type AccessRole = (typeof accessRoles)[number]

export function instancePortsWritePermission(
  ports: ReadonlyArray<{ externalPort?: number; id?: string }>
): AccessPermission {
  return ports.some(
    (port) => port.id !== undefined && port.externalPort !== undefined
  )
    ? "instance.network.public-port.write"
    : "instance.network.write"
}

const legacyRolePermissions: Record<
  AccessRole,
  ReadonlySet<AccessPermission>
> = {
  owner: new Set(legacyAccessPermissions),
  admin: new Set(
    legacyAccessPermissions.filter(
      (permission) => permission !== "relay.delete"
    )
  ),
  operator: new Set([
    "relay.read",
    "instance.read",
    "instance.console.read",
    "instance.console.write",
    "instance.files.read",
    "instance.files.write",
    "instance.power",
    "instance.logs.share",
    "instance.network.read",
    "instance.network.write",
    "instance.sftp.connect",
    "database.read",
    "database.credentials.read",
    "database.power",
    "database.network.read",
    "database.network.write",
    "database.dump.export",
    "database.dump.import",
    "backup.read",
    "backup.create",
    "backup.download",
    "backup.restore",
    "backup.delete",
    "schedule.read",
    "schedule.create",
    "schedule.execute",
    "schedule.update",
    "schedule.delete",
  ]),
  viewer: new Set([
    "relay.read",
    "instance.read",
    "instance.console.read",
    "instance.files.read",
    "instance.logs.share",
    "instance.network.read",
    "instance.sftp.connect",
    "database.read",
    "database.network.read",
    "backup.read",
    "backup.download",
    "schedule.read",
  ]),
}

/** Migration snapshots use individual selections, never dynamic ALL. */
export function legacyRolePermissionSelections(
  role: AccessRole,
  scopeType: PermissionScopeType
): PermissionSelection[] {
  const permissions = new Set(legacyRolePermissions[role])
  if (permissions.has("instance.files.write")) {
    permissions.add("instance.files.delete")
    permissions.add("instance.files.chmod")
  }
  if (permissions.has("access.manage")) permissions.add("preset.manage")
  return [...permissions].flatMap((key) =>
    accessPermissionSupported(key, scopeType)
      ? [{ kind: "permission" as const, key }]
      : []
  )
}

const rolePermissions = new Map<AccessRole, ReadonlySet<AccessPermission>>(
  accessRoles.map((role) => [
    role,
    new Set(
      expandPermissionSelections(
        legacyRolePermissionSelections(role, "relay"),
        "relay"
      )
    ),
  ])
)

/** Explicit permissions, including an empty list, are authoritative over legacy roles. */
export function grantHasPermission(
  grant: { role?: string; permissions?: readonly string[] },
  permission: AccessPermission
): boolean {
  if (Object.hasOwn(grant, "permissions"))
    return grant.permissions?.includes(permission) ?? false
  return (
    grant.role !== undefined &&
    isAccessRole(grant.role) &&
    roleHasPermission(grant.role, permission)
  )
}

export const accessRoleDetails: Record<
  AccessRole,
  { description: string; label: string }
> = {
  owner: {
    label: "Owner",
    description: "Full control, including access management and Relay removal.",
  },
  admin: {
    label: "Admin",
    description: "Manage people, Relay settings, and every instance operation.",
  },
  operator: {
    label: "Operator",
    description:
      "Operate servers and databases, including power, files, and private networks.",
  },
  viewer: {
    label: "Viewer",
    description:
      "Read-only access to assigned servers, databases, consoles, files, and logs.",
  },
}

export function roleHasPermission(
  role: AccessRole,
  permission: AccessPermission
): boolean {
  return rolePermissions.get(role)?.has(permission) ?? false
}

export function platformRoleHasPermission(
  role: PlatformRole,
  permission: PlatformPermission
): boolean {
  return platformRolePermissions[role].has(permission)
}

export function isAccessRole(value: string): value is AccessRole {
  return accessRoles.includes(value as AccessRole)
}
