import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every way to ask an app to deploy joins one request, the newest ask's
// trigger and target winning: a push's or a redeploy's commit, a redeploy's
// digest and the image it was of. A person's ask is kept, by who made it,
// until a deployment takes it, and a deployment takes it as it plans, so
// what's left is waiting. The kinds asked for, each a flag, become the
// trigger of the newest.
export const appDeploymentOneRequest: Migration = {
  id: 53,
  name: "app_deployment_one_request",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const request = databaseTableName("app_deployment_request")
    const has = (name: string) =>
      sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ${request}
           AND column_name = ${name}
      `.pipe(Effect.map(([found]) => Number(found?.count ?? 0) > 0))
    if (!(yield* has("trigger"))) {
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  ADD COLUMN \`trigger\` enum('manual','poll','push','redeploy','update') NOT NULL DEFAULT 'poll'`)
    }
    if (yield* has("push")) {
      yield* sql.unsafe(`UPDATE \`${request}\`
   SET \`trigger\` = IF(push, 'push', IF(image_update, 'update', 'poll'))`)
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  DROP COLUMN \`push\`, DROP COLUMN \`poll\`, DROP COLUMN \`image_update\``)
    }
    if (!(yield* has("requested_by"))) {
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  ADD COLUMN \`requested_by\` varchar(36) DEFAULT NULL`)
    }
    if (!(yield* has("image_digest"))) {
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  ADD COLUMN \`image_digest\` varchar(100) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD COLUMN \`image_source\` varchar(512) DEFAULT NULL`)
    }
    if (!(yield* has("taken_by"))) {
      yield* sql.unsafe(`ALTER TABLE \`${request}\`
  ADD COLUMN \`taken_by\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
    }
  }),
}
