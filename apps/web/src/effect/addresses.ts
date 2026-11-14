import { randomUUID } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { DomainConfigurationError } from "@/effect/errors"
import {
  claimHostnamesEffect,
  moveHostnameClaimsEffect,
  releaseUnusedHostnamesEffect,
  type HostnameOwner,
} from "@/effect/hostname-claims"
import { databaseTable } from "@/lib/database-config"

// One row per hostname an instance holds, with the one address record Kiln
// keeps for it. What the name is used for is the only difference between
// rows: through Traefik for web routes (`routed`), where the record points
// at the Relay and may go through Cloudflare's proxy, or straight to a game
// server's game port (`game`), where it points at the server's public host,
// never proxied, with an SRV record when the game looks one up. One name
// can be used both ways at once: the record is then the game port's.
const addressTable = databaseTable("instance_address")
const optOutTable = databaseTable("instance_domain_opt_out")

export type WebHostnameResourceType = HostnameOwner["resourceType"]
export type WebHostnameResource = HostnameOwner

/**
 * The address record Cloudflare already had under a hostname, that Kiln
 * didn't make, as Kiln last saw it.
 */
export interface ExistingWebRecord {
  content: string
  id: string
  proxied: boolean
  type: "A" | "AAAA" | "CNAME"
}

/** A hostname an instance holds, and the records Kiln keeps for it. */
export interface Address {
  /** The connection whose token manages its zone. */
  connectionId: string
  createdAt: number
  /**
   * While `external`, the address record Cloudflare had under the name, as
   * Kiln last saw it; null when it had none, only other kinds of record.
   */
  existingRecord: ExistingWebRecord | null
  /** A game server's address: its record points at its game port. */
  game: boolean
  /** Made by Kiln as an App's address, kept without a route. */
  generated: boolean
  hostname: string
  id: string
  lastError: string | null
  /**
   * The name a rename is moving it to, held alongside its current one until
   * Cloudflare has it; null when no rename is under way.
   */
  next: { hostname: string; vanityDomain: string } | null
  /** The one Hearth advertises as its instance's connect address. */
  primary: boolean
  /** Whether Kiln keeps its record behind Cloudflare's proxy. */
  proxied: boolean
  /** The game port its SRV record names, for a game server's address. */
  publicPort: number | null
  recordId: string | null
  recordType: "A" | "AAAA" | "CNAME" | null
  relayId: string
  resourceId: string
  resourceType: WebHostnameResourceType
  /** Used by its instance's web routes as last saved. */
  routed: boolean
  srvProtocol: "tcp" | "udp" | null
  srvRecordId: string | null
  srvService: string | null
  /**
   * `external` when Cloudflare already had a record Kiln didn't make; Kiln
   * leaves it alone and checks again on the next sync.
   */
  status: "active" | "error" | "external" | "pending" | "removing"
  supportsSrv: boolean
  /**
   * What its record points at: its game server's public host, or the
   * Relay's for a name only web routes use.
   */
  target: string | null
  /** The vanity domain it's named under, when it is. */
  vanityDomain: string | null
  /** The zone its records go in; null only for one older than that. */
  zoneId: string | null
}

/**
 * A hostname as an instance's web routes see it. A game server's own
 * address reads as in step with no record of its own: its record is the
 * game port's, and how that is doing shows with the address.
 */
export type WebHostname = Address

/** A game server's address: the name players join it at, and its records. */
export interface InstanceDomainAssignment {
  addressRecordId: string | null
  addressRecordType: "A" | "AAAA" | "CNAME" | null
  domain: string
  id: string
  instanceId: string
  integrationId: string
  lastError: string | null
  /**
   * The name a rename is moving it to, held alongside its current one until
   * Cloudflare has it; null when no rename is under way.
   */
  next: { domain: string; vanityLabel: string } | null
  /** The domain Hearth advertises as the game server's connect address. */
  primary: boolean
  publicHost: string
  publicPort: number
  relayId: string
  srvProtocol: "tcp" | "udp" | null
  srvRecordId: string | null
  srvService: string | null
  status: "active" | "error" | "pending" | "removing"
  supportsSrv: boolean
  vanityLabel: string
  /** Null only if its row is older than rows keeping their zone. */
  zoneId: string | null
}

/**
 * Whether a hostname's record goes through Cloudflare's proxy, as Kiln
 * keeps it or last saw someone else's; null when that's unknown. A game
 * server's own address never does: players connect to it directly.
 */
export function webHostnameProxied(
  row: Pick<Address, "existingRecord" | "game" | "proxied" | "status">
): boolean | null {
  if (row.game) return false
  if (row.status === "external") return row.existingRecord?.proxied ?? null
  return row.proxied
}

interface AddressRow extends RowDataPacket {
  created_at: number
  existing_record_content: string | null
  existing_record_id: string | null
  existing_record_proxied: boolean | number | null
  existing_record_type: "A" | "AAAA" | "CNAME" | null
  game: boolean | number
  hostname: string
  id: string
  integration_id: string
  is_generated: boolean | number
  is_primary: boolean | number
  last_error: string | null
  next_hostname: string | null
  next_vanity_domain: string | null
  proxied: boolean | number
  public_port: number | null
  record_id: string | null
  record_type: "A" | "AAAA" | "CNAME" | null
  relay_id: string
  resource_id: string
  resource_type: WebHostnameResourceType
  routed: boolean | number
  srv_protocol: "tcp" | "udp" | null
  srv_record_id: string | null
  srv_service: string | null
  status: Address["status"]
  supports_srv: boolean | number
  target: string | null
  vanity_domain: string | null
  zone_id: string | null
}

