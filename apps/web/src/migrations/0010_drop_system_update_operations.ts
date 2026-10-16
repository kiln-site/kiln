import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Relays report the updates they run, so Hearth no longer tracks them in
// its own table.
export const dropSystemUpdateOperations: Migration = {
  id: 10,
  name: "drop_system_update_operations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("system_update_operation")
    yield* sql.unsafe(`DROP TABLE IF EXISTS \`${table}\``)
  }),
}
