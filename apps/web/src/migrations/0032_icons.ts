import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// The pictures Kiln shows for game servers, apps, databases, and accounts.
// Each subject has up to two: one someone chose (`custom`) and one Hearth
// found itself (`detected`), such as a game server's `server-icon.png` or an
// app's site icon. A custom one is shown over a detected one. A detected row
// without an image records that Hearth looked and found nothing, and
// `origin_version` what it looked at, so unchanged files aren't read again.
// Users have no Relay, so their `relay_id` is empty. Like favorites, rows
// have no foreign keys; deleting a subject removes its rows.
export const icons: Migration = {
  id: 32,
  name: "icons",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("icon")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`subject_kind\` enum('server','app','database','user') NOT NULL,
  \`relay_id\` varchar(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`subject_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`source\` enum('custom','detected') NOT NULL,
  \`content_type\` varchar(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`image\` mediumblob DEFAULT NULL,
  \`digest\` char(16) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`origin\` json DEFAULT NULL,
  \`origin_version\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`checked_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`subject_kind\`,\`relay_id\`,\`subject_id\`,\`source\`)
)`)
  }),
}
