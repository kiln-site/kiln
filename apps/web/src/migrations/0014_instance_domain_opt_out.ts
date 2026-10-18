import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Game servers whose vanity domain an administrator removed. Starts, port
// changes, and Sync skip them instead of generating a new address. No foreign
// key: like `instance_favorite`, Relay snapshots rewrite instance rows.
export const instanceDomainOptOut: Migration = {
  id: 14,
  name: "instance_domain_opt_out",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("instance_domain_opt_out")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`instance_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`relay_id\`,\`instance_id\`)
)`)
  }),
}
