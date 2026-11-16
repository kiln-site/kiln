import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A tunnel deploys again as every other kind does, so its deployments are
// recorded beside theirs.
export const tunnelDeployments: Migration = {
  id: 80,
  name: "tunnel_deployments",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("deployment")
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
      MODIFY \`instance_kind\` enum('app','server','database','tunnel') NOT NULL DEFAULT 'app'`)
  }),
}
