import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// System update operations Hearth is tracking until the Relay reports them
// settled. A batched update replaces Hearth before the Relay, so the
// replacement Hearth resumes tracking from these rows.
export const systemUpdateOperations: Migration = {
  id: 6,
  name: "system_update_operations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("system_update_operation")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`operation_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`component\` enum('hearth','relay') NOT NULL,
  \`deadline_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`operation_id\`)
)`)
  }),
}
