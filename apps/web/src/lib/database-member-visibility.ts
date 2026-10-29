import type {
  DatabaseConnectionMemberKind,
  RelayManagedDatabase,
} from "@workspace/contracts"

import type { AccessGrant } from "@/lib/access-control"
import type { AccessPermission } from "@/lib/permissions"
import { effectiveScopePermissions } from "@/lib/resource-permissions"

// What reading each kind of member takes, and the scope it's checked on.
const memberRead = {
  app: { permission: "app.read", resourceType: "app" },
  database: { permission: "database.read", resourceType: "database" },
  instance: { permission: "instance.read", resourceType: "instance" },
} as const satisfies Record<
  DatabaseConnectionMemberKind,
  {
    permission: AccessPermission
    resourceType: "app" | "database" | "instance"
  }
>

/**
 * The database as someone may see it: its network's members only with the
 * database's `database.network.read`, and of those, only the ones they may
 * read themselves. A member's ID and names say what runs on the Relay.
 */
export function withVisibleDatabaseMembers<
  Database extends Pick<RelayManagedDatabase, "id" | "members">,
>(
  database: Database,
  viewer: {
    readonly admin: boolean
    readonly grants: ReadonlyArray<AccessGrant>
    readonly relayId: string
  }
): Database {
  if (viewer.admin) return database
  const may = (
    permission: AccessPermission,
    resourceType: "app" | "database" | "instance",
    resourceId: string
  ) =>
    effectiveScopePermissions(viewer.grants, {
      relayId: viewer.relayId,
      resourceId,
      resourceType,
    }).has(permission)
  if (!may("database.network.read", "database", database.id))
    return { ...database, members: [] }
  return {
    ...database,
    members: database.members.filter((member) => {
      const { permission, resourceType } = memberRead[member.kind]
      return may(permission, resourceType, member.id)
    }),
  }
}
