import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Deployments asked for and not yet started, one row per app, so a push,
// poll or image update that arrives while one runs isn't lost, even across
// a restart. Each kind of request is kept, and the revision counts every
// request, so the one that started can tell whether another came since.
export const appDeploymentRequests: Migration = {
  id: 49,
  name: "app_deployment_requests",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const request = databaseTableName("app_deployment_request")
    const appTable = databaseTableName("app")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${request}\` (
  \`app_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`push\` tinyint(1) NOT NULL DEFAULT '0',
  \`poll\` tinyint(1) NOT NULL DEFAULT '0',
  \`image_update\` tinyint(1) NOT NULL DEFAULT '0',
  \`revision\` bigint unsigned NOT NULL DEFAULT '1',
  \`requested_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`app_id\`),
  CONSTRAINT \`${request}_app_fk\` FOREIGN KEY (\`app_id\`) REFERENCES \`${appTable}\` (\`app_id\`) ON DELETE CASCADE
)`)
  }),
}
