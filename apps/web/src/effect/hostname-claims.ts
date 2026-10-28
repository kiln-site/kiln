import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { HostnameInUseError } from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"

/** The game server or app a hostname belongs to. */
export interface HostnameOwner {
  readonly relayId: string
  readonly resourceId: string
  readonly resourceType: "app" | "instance"
}

interface ClaimRow extends RowDataPacket {
  relay_id: string
  resource_id: string
  resource_type: HostnameOwner["resourceType"]
}

const claimTable = databaseTable("hostname_claim")

/**
 * Takes `hostnames` for `owner`, or confirms it holds them. Run it in the
 * transaction that writes the row using each name, so a name is never used
 * without its claim. Fails when another game server or app holds one; names
 * are kept lowercase, so every spelling of a name is one claim.
 */
export const claimHostnamesEffect = Effect.fn("hostnameClaims.claim")(
  function* (owner: HostnameOwner, hostnames: ReadonlyArray<string>) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    for (const hostname of new Set(hostnames.map(canonicalHostname))) {
      yield* database.execute(
        "hostnameClaims.claim",
        `INSERT IGNORE INTO ${claimTable}
           (hostname, relay_id, resource_type, resource_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [hostname, owner.relayId, owner.resourceType, owner.resourceId, now]
      )
      // A locking read sees the claim as committed, whatever the
      // transaction read before, and keeps it from being released
      // until the caller commits.
      const [row] = yield* database.queryRows<ClaimRow>(
        "hostnameClaims.claim",
        `SELECT relay_id, resource_type, resource_id
           FROM ${claimTable}
          WHERE hostname = ?
          FOR SHARE`,
        [hostname]
      )
      const holder = row ? claimOwner(row) : null
      if (!holder || !sameOwner(holder, owner)) {
        return yield* HostnameInUseError.make({
          holder,
          hostname,
          message: `${hostname} is already in use`,
        })
      }
    }
  }
)

/**
 * Lets go of claims nothing uses any more: no web hostname, and no game
 * server domain by its name or the name it's being renamed to. Run it in
 * the transaction that stopped using them. Narrowed to one owner, and to
 * `hostnames` when given; a Relay's when only its ID is.
 */
export const releaseUnusedHostnamesEffect = Effect.fn("hostnameClaims.release")(
  function* (
    owner: HostnameOwner | { readonly relayId: string },
    hostnames?: ReadonlyArray<string>
  ) {
    if (hostnames?.length === 0) return
    const database = yield* Database
    const conditions = ["claim.relay_id = ?"]
    const values: Array<string> = [owner.relayId]
    if ("resourceId" in owner) {
      conditions.push("claim.resource_type = ?", "claim.resource_id = ?")
      values.push(owner.resourceType, owner.resourceId)
    }
    if (hostnames) {
      conditions.push(
        `claim.hostname IN (${hostnames.map(() => "?").join(", ")})`
      )
      values.push(...hostnames.map(canonicalHostname))
    }
    yield* database.execute(
      "hostnameClaims.release",
      `DELETE claim FROM ${claimTable} claim
      WHERE ${conditions.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1 FROM ${databaseTable("web_hostname")} used
           WHERE used.hostname = claim.hostname)
        AND NOT EXISTS (
          SELECT 1 FROM ${databaseTable("instance_domain")} used
           WHERE claim.resource_type = 'instance'
             AND used.relay_id = claim.relay_id
             AND used.instance_id = claim.resource_id
             AND (CONCAT(used.vanity_label, '.', used.domain) = claim.hostname
               OR CONCAT(used.next_vanity_label, '.', used.next_domain)
                  = claim.hostname))`,
      values
    )
  }
)

/**
 * Gives `from`'s claims on `hostnames` to `to`, in the transaction that
 * moves the rows using them.
 */
export const moveHostnameClaimsEffect = Effect.fn("hostnameClaims.move")(
  function* (
    from: HostnameOwner,
    to: HostnameOwner,
    hostnames: ReadonlyArray<string>
  ) {
    if (hostnames.length === 0) return
    const database = yield* Database
    yield* database.execute(
      "hostnameClaims.move",
      `UPDATE ${claimTable}
          SET relay_id = ?, resource_type = ?, resource_id = ?
        WHERE relay_id = ? AND resource_type = ? AND resource_id = ?
          AND hostname IN (${hostnames.map(() => "?").join(", ")})`,
      [
        to.relayId,
        to.resourceType,
        to.resourceId,
        from.relayId,
        from.resourceType,
        from.resourceId,
        ...hostnames.map(canonicalHostname),
      ]
    )
  }
)

/** The game server or app holding a hostname, or null. */
export const loadHostnameHolderEffect = Effect.fn("hostnameClaims.holder")(
  function* (hostname: string) {
    const database = yield* Database
    const [row] = yield* database.queryRows<ClaimRow>(
      "hostnameClaims.holder",
      `SELECT relay_id, resource_type, resource_id
         FROM ${claimTable}
        WHERE hostname = ?`,
      [canonicalHostname(hostname)]
    )
    return row ? claimOwner(row) : null
  }
)

/** Names held directly under `domain`, by their label, with their holders. */
export const loadClaimedLabelsEffect = Effect.fn("hostnameClaims.labels")(
  function* (domain: string) {
    const database = yield* Database
    const suffix = `.${canonicalHostname(domain)}`
    const rows = yield* database.queryRows<ClaimRow & { hostname: string }>(
      "hostnameClaims.labels",
      `SELECT hostname, relay_id, resource_type, resource_id
         FROM ${claimTable}
        WHERE RIGHT(hostname, ?) = ?`,
      [suffix.length, suffix]
    )
    const labels = new Map<string, HostnameOwner>()
    for (const row of rows) {
      const label = row.hostname.slice(0, -suffix.length)
      if (label && !label.includes(".")) labels.set(label, claimOwner(row))
    }
    return labels
  }
)

export function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase()
}

export function sameOwner(left: HostnameOwner, right: HostnameOwner): boolean {
  return (
    left.relayId === right.relayId &&
    left.resourceId === right.resourceId &&
    left.resourceType === right.resourceType
  )
}

function claimOwner(row: ClaimRow): HostnameOwner {
  return {
    relayId: row.relay_id.trim(),
    resourceId: row.resource_id,
    resourceType: row.resource_type,
  }
}
