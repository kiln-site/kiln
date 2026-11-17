import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every Relay pairs through its announcements, so a join no longer keeps
// what its Relay said it can do.
export const relayJoinFeatures: Migration = {
  id: 89,
  name: "relay_join_features",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const join = databaseTableName("relay_join")
    const found = yield* sql.unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'features'`,
      [join]
    )
    if (Number(found[0]?.found ?? 0) > 0) {
      yield* sql.unsafe(`ALTER TABLE \`${join}\` DROP COLUMN \`features\``)
    }
  }),
}
