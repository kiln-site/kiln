import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

// A domain says who writes its DNS: a DNS service through a connection
// (Cloudflare, every domain so far), its owner by hand, or a tunnel. Vanity
// domains become `domain`, each with its provider; the connection and zone
// are a DNS service's, so a domain of another provider has none.
//
// Each step looks before it acts, so a migration cut short finishes when it
// runs again.
export const domains: Migration = {
  id: 85,
  name: "domains",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const zone = databaseTableName("domain_zone")
    const domain = databaseTableName("domain")

    if (yield* tableExists(sql, zone)) {
      yield* sql.unsafe(`RENAME TABLE \`${zone}\` TO \`${domain}\``)
    }
    if (!(yield* columnExists(sql, domain, "provider"))) {
      yield* sql.unsafe(`ALTER TABLE \`${domain}\`
  ADD COLUMN \`provider\` enum('cloudflare','manual','tunnel') NOT NULL DEFAULT 'cloudflare' AFTER \`domain\``)
    }
    yield* sql.unsafe(`ALTER TABLE \`${domain}\`
  MODIFY \`integration_id\` varchar(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  MODIFY \`zone_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  MODIFY \`zone_name\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
  }),
}

function tableExists(sql: Sql, table: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}

function columnExists(sql: Sql, table: string, column: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}
