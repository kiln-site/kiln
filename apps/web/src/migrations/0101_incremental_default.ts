import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { scheduleTargetKey } from "@workspace/contracts/schedules"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

/**
 * An incremental backup step backed up the game servers of its schedule, and
 * now backs up everything in it that it isn't told to leave out. In a schedule
 * with anything else, one names the game servers it backed up, so it goes on
 * backing up those alone: whoever saved it was never checked for the rest, even
 * what it named. What's sent of it is owed to the Relays again.
 *
 * And which format a snapshot's download is prepared as, null being the zip
 * they all were.
 */
export const incrementalDefault: Migration = {
  id: 101,
  name: "incremental_default",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const task = databaseTableName("backup_task")
    const found = yield* sql<{ found: number }>`
      SELECT 1 AS found FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${task}
        AND column_name = 'export_format'
    `
    if (found.length === 0) {
      yield* sql.unsafe(
        `ALTER TABLE \`${task}\` ADD COLUMN \`export_format\` varchar(16) CHARACTER SET ascii COLLATE ascii_bin NULL`
      )
    }
    const actionTable = sql(databaseTableName("schedule_action"))
    const actions = yield* sql<{
      config: unknown
      id: string
      scheduleId: string
    }>`
      SELECT id, schedule_id AS scheduleId, action_config AS config
        FROM ${actionTable}
       WHERE action_type = 'backup'
    `
    for (const action of actions) {
      const config = record(action.config)
      if (config?.mode !== "incremental") continue
      const targets = yield* sql<{
        id: string
        kind: "app" | "database" | "instance" | "relay" | "volume"
        relayId: string
      }>`
        SELECT relay_id AS relayId, target_kind AS kind, target_id AS id
          FROM ${sql(databaseTableName("schedule_target"))}
         WHERE schedule_id = ${action.scheduleId}
      `
      if (targets.every(({ kind }) => kind === "instance")) continue
      const servers = targets
        .filter(({ kind }) => kind === "instance")
        .map((target) => scheduleTargetKey(target))
      const chosen = config.targetKeys
      const named = JSON.stringify({
        ...config,
        targetKeys: Array.isArray(chosen)
          ? servers.filter((key) => chosen.includes(key))
          : servers,
      })
      yield* sql`
        UPDATE ${actionTable} SET action_config = ${named}
         WHERE id = ${action.id} AND schedule_id = ${action.scheduleId}
      `
      yield* sql`
        UPDATE ${sql(databaseTableName("schedule_deployment"))}
           SET status = 'pending',
               desired_generation = desired_generation + 1
         WHERE schedule_id = ${action.scheduleId}
      `
    }
  }),
}

// mysql2 returns JSON columns parsed, and MariaDB's as text.
function record(value: unknown): Record<string, unknown> | null {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
  return parsed !== null && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : null
}
