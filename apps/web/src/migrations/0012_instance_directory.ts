import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

export const instanceDirectory: Migration = {
  id: 12,
  name: "instance_directory",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("instance")
    yield* sql.unsafe(
      `ALTER TABLE \`${table}\` ADD COLUMN \`directory_metadata\` json DEFAULT NULL`
    )
  }),
}