const addressSelect = `SELECT id, hostname, relay_id, resource_type,
       resource_id, integration_id, zone_id, vanity_domain, game, routed,
       is_generated, is_primary, next_hostname, next_vanity_domain,
       public_port, supports_srv, srv_service, srv_protocol, srv_record_id,
       record_id, record_type, target, proxied, existing_record_id,
       existing_record_type, existing_record_content,
       existing_record_proxied, status, last_error, created_at
  FROM ${addressTable}`

const ofResource = "relay_id = ? AND resource_type = ? AND resource_id = ?"
const resourceValues = (resource: HostnameOwner) => [
  resource.relayId,
  resource.resourceType,
  resource.resourceId,
]

export const loadAddressEffect = Effect.fn("addresses.load")(function* (
  id: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<AddressRow>(
    "addresses.load",
    `${addressSelect} WHERE id = ? LIMIT 1`,
    [id]
  )
  return row ? address(row) : null
})

/** An instance's addresses: its primary first, then by name. */
export const listResourceAddressesEffect = Effect.fn("addresses.resource")(
  function* (resource: HostnameOwner) {
    const database = yield* Database
    const rows = yield* database.queryRows<AddressRow>(
      "addresses.resource",
      `${addressSelect}
        WHERE ${ofResource}
        ORDER BY is_primary DESC, is_generated DESC, created_at, hostname`,
      resourceValues(resource)
    )
    return rows.map(address)
  }
)

/** Every address, or one Relay's or one connection's, by name. */
export const listAddressesEffect = Effect.fn("addresses.list")(
  function* (filter?: { connectionId?: string; relayId?: string }) {
    const database = yield* Database
    const conditions: Array<string> = []
    const values: Array<string> = []
    if (filter?.relayId) {
      conditions.push("relay_id = ?")
      values.push(filter.relayId)
    }
    if (filter?.connectionId) {
      conditions.push("integration_id = ?")
      values.push(filter.connectionId)
    }
    const rows = yield* database.queryRows<AddressRow>(
      "addresses.list",
      `${addressSelect}
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY hostname`,
      values
    )
    return rows.map(address)
  }
)

// The two shapes the pages read an instance's names in: the hostnames its
// web routes answer on, and a game server's addresses.

const usedByWeb = (row: Address) => !row.game || row.routed

/** A game server's address as its web routes see it: the game port's. */
function webHostname(row: Address): WebHostname {
  return row.game
    ? {
        ...row,
        existingRecord: null,
        generated: false,
        lastError: null,
        proxied: false,
        recordId: null,
        recordType: null,
        status: "active",
        target: null,
      }
    : row
}

export const loadWebHostnameEffect = Effect.fn("webHostnames.load")(function* (
  id: string
) {
  const row = yield* loadAddressEffect(id)
  return row && usedByWeb(row) ? webHostname(row) : null
})

export const loadWebHostnameByNameEffect = Effect.fn("webHostnames.byName")(
  function* (hostname: string) {
    const database = yield* Database
    const [found] = yield* database.queryRows<AddressRow>(
      "webHostnames.byName",
      `${addressSelect} WHERE hostname = ? LIMIT 1`,
      [hostname]
    )
    const row = found ? address(found) : null
    return row && usedByWeb(row) ? webHostname(row) : null
  }
)

/** The hostnames an instance's web routes may answer on, generated first. */
export const listResourceWebHostnamesEffect = Effect.fn(
  "webHostnames.resource"
)(function* (resource: HostnameOwner) {
  const rows = yield* listResourceAddressesEffect(resource)
  return rows
    .filter(usedByWeb)
    .map(webHostname)
    .sort(
      (left, right) =>
        Number(right.generated) - Number(left.generated) ||
        left.hostname.localeCompare(right.hostname)
    )
})

/** Every such hostname, or one Relay's or one connection's. */
export const listWebHostnamesEffect = Effect.fn("webHostnames.list")(
  function* (filter?: { connectionId?: string; relayId?: string }) {
    const rows = yield* listAddressesEffect(filter)
    return rows.filter(usedByWeb).map(webHostname)
  }
)

/** A game server's addresses, primary first. */
export const loadInstanceDomainAssignmentsForInstanceEffect = Effect.fn(
  "domains.assignments.instance"
)(function* (relayId: string, instanceId: string) {
  const rows = yield* listResourceAddressesEffect({
    relayId,
    resourceId: instanceId,
    resourceType: "instance",
  })
  return rows.filter((row) => row.game).map(assignmentOf)
})

/** Active game addresses, each game server's primary before its others. */
export const loadActiveInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.active"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<AddressRow>(
    "domains.assignments.active",
    `${addressSelect}
      WHERE game = 1 AND status = 'active'
      ORDER BY is_primary DESC, created_at, id`
  )
  return rows.map((row) => assignmentOf(address(row)))
})

export const loadInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.all"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<AddressRow>(
    "domains.assignments.all",
    `${addressSelect}
      WHERE game = 1
      ORDER BY vanity_domain, hostname`
  )
  return rows.map((row) => assignmentOf(address(row)))
})

/**
 * Holds a hostname for an instance before its record exists, claiming it in
 * the same transaction. A hostname another instance holds fails rather than
 * being taken over.
 */
