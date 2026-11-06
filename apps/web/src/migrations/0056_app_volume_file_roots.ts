import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A volume opened through an App has a file root of its own, whose ID is
// longer than any root before it, and its recent and pinned files key on it.
export const appVolumeFileRoots: Migration = {
  id: 56,
  name: "app_volume_file_roots",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("file_activity")
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
  MODIFY \`root_id\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`)
  }),
}
