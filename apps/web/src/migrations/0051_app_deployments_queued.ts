import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// An App's deployment is queued as an operation, which keeps what was
// asked of it, so the request kept beside it goes. An image update's claim
// on a digest notes the deployment that made it, so that deployment run
// again knows the claim as its own.
export const appDeploymentsQueued: Migration = {
  id: 51,
  name: "app_deployments_queued",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const request = databaseTableName("app_deployment_request")
    const attempt = databaseTableName("app_image_update_attempt")
    yield* sql.unsafe(`DROP TABLE IF EXISTS \`${request}\``)
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${attempt}
         AND column_name = 'deployment_id'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${attempt}\`
  ADD COLUMN \`deployment_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
  }),
}
