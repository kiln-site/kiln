import {
  migratedPowerActions,
  migratedPowerPermission,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every kind of instance takes `instance.power.*` for its power, so
// `database.power` is gone and `app.manage` no longer starts or stops an
// App. Whoever could power a database or an App keeps every power action:
// on one database that stays on it, and on a Relay it now covers every
// instance there. What each Relay lets Hearth do moves the same way the
// Relay moves it.
export const instancePowerPermissions: Migration = {
  id: 62,
  name: "instance_power_permissions",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const moveSelections = Effect.fnUntraced(function* (
      selections: string,
      owner: string,
      scopes: string
    ) {
      // A database's power was given on the database or its Relay; an
      // App's only on a Relay. Stored anywhere else, neither did anything.
      yield* sql`
        INSERT IGNORE INTO ${sql(selections)}
          (${sql(owner)}, selection_kind, selection_key)
        SELECT DISTINCT s.${sql(owner)}, 'permission', ${migratedPowerPermission}
          FROM ${sql(selections)} s
          JOIN ${sql(scopes)} scope ON scope.id = s.${sql(owner)}
         WHERE (scope.resource_type IN ('relay', 'database')
                AND ((s.selection_kind = 'permission'
                      AND s.selection_key = 'database.power')
                  OR (s.selection_kind = 'collection'
                      AND s.selection_key = 'database.power.all')))
            OR (scope.resource_type = 'relay'
                AND ((s.selection_kind = 'permission'
                      AND s.selection_key = 'app.manage')
                  OR (s.selection_kind = 'collection'
                      AND s.selection_key IN ('app.manage.all', 'app.all'))))
      `
      // Nothing recognizes these any more, wherever they were stored, and a
      // collection nothing recognizes would stop its grant from loading.
      yield* sql`
        DELETE FROM ${sql(selections)}
         WHERE (selection_kind = 'permission'
                AND selection_key = 'database.power')
            OR (selection_kind = 'collection'
                AND selection_key = 'database.power.all')
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
      const actions = migratedPowerActions(stored)
      if (actions.join() === stored.join()) continue
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
