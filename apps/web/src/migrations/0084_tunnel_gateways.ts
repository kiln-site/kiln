import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

// A tailnet becomes a tunnel: one instance, with the Relays it reaches as
// its gateways, which aren't instances. What each was kept as is renamed for
// what it is now:
//
// - `tunnel` (a tailnet's Relay) becomes `tunnel_gateway`, and `tailnet`
//   becomes `tunnel`, keeping its ID. Its name moves to it from its
//   instance group, which goes, with its members: a tunnel is no group.
// - `tailnet_domain` becomes `tunnel_domain`, and every `tailnet_id` a
//   `tunnel_id`.
// - The directory holds a tunnel's ID as a tunnel's, and a gateway's as a
//   gateway's, so neither is handed out again.
// - A gateway's deployments are recorded as a gateway's.
// - A tunnel names the Brick it runs; its gateways' saved state says which.
//
// Each step looks before it acts, so a migration cut short finishes when it
// runs again.
export const tunnelGateways: Migration = {
  id: 84,
  name: "tunnel_gateways",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tailnet = databaseTableName("tailnet")
    const tunnel = databaseTableName("tunnel")
    const gateway = databaseTableName("tunnel_gateway")
    const tailnetDomain = databaseTableName("tailnet_domain")
    const domain = databaseTableName("tunnel_domain")
    const name = databaseTableName("tunnel_name")
    const group = databaseTableName("instance_group")
    const member = databaseTableName("instance_group_member")
    const directory = databaseTableName("instance_id")
    const deployment = databaseTableName("deployment")

    if (yield* tableExists(sql, tailnet)) {
      if (
        !(yield* tableExists(sql, gateway)) &&
        (yield* tableExists(sql, tunnel))
      ) {
        yield* sql.unsafe(`RENAME TABLE \`${tunnel}\` TO \`${gateway}\``)
      }
      yield* sql.unsafe(`RENAME TABLE \`${tailnet}\` TO \`${tunnel}\``)
    }
    if (yield* tableExists(sql, tailnetDomain)) {
      yield* sql.unsafe(`RENAME TABLE \`${tailnetDomain}\` TO \`${domain}\``)
    }
    for (const table of [gateway, domain, name]) {
      if (yield* columnExists(sql, table, "tailnet_id")) {
        yield* sql.unsafe(
          `ALTER TABLE \`${table}\` RENAME COLUMN \`tailnet_id\` TO \`tunnel_id\``
        )
      }
    }

    if (!(yield* columnExists(sql, tunnel, "name"))) {
      yield* sql.unsafe(`ALTER TABLE \`${tunnel}\`
  ADD COLUMN \`name\` varchar(120) NOT NULL DEFAULT '' AFTER \`id\``)
    }
    yield* sql.unsafe(`UPDATE \`${tunnel}\` tunnel
  JOIN \`${group}\` tunnel_group ON tunnel_group.id = tunnel.id
   SET tunnel.name = tunnel_group.name
 WHERE tunnel.name = ''`)
    if (!(yield* columnExists(sql, tunnel, "brick_source"))) {
      yield* sql.unsafe(`ALTER TABLE \`${tunnel}\`
  ADD COLUMN \`brick_source\` varchar(2048) DEFAULT NULL AFTER \`name\``)
      yield* sql.unsafe(`UPDATE \`${tunnel}\` tunnel
   SET brick_source = (
     SELECT JSON_UNQUOTE(JSON_EXTRACT(gateway.state, '$.brick.source'))
       FROM \`${gateway}\` gateway
      WHERE gateway.tunnel_id = tunnel.id
        AND JSON_TYPE(JSON_EXTRACT(gateway.state, '$.brick.source')) = 'STRING'
      LIMIT 1
   )`)
    }

    yield* sql.unsafe(`ALTER TABLE \`${directory}\`
  MODIFY \`kind\` enum('relay','server','app','database','tailscale','group','tunnel','gateway') NOT NULL`)
    yield* sql.unsafe(`UPDATE \`${directory}\` SET kind = 'gateway'
  WHERE kind = 'tunnel' AND id IN (SELECT id FROM \`${gateway}\`)`)
    yield* sql.unsafe(`UPDATE \`${directory}\` SET kind = 'tunnel'
  WHERE kind = 'group' AND id IN (SELECT id FROM \`${tunnel}\`)`)
    yield* sql.unsafe(
      `DELETE FROM \`${member}\` WHERE group_id IN (SELECT id FROM \`${tunnel}\`)`
    )
    yield* sql.unsafe(
      `DELETE FROM \`${group}\` WHERE id IN (SELECT id FROM \`${tunnel}\`)`
    )

    yield* sql.unsafe(`ALTER TABLE \`${deployment}\`
  MODIFY \`instance_kind\` enum('app','server','database','tunnel','gateway') NOT NULL DEFAULT 'app'`)
    yield* sql.unsafe(
      `UPDATE \`${deployment}\` SET instance_kind = 'gateway' WHERE instance_kind = 'tunnel'`
    )
  }),
}

function tableExists(sql: Sql, table: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
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