export const insertWebHostnameEffect = Effect.fn("addresses.insert")(function* (
  input: HostnameOwner & {
    connectionId: string
    generated: boolean
    hostname: string
    id: string
    vanityDomain: string | null
    zoneId: string
  }
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("addresses.insert", () =>
    Effect.gen(function* () {
      // A connection removed since its zone was resolved takes no new
      // hostnames; removing one waits for this insert, then deletes it.
      const connections = yield* database.queryRows<RowDataPacket>(
        "addresses.insert",
        `SELECT 1 FROM ${databaseTable("domain_integration")}
            WHERE id = ?
            LOCK IN SHARE MODE`,
        [input.connectionId]
      )
      if (connections.length === 0) {
        return yield* DomainConfigurationError.make({
          message: "The Cloudflare connection for this hostname was removed",
        })
      }
      yield* claimHostnamesEffect(input, [input.hostname])
      yield* database.execute(
        "addresses.insert",
        `INSERT INTO ${addressTable}
             (id, hostname, relay_id, resource_type, resource_id,
              integration_id, zone_id, vanity_domain, is_generated, status,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          input.id,
          input.hostname.toLowerCase(),
          ...resourceValues(input),
          input.connectionId,
          input.zoneId,
          input.vanityDomain,
          input.generated,
          now,
          now,
        ]
      )
    })
  )
})

/** Where a game server is reached: its public host and game port. */
export interface GameEndpoint {
  publicHost: string
  publicPort: number
  /** How its game looks it up by name, when it does. */
  srv: { protocol: "tcp" | "udp"; service: string } | null
}

/**
 * Holds a name for a game server's new address before its records exist,
 * claiming it in the same transaction, so a name another instance holds
 * fails rather than being taken over.
 */
export const insertInstanceDomainAssignmentEffect = Effect.fn(
  "addresses.insertGame"
)(function* (input: {
  /** The connection whose token manages the domain's zone. */
  connectionId: string
  domain: string
  endpoint: GameEndpoint
  hostname: string
  id: string
  instanceId: string
  primary: boolean
  relayId: string
  /** The zone its records go in, as the domain was loaded. */
  zoneId: string
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("addresses.insertGame", () =>
    Effect.gen(function* () {
      const owner = {
        relayId: input.relayId,
        resourceId: input.instanceId,
        resourceType: "instance" as const,
      }
      yield* claimHostnamesEffect(owner, [input.hostname])
      // Only into an enabled domain still in the zone its records will go
      // in: a save that removes or moves it either waits for this row or
      // this insert finds nothing.
      const result = yield* database.execute(
        "addresses.insertGame",
        `INSERT INTO ${addressTable}
           (id, hostname, relay_id, resource_type, resource_id,
            integration_id, zone_id, vanity_domain, game, is_primary, target,
            public_port, supports_srv, srv_service, srv_protocol, status,
            last_error, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?,
                'pending', NULL, ?, ?
           FROM ${databaseTable("domain_zone")}
          WHERE domain = ? AND zone_id = ? AND integration_id = ?
            AND enabled = 1`,
        [
          input.id,
          input.hostname.toLowerCase(),
          ...resourceValues(owner),
          input.connectionId,
          input.zoneId,
          input.domain,
          input.primary,
          input.endpoint.publicHost,
          input.endpoint.publicPort,
          input.endpoint.srv !== null,
          input.endpoint.srv?.service ?? null,
          input.endpoint.srv?.protocol ?? null,
          now,
          now,
          input.domain,
          input.zoneId,
          input.connectionId,
        ]
      )
      if (result.affectedRows === 0) {
        return yield* DomainConfigurationError.make({
          message: `${input.domain} isn't taking new game server domains`,
        })
      }
    })
  )
})

/**
 * Gives an address whose records were released a new name, claiming it and
 * letting go of the old ones in the same transaction, which also finishes
 * any rename it was in. Locks its domain's row before the address's, the
 * order a save takes them in, and only while the domain is still in the
 * zone, and on the connection, its records will go in. The connection moves
 * with it, so later syncs and the delete use the token that made them.
 */
