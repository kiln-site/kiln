import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// An App holds addresses as a game server does: several, each its own to
// rename or remove. What told the one address Kiln made for an App apart
// from a name only its web routes use was `is_generated`. It becomes
// `standalone`, and says the same of every address an instance holds in its
// own right, however it came by it: a game server's, an App's made for it,
// or one someone added. A name held only because a web route answers on it
// is the rest, and goes when the route stops using it.
//
// MySQL doesn't roll DDL back, so each step is safe to run again.
export const standaloneAddresses: Migration = {
  id: 76,
  name: "standalone_addresses",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const address = databaseTableName("instance_address")
    const columns = new Set(
      (yield* sql<{ name: string }>`
        SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ${address}
      `).map((column) => column.name)
    )
    if (columns.has("is_generated") && !columns.has("standalone")) {
      yield* sql.unsafe(`ALTER TABLE \`${address}\`
  CHANGE COLUMN \`is_generated\` \`standalone\` tinyint(1) NOT NULL DEFAULT '0'`)
    }
    yield* sql`UPDATE ${sql(address)} SET standalone = 1 WHERE game = 1`
  }),
}
