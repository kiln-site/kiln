import { migrateLegacyTailscaleBindings } from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Tailscale members are named by kind: `instance:<id>` for a game server,
// which bindings named by its bare ID before, beside `app:<id>:<service>`.
// Hearth keeps each Relay's deployment of a network as it last saw it;
// those rewrite their bindings one row at a time, so a retry after a crash
// skips rows already rewritten. A row that can't be read is left as it is,
// as cleanup already leaves one.
export const tailscaleMemberIds: Migration = {
  id: 39,
  name: "tailscale_member_ids",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("tailscale_network_deployment")
    const rows = yield* sql<{
      deployment: unknown
      networkId: string
      relayId: string
    }>`
      SELECT network_id AS networkId, relay_id AS relayId, deployment
        FROM ${sql(table)}
    `
    for (const row of rows) {
      const migrated = yield* Effect.try(() =>
        migrateLegacyTailscaleBindings(
          typeof row.deployment === "string"
            ? JSON.parse(row.deployment)
            : row.deployment
        )
      ).pipe(Effect.orElseSucceed(() => null))
      if (!migrated) continue
      // Its cleanup's schedule stays as it was.
      yield* sql`
        UPDATE ${sql(table)}
           SET deployment = ${JSON.stringify(migrated)},
               updated_at = updated_at
         WHERE network_id = ${row.networkId} AND relay_id = ${row.relayId}
      `
    }
  }),
}
