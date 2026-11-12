import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A scheduled backup of an App is of its volumes alone now, each sent once
// with every App of the step that uses it. What each Relay holds of such a
// schedule was sent the older way, an App's folder among it, and its Relay
// refuses to run that rather than back the App up short. Every schedule
// that backs up an App is owed to its Relays again, as a change to it would
// leave it, and is sent once Hearth is up.
export const appBackupSchedules: Migration = {
  id: 74,
  name: "app_backup_schedules",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const deployments = databaseTableName("schedule_deployment")
    const targets = databaseTableName("schedule_target")
    const actions = databaseTableName("schedule_action")
    yield* sql`
      UPDATE ${sql(deployments)} deployment
         SET deployment.status = 'pending',
             deployment.desired_generation = deployment.desired_generation + 1
       WHERE EXISTS (
               SELECT 1 FROM ${sql(targets)} target
                WHERE target.schedule_id = deployment.schedule_id
                  AND target.relay_id = deployment.relay_id
                  AND target.target_kind = 'app'
             )
         AND EXISTS (
               SELECT 1 FROM ${sql(actions)} action
                WHERE action.schedule_id = deployment.schedule_id
                  AND action.action_type = 'backup'
             )
    `
  }),
}
