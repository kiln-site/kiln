import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { ResourceNotFoundError } from "@/effect/errors"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import type { AccessPermission } from "@/lib/permissions"

// Who may do what to a tunnel and its gateways. A tunnel is one instance:
// its owner and platform administrators change it and connect to it. A
// gateway is its tunnel's part on one Relay, which is no instance anyone
// opens: what every kind of instance has (power, deploying, logs, terminal)
// it takes as its tunnel's owner may, or as a grant on its Relay reaches
// everything there. A tunnel can't be shared on its own yet (step 14 of
// docs/instances.md).

/** A tunnel as Hearth keeps it, for deciding who may change it. */
export interface TunnelRecord {
  id: string
  name: string
  ownerId: string | null
}

/** A gateway as Hearth keeps it: its tunnel, where it runs, and its owner. */
export interface GatewayRecord {
  id: string
  /** Its tunnel's owner. */
  ownerId: string | null
  relayId: string
  tunnelId: string
}

interface GatewayRow extends RowDataPacket {
  id: string
  owner_id: string | null
  relay_id: string
  tunnel_id: string
}

const gatewaySelect = `SELECT gateway.id, gateway.relay_id, gateway.tunnel_id,
       tunnel.owner_id
  FROM ${databaseTable("tunnel_gateway")} gateway
  JOIN ${databaseTable("tunnel")} tunnel ON tunnel.id = gateway.tunnel_id`

const gatewayRecord = (row: GatewayRow): GatewayRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  relayId: row.relay_id,
  tunnelId: row.tunnel_id,
})

export const loadGatewayEffect = Effect.fn("gateways.load")(function* (
  id: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<GatewayRow>(
    "gateways.load",
    `${gatewaySelect} WHERE gateway.id = ?`,
    [id]
  )
  return row ? gatewayRecord(row) : null
})

/** A tunnel's gateways, or every gateway Hearth keeps. */
export const listGatewayRecordsEffect = Effect.fn("gateways.list")(function* (
  tunnelId?: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<GatewayRow>(
    "gateways.list",
    tunnelId === undefined
      ? gatewaySelect
      : `${gatewaySelect} WHERE gateway.tunnel_id = ?`,
    tunnelId === undefined ? [] : [tunnelId]
  )
  return rows.map(gatewayRecord)
})

export const loadTunnelRecordEffect = Effect.fn("tunnels.loadRecord")(
  function* (id: string) {
    const database = yield* Database
    const [row] = yield* database.queryRows<
      RowDataPacket & { id: string; name: string; owner_id: string | null }
    >(
      "tunnels.loadRecord",
      `SELECT id, name, owner_id FROM ${databaseTable("tunnel")} WHERE id = ?`,
      [id]
    )
    return row
      ? ({
          id: row.id,
          name: row.name,
          ownerId: row.owner_id,
        } satisfies TunnelRecord)
      : null
  }
)

const notFound = (resource: "gateway" | "tunnel") =>
  new ResourceNotFoundError({
    message: resource === "tunnel" ? "Tunnel not found" : "Gateway not found",
    resource,
  })

/**
 * Whoever may change a tunnel and connect things to it: a platform
 * administrator or its owner. Returns the tunnel.
 */
export async function requireTunnelManager(
  user: AuthenticatedUser,
  tunnelId: string
): Promise<TunnelRecord> {
  const tunnel = await runAppEffect(
    "tunnels.loadRecord",
    loadTunnelRecordEffect(tunnelId)
  )
  if (!tunnel) throw notFound("tunnel")
  if (isPlatformAdmin(user) || tunnel.ownerId === user.id) return tunnel
  throw new Error("Only the tunnel's owner can change it")
}

/**
 * Whoever may do `permission` to a gateway: a platform administrator, its
 * tunnel's owner, or whoever holds it on the gateway's Relay. Returns the
 * gateway.
 */
export async function requireGatewayPermission(
  user: AuthenticatedUser,
  gatewayId: string,
  permission: AccessPermission
): Promise<GatewayRecord> {
  const gateway = await runAppEffect(
    "gateways.load",
    loadGatewayEffect(gatewayId)
  )
  if (!gateway) throw notFound("gateway")
  if (isPlatformAdmin(user) || gateway.ownerId === user.id) return gateway
  await requireRelayPermission({ permission, relayId: gateway.relayId, user })
  return gateway
}

/**
 * The tunnel's gateways `permission` may be done to, each as
 * `requireGatewayPermission` decides. A tunnel the viewer reaches no
 * gateway of is refused, as one it can't see.
 */
export async function requireTunnelGateways(
  user: AuthenticatedUser,
  tunnelId: string,
  permission: AccessPermission
): Promise<Array<GatewayRecord>> {
  const gateways = await runAppEffect(
    "gateways.list",
    listGatewayRecordsEffect(tunnelId)
  )
  const allowed: Array<GatewayRecord> = []
  for (const gateway of gateways) {
    if (isPlatformAdmin(user) || gateway.ownerId === user.id) {
      allowed.push(gateway)
      continue
    }
    const held = await recoverPromise(
      async () => {
        await requireRelayPermission({
          permission,
          relayId: gateway.relayId,
          user,
        })
        return true
      },
      () => false
    )
    if (held) allowed.push(gateway)
  }
  if (allowed.length === 0 && gateways.length > 0) throw notFound("tunnel")
  return allowed
}
