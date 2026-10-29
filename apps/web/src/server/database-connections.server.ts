import {
  relayManagedDatabaseSchema,
  type DatabaseConnectionMember,
  type RelayManagedDatabase,
} from "@workspace/contracts"

import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import {
  databaseForViewer,
  databaseRpc,
  requiredRelay,
} from "@/server/managed-database-access"

// What changing a member's connections takes of the member itself.
const memberPermission = {
  app: "app.manage",
  database: "database.network.write",
  instance: "instance.network.write",
} as const satisfies Record<DatabaseConnectionMember["kind"], AccessPermission>

/**
 * Connects a member to a database, or disconnects it: a game server, an App
 * (every service of it), or another database on the same Relay. It changes
 * both, so it needs the database's network permission and the member's
 * own. The Relay keeps the connection and checks the same of Hearth.
 */
export async function writeDatabaseConnection(
  user: AuthenticatedUser,
  input: {
    connected: boolean
    databaseId: string
    member: DatabaseConnectionMember
    relayId: string
  }
): Promise<RelayManagedDatabase> {
  const relay = await requiredRelay(input.relayId)
  if (input.member.kind === "database" && input.member.id === input.databaseId)
    throw new Error("A database can't connect to itself")
  await requireRelayPermission({
    databaseId: input.databaseId,
    permission: "database.network.write",
    relayId: relay.id,
    user,
  })
  const { id, kind } = input.member
  await requireRelayPermission({
    ...(kind === "instance"
      ? { instanceId: id }
      : kind === "app"
        ? { appId: id }
        : { databaseId: id }),
    permission: memberPermission[kind],
    relayId: relay.id,
    user,
  })
  if (input.member.kind === "app") {
    const { ensureAppDatabaseConnectionsImported } =
      await import("@/lib/app-database-connections.server")
    await ensureAppDatabaseConnectionsImported(relay)
  }
  const database = relayManagedDatabaseSchema.parse(
    await databaseRpc(
      relay,
      "database.network.write",
      {
        connected: input.connected,
        databaseId: input.databaseId,
        member: input.member,
      },
      30_000,
      user.id
    )
  )
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relay.id] },
    scope: { relayId: relay.id },
    topics: kind === "app" ? ["apps", "databases"] : ["databases"],
    type: "hearth.invalidate",
  })
  return databaseForViewer(user, relay.id, database)
}
