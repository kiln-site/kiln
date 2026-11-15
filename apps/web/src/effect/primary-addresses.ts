import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// Each instance's one primary address: what Kiln shows for it (lists, its
// header, the infra map, the copy button) and, for a game server, the
// address it advertises. One row per instance names it, so an instance
// can't have two. It changes nothing about routing: every address works,
// primary or not. A row naming an address that's gone is ignored, and the
// instance's first address that serves stands in until another is chosen.
export const primaryAddressTable = databaseTable("instance_primary_address")

export type PrimaryAddressInstanceType = "app" | "database" | "instance"

/** Which of an instance's addresses is its primary. */
export interface PrimaryAddress {
  /** A game server's join address, or one of an App's web routes. */
  kind: "join" | "route"
  /** The join address's ID, or the web route's. */
  ref: string
}

export interface PrimaryAddressInstance {
  id: string
  type: PrimaryAddressInstanceType
}

interface PrimaryAddressRow extends RowDataPacket {
  address_kind: PrimaryAddress["kind"]
  address_ref: string
  instance_id: string
  instance_type: PrimaryAddressInstanceType
}

export const loadPrimaryAddressEffect = Effect.fn("primaryAddresses.load")(
  function* (instance: PrimaryAddressInstance) {
    const database = yield* Database
    const [row] = yield* database.queryRows<PrimaryAddressRow>(
      "primaryAddresses.load",
      `SELECT instance_type, instance_id, address_kind, address_ref
         FROM ${primaryAddressTable}
        WHERE instance_type = ? AND instance_id = ?`,
      [instance.type, instance.id]
    )
    return row ? primaryAddress(row) : null
  }
)

/** The primary addresses of every instance of a kind, by instance ID. */
export const loadPrimaryAddressesEffect = Effect.fn("primaryAddresses.list")(
  function* (type: PrimaryAddressInstanceType) {
    const database = yield* Database
    const rows = yield* database.queryRows<PrimaryAddressRow>(
      "primaryAddresses.list",
      `SELECT instance_type, instance_id, address_kind, address_ref
         FROM ${primaryAddressTable}
        WHERE instance_type = ?`,
      [type]
    )
    return new Map(rows.map((row) => [row.instance_id, primaryAddress(row)]))
  }
)

/** Makes `address` its instance's primary, in place of any other. */
export const setPrimaryAddressEffect = Effect.fn("primaryAddresses.set")(
  function* (instance: PrimaryAddressInstance, address: PrimaryAddress) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "primaryAddresses.set",
      `INSERT INTO ${primaryAddressTable}
         (instance_type, instance_id, address_kind, address_ref, chosen_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE address_kind = VALUES(address_kind),
         address_ref = VALUES(address_ref), chosen_at = VALUES(chosen_at)`,
      [instance.type, instance.id, address.kind, address.ref, now]
    )
  }
)

/**
 * Makes `address` its instance's primary only if it has none. Says whether
 * it did.
 */
export const adoptPrimaryAddressEffect = Effect.fn("primaryAddresses.adopt")(
  function* (instance: PrimaryAddressInstance, address: PrimaryAddress) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "primaryAddresses.adopt",
      `INSERT IGNORE INTO ${primaryAddressTable}
         (instance_type, instance_id, address_kind, address_ref, chosen_at)
       VALUES (?, ?, ?, ?, ?)`,
      [instance.type, instance.id, address.kind, address.ref, now]
    )
    return result.affectedRows > 0
  }
)

/** Forgets the primary of each of these addresses that is one. */
export const clearPrimaryAddressesEffect = Effect.fn("primaryAddresses.clear")(
  function* (kind: PrimaryAddress["kind"], refs: ReadonlyArray<string>) {
    if (refs.length === 0) return
    const database = yield* Database
    yield* database.execute(
      "primaryAddresses.clear",
      `DELETE FROM ${primaryAddressTable}
        WHERE address_kind = ?
          AND address_ref IN (${refs.map(() => "?").join(", ")})`,
      [kind, ...refs]
    )
  }
)

/** Forgets a deleted instance's primary address. */
export const forgetPrimaryAddressEffect = Effect.fn("primaryAddresses.forget")(
  function* (instance: PrimaryAddressInstance) {
    const database = yield* Database
    yield* database.execute(
      "primaryAddresses.forget",
      `DELETE FROM ${primaryAddressTable}
        WHERE instance_type = ? AND instance_id = ?`,
      [instance.type, instance.id]
    )
  }
)

function primaryAddress(row: PrimaryAddressRow): PrimaryAddress {
  return { kind: row.address_kind, ref: row.address_ref }
}
