import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

const TARGET_KINDS = "enum('instance','database','platform','app','volume')"
// Long enough for an App's Compose volume, `<App ID>/<key>`.
const TARGET_ID = "varchar(200) CHARACTER SET ascii COLLATE ascii_bin"
const ARTIFACT_KINDS =
  "enum('archive','database_dump','platform_bundle','restic_snapshot','tar_archive')"

// Backups of Apps' folders and volumes: every table that names a backup's
// target takes the App and volume kinds and the longer IDs an App's volume
// has, and a backup and a download share their tar archives. A backup also
// records whether it's taken live or with what uses it stopped, so a
// dispatch after a restart asks the Relay for the same. Rows keep their
// values: each change only widens a column.
export const backupResourceTargets: Migration = {
  id: 42,
  name: "backup_resource_targets",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const backup = databaseTableName("backup")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${backup}
    `
    const consistency = columns.some(
      ({ columnName }) => columnName === "consistency"
    )
      ? ""
      : `,
  ADD COLUMN \`consistency\` enum('live','stopped') DEFAULT NULL`
    yield* sql.unsafe(`ALTER TABLE \`${backup}\`
  MODIFY \`target_kind\` ${TARGET_KINDS} NOT NULL,
  MODIFY \`target_id\` ${TARGET_ID} NOT NULL,
  MODIFY \`artifact_kind\` ${ARTIFACT_KINDS} NOT NULL${consistency}`)
    for (const table of ["backup_policy", "backup_repository"]) {
      yield* sql.unsafe(`ALTER TABLE \`${databaseTableName(table)}\`
  MODIFY \`target_kind\` ${TARGET_KINDS} NOT NULL,
  MODIFY \`target_id\` ${TARGET_ID} NOT NULL`)
    }
    yield* sql.unsafe(`ALTER TABLE \`${databaseTableName("backup_download_share")}\`
  MODIFY \`target_kind\` ${TARGET_KINDS} NOT NULL,
  MODIFY \`target_id\` ${TARGET_ID} NOT NULL,
  MODIFY \`artifact_kind\` ${ARTIFACT_KINDS} NOT NULL`)
  }),
}
