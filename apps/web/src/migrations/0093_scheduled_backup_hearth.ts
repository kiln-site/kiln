import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A Relay no longer holds a bucket's keys for a schedule's backups: it
// offers each one to the Hearth that sent the schedule, and to no other,
// and Hearth admits it only if it is one of the backups it told that Relay
// to take (`backup_executions`, written each time a schedule is sent).
//
// What each Relay holds of a schedule was sent before it kept which Hearth
// that was, and before Hearth kept what it had told it. So every schedule
// with a backup step is owed to its Relays again, as a change to it would
// leave it, and is sent once Hearth is up. Until it arrives, a backup such
// a schedule takes waits on its Relay, and Hearth decides nothing of it.
export const scheduledBackupHearth: Migration = {
  id: 93,
  name: "scheduled_backup_hearth",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const deployments = databaseTableName("schedule_deployment")
    const actions = databaseTableName("schedule_action")
    const [column] = yield* sql<{ found: number }>`
      SELECT 1 AS found
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ${deployments}
        AND column_name = 'backup_executions'
    `
    if (!column) {
      yield* sql.unsafe(
        `ALTER TABLE \`${deployments}\` ADD COLUMN \`backup_executions\` json DEFAULT NULL`
      )
    }
    // A schedule's backup for a bucket that is under way now was started
    // by a Relay holding the bucket's keys, at a path that Relay named.
    // It is not carried across: Hearth signs nothing for it, and the
    // schedule's next run takes it again.
    const now = Date.now()
    const under = `task.task_kind = 'create'
       AND task.status IN ('queued', 'running')
       AND backup.reason = 'scheduled' AND backup.storage_id IS NOT NULL`
    yield* sql.unsafe(
      `UPDATE \`${databaseTableName("backup_artifact")}\` artifact
         JOIN \`${databaseTableName("backup")}\` backup
           ON backup.id = artifact.backup_id
         JOIN \`${databaseTableName("backup_task")}\` task
           ON task.backup_id = backup.id
          SET artifact.status = 'failed', artifact.updated_at = ?
        WHERE ${under} AND artifact.status IN ('queued', 'running')`,
      [now]
    )
    yield* sql.unsafe(
      `UPDATE \`${databaseTableName("backup_task")}\` task
         JOIN \`${databaseTableName("backup")}\` backup
           ON backup.id = task.backup_id
          SET task.status = 'failed',
              task.error = 'It was under way as Kiln updated, and is not carried across',
              task.finished_at = ?, task.updated_at = ?,
              -- One being deleted stays so: its delete, which waited on
              -- this create, goes on now that the create has ended.
              backup.status = IF(backup.status = 'deleting', backup.status, 'failed'),
              backup.updated_at = ?
        WHERE ${under}`,
      [now, now, now]
    )
    yield* sql`
      UPDATE ${sql(deployments)} deployment
         SET deployment.status = 'pending',
             deployment.desired_generation = deployment.desired_generation + 1
       WHERE EXISTS (
               SELECT 1 FROM ${sql(actions)} action
                WHERE action.schedule_id = deployment.schedule_id
                  AND action.action_type = 'backup'
             )
    `
  }),
}
