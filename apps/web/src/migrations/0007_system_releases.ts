import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Hearth's copy of Kiln's GitHub releases. Releases don't change once
// published, so Hearth asks GitHub only for ones newer than it has, and pages
// back through older ones when someone scrolls the changelog that far.
//
// `system_component_version` remembers the version each Panel and Relay ran
// before its current one, so the changelog can mark where it came from.
export const systemReleases: Migration = {
  id: 7,
  name: "system_releases",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const releases = databaseTableName("system_release")
    const versions = databaseTableName("system_component_version")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${releases}\` (
  \`tag\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`version\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`channel\` enum('nightly','stable') NOT NULL,
  \`aliases\` json DEFAULT NULL,
  \`notes\` mediumtext DEFAULT NULL,
  \`url\` varchar(512) NOT NULL,
  \`manifest_url\` varchar(512) NOT NULL,
  \`published_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`tag\`),
  KEY \`${releases}_published_idx\` (\`published_at\`,\`tag\`)
)`)
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${versions}\` (
  \`target_key\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`version\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`previous_version\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`changed_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`target_key\`)
)`)
  }),
}
