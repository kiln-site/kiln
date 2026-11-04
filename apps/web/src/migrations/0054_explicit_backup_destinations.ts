import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every backup names where it goes: a target no longer has a preferred
// destination to fall back on. What still leaned on one is settled here, to
// what it would have used, before the preference goes: a server migration,
// which reads its final backup's destination only once it reaches that step,
// in its row and in the operation that runs it. A scheduled backup never used
// the preference, and one saved without a destination ran on its Relay.
export const explicitBackupDestinations: Migration = {
  id: 54,
  name: "explicit_backup_destinations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const action = databaseTableName("schedule_action")
    yield* sql.unsafe(`UPDATE \`${action}\`
  SET action_config = JSON_SET(
    action_config, '$.destination', JSON_EXTRACT('{"kind":"local"}', '$')
  )
  WHERE action_type = 'backup'
    AND NOT JSON_CONTAINS_PATH(action_config, 'one', '$.destination')`)

    const policy = databaseTableName("backup_policy")
    const [column] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${policy}
         AND column_name = 'storage_id'
    `
    if (Number(column?.count ?? 0) === 0) return

    // Left out, and no policy of its own, was the Relay: a JSON null.
    const pin = (
      table: string,
      document: string,
      path: string,
      relayId: string,
      instanceId: string,
      only: string
    ) =>
      sql.unsafe(`UPDATE \`${table}\` target
  LEFT JOIN \`${policy}\` policy
    ON policy.relay_id = ${relayId}
   AND policy.target_kind = 'instance'
   AND policy.target_id = ${instanceId}
  SET target.${document} = JSON_SET(
    target.${document}, '${path}.storageId', policy.storage_id
  )
  WHERE ${only}
    AND JSON_TYPE(JSON_EXTRACT(target.${document}, '${path}')) = 'OBJECT'
    AND NOT JSON_CONTAINS_PATH(target.${document}, 'one', '${path}.storageId')`)

    const migration = databaseTableName("server_migration")
    const operation = databaseTableName("operation")
    for (const option of ["backup", "deleteSource"]) {
      yield* pin(
        migration,
        "options",
        `$.${option}`,
        "target.source_relay_id",
        "target.source_instance_id",
        "1 = 1"
      )
      yield* pin(
        operation,
        "input",
        `$.options.${option}`,
        "JSON_UNQUOTE(JSON_EXTRACT(target.input, '$.source.relayId'))",
        "JSON_UNQUOTE(JSON_EXTRACT(target.input, '$.source.instanceId'))",
        "target.kind = 'server.migration'"
      )
    }

    const keys = yield* sql<{ name: string }>`
      SELECT constraint_name AS name FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ${policy}
         AND column_name = 'storage_id'
         AND referenced_table_name IS NOT NULL
    `
    yield* sql.unsafe(`ALTER TABLE \`${policy}\` ${[
      ...keys.map((key) => `DROP FOREIGN KEY \`${key.name}\``),
      "DROP COLUMN `storage_id`",
    ].join(", ")}`)
  }),
}
