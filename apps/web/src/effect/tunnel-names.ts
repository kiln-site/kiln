import { randomUUID } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// The names each member has in a tailnet: one generated as it connected,
// under the tailnet's first TLD, which can be renamed but not removed, and
// any aliases, at any depth, under any of its TLDs. A name is unique in its
// tailnet. Its tunnels' CoreDNS answers each with the address the member has
// on the tunnel on its own Relay (`tunnel-dns.server.ts`).

const nameTable = databaseTable("tunnel_name")

export interface TunnelName {
  domain: string
  /** The one it was given as it connected, which can't be removed. */
  generated: boolean
  id: string
  /** Its label or labels, under its TLD. */
  label: string
  memberId: string
  tailnetId: string
}

interface NameRow extends RowDataPacket {
  domain: string
  generated_for: string | null
  id: string
  label: string
  member_id: string
  tailnet_id: string
}

/** A name whole: its label or labels, then its TLD. */
export function tunnelNameOf(name: Pick<TunnelName, "domain" | "label">) {
  return `${name.label}.${name.domain}`
}

/** Every name in these tailnets, the generated one first for each member. */
export const listTunnelNamesEffect = Effect.fn("tunnelNames.list")(function* (
  tailnetIds: ReadonlyArray<string>
) {
  if (tailnetIds.length === 0) return []
  const database = yield* Database
  const rows = yield* database.queryRows<NameRow>(
    "tunnelNames.list",
    `SELECT id, tailnet_id, member_id, label, domain, generated_for
       FROM ${nameTable}
      WHERE tailnet_id IN (${tailnetIds.map(() => "?").join(", ")})
      ORDER BY tailnet_id, member_id, generated_for IS NULL, label, domain`,
    [...tailnetIds]
  )
  return rows.map((row): TunnelName => ({
    domain: row.domain,
    generated: row.generated_for !== null,
    id: row.id,
    label: row.label,
    memberId: row.member_id,
    tailnetId: row.tailnet_id,
  }))
})

// A label is at most 63 characters, DNS's limit for one.
const MAXIMUM_LABEL_LENGTH = 63

/**
 * A member to name as it connects: what it's called, and what it is with its
 * ID's first characters, for a name with nothing left of it.
 */
export interface UnnamedTunnelMember {
  /** `game-server-1a2b3c`, `app-…` or `database-…`. */
  fallback: string
  memberId: string
  name: string
}

/**
 * Names each member once, as it connects to a tailnet, from what it's called:
 * lowercase, spaces become hyphens, anything but letters, digits and hyphens
 * dropped, repeated hyphens collapsed and trimmed, at most 63 characters, its
 * fallback when nothing is left, and `-2`, `-3` while another name under
 * `domain` in the tailnet, or one in `reserved`, has it. Saves nothing: the
 * save that connects them does (`setGeneratedTunnelNamesEffect`).
 */
export const generateTunnelNamesEffect = Effect.fn("tunnelNames.generate")(
  function* (
    tailnetId: string,
    domain: string,
    members: ReadonlyArray<UnnamedTunnelMember>,
    reserved: ReadonlyArray<string> = []
  ) {
    const generated = new Map<string, string>()
    if (members.length === 0) return generated
    const taken = new Set(reserved)
    for (const name of yield* listTunnelNamesEffect([tailnetId])) {
      if (name.domain === domain) taken.add(name.label)
    }
    for (const member of members) {
      const base = tunnelLabelOf(member.name) || tunnelLabelOf(member.fallback)
      let label = base
      for (let suffix = 2; taken.has(label); suffix += 1) {
        const ending = `-${suffix}`
        label = `${base.slice(0, MAXIMUM_LABEL_LENGTH - ending.length).replace(/-+$/u, "")}${ending}`
      }
      taken.add(label)
      generated.set(member.memberId, label)
    }
    return generated
  }
)

function tunnelLabelOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAXIMUM_LABEL_LENGTH)
    .replace(/-+$/u, "")
}

/**
 * Gives each member its generated name, or renames the one it has. A name
 * another member of the tailnet has fails it, as each is unique.
 */
export const setGeneratedTunnelNamesEffect = Effect.fn(
  "tunnelNames.setGenerated"
)(function* (
  tailnetId: string,
  names: ReadonlyArray<{ domain: string; label: string; memberId: string }>
) {
  if (names.length === 0) return
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tunnelNames.setGenerated", (transaction) =>
    Effect.forEach(
      names,
      (name) =>
        transaction.execute(
          `INSERT INTO ${nameTable}
             (id, tailnet_id, member_id, label, domain, generated_for,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE label = VALUES(label),
             domain = VALUES(domain)`,
          [
            randomUUID(),
            tailnetId,
            name.memberId,
            name.label,
            name.domain,
            name.memberId,
            now,
          ]
        ),
      { discard: true }
    )
  )
})

/**
 * Forgets the names of a tailnet's members that aren't in `kept`, and its
 * aliases under TLDs it no longer has.
 */
export const keepTunnelNamesOfEffect = Effect.fn("tunnelNames.keep")(function* (
  tailnetId: string,
  kept: ReadonlyArray<string>,
  domains: ReadonlyArray<string>
) {
  const database = yield* Database
  const members = kept.map(() => "?").join(", ")
  const tlds = domains.map(() => "?").join(", ")
  yield* database.execute(
    "tunnelNames.keep",
    `DELETE FROM ${nameTable}
      WHERE tailnet_id = ?
        AND (${kept.length > 0 ? `member_id NOT IN (${members})` : "TRUE"}
             OR domain NOT IN (${tlds}))`,
    [tailnetId, ...kept, ...domains]
  )
})

/** Gives a member another name in its tailnet. */
export const addTunnelAliasEffect = Effect.fn("tunnelNames.addAlias")(
  function* (name: {
    domain: string
    label: string
    memberId: string
    tailnetId: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const id = randomUUID()
    yield* database.execute(
      "tunnelNames.addAlias",
      `INSERT INTO ${nameTable}
       (id, tailnet_id, member_id, label, domain, generated_for, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [id, name.tailnetId, name.memberId, name.label, name.domain, now]
    )
    return id
  }
)

/** Takes away an alias. A generated name stays. Says whether it was one. */
export const removeTunnelAliasEffect = Effect.fn("tunnelNames.removeAlias")(
  function* (id: string) {
    const database = yield* Database
    const result = yield* database.execute(
      "tunnelNames.removeAlias",
      `DELETE FROM ${nameTable} WHERE id = ? AND generated_for IS NULL`,
      [id]
    )
    return result.affectedRows > 0
  }
)

/** One name, as Hearth keeps it. */
export const loadTunnelNameEffect = Effect.fn("tunnelNames.load")(function* (
  id: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<NameRow>(
    "tunnelNames.load",
    `SELECT id, tailnet_id, member_id, label, domain, generated_for
       FROM ${nameTable} WHERE id = ?`,
    [id]
  )
  return row
    ? ({
        domain: row.domain,
        generated: row.generated_for !== null,
        id: row.id,
        label: row.label,
        memberId: row.member_id,
        tailnetId: row.tailnet_id,
      } satisfies TunnelName)
    : null
})
