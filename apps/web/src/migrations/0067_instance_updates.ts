import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Updates are every instance's, not only an image App's: what each one
// decided to do about them, what the last check found, and each update Kiln
// already tried. The App tables become the instance ones, keeping what they
// hold, and an update says which kind its instance is. Rows no longer hang off the App
// table, so deleting an instance removes them (`resource-deletion-cleanup`).
export const instanceUpdates: Migration = {
  id: 67,
  name: "instance_updates",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const moves = [
      ["app_image_update", "instance_update"],
      ["app_image_update_attempt", "instance_update_attempt"],
    ] as const
    for (const [from, to] of moves) {
      const before = databaseTableName(from)
      const after = databaseTableName(to)
      const tables = new Set(
        (yield* sql<{ name: string }>`
          SELECT table_name AS name FROM information_schema.tables
           WHERE table_schema = DATABASE()
             AND table_name IN (${before}, ${after})
        `).map((table) => table.name)
      )
      if (tables.has(before) && !tables.has(after)) {
        yield* sql.unsafe(`RENAME TABLE \`${before}\` TO \`${after}\``)
      }
      // A foreign key keeps its name through a rename.
      const foreignKeys = yield* sql<{ name: string }>`
        SELECT constraint_name AS name
          FROM information_schema.table_constraints
         WHERE table_schema = DATABASE() AND table_name = ${after}
           AND constraint_type = 'FOREIGN KEY'
      `
      for (const { name } of foreignKeys) {
        yield* sql.unsafe(
          `ALTER TABLE \`${after}\` DROP FOREIGN KEY \`${name}\``
        )
      }
      const columns = new Map(
        (yield* sql<{ name: string; type: string }>`
          SELECT column_name AS name, column_type AS type
            FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ${after}
        `).map((column) => [column.name, column.type])
      )
      const idType = columns.get("app_id")
      if (idType !== undefined) {
        yield* sql.unsafe(`ALTER TABLE \`${after}\`
  CHANGE COLUMN \`app_id\` \`instance_id\` ${idType} CHARACTER SET ascii COLLATE ascii_bin NOT NULL`)
      }
      // An attempt is told apart by its instance's ID alone, which no two
      // kinds share.
      if (to === "instance_update" && !columns.has("instance_kind")) {
        // Every row so far is an App's.
        yield* sql.unsafe(`ALTER TABLE \`${after}\`
  ADD COLUMN \`instance_kind\` enum('app','database','server') NOT NULL DEFAULT 'app' AFTER \`instance_id\``)
        yield* sql.unsafe(`ALTER TABLE \`${after}\`
  ALTER COLUMN \`instance_kind\` DROP DEFAULT`)
      }
    }
  }),
}
