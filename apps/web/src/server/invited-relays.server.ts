import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"
import type { RelayProcessMemory } from "@workspace/contracts"

import { Database } from "@/effect/database"
import { attachRelayOwnersEffect } from "@/effect/relay-owners"
import { databaseTable } from "@/lib/database-config"
import { relayConnectionNode } from "@/lib/relay-connection"

interface InvitedRelayRow extends RowDataPacket {
  created_by: string | null
  hostname: string
  id: string
  port: number
  use_tls: number
}

export interface InvitedRelay {
  hostname: string
  id: string
  // Undefined while this process has no connection to the Relay, null when
  // the Relay is too old to report it.
  memory: RelayProcessMemory | null | undefined
  ownerEmail: string | null
  ownerName: string | null
  port: number
  useTls: boolean
}

/**
 * Relays the user is invited to and hasn't answered, with what their Relays
 * table row shows. Every Relay grant includes `relay.read`, so the invitee
 * sees no more of the Relay than accepting would show them. With
 * `includeOwnerDetails`, they also see the owner's email, to know who they'd
 * be joining; without it, owners are named as for every non-admin.
 */
export const listInvitedRelaysEffect = Effect.fn(
  "ResourceInvitations.invitedRelays"
)(function* (userId: string, includeOwnerDetails: boolean) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<InvitedRelayRow>(
    "resource_invitations.invited_relays",
    `SELECT DISTINCT r.id, r.hostname, r.port, r.use_tls, r.created_by
       FROM ${databaseTable("invitation")} i
       JOIN ${databaseTable("access_grant")} g ON g.id = i.access_id
       JOIN ${databaseTable("relay")} r ON r.id = i.relay_id
      WHERE i.user_id = ? AND i.access_type = 'scoped'
        AND i.accepted_at IS NULL AND i.declined_at IS NULL
        AND i.revoked_at IS NULL AND i.cancelled_at IS NULL
        AND i.expires_at > ?
        AND g.state = 'pending' AND g.resource_type = 'relay'
        AND r.enabled = TRUE`,
    [userId, now]
  )
  const relays = yield* attachRelayOwnersEffect(
    rows.map((row) => ({
      createdBy: row.created_by,
      hostname: row.hostname,
      id: row.id,
      port: row.port,
      useTls: Boolean(row.use_tls),
    })),
    includeOwnerDetails
  )
  return relays.map((relay): InvitedRelay => ({
    hostname: relay.hostname,
    id: relay.id,
    memory: relayMemory(relay.id),
    ownerEmail: relay.ownerEmail,
    ownerName: relay.ownerName,
    port: relay.port,
    useTls: relay.useTls,
  }))
})

function relayMemory(relayId: string): RelayProcessMemory | null | undefined {
  const node = relayConnectionNode(relayId)
  return node ? (node.relayMemory ?? null) : undefined
}
