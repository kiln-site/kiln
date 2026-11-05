import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// What an app's branch held when its source was chosen, which checking the
// branch must not take for a push. Sources from before this have none.
export const appSourceBaseline: Migration = {
  id: 55,
  name: "app_source_baseline",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const source = databaseTableName("app_github_source")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${source}
         AND column_name = 'baseline_commit'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${source}\`
  ADD COLUMN \`baseline_commit\` char(40) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER \`branch\``)
  }),
}
