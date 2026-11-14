import {
  migratedLogActions,
  migratedLogsPermission,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Reading any kind of instance's logs takes `instance.logs.read`, so
// `app.logs.read` and `database.logs.read` are gone. Whoever could read an
// App's logs (only ever given on its Relay) or a database's keeps that
// under `instance.logs.read`. On a Relay it also covers the game servers
// there, as App files, routes and shells do once moved. Every App
// permission and every database permission cover it already. What each
// Relay lets Hearth do moves the same way the Relay moves it.
export const instanceLogsPermission: Migration = {
  id: 77,
  name: "instance_logs_permission",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const moveSelections = Effect.fnUntraced(function* (
      selections: string,
      owner: string
    ) {
      yield* sql`
        INSERT IGNORE INTO ${sql(selections)}
          (${sql(owner)}, selection_kind, selection_key)
        SELECT DISTINCT ${sql(owner)}, 'permission', ${migratedLogsPermission}
          FROM ${sql(selections)}
         WHERE (selection_kind = 'permission'
                AND selection_key IN ('app.logs.read', 'database.logs.read'))
            OR (selection_kind = 'collection'
                AND selection_key IN ('app.logs.all', 'database.logs.all'))
      `
      // Nothing recognizes these any more, wherever they were stored, and a
      // collection nothing recognizes would stop its grant from loading.
      yield* sql`
        DELETE FROM ${sql(selections)}
         WHERE (selection_kind = 'permission'
                AND selection_key IN ('app.logs.read', 'database.logs.read'))
            OR (selection_kind = 'collection'
                AND selection_key IN ('app.logs.all', 'database.logs.all'))
      `
    })

    yield* moveSelections(databaseTableName("access_selection"), "access_id")
    yield* moveSelections(databaseTableName("preset_selection"), "preset_id")

    const relays = databaseTableName("relay")
    const clients = yield* sql<{ actions: unknown; id: string }>`
      SELECT id, client_actions AS actions FROM ${sql(relays)}
       WHERE client_role = 'custom'
    `
    for (const client of clients) {
      const stored: unknown =
        typeof client.actions === "string"
          ? JSON.parse(client.actions)
          : client.actions
      if (
        !Array.isArray(stored) ||
        !stored.every((action) => typeof action === "string")
      ) {
        continue
      }
      const actions = migratedLogActions(stored)
      if (actions.join() === stored.join()) continue
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
