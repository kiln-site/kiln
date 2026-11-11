import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Instance groups: a record that keeps instances of any kind together, and
// which instances it keeps. A group has an ID of its own in the instance
// directory. An instance is in one group at most, and IDs are unique across
// kinds, so a member is found by its ID alone. Like favorites, the rows have
// no foreign keys: what removes an instance or a Relay removes its
// memberships.
export const instanceGroups: Migration = {
  id: 71,
  name: "instance_groups",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`ALTER TABLE \`${databaseTableName("instance_id")}\`
  MODIFY \`kind\` enum('relay','server','app','database','tailscale','group') NOT NULL`)
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${databaseTableName("instance_group")}\` (
  \`id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`name\` varchar(120) NOT NULL,
  \`created_by\` varchar(36) NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`)
)`)
    const members = databaseTableName("instance_group_member")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${members}\` (
  \`instance_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`group_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`instance_kind\` enum('server','app','database') NOT NULL,
  \`relay_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`instance_id\`),
  KEY \`${members}_group_idx\` (\`group_id\`),
  KEY \`${members}_relay_idx\` (\`relay_id\`)
)`)
  }),
}
