import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A database opened to the internet holds its public name as a game server
// or App holds theirs: an address row, and the claim that keeps the name its
// own. Adding a value to an enum changes no row, so this is safe to run
// again.
export const databaseAddresses: Migration = {
  id: 103,
  name: "database_addresses",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const table of ["instance_address", "hostname_claim"]) {
      yield* sql.unsafe(
        `ALTER TABLE \`${databaseTableName(table)}\` MODIFY \`resource_type\` enum('app','instance','database') NOT NULL`
      )
    }
  }),
}
