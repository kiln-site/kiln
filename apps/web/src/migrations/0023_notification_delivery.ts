import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// When each notification may be pushed, when an open tab showed it, and when
// it was pushed. Ones that wait set `push_pending` to 2, which Hearths from
// before this ignore. A push waits briefly so a tab the user is using can show it
// instead; one a tab showed isn't pushed. A notification pushed and then read
// or cleared is closed on the user's devices. Only new rows set them, so
// existing rows need no backfill, and each column is skipped once added, so a
// migration that stopped partway finishes on the next start.
export const notificationDelivery: Migration = {
  id: 23,
  name: "notification_delivery",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const notification = databaseTableName("notification")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${notification}
    `
    for (const column of ["push_due_at", "seen_at", "pushed_at"]) {
      if (columns.some(({ columnName }) => columnName === column)) continue
      yield* sql.unsafe(`ALTER TABLE \`${notification}\`
  ADD COLUMN \`${column}\` bigint unsigned DEFAULT NULL`)
    }
  }),
}
