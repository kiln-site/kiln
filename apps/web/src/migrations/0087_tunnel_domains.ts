import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

// A tunnel's TLDs are domains whose provider is the tunnel: `tunnel_domain`
// rows move into `domain`, in their order, the first its default. A TLD
// another domain already has fails the migration rather than being dropped.
//
// Each step looks before it acts, so a migration cut short finishes when it
// runs again.
export const tunnelDomains: Migration = {
  id: 87,
  name: "tunnel_domains",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const domain = databaseTableName("domain")
    const tunnel = databaseTableName("tunnel")
    const tunnelDomain = databaseTableName("tunnel_domain")
    if (!(yield* columnExists(sql, domain, "tunnel_id"))) {
      yield* sql.unsafe(`ALTER TABLE \`${domain}\`
  ADD COLUMN \`tunnel_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER \`owner_id\`,
  ADD COLUMN \`position\` smallint unsigned DEFAULT NULL AFTER \`tunnel_id\`,
  ADD KEY \`${domain}_tunnel_idx\` (\`tunnel_id\`, \`position\`),
  ADD CONSTRAINT \`${domain}_tunnel_fk\` FOREIGN KEY (\`tunnel_id\`)
    REFERENCES \`${tunnel}\` (\`id\`) ON DELETE CASCADE`)
    }
    if (yield* tableExists(sql, tunnelDomain)) {
      const now = Date.now()
      yield* sql.unsafe(`INSERT INTO \`${domain}\`
  (domain, provider, tunnel_id, position, is_default, enabled, created_at,
   updated_at)
SELECT old.domain, 'tunnel', old.tunnel_id, old.position, old.position = 0,
       1, ${now}, ${now}
  FROM \`${tunnelDomain}\` old
 WHERE NOT EXISTS (
   SELECT 1 FROM \`${domain}\` moved
    WHERE moved.domain = old.domain AND moved.provider = 'tunnel'
      AND moved.tunnel_id = old.tunnel_id)`)
      yield* sql.unsafe(`DROP TABLE \`${tunnelDomain}\``)
    }
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
