import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Whether a platform backup alone, with Kiln's recovery code, restores Kiln
// on a new machine (format 2), so Kiln can say whether one exists away from
// this machine. Backups from before say no, as they can't.
export const recoverableBackups: Migration = {
  id: 92,
  name: "recoverable_backups",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const backup = databaseTableName("backup")
    const [found] = yield* sql<{ found: number }>`
      SELECT COUNT(*) AS found FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ${backup}
        AND column_name = 'recoverable'
    `
    if (Number(found?.found ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${backup}\`
  ADD COLUMN \`recoverable\` tinyint(1) NOT NULL DEFAULT 0 AFTER \`artifact_kind\``)
  }),
}
