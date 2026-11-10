import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A database runs a Brick, which says its image and the port it listens
// on, where both used to follow from its engine. Its record keeps them now,
// with the Brick it runs. One made before then ran its engine's fixed image
// and port, which is what it is given here: the last use of that table.
export const databaseBricks: Migration = {
  id: 66,
  name: "database_bricks",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("database")
    const columns = new Set(
      (yield* sql<{ name: string }>`
        SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ${table}
      `).map((column) => column.name)
    )
    const added = [
      ...(columns.has("brick_id")
        ? []
        : [
            "ADD COLUMN `brick_id` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER `engine`",
          ]),
      // Where its Brick came from; unknown for one made before Bricks.
      ...(columns.has("brick_source")
        ? []
        : [
            "ADD COLUMN `brick_source` varchar(2048) DEFAULT NULL AFTER `brick_id`",
          ]),
      // Null from when it is recorded until its Relay says what it runs.
      ...(columns.has("image")
        ? []
        : ["ADD COLUMN `image` varchar(512) DEFAULT NULL AFTER `brick_source`"]),
      ...(columns.has("internal_port")
        ? []
        : [
            "ADD COLUMN `internal_port` int unsigned DEFAULT NULL AFTER `image`",
          ]),
    ]
    if (added.length > 0) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ${added.join(",\n  ")}`)
    }
    yield* sql`
      UPDATE ${sql(table)}
         SET brick_id = engine,
             image = CASE engine
               WHEN 'mysql' THEN 'mysql:8.4'
               WHEN 'mariadb' THEN 'mariadb:11.8'
               WHEN 'postgres' THEN 'postgres:17'
               WHEN 'redis' THEN 'redis:8'
               WHEN 'valkey' THEN 'valkey/valkey:8'
             END,
             internal_port = CASE engine
               WHEN 'postgres' THEN 5432
               WHEN 'redis' THEN 6379
               WHEN 'valkey' THEN 6379
               ELSE 3306
             END
       WHERE brick_id IS NULL
    `
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
  MODIFY \`brick_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  MODIFY \`internal_port\` int unsigned NOT NULL`)
  }),
}
