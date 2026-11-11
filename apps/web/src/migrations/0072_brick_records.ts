import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// What an App and a group keep of the Brick they were installed from, so
// they can be offered its newer revisions: for an App, the Brick, its
// revision and answers, kept encrypted beside its configuration since an
// answer can be a secret; for a group, its Brick, its answers and what its
// databases were made from, and which of the Brick's members each instance
// is. One made before this has none.
export const brickRecords: Migration = {
  id: 72,
  name: "brick_records",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const added = (table: string, column: string, definition: string) =>
      Effect.gen(function* () {
        const name = databaseTableName(table)
        const [found] = yield* sql<{ name: string }>`
          SELECT column_name AS name FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ${name}
             AND column_name = ${column}
        `
        if (!found) {
          yield* sql.unsafe(
            `ALTER TABLE \`${name}\` ADD COLUMN \`${column}\` ${definition}`
          )
        }
      })
    yield* added("app", "brick_ciphertext", "mediumtext DEFAULT NULL")
    yield* added("instance_group", "brick_source", "varchar(2048) DEFAULT NULL")
    yield* added(
      "instance_group",
      "brick_ciphertext",
      "mediumtext DEFAULT NULL"
    )
    yield* added(
      "instance_group_member",
      "member",
      "varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL"
    )
  }),
}
