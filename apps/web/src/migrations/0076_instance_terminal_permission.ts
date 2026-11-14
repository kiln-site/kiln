import {
  migratedTerminalActions,
  migratedTerminalPermission,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A shell in any kind of instance takes `instance.terminal`, so
// `app.terminal` and `database.terminal` are gone. Whoever could open an
// App's shell (only ever given on its Relay, alone or with every App
// permission) or a database's keeps that under `instance.terminal`. On a
// Relay it also covers the game servers there, as App files and routes do
// once moved. A database's every-permission collection covers it already.
// What each Relay lets Hearth do moves the same way the Relay moves it.
export const instanceTerminalPermission: Migration = {
  id: 76,
  name: "instance_terminal_permission",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const moveSelections = Effect.fnUntraced(function* (
      selections: string,
      owner: string,
      scopes: string
    ) {
      yield* sql`
        INSERT IGNORE INTO ${sql(selections)}
          (${sql(owner)}, selection_kind, selection_key)
        SELECT DISTINCT s.${sql(owner)}, 'permission', ${migratedTerminalPermission}
          FROM ${sql(selections)} s
          JOIN ${sql(scopes)} scope ON scope.id = s.${sql(owner)}
         WHERE (s.selection_kind = 'permission'
                AND s.selection_key IN ('app.terminal', 'database.terminal'))
            OR (s.selection_kind = 'collection'
                AND s.selection_key IN ('app.terminal.all', 'database.terminal.all'))
            OR (scope.resource_type = 'relay'
                AND s.selection_kind = 'collection'
                AND s.selection_key = 'app.all')
      `
      // Nothing recognizes these any more, wherever they were stored, and a
      // collection nothing recognizes would stop its grant from loading.
      yield* sql`
        DELETE FROM ${sql(selections)}
         WHERE (selection_kind = 'permission'
                AND selection_key IN ('app.terminal', 'database.terminal'))
            OR (selection_kind = 'collection'
                AND selection_key IN ('app.terminal.all', 'database.terminal.all'))
      `
    })

    yield* moveSelections(
      databaseTableName("access_selection"),
      "access_id",
      databaseTableName("access_grant")
    )
    yield* moveSelections(
      databaseTableName("preset_selection"),
      "preset_id",
      databaseTableName("permission_preset")
    )

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
      const actions = migratedTerminalActions(stored)
      if (actions.join() === stored.join()) continue
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
