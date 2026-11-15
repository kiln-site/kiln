import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// An instance's primary address can be one of its names in a tailnet.
export const tunnelPrimaryNames: Migration = {
  id: 82,
  name: "tunnel_primary_names",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const primary = databaseTableName("instance_primary_address")
    yield* sql.unsafe(`ALTER TABLE \`${primary}\`
  MODIFY \`address_kind\` enum('join','route','tunnel') NOT NULL`)
  }),
}
