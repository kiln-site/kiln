import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A database deploys again as a game server and an App do, so its
// deployments are recorded beside theirs.
export const databaseDeployments: Migration = {
  id: 64,
  name: "database_deployments",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("deployment")
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
      MODIFY \`instance_kind\` enum('app','server','database') NOT NULL DEFAULT 'app'`)
  }),
}
