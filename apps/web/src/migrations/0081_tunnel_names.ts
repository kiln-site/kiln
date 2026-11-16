import { randomUUID } from "node:crypto"

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

// Hearth keeps every name in a tailnet. A tailnet has TLDs, in order, its
// first the one each member's generated name is under (`tailnet_domain`),
// and each member it connects has names (`tunnel_name`): one it was given
// when it connected, which can be renamed but not removed, and aliases.
//
// A network's domain becomes its tailnet's first TLD, and the hostname each
// member had on its node becomes its generated name. What Hearth last saw of
// each tunnel names its TLDs, and its members no longer carry a hostname.
// Each step looks before it acts, so a migration cut short finishes when it
// runs again.
export const tunnelNames: Migration = {
  id: 81,
  name: "tunnel_names",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tailnet = databaseTableName("tailnet")
    const tunnel = databaseTableName("tunnel")
    const domains = databaseTableName("tailnet_domain")
    const names = databaseTableName("tunnel_name")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${domains}\` (
  \`tailnet_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`domain\` varchar(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`position\` smallint unsigned NOT NULL,
  PRIMARY KEY (\`tailnet_id\`, \`domain\`),
  UNIQUE KEY \`${domains}_domain\` (\`domain\`),
  CONSTRAINT \`${domains}_tailnet_fk\` FOREIGN KEY (\`tailnet_id\`)
    REFERENCES \`${tailnet}\` (\`id\`) ON DELETE CASCADE
)`)
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${names}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`tailnet_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`member_id\` varchar(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`label\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`domain\` varchar(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`generated_for\` varchar(96) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${names}_name\` (\`tailnet_id\`, \`label\`, \`domain\`),
  UNIQUE KEY \`${names}_generated\` (\`tailnet_id\`, \`generated_for\`),
  KEY \`${names}_member\` (\`tailnet_id\`, \`member_id\`),
  CONSTRAINT \`${names}_tailnet_fk\` FOREIGN KEY (\`tailnet_id\`)
    REFERENCES \`${tailnet}\` (\`id\`) ON DELETE CASCADE
)`)

    if (!(yield* columnExists(sql, tailnet, "domain"))) return
    yield* sql.unsafe(`INSERT IGNORE INTO \`${domains}\` (tailnet_id, domain, position)
  SELECT id, domain, 0 FROM \`${tailnet}\``)
    const rows = yield* sql<{
      domain: string
      id: string
      state: unknown
      tailnet_id: string
    }>`
      SELECT tunnel.id, tunnel.tailnet_id, tunnel.state, tailnet.domain
        FROM ${sql(tunnel)} tunnel
        JOIN ${sql(tailnet)} tailnet ON tailnet.id = tunnel.tailnet_id
    `
    const now = Date.now()
    for (const row of rows) {
      const state = parsed(row.state)
      const bindings = Array.isArray(state.bindings) ? state.bindings : []
      for (const binding of bindings) {
        if (typeof binding !== "object" || binding === null) continue
        const { hostname, memberId } = binding as Record<string, unknown>
        if (typeof hostname !== "string" || typeof memberId !== "string") {
          continue
        }
        yield* sql`
          INSERT IGNORE INTO ${sql(names)}
            (id, tailnet_id, member_id, label, domain, generated_for, created_at)
          VALUES (${randomUUID()}, ${row.tailnet_id}, ${memberId},
                  ${hostname.replace(/\.$/u, "")}, ${row.domain}, ${memberId},
                  ${now})
        `
      }
      const { domain: _domain, ...rest } = state
      const next = {
        ...rest,
        bindings: bindings.map((binding: unknown) => {
          if (typeof binding !== "object" || binding === null) return binding
          const { hostname: _hostname, ...kept } = binding as Record<
            string,
            unknown
          >
          return kept
        }),
        domains: [row.domain],
      }
      yield* sql`
        UPDATE ${sql(tunnel)} SET state = ${JSON.stringify(next)}
         WHERE id = ${row.id}
      `
    }
    yield* sql.unsafe(`ALTER TABLE \`${tailnet}\` DROP COLUMN \`domain\``)
  }),
}

function parsed(value: unknown): Record<string, unknown> {
  const decoded: unknown = typeof value === "string" ? JSON.parse(value) : value
  return typeof decoded === "object" && decoded !== null
    ? (decoded as Record<string, unknown>)
    : {}
}

function columnExists(sql: Sql, name: string, column: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [name, column]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}
