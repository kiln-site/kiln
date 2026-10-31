import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// An app's deployment request is kept once taken, its revision counting on,
// so a deployment acknowledges only what it took and one asked for since
// still waits. A push pins the commit it deploys, and the repository and
// branch it came from, so one changed since deploys its new branch instead.
export const appDeploymentIntent: Migration = {
  id: 51,
  name: "app_deployment_intent",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const request = databaseTableName("app_deployment_request")
    const has = (name: string) =>
      sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ${request}
           AND column_name = ${name}
      `.pipe(Effect.map(([found]) => Number(found?.count ?? 0) > 0))
    if (!(yield* has("commit_sha"))) {
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  ADD COLUMN \`commit_sha\` char(40) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
    }
    if (!(yield* has("commit_source"))) {
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  ADD COLUMN \`commit_source\` varchar(300) DEFAULT NULL`)
    }
    if (!(yield* has("acknowledged_revision"))) {
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  ADD COLUMN \`acknowledged_revision\` bigint unsigned NOT NULL DEFAULT '0'`)
    }
  }),
}
