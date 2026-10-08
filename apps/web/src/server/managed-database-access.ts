import type { RelayControlOperation } from "@workspace/contracts"

import { loadManagedDatabaseCredentialEffect } from "@/effect/managed-databases"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AccessPermission } from "@/lib/permissions"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
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
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === id
  )
  if (!relay) throw new Error("Relay not found")
  return relay
}

export async function databaseRpc(
  relay: PersistedRelay,
  operation: RelayControlOperation,
  payload: unknown,
  timeoutMs: number,
  subject?: string
): Promise<unknown> {
  const { relayRpc } = await import("@/lib/relay-connection")
  return relayRpc(relay, operation, payload, timeoutMs, subject)
}
