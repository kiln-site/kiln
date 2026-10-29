import type {
  RelayControlOperation,
  RelayManagedDatabase,
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
import type { PersistedRelay } from "@/lib/relay-registry"
import { activeRelay } from "@/lib/relay-registry"
import { requireEligibleResourceUser } from "@/server/auth"

// Server-only helpers for managed database requests. They live apart from
// the server functions in databases.ts: plain exports there would keep these
// server imports in the client bundle.

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
