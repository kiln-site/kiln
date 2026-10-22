import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Whether each image app's tag names a newer image than the one it runs,
// and what to do about it: tell the people who can deploy it, or deploy it
// once it's been out a while. Each digest an image update deployed is
// kept, so a failed one isn't tried again.
export const appImageUpdates: Migration = {
  id: 20,
  name: "app_image_updates",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const updates = databaseTableName("app_image_update")
    const attempts = databaseTableName("app_image_update_attempt")
    const appTable = databaseTableName("app")
    const deployment = databaseTableName("app_deployment")

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${updates}\` (
  \`app_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`mode\` enum('off','notify','auto') NOT NULL DEFAULT 'notify',
  \`delay_hours\` smallint unsigned NOT NULL DEFAULT '72',
  \`state\` enum('current','available','changed','untracked','not_deployed') DEFAULT NULL,
  \`image\` varchar(512) DEFAULT NULL,
  \`running_digest\` char(71) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`latest_digest\` char(71) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`latest_seen_at\` bigint unsigned DEFAULT NULL,
  \`skipped_digest\` char(71) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`checked_at\` bigint unsigned DEFAULT NULL,
  \`check_error\` varchar(500) DEFAULT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`app_id\`),
  CONSTRAINT \`${updates}_app_fk\` FOREIGN KEY (\`app_id\`) REFERENCES \`${appTable}\` (\`app_id\`) ON DELETE CASCADE
)`)

    // Every digest an image update deployed, however it went, so one isn't
    // deployed on its own again after its record is pruned.
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${attempts}\` (
  \`app_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`digest\` char(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`attempted_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`app_id\`, \`digest\`),
  CONSTRAINT \`${attempts}_app_fk\` FOREIGN KEY (\`app_id\`) REFERENCES \`${appTable}\` (\`app_id\`) ON DELETE CASCADE
)`)

    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${deployment}
    `
    if (!columns.some((column) => column.columnName === "image_digest")) {
      yield* sql.unsafe(`ALTER TABLE \`${deployment}\`
  ADD COLUMN \`image_digest\` char(71) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER \`commit_author\``)
    }
    yield* sql.unsafe(`ALTER TABLE \`${deployment}\`
  MODIFY \`trigger\` enum('manual','push','poll','redeploy','update') NOT NULL`)
  }),
}
