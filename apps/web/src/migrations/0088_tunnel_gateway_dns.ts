import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

// A tunnel's DNS is one hosts file per gateway. Each gateway records whether
// it has the latest, and when to try again if it missed it, so Hearth's DNS
// worker brings a gateway that was away up to date.
//
// Each step looks before it acts, so a migration cut short finishes when it
// runs again.
export const tunnelGatewayDns: Migration = {
  id: 88,
  name: "tunnel_gateway_dns",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const gateway = databaseTableName("tunnel_gateway")
    if (!(yield* columnExists(sql, gateway, "dns_pending"))) {
      yield* sql.unsafe(`ALTER TABLE \`${gateway}\`
  ADD COLUMN \`dns_pending\` tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN \`dns_attempts\` smallint unsigned NOT NULL DEFAULT 0,
  ADD COLUMN \`dns_next_attempt_at\` bigint unsigned DEFAULT NULL,
  ADD COLUMN \`dns_last_error\` varchar(512) DEFAULT NULL,
  ADD KEY \`${gateway}_dns_idx\` (\`dns_pending\`, \`dns_next_attempt_at\`)`)
    }
  }),
}

function columnExists(sql: Sql, table: string, column: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}
