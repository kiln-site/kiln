import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A tunnel runs a Brick, which its Relay records with the images it runs.
// What Hearth last saw of each tunnel made before then names the Brick it
// runs as its Relay does: Kiln's `tailscale` Brick at the images every
// tunnel ran then, with no source. Each tunnel is looked at before it is
// changed, so a migration cut short finishes when it runs again.
export const tunnelBricks: Migration = {
  id: 83,
  name: "tunnel_bricks",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tunnel = databaseTableName("tunnel")
    const rows = yield* sql<{ id: string; state: unknown }>`
      SELECT id, state FROM ${sql(tunnel)}
    `
    for (const row of rows) {
      const state = parsed(row.state)
      if ("brick" in state) continue
      const next = {
        ...state,
        brick: {
          id: "tailscale",
          images: {
            dns: "coredns/coredns:1.14.7",
            tailscale: "tailscale/tailscale:stable",
          },
          revision: 1,
          source: null,
        },
      }
      yield* sql`
        UPDATE ${sql(tunnel)} SET state = ${JSON.stringify(next)}
         WHERE id = ${row.id}
      `
    }
  }),
}

function parsed(value: unknown): Record<string, unknown> {
  const decoded: unknown = typeof value === "string" ? JSON.parse(value) : value
  return typeof decoded === "object" && decoded !== null
    ? (decoded as Record<string, unknown>)
    : {}
}
