import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { ResourceNotFoundError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import type { AccessPermission } from "@/lib/permissions"

/** A tunnel as Hearth keeps it: where it runs, its tailnet, and its owner. */
export interface TunnelRecord {
  id: string
  ownerId: string | null
  relayId: string
  tailnetId: string
}

interface TunnelRow extends RowDataPacket {
  id: string
  owner_id: string | null
  relay_id: string
  tailnet_id: string
}

export const loadTunnelEffect = Effect.fn("tunnels.load")(function* (
  id: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<TunnelRow>(
    "tunnels.load",
    `SELECT id, relay_id, tailnet_id, owner_id
       FROM ${databaseTable("tunnel")}
      WHERE id = ?`,
    [id]
  )
  return row
    ? ({
        id: row.id,
        ownerId: row.owner_id,
        relayId: row.relay_id,
        tailnetId: row.tailnet_id,
      } satisfies TunnelRecord)
    : null
})

/** Every tunnel Hearth keeps. */
export const listTunnelRecordsEffect = Effect.fn("tunnels.list")(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<TunnelRow>(
    "tunnels.list",
    `SELECT id, relay_id, tailnet_id, owner_id
       FROM ${databaseTable("tunnel")}`
  )
  return rows.map(
    (row): TunnelRecord => ({
      id: row.id,
      ownerId: row.owner_id,
      relayId: row.relay_id,
      tailnetId: row.tailnet_id,
    })
  )
})

/**
 * Whoever may do `permission` to a tunnel: a platform administrator, its
 * owner, or whoever holds it on the tunnel's Relay, as a grant there reaches
 * everything on it. A tunnel can't be shared on its own yet (step 14 of
 * docs/instances.md). Returns the tunnel.
 */
export async function requireTunnelPermission(
  user: AuthenticatedUser,
  tunnelId: string,
  permission: AccessPermission
): Promise<TunnelRecord> {
  const tunnel = await runAppEffect("tunnels.load", loadTunnelEffect(tunnelId))
  if (!tunnel) {
    throw new ResourceNotFoundError({
      message: "Tunnel not found",
      resource: "tunnel",
    })
  }
  if (isPlatformAdmin(user) || tunnel.ownerId === user.id) return tunnel
  await requireRelayPermission({ permission, relayId: tunnel.relayId, user })
  return tunnel
}
