import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every instance with addresses of its own has a main one: the address
// shown for it, and for a game server the one it is joined by. Only a game
// server's addresses had one until every kind held them the same way, so
// an App's keeps none from before. The oldest it still has becomes it.
//
// Safe to run again: an instance that has a main address is left alone.
export const mainAddresses: Migration = {
  id: 77,
  name: "main_addresses",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const address = databaseTableName("instance_address")
    // Oldest first, then by ID where two were made at once.
    const age = (alias: string) =>
      `CONCAT(LPAD(${alias}.created_at, 20, '0'), ${alias}.id)`
    yield* sql.unsafe(`UPDATE \`${address}\` held
  JOIN (
    SELECT own.relay_id, own.resource_type, own.resource_id,
           MIN(${age("own")}) AS oldest
      FROM \`${address}\` own
     WHERE own.standalone = 1 AND own.status <> 'removing'
     GROUP BY own.relay_id, own.resource_type, own.resource_id
    HAVING SUM(own.is_primary) = 0
  ) without_main
    ON without_main.relay_id = held.relay_id
   AND without_main.resource_type = held.resource_type
   AND without_main.resource_id = held.resource_id
   AND without_main.oldest = ${age("held")}
   SET held.is_primary = 1
 WHERE held.standalone = 1 AND held.status <> 'removing'`)
  }),
}
