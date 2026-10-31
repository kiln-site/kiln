import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// An App's deployment is queued as an operation, which keeps what was
// asked of it, so the request kept beside it goes: each one still waiting
// becomes the App's queued deployment first, under the App, so running
// this again queues no second one. An image update's claim on a digest
// notes the deployment that made it, so that deployment run again knows
// the claim as its own.
export const appDeploymentsQueued: Migration = {
  id: 51,
  name: "app_deployments_queued",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const request = databaseTableName("app_deployment_request")
    const operation = databaseTableName("operation")
    const attempt = databaseTableName("app_image_update_attempt")
    const has = (table: string, column?: string) =>
      sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ${table}
           ${column === undefined ? sql`` : sql`AND column_name = ${column}`}
      `.pipe(Effect.map(([found]) => Number(found?.count ?? 0) > 0))
    if (yield* has(request)) {
      yield* sql.unsafe(`INSERT IGNORE INTO \`${operation}\`
  (id, kind, version, queue_key, input, state, trace_sampled, created_at,
   updated_at)
SELECT UUID(), 'app.deploy', 1, CONCAT(relay_id, '/', app_id),
       JSON_OBJECT('appId', app_id, 'relayId', relay_id,
         'trigger', IF(push, 'push', IF(image_update, 'update', 'poll')),
         'requestedBy', NULL),
       'waiting', 0, requested_at, requested_at
  FROM \`${request}\``)
      yield* sql.unsafe(`DROP TABLE \`${request}\``)
    }
    if (yield* has(attempt, "deployment_id")) return
    yield* sql.unsafe(`ALTER TABLE \`${attempt}\`
  ADD COLUMN \`deployment_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
  }),
}
