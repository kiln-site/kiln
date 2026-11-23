import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

/**
 * Pinning a Relay's host files recorded them as a game server's that has the
 * Relay's own ID. No real one does, since an ID is one instance's alone. The
 * pins it held go with it, and are made again as the Relay's when someone
 * next opens its Info page.
 */
export const relayPhantomGameServers: Migration = {
  id: 97,
  name: "relay_phantom_game_servers",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("instance")
    yield* sql`DELETE FROM ${sql(table)} WHERE instance_id = relay_id`
  }),
}
