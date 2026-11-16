import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

// A domain its owner manages elsewhere: Kiln holds its names and writes no
// records. Such a domain keeps who added it, and a name under it has no
// connection.
//
// Each step looks before it acts, so a migration cut short finishes when it
// runs again.
export const manualDomains: Migration = {
  id: 86,
  name: "manual_domains",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const domain = databaseTableName("domain")
    const address = databaseTableName("instance_address")
    if (!(yield* columnExists(sql, domain, "owner_id"))) {
      yield* sql.unsafe(`ALTER TABLE \`${domain}\`
  ADD COLUMN \`owner_id\` varchar(36) DEFAULT NULL AFTER \`provider\``)
    }
    yield* sql.unsafe(`ALTER TABLE \`${address}\`
  MODIFY \`integration_id\` varchar(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
  }),
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
