import {
  migratedRouteActions,
  migratedRoutesPermission,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every kind of instance takes `instance.network.write` to save its web
// routes, so configuring an App (`app.manage`) no longer does. Whoever
// could save an App's keeps that. An App's are only ever given on its
// Relay, where changing the network now covers every game server and App
// there, as it already covered every game server.
//
// A game server's already took this, so nothing of theirs moves. Reading
// an App's routes stays with seeing the App. What each Relay lets Hearth
// do moves the same way the Relay moves it.
export const instanceRoutesPermission: Migration = {
  id: 73,
  name: "instance_routes_permission",
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
        SELECT DISTINCT s.${sql(owner)}, 'permission', ${migratedRoutesPermission}
          FROM ${sql(selections)} s
          JOIN ${sql(scopes)} scope ON scope.id = s.${sql(owner)}
         WHERE scope.resource_type = 'relay'
           AND ((s.selection_kind = 'permission'
                 AND s.selection_key = 'app.manage')
             OR (s.selection_kind = 'collection'
                 AND s.selection_key IN ('app.manage.all', 'app.all')))
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
      const actions = migratedRouteActions(stored)
      if (actions.join() === stored.join()) continue
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