export const reserveInstanceDomainAssignmentEffect = Effect.fn(
  "addresses.reserve"
)(function* (input: {
  connectionId: string
  domain: string
  hostname: string
  id: string
  zoneId: string
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("addresses.reserve", (transaction) =>
    Effect.gen(function* () {
      const zones = yield* transaction.queryRows<RowDataPacket>(
        `SELECT 1 FROM ${databaseTable("domain_zone")}
          WHERE domain = ? AND zone_id = ? AND integration_id = ?
          LOCK IN SHARE MODE`,
        [input.domain, input.zoneId, input.connectionId]
      )
      if (zones.length === 0) {
        return yield* DomainConfigurationError.make({
          message: `${input.domain} is no longer a configured vanity domain`,
        })
      }
      const current = yield* lockAddressEffect(input.id)
      if (current.status === "removing") {
        return yield* DomainConfigurationError.make({
          message: "The domain is being deleted",
        })
      }
      const hostname = input.hostname.toLowerCase()
      yield* claimHostnamesEffect(current, [hostname])
      const moved = hostname !== current.hostname
      const routedThere = moved
        ? yield* takeRouteNameEffect(current, hostname)
        : current.routed
      yield* transaction.execute(
        `UPDATE ${addressTable}
            SET hostname = ?, vanity_domain = ?, next_hostname = NULL,
                next_vanity_domain = NULL, integration_id = ?, zone_id = ?,
                record_id = NULL, record_type = NULL, srv_record_id = NULL,
                routed = ?, status = 'pending', last_error = NULL,
                updated_at = ?
          WHERE id = ?`,
        [
          hostname,
          input.domain,
          input.connectionId,
          input.zoneId,
          routedThere,
          now,
          input.id,
        ]
      )
      if (moved) yield* leaveToRoutesEffect(current, now)
      yield* releaseUnusedHostnamesEffect(
        current,
        addressHostnames(current).filter((name) => name !== hostname)
      )
    })
  )
})

/**
 * Starts renaming an address: claims the new name and records it beside the
 * current one, which stays held until Cloudflare has the new name, so a
 * rename cut short by a failure or a restart can always be finished. One
 * rename at a time: an unfinished one must finish first, so no name its
 * records may be under is let go early. Only onto a domain still
 * configured; removing it waits for this, then sees the rename.
 */
export const beginInstanceDomainRenameEffect = Effect.fn(
  "addresses.beginRename"
)(function* (input: { domain: string; id: string; vanityLabel: string }) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("addresses.beginRename", () =>
    Effect.gen(function* () {
      const zones = yield* database.queryRows<RowDataPacket>(
        "addresses.beginRename",
        `SELECT 1 FROM ${databaseTable("domain_zone")}
          WHERE domain = ?
          LOCK IN SHARE MODE`,
        [input.domain]
      )
      if (zones.length === 0) {
        return yield* DomainConfigurationError.make({
          message: `${input.domain} is no longer a configured vanity domain`,
        })
      }
      const current = yield* lockAddressEffect(input.id)
      const hostname = `${input.vanityLabel}.${input.domain}`.toLowerCase()
      if (current.next && current.next.hostname !== hostname) {
        return yield* DomainConfigurationError.make({
          message: `Finish renaming to ${current.next.hostname} first`,
        })
      }
      yield* claimHostnamesEffect(current, [hostname])
      yield* database.execute(
        "addresses.beginRename",
        `UPDATE ${addressTable}
            SET next_hostname = ?, next_vanity_domain = ?, attempts = 0,
                next_attempt_at = NULL, updated_at = ?
          WHERE id = ?`,
        [hostname, input.domain, now, input.id]
      )
    })
  )
})

/**
 * Takes a renamed address's new name as its own once Cloudflare's records
 * have it, letting go of the old one. A web route on the old name keeps it,
 * as a hostname of its own.
 */
export const finishInstanceDomainRenameEffect = Effect.fn(
  "addresses.finishRename"
)(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("addresses.finishRename", () =>
    Effect.gen(function* () {
      const current = yield* lockAddressEffect(id)
      if (!current.next) return
      const routedThere = yield* takeRouteNameEffect(
        current,
        current.next.hostname
      )
      yield* database.execute(
        "addresses.finishRename",
        `UPDATE ${addressTable}
            SET hostname = next_hostname, vanity_domain = next_vanity_domain,
                next_hostname = NULL, next_vanity_domain = NULL, routed = ?,
                last_error = NULL, attempts = 0, next_attempt_at = NULL,
                updated_at = ?
          WHERE id = ?`,
        [routedThere, now, id]
      )
      yield* leaveToRoutesEffect(current, now)
      yield* releaseUnusedHostnamesEffect(current, [current.hostname])
    })
  )
})

/**
 * A web route of the address's instance may already answer on the name the
 * address is taking, held by a row of its own meanwhile: a row can't be
 * moved onto a name another holds. They become one row, the address's.
 * Reports whether routes use the name.
 */
const takeRouteNameEffect = Effect.fnUntraced(function* (
  owner: HostnameOwner,
  hostname: string
) {
  const database = yield* Database
  const [held] = yield* database.queryRows<
    RowDataPacket & { id: string; routed: boolean | number }
  >(
    "addresses.takeRouteName",
    `SELECT id, routed FROM ${addressTable}
      WHERE hostname = ? AND game = 0 AND ${ofResource}
      FOR UPDATE`,
    [hostname, ...resourceValues(owner)]
  )
  if (!held) return false
  yield* database.execute(
    "addresses.takeRouteName",
    `DELETE FROM ${addressTable} WHERE id = ?`,
    [held.id]
  )
  return Boolean(held.routed)
})

/**
 * Leaves the name an address moved off to the web routes that answer on it,
 * as a hostname of their own, with a record to make. Run it once the
 * address has its new name, in the same transaction. A name no route uses
 * is simply let go.
 */
