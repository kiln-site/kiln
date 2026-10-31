import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// The trigger of a sync's run asked for and not yet finished, so a manual
// run, edit or push isn't lost while another runs, or across a restart.
// Its revision counts each one asked for, and the run that took it notes
// which, so finishing clears only what it took. A sync with one asked for
// since shows as queued.
export const githubSyncQueuedTrigger: Migration = {
  id: 50,
  name: "github_sync_queued_trigger",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const sync = databaseTableName("github_sync")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${sync}
         AND column_name = 'queued_trigger'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${sync}\`
  ADD COLUMN \`queued_trigger\` varchar(16) DEFAULT NULL,
  ADD COLUMN \`queued_revision\` bigint unsigned NOT NULL DEFAULT '0',
  ADD COLUMN \`taken_revision\` bigint unsigned NOT NULL DEFAULT '0'`)
  }),
}
