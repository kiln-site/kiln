import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Joins pair through a Relay's announcements when it can
// (server/relay-join.server.ts), so Hearth needn't reach the Relay: a join
// keeps what its Relay said it can do (`features`), the pairing request
// Hearth's answers carry (`pairing_request`), and the Relay's signed reply
// (`pairing_response`).
//
// Relays' addresses stop being unique: machines behind one home router share
// its address, and ones that connect to Hearth themselves needn't be told
// apart by it. Joining still keeps one Relay per address Hearth can reach.
export const relayJoinPairing: Migration = {
  id: 34,
  name: "relay_join_pairing",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const join = databaseTableName("relay_join")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${join}
    `
    const has = (name: string) =>
      columns.some(({ columnName }) => columnName === name)
    for (const column of ["features", "pairing_request", "pairing_response"]) {
      if (!has(column)) {
        yield* sql.unsafe(`ALTER TABLE \`${join}\`
  ADD COLUMN \`${column}\` json DEFAULT NULL`)
      }
    }
    const relay = databaseTableName("relay")
    const indexes = yield* sql<{ indexName: string; nonUnique: number }>`
      SELECT index_name AS indexName, MIN(non_unique) AS nonUnique
      FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ${relay}
      GROUP BY index_name
    `
    const endpoint = indexes.find(
      ({ indexName }) => indexName === `${relay}_endpoint_unique`
    )
    if (endpoint && Number(endpoint.nonUnique) === 0) {
      yield* sql.unsafe(`ALTER TABLE \`${relay}\`
  DROP INDEX \`${relay}_endpoint_unique\`,
  ADD INDEX \`${relay}_endpoint_idx\` (\`hostname\`,\`port\`)`)
    }
  }),
}