const leaveToRoutesEffect = Effect.fnUntraced(function* (
  previous: Address,
  now: number
) {
  if (!previous.routed || !previous.zoneId) return
  const database = yield* Database
  yield* database.execute(
    "addresses.leaveToRoutes",
    `INSERT INTO ${addressTable}
       (id, hostname, relay_id, resource_type, resource_id, integration_id,
        zone_id, vanity_domain, routed, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
    [
      randomUUID(),
      previous.hostname,
      ...resourceValues(previous),
      previous.connectionId,
      previous.zoneId,
      previous.vanityDomain,
      now,
      now,
    ]
  )
})

const lockAddressEffect = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database
  const [row] = yield* database.queryRows<AddressRow>(
    "addresses.lock",
    `${addressSelect} WHERE id = ? FOR UPDATE`,
    [id]
  )
  if (!row) {
    return yield* DomainConfigurationError.make({
      message: "The domain was removed",
    })
  }
  return address(row)
})

/**
 * Records the address record Kiln made or pointed for a hostname, at once,
 * so a step that fails after it leaves no record Kiln lost track of. False
 * when the hostname was let go or marked for deletion meanwhile, as
 * removing its Relay does, so the caller deletes a record it made.
 */
export const saveAddressRecordEffect = Effect.fn("addresses.saveRecord")(
  function* (input: {
    id: string
    recordId: string
    recordType: "A" | "AAAA" | "CNAME"
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "addresses.saveRecord",
      `UPDATE ${addressTable}
          SET record_id = ?, record_type = ?, updated_at = ?
        WHERE id = ? AND status <> 'removing'`,
      [input.recordId, input.recordType, now, input.id]
    )
    return result.affectedRows > 0
  }
)

/**
 * Marks a hostname in step: where its records now point, with the SRV
 * record it has, if it has one.
 */
export const activateAddressEffect = Effect.fn("addresses.activate")(
  function* (input: {
    id: string
    publicPort: number | null
    srv: GameEndpoint["srv"]
    srvRecordId: string | null
    target: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.activate",
      `UPDATE ${addressTable}
          SET target = ?, public_port = ?, supports_srv = ?, srv_service = ?,
              srv_protocol = ?, srv_record_id = ?, status = 'active',
              last_error = NULL, attempts = 0, next_attempt_at = NULL,
              existing_record_id = NULL, existing_record_type = NULL,
              existing_record_content = NULL, existing_record_proxied = NULL,
              updated_at = ?
        WHERE id = ? AND status <> 'removing'`,
      [
        input.target,
        input.publicPort,
        input.srv !== null,
        input.srv?.service ?? null,
        input.srv?.protocol ?? null,
        input.srvRecordId,
        now,
        input.id,
      ]
    )
  }
)

/** Clears the error of an address found in step again. */
export const clearAddressErrorEffect = Effect.fn("addresses.clearError")(
  function* (id: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.clearError",
      `UPDATE ${addressTable}
          SET last_error = NULL, attempts = 0, next_attempt_at = NULL,
              updated_at = ?
        WHERE id = ? AND status = 'active' AND next_hostname IS NULL`,
      [now, id]
    )
  }
)

/**
 * Says why a hostname's records aren't in step. A game server's address
 * that had its records keeps them, and stays the server's address, while
 * they don't follow it; one being deleted stays that. Anything else is
 * failing until an attempt succeeds.
 */
export const recordAddressErrorEffect = Effect.fn("addresses.recordError")(
  function* (id: string, message: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.recordError",
      `UPDATE ${addressTable}
          SET status = CASE
                WHEN status = 'removing' THEN 'removing'
                WHEN game = 1 AND status = 'active' THEN 'active'
                ELSE 'error' END,
              last_error = ?, updated_at = ?
        WHERE id = ?`,
      [message.slice(0, 512), now, id]
    )
  }
)

/** Has a hostname's records made or checked again, as a save or Sync asks. */
export const setAddressPendingEffect = Effect.fn("addresses.pending")(
  function* (id: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.pending",
      `UPDATE ${addressTable}
          SET status = 'pending', last_error = NULL, updated_at = ?
        WHERE id = ? AND status <> 'removing'`,
      [now, id]
    )
  }
)

/**
 * Leaves a hostname to the record Cloudflare already had under its name,
 * remembering that record's address, if it has one, for its owner to see
 * and take over.
 */
export const markWebHostnameExternalEffect = Effect.fn(
  "addresses.markExternal"
)(function* (id: string, message: string, existing: ExistingWebRecord | null) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "addresses.markExternal",
    `UPDATE ${addressTable}
        SET status = 'external', last_error = ?, existing_record_id = ?,
            existing_record_type = ?, existing_record_content = ?,
            existing_record_proxied = ?, updated_at = ?
      WHERE id = ? AND status <> 'removing'`,
    [
      message.slice(0, 512),
      existing?.id ?? null,
      existing?.type ?? null,
      existing?.content.slice(0, 255) ?? null,
      existing ? existing.proxied : null,
      now,
      id,
    ]
  )
})

/**
 * Makes an existing record Kiln's own: the hostname keeps it as the record
 * it made, so the next sync points it where the hostname points, marks it
 * as Kiln's, and deleting the hostname deletes it. Only while the hostname
 * is still left to that record; reports whether it was.
 */
export const adoptWebHostnameRecordEffect = Effect.fn("addresses.adopt")(
  function* (input: {
    id: string
    proxied: boolean
    recordId: string
    recordType: "A" | "AAAA" | "CNAME"
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "addresses.adopt",
      `UPDATE ${addressTable}
          SET record_id = ?, record_type = ?, target = NULL, proxied = ?,
              status = 'pending', last_error = NULL, attempts = 0,
              next_attempt_at = NULL, existing_record_id = NULL,
              existing_record_type = NULL, existing_record_content = NULL,
              existing_record_proxied = NULL, updated_at = ?
        WHERE id = ? AND status = 'external'`,
      [input.recordId, input.recordType, input.proxied, now, input.id]
    )
    return result.affectedRows > 0
  }
)

/**
 * Sets whether an instance's hostnames go through Cloudflare's proxy. A
 * record Kiln keeps that changes waits for the next sync, as a new one
 * does. A game server's address never does.
 */
export const setWebHostnamesProxiedEffect = Effect.fn("addresses.proxied")(
  function* (
    resource: HostnameOwner,
    hostnames: ReadonlyArray<string>,
    proxied: boolean
  ) {
    const names = [...new Set(hostnames.map((name) => name.toLowerCase()))]
    if (names.length === 0) return
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.proxied",
      `UPDATE ${addressTable}
          SET proxied = ?,
              status = IF(status = 'active' AND record_id IS NOT NULL,
                'pending', status),
              attempts = 0, next_attempt_at = NULL, updated_at = ?
        WHERE ${ofResource}
          AND game = 0 AND proxied <> ?
          AND hostname IN (${names.map(() => "?").join(", ")})`,
      [proxied, now, ...resourceValues(resource), proxied, ...names]
    )
  }
)

/** Records which of an instance's hostnames its routes use, as just saved. */
export const setWebHostnamesRoutedEffect = Effect.fn("addresses.routed")(
  function* (resource: HostnameOwner, hostnames: ReadonlyArray<string>) {
    const database = yield* Database
    const names = [...new Set(hostnames.map((name) => name.toLowerCase()))]
    yield* database.execute(
      "addresses.routed",
      `UPDATE ${addressTable}
          SET routed = ${
            names.length > 0
              ? `hostname IN (${names.map(() => "?").join(", ")})`
              : "0"
          }
        WHERE ${ofResource}`,
      [...names, ...resourceValues(resource)]
    )
  }
)

const removingSet = `status = 'removing', is_primary = 0, last_error = NULL,
  attempts = 0, next_attempt_at = NULL`

/**
 * Marks hostnames for deletion. Each keeps its row, its claim, and records
 * Kiln couldn't delete yet, until a delete finishes; nothing re-creates it,
 * and the DNS worker finishes any a request doesn't.
 */
export const markAddressesRemovingEffect = Effect.fn("addresses.markRemoving")(
  function* (ids: ReadonlyArray<string>) {
    if (ids.length === 0) return
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.markRemoving",
      `UPDATE ${addressTable}
          SET ${removingSet}, updated_at = ?
        WHERE id IN (${ids.map(() => "?").join(", ")})`,
      [now, ...ids]
    )
  }
)

/** Marks every hostname of a deleted instance for deletion. */
export const markResourceAddressesRemovingEffect = Effect.fn(
  "addresses.markResourceRemoving"
)(function* (resource: HostnameOwner) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "addresses.markResourceRemoving",
    `UPDATE ${addressTable}
        SET ${removingSet}, updated_at = ?
      WHERE ${ofResource}`,
    [now, ...resourceValues(resource)]
  )
})

/**
 * Marks every hostname on a removed Relay for deletion, before their
 * records are deleted, so any delete that fails is finished by the DNS
 * worker. Its game servers' opt-outs go with it.
 */
export const markRelayAddressesRemovingEffect = Effect.fn(
  "addresses.markRelayRemoving"
)(function* (relayId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "addresses.markRelayRemoving",
    `UPDATE ${addressTable}
        SET ${removingSet}, updated_at = ?
      WHERE relay_id = ?`,
    [now, relayId]
  )
  yield* database.execute(
    "addresses.optOuts.deleteRelay",
    `DELETE FROM ${optOutTable} WHERE relay_id = ?`,
    [relayId]
  )
})

/**
 * Forgets every hostname on a Relay without touching Cloudflare, as
 * removing it and keeping its records does, and lets go of their names.
 */
export const deleteRelayAddressesEffect = Effect.fn("addresses.deleteRelay")(
  function* (relayId: string) {
    const database = yield* Database
    yield* database.transaction("addresses.deleteRelay", () =>
      Effect.gen(function* () {
        yield* database.execute(
          "addresses.deleteRelay",
          `DELETE FROM ${addressTable} WHERE relay_id = ?`,
          [relayId]
        )
        yield* releaseUnusedHostnamesEffect({ relayId })
      })
    )
    yield* database.execute(
      "addresses.optOuts.deleteRelay",
      `DELETE FROM ${optOutTable} WHERE relay_id = ?`,
      [relayId]
    )
  }
)

/**
 * Takes back hostnames marked for removal that an instance's routes use
 * again; a sync points their records where they belong instead of deleting
 * them.
 */
export const reviveWebHostnamesEffect = Effect.fn("addresses.revive")(
  function* (ids: ReadonlyArray<string>) {
    if (ids.length === 0) return
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.revive",
      `UPDATE ${addressTable}
          SET status = 'pending', last_error = NULL, attempts = 0,
              next_attempt_at = NULL, updated_at = ?
        WHERE id IN (${ids.map(() => "?").join(", ")})
          AND status = 'removing'`,
      [now, ...ids]
    )
  }
)

/** Forgets the address record Kiln deleted or found gone. */
export const clearAddressRecordEffect = Effect.fn("addresses.clearRecord")(
  function* (id: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.clearRecord",
      `UPDATE ${addressTable}
          SET record_id = NULL, record_type = NULL, updated_at = ?
        WHERE id = ?`,
      [now, id]
    )
  }
)

/** Forgets the SRV record Kiln deleted, and that the name had one. */
export const clearAddressSrvEffect = Effect.fn("addresses.clearSrv")(function* (
  id: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "addresses.clearSrv",
    `UPDATE ${addressTable}
          SET srv_record_id = NULL, supports_srv = 0, srv_service = NULL,
              srv_protocol = NULL, updated_at = ?
        WHERE id = ?`,
    [now, id]
  )
})

/** Forgets every record of an address, once Kiln has deleted them. */
export const clearAddressRecordsEffect = Effect.fn("addresses.clearRecords")(
  function* (id: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.clearRecords",
      `UPDATE ${addressTable}
          SET record_id = NULL, record_type = NULL, srv_record_id = NULL,
              status = IF(status = 'active', 'pending', status),
              updated_at = ?
        WHERE id = ?`,
      [now, id]
    )
  }
)

/** Forgets a hostname, letting go of its names. */
export const deleteAddressEffect = Effect.fn("addresses.delete")(function* (
  row: Address
) {
  const database = yield* Database
  yield* database.transaction("addresses.delete", () =>
    Effect.gen(function* () {
      yield* database.execute(
        "addresses.delete",
        `DELETE FROM ${addressTable} WHERE id = ?`,
        [row.id]
      )
      yield* releaseUnusedHostnamesEffect(row, addressHostnames(row))
    })
  )
})

/**
 * Stops a hostname being its game server's address while its web routes
 * still answer on it: the name stays theirs, its record is theirs to point
 * at the Relay, and a rename it was in is dropped. Its SRV record stays
 * recorded until it is deleted.
 */
export const stopGameAddressEffect = Effect.fn("addresses.stopGame")(function* (
  row: Address
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("addresses.stopGame", () =>
    Effect.gen(function* () {
      yield* database.execute(
        "addresses.stopGame",
        `UPDATE ${addressTable}
              SET game = 0, is_primary = 0, public_port = NULL,
                  next_hostname = NULL, next_vanity_domain = NULL,
                  status = 'pending', last_error = NULL, attempts = 0,
                  next_attempt_at = NULL, updated_at = ?
            WHERE id = ? AND game = 1`,
        [now, row.id]
      )
      if (row.next) {
        yield* releaseUnusedHostnamesEffect(row, [row.next.hostname])
      }
    })
  )
})

/** Makes one address its instance's primary and demotes the rest. */
export const setInstanceDomainPrimaryEffect = Effect.fn("addresses.setPrimary")(
  function* (input: HostnameOwner & { id: string }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "addresses.setPrimary",
      `UPDATE ${addressTable}
          SET is_primary = (id = ?), updated_at = ?
        WHERE ${ofResource}`,
      [input.id, now, ...resourceValues(input)]
    )
  }
)

// A row on the name a rename is moving one of its instance's game addresses
// to: it goes wherever that address goes.
const onRenamedAddressName = `EXISTS (
  SELECT 1 FROM ${addressTable} address
   WHERE address.relay_id = used.relay_id
     AND address.resource_type = used.resource_type
     AND address.resource_id = used.resource_id
     AND address.game = 1
     AND address.next_hostname = used.hostname)`

/**
 * Whether a rename is moving one of the hostname's own instance's game
 * addresses onto its name. That address's record is about to be there, so
 * the hostname makes none of its own; the two become one row when the
 * rename finishes.
 */
export const renameTakingNameEffect = Effect.fn("addresses.renameTakingName")(
  function* (row: Pick<Address, keyof HostnameOwner | "hostname">) {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket>(
      "addresses.renameTakingName",
      `SELECT 1 FROM ${addressTable}
        WHERE ${ofResource} AND game = 1 AND next_hostname = ?
        LIMIT 1`,
      [...resourceValues(row), row.hostname]
    )
    return rows.length > 0
  }
)

/**
 * Gives an instance's hostnames, and their names, to the one taking its
 * place, as moving a game server to another Relay does: its game addresses,
 * with what follows them, or the rest. Ones being deleted stay with their
 * delete. Reports how many moved.
 */
export const reassignAddressesEffect = Effect.fn("addresses.reassign")(
  function* (from: HostnameOwner, to: HostnameOwner, which: "game" | "rest") {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction("addresses.reassign", () =>
      Effect.gen(function* () {
        const moving = yield* database.queryRows<
          RowDataPacket & {
            game: boolean | number
            hostname: string
            next_hostname: string | null
          }
        >(
          "addresses.reassign",
          `SELECT hostname, next_hostname, game FROM ${addressTable} used
            WHERE ${ofResource} AND status <> 'removing'
              AND ${
                which === "game"
                  ? `(game = 1 OR ${onRenamedAddressName})`
                  : `game = 0 AND NOT ${onRenamedAddressName}`
              }
            FOR UPDATE`,
          resourceValues(from)
        )
        if (moving.length === 0) return 0
        const hostnames = moving.map((row) => row.hostname)
        yield* database.execute(
          "addresses.reassign",
          `UPDATE ${addressTable}
              SET relay_id = ?, resource_type = ?, resource_id = ?,
                  attempts = 0, next_attempt_at = NULL, updated_at = ?
            WHERE ${ofResource} AND status <> 'removing'
              AND hostname IN (${hostnames.map(() => "?").join(", ")})`,
          [...resourceValues(to), now, ...resourceValues(from), ...hostnames]
        )
        yield* moveHostnameClaimsEffect(from, to, [
          ...hostnames,
          ...moving.flatMap((row) =>
            row.next_hostname ? [row.next_hostname] : []
          ),
        ])
        return which === "game"
          ? moving.filter((row) => row.game).length
          : moving.length
      })
    )
  }
)

export const loadInstanceDomainOptOutEffect = Effect.fn("domains.optOut.load")(
  function* (relayId: string, instanceId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket>(
      "domains.optOut.load",
      `SELECT 1 FROM ${optOutTable}
      WHERE relay_id = ? AND instance_id = ?
      LIMIT 1`,
      [relayId, instanceId]
    )
    return rows.length > 0
  }
)

export const setInstanceDomainOptOutEffect = Effect.fn("domains.optOut.set")(
  function* (relayId: string, instanceId: string, optedOut: boolean) {
    const database = yield* Database
    if (!optedOut) {
      yield* database.execute(
        "domains.optOut.clear",
        `DELETE FROM ${optOutTable}
          WHERE relay_id = ? AND instance_id = ?`,
        [relayId, instanceId]
      )
      return
    }
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "domains.optOut.save",
      `INSERT IGNORE INTO ${optOutTable}
         (relay_id, instance_id, created_at)
       VALUES (?, ?, ?)`,
      [relayId, instanceId, now]
    )
  }
)

// A hostname with DNS work left: a delete or a rename to finish, a record
// to make or one that failed, or an address whose records didn't follow its
// game server. One a failed save claimed waits for a save, and one left to
// someone else's record for Sync.
const addressNeedsWork = `(status = 'removing'
  OR next_hostname IS NOT NULL
  OR (status IN ('pending', 'error')
    AND (game = 1 OR routed = 1 OR is_generated = 1
      OR record_id IS NOT NULL OR srv_record_id IS NOT NULL))
  OR (game = 1 AND status = 'active' AND last_error IS NOT NULL))`

/** Instances with DNS work due, once any retry they wait on is up. */
export const listDueAddressResourcesEffect = Effect.fn("addresses.due")(
  function* (now: number) {
    const database = yield* Database
    const rows = yield* database.queryRows<
      RowDataPacket & {
        relay_id: string
        resource_id: string
        resource_type: WebHostnameResourceType
      }
    >(
      "addresses.due",
      `SELECT DISTINCT relay_id, resource_type, resource_id
       FROM ${addressTable}
      WHERE ${addressNeedsWork}
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      LIMIT 25`,
      [now]
    )
    return rows.map((row): HostnameOwner => ({
      relayId: row.relay_id.trim(),
      resourceId: row.resource_id,
      resourceType: row.resource_type,
    }))
  }
)

/** When the next hostname still waiting on DNS work is due, if any is. */
export const nextAddressAttemptEffect = Effect.fn("addresses.next")(
  function* () {
    const database = yield* Database
    const [row] = yield* database.queryRows<
      RowDataPacket & { next: number | null }
    >(
      "addresses.next",
      `SELECT MIN(COALESCE(next_attempt_at, 0)) AS next
         FROM ${addressTable}
        WHERE ${addressNeedsWork}`
    )
    return row?.next === null || row?.next === undefined
      ? null
      : Number(row.next)
  }
)

/** Makes every hostname still waiting on work due now, as Sync does. */
export const retryAddressesNowEffect = Effect.fn("addresses.retryNow")(
  function* () {
    const database = yield* Database
    yield* database.execute(
      "addresses.retryNow",
      `UPDATE ${addressTable}
          SET next_attempt_at = NULL
        WHERE ${addressNeedsWork}`
    )
  }
)

/**
 * Puts off an instance's hostnames that still need work after an attempt,
 * each time twice as long, up to an hour.
 */
export const deferAddressesEffect = Effect.fn("addresses.defer")(function* (
  resource: HostnameOwner,
  now: number
) {
  const database = yield* Database
  yield* database.execute(
    "addresses.defer",
    `UPDATE ${addressTable}
        SET next_attempt_at = ? + LEAST(3600000, 30000 * POW(2, attempts)),
            attempts = LEAST(attempts + 1, 60)
      WHERE ${ofResource} AND ${addressNeedsWork}`,
    [now, ...resourceValues(resource)]
  )
})

/** An address's name, and the one a rename is moving it to. */
export function addressHostnames(
  row: Pick<Address, "hostname" | "next">
): Array<string> {
  return [row.hostname, ...(row.next ? [row.next.hostname] : [])]
}

function address(row: AddressRow): Address {
  return {
    connectionId: row.integration_id,
    createdAt: Number(row.created_at),
    existingRecord:
      row.existing_record_id &&
      row.existing_record_type &&
      row.existing_record_content !== null
        ? {
            content: row.existing_record_content,
            id: row.existing_record_id,
            proxied: Boolean(row.existing_record_proxied),
            type: row.existing_record_type,
          }
        : null,
    game: Boolean(row.game),
    generated: Boolean(row.is_generated),
    hostname: row.hostname,
    id: row.id,
    lastError: row.last_error,
    next:
      row.next_hostname && row.next_vanity_domain
        ? { hostname: row.next_hostname, vanityDomain: row.next_vanity_domain }
        : null,
    primary: Boolean(row.is_primary),
    proxied: Boolean(row.proxied),
    publicPort: row.public_port,
    recordId: row.record_id,
    recordType: row.record_type,
    relayId: row.relay_id.trim(),
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    routed: Boolean(row.routed),
    srvProtocol: row.srv_protocol,
    srvRecordId: row.srv_record_id,
    srvService: row.srv_service,
    status: row.status,
    supportsSrv: Boolean(row.supports_srv),
    target: row.target,
    vanityDomain: row.vanity_domain,
    zoneId: row.zone_id,
  }
}

/** A game server's address, as its Network page and the Domains page read it. */
export function assignmentOf(row: Address): InstanceDomainAssignment {
  const domain = row.vanityDomain ?? ""
  // A name under its vanity domain: the label is what comes before it.
  const label = (hostname: string, under: string) =>
    hostname.slice(0, hostname.length - under.length - 1)
  return {
    addressRecordId: row.recordId,
    addressRecordType: row.recordType,
    domain,
    id: row.id,
    instanceId: row.resourceId,
    integrationId: row.connectionId,
    lastError: row.lastError,
    next: row.next
      ? {
          domain: row.next.vanityDomain,
          vanityLabel: label(row.next.hostname, row.next.vanityDomain),
        }
      : null,
    primary: row.primary,
    publicHost: row.target ?? "",
    publicPort: row.publicPort ?? 0,
    relayId: row.relayId,
    srvProtocol: row.srvProtocol,
    srvRecordId: row.srvRecordId,
    srvService: row.srvService,
    // A game server's address is never left to someone else's record.
    status: row.status === "external" ? "error" : row.status,
    supportsSrv: row.supportsSrv,
    vanityLabel: label(row.hostname, domain),
    zoneId: row.zoneId,
  }
}
