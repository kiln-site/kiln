import {
  relayManagedDatabaseSchema,
  type DatabaseConnectionMember,
  type RelayManagedDatabase,
} from "@workspace/contracts"

import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { exclusive, partKey, relayKey, resourceKey } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"
import {
  databaseForViewer,
  databaseRpc,
  requiredRelay,
} from "@/server/managed-database-access"

// What changing a member's connections takes of the member itself.
export const memberPermission = {
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

interface DatabaseConnectionInput {
  connected: boolean
  databaseId: string
  member: DatabaseConnectionMember
  relayId: string
}

// Connects a game server, an App, or another database to the database, or
// disconnects it, from either end. It changes both, so it holds both and needs both ends'
// network permissions; an App's also holds its Relay's handover of Apps'
// database connections, which it may finish first.
export const connectDatabase = operation<DatabaseConnectionInput>()({
  name: "database.network.update",
  doing: "Changing this database's connections",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(async () => {
          await requireRelayPermission({
            databaseId: input.databaseId,
            permission: "database.network.write",
            relayId: input.relayId,
            user: person,
          })
          const { id, kind } = input.member
          await requireRelayPermission({
            ...(kind === "instance"
              ? { instanceId: id }
              : kind === "app"
                ? { appId: id }
                : { databaseId: id }),
            permission: memberPermission[kind],
            relayId: input.relayId,
            user: person,
          })
        })
      )
    ),
  locks: ({ input }) => [
    exclusive(resourceKey("database", input.relayId, input.databaseId)),
    exclusive(resourceKey(input.member.kind, input.relayId, input.member.id)),
    ...(input.member.kind === "app"
      ? [exclusive(partKey(relayKey(input.relayId), "database-connections"))]
      : []),
  ],
  run: ({ context: user, input }) =>
    promiseEffect(() => writeDatabaseConnection(user, input)),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
})
