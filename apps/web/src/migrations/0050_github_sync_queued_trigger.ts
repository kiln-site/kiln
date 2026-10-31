import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// The trigger of a sync's run asked for and not yet taken, so a manual run,
// edit or push isn't lost while another runs, or across a restart. A sync
// with one shows as queued.
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
  ADD COLUMN \`queued_trigger\` varchar(16) DEFAULT NULL`)
  }),
}
