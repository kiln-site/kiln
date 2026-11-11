import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// When an instance's Brick was last seen, apart from when its image was
// checked: checks overlap, so what one found is written only if nothing
// asked later has been, and it counts only until the instance's next
// deployment, which may have changed the Brick it runs.
export const instanceBrickCheckTime: Migration = {
  id: 70,
  name: "instance_brick_check_time",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("instance_update")
    const [column] = yield* sql<{ name: string }>`
      SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${table}
         AND column_name = 'brick_checked_at'
    `
    if (!column) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ADD COLUMN \`brick_checked_at\` bigint unsigned DEFAULT NULL`)
    }
  }),
}
