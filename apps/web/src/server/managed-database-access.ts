import {
  databaseEngineSupportsLogicalBackups,
  type DatabaseEngine,
  type RelayControlOperation,
  type RelayManagedDatabase,
} from "@workspace/contracts"

import { loadManagedDatabaseCredentialEffect } from "@/effect/managed-databases"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { withVisibleDatabaseMembers } from "@/lib/database-member-visibility"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { activeRelay } from "@/lib/relay-registry"
import { requireEligibleResourceUser } from "@/server/auth"

// Server-only helpers for managed database requests. They live apart from
// the server functions in databases.ts: plain exports there would keep these
// server imports in the client bundle.

export const databaseEngineDetails = {
  mariadb: {
    image: "mariadb:11.8",
    internalPort: 3306,
    supportsImportExport: databaseEngineSupportsLogicalBackups("mariadb"),
  },
  mysql: {
    image: "mysql:8.4",
    internalPort: 3306,
    supportsImportExport: databaseEngineSupportsLogicalBackups("mysql"),
  },
  postgres: {
    image: "postgres:17",
    internalPort: 5432,
    supportsImportExport: databaseEngineSupportsLogicalBackups("postgres"),
  },
  redis: {
    image: "redis:8",
    internalPort: 6379,
    supportsImportExport: databaseEngineSupportsLogicalBackups("redis"),
  },
  valkey: {
    image: "valkey/valkey:8",
    internalPort: 6379,
    supportsImportExport: databaseEngineSupportsLogicalBackups("valkey"),
  },
} satisfies Record<
  DatabaseEngine,
  { image: string; internalPort: number; supportsImportExport: boolean }
>

export async function authorizedDatabase(
  data: { databaseId: string; relayId: string },
  permission: AccessPermission
) {
  const user = await requireEligibleResourceUser()
  const relay = await requiredRelay(data.relayId)
  await requireRelayPermission({
    databaseId: data.databaseId,
    permission,
    relayId: data.relayId,
    user,
  })
  return { relay, user }
}

export async function requiredCredential(relayId: string, databaseId: string) {
  const credential = await runAppEffect(
    "managedDatabases.credential.internal",
    loadManagedDatabaseCredentialEffect(relayId, databaseId)
  )
  if (!credential) throw new Error("Database credentials are unavailable")
  return credential
}

export async function requiredRelay(id: string): Promise<PersistedRelay> {
  return activeRelay(id)
}

export async function databaseRpc(
  relay: PersistedRelay,
  operation: RelayControlOperation,
  payload: unknown,
  timeoutMs: number,
  subject?: string,
  signal?: AbortSignal
): Promise<unknown> {
  const { relayRpc } = await import("@/lib/relay-connection")
  return relayRpc(relay, operation, payload, timeoutMs, subject, signal)
}

/** The database as the user may see it: only members they may read. */
export async function databaseForViewer(
  user: AuthenticatedUser,
  relayId: string,
  database: RelayManagedDatabase
): Promise<RelayManagedDatabase> {
  const admin = isPlatformAdmin(user)
  return withVisibleDatabaseMembers(database, {
    admin,
    grants: admin ? [] : await listUserGrants(user.id, relayId),
    relayId,
  })
}

export function publishDatabaseChange(
  relayId: string,
  directoryChanged: boolean
): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: directoryChanged
      ? ["databases", "database-directory"]
      : ["databases"],
    type: "hearth.invalidate",
  })
}
