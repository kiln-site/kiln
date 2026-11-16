import { migratedTunnelId } from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

// Each Tailscale network's node on a Relay becomes a tunnel, an instance of
// its own, and the network a tailnet: an instance group of its tunnels,
// with what they share kept beside it.
//
// - The network keeps its ID, as its group's: `tailscale_network` becomes
//   `tailnet`, its name moves to the group, and the directory holds its ID
//   as a group's.
// - Each of its deployments becomes a tunnel, in `tunnel`, whose ID is
//   worked out from the network's and the Relay's (`migratedTunnelId`), as
//   that Relay works it out on its side. The directory reserves it, and the
//   migration stops if another instance already has it. The network's owner
//   owns it, and it is a member of the network's group.
// - What Hearth last saw of each node is kept as the tunnel's: its ID and
//   tailnet, and its power state in place of the game server it read as.
//
// Each step looks before it acts, so a migration cut short finishes when it
// runs again.
export const tunnels: Migration = {
  id: 79,
  name: "tunnels",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const network = databaseTableName("tailscale_network")
    const deployment = databaseTableName("tailscale_network_deployment")
    const tailnet = databaseTableName("tailnet")
    const tunnel = databaseTableName("tunnel")
    const group = databaseTableName("instance_group")
    const member = databaseTableName("instance_group_member")
    const directory = databaseTableName("instance_id")

    yield* sql.unsafe(`ALTER TABLE \`${directory}\`
  MODIFY \`kind\` enum('relay','server','app','database','tailscale','group','tunnel') NOT NULL`)
    yield* sql.unsafe(`ALTER TABLE \`${member}\`
  MODIFY \`instance_kind\` enum('server','app','database','tunnel') NOT NULL`)

    if (yield* tableExists(sql, network)) {
      yield* sql.unsafe(`INSERT IGNORE INTO \`${group}\`
    (id, name, created_by, created_at, updated_at)
  SELECT id, name, COALESCE(owner_id, ''), created_at, updated_at
    FROM \`${network}\``)
      yield* sql.unsafe(`UPDATE \`${directory}\` SET kind = 'group'
  WHERE kind = 'tailscale' AND id IN (SELECT id FROM \`${network}\`)`)
      yield* sql.unsafe(`RENAME TABLE \`${network}\` TO \`${tailnet}\``)
    }
    if (yield* columnExists(sql, tailnet, "name")) {
      yield* sql.unsafe(`ALTER TABLE \`${tailnet}\` DROP COLUMN \`name\``)
    }

    if (!(yield* tableExists(sql, deployment))) return
    const oldKey = `${deployment}_network_fk`
    if (yield* constraintExists(sql, deployment, oldKey)) {
      yield* sql.unsafe(
        `ALTER TABLE \`${deployment}\` DROP FOREIGN KEY \`${oldKey}\``
      )
    }
    if (yield* columnExists(sql, deployment, "network_id")) {
      yield* sql.unsafe(`ALTER TABLE \`${deployment}\`
  CHANGE \`network_id\` \`tailnet_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CHANGE \`deployment\` \`state\` json NOT NULL,
  ADD COLUMN \`id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NULL FIRST,
  ADD COLUMN \`owner_id\` varchar(36) DEFAULT NULL AFTER \`relay_id\``)
    }

    const rows = yield* sql<{
      owner_id: string | null
      relay_id: string
      state: unknown
      tailnet_id: string
    }>`
      SELECT deployment.tailnet_id, deployment.relay_id, deployment.state,
             tailnet.owner_id
        FROM ${sql(deployment)} deployment
        LEFT JOIN ${sql(tailnet)} tailnet ON tailnet.id = deployment.tailnet_id
       WHERE deployment.id IS NULL
    `
    const now = Date.now()
    for (const row of rows) {
      const id = yield* Effect.promise(() =>
        migratedTunnelId(row.tailnet_id, row.relay_id)
      )
      const [held] = yield* sql<{ kind: string }>`
        SELECT kind FROM ${sql(directory)} WHERE id = ${id}
      `
      if (held && held.kind !== "tunnel") {
        return yield* Effect.die(
          new Error(
            `The tunnel ID ${id} for network ${row.tailnet_id} on Relay ${row.relay_id} is already a ${held.kind}'s`
          )
        )
      }
      if (!held) {
        yield* sql`
          INSERT INTO ${sql(directory)} (id, kind, relay_id, created_at)
          VALUES (${id}, 'tunnel', ${row.relay_id}, ${now})
        `
      }
      yield* sql`
        UPDATE ${sql(deployment)}
           SET id = ${id}, owner_id = ${row.owner_id},
               state = ${JSON.stringify(tunnelState(row.state, id, row.tailnet_id))}
         WHERE tailnet_id = ${row.tailnet_id} AND relay_id = ${row.relay_id}
      `
      yield* sql`
        INSERT IGNORE INTO ${sql(member)}
          (instance_id, group_id, instance_kind, relay_id, created_at)
        VALUES (${id}, ${row.tailnet_id}, 'tunnel', ${row.relay_id}, ${now})
      `
    }

    if (!(yield* indexExists(sql, deployment, `${tunnel}_tailnet_relay`))) {
      yield* sql.unsafe(`ALTER TABLE \`${deployment}\`
  MODIFY \`id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (\`id\`),
  ADD UNIQUE KEY \`${tunnel}_tailnet_relay\` (\`tailnet_id\`, \`relay_id\`)`)
    }
    if (!(yield* constraintExists(sql, deployment, `${tunnel}_tailnet_fk`))) {
      yield* sql.unsafe(`ALTER TABLE \`${deployment}\`
  ADD CONSTRAINT \`${tunnel}_tailnet_fk\` FOREIGN KEY (\`tailnet_id\`)
  REFERENCES \`${tailnet}\` (\`id\`) ON DELETE CASCADE`)
    }
    yield* sql.unsafe(`RENAME TABLE \`${deployment}\` TO \`${tunnel}\``)
  }),
}

// What Hearth last saw of a node, as its tunnel's.
function tunnelState(saved: unknown, id: string, tailnetId: string) {
  const parsed: unknown = typeof saved === "string" ? JSON.parse(saved) : saved
  const { instance, ...rest } =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  const observed =
    typeof instance === "object" && instance !== null
      ? (instance as { observedState?: unknown }).observedState
      : undefined
  return {
    ...rest,
    id,
    observedState: typeof observed === "string" ? observed : "stopped",
    tailnetId,
  }
}

function tableExists(sql: Sql, name: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = ?`,
      [name]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}

function columnExists(sql: Sql, name: string, column: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [name, column]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}

function indexExists(sql: Sql, name: string, index: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [name, index]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}

function constraintExists(sql: Sql, name: string, constraint: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.table_constraints
WHERE table_schema = DATABASE() AND table_name = ?
  AND constraint_name = ? AND constraint_type = 'FOREIGN KEY'`,
      [name, constraint]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}
