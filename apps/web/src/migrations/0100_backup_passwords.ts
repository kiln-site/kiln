import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

/**
 * A backup destination's own password, which its owner can open its
 * incremental backups with. Null until it's first needed. Schedules carry it
 * to their Relays, so every one that backs up is owed to them again.
 */
export const backupPasswords: Migration = {
  id: 100,
  name: "backup_passwords",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("backup_storage")
    const found = yield* sql<{ found: number }>`
      SELECT 1 AS found FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
        AND column_name = 'password_ciphertext'
    `
    if (found.length > 0) return
    yield* sql.unsafe(
      `ALTER TABLE \`${table}\` ADD COLUMN \`password_ciphertext\` text NULL`
    )
    yield* sql`
      UPDATE ${sql(databaseTableName("schedule_deployment"))} deployment
         SET deployment.status = 'pending',
             deployment.desired_generation = deployment.desired_generation + 1
       WHERE EXISTS (
               SELECT 1 FROM ${sql(databaseTableName("schedule_action"))} action
                WHERE action.schedule_id = deployment.schedule_id
                  AND action.action_type = 'backup'
             )
    `
  }),
}
