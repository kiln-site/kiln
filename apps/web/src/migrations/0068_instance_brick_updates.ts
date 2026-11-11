import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// An instance's updates are also its Brick's: which revision of the recipe
// it was installed from, and the newer one its catalog has, with when Kiln
// first saw it and whether someone passed over it, as an image's are kept.
export const instanceBrickUpdates: Migration = {
  id: 68,
  name: "instance_brick_updates",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("instance_update")
    const columns = new Set(
      (yield* sql<{ name: string }>`
        SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ${table}
      `).map((column) => column.name)
    )
    const added = [
      ["brick_source", "varchar(2048) DEFAULT NULL"],
      ["brick_revision", "int unsigned DEFAULT NULL"],
      ["latest_revision", "int unsigned DEFAULT NULL"],
      ["revision_seen_at", "bigint unsigned DEFAULT NULL"],
      ["skipped_revision", "int unsigned DEFAULT NULL"],
    ].filter(([name]) => !columns.has(name!))
    if (added.length > 0) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ${added.map(([name, type]) => `ADD COLUMN \`${name}\` ${type}`).join(",\n  ")}`)
    }
  }),
}
