import {
  migratedDeployActions,
  migratedDeployPermission,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every kind of instance takes `instance.deploy` to be deployed again, so
// configuring an App (`app.manage`) no longer deploys it, and changing a
// game server's configuration no longer reinstalls it. Whoever could do
// either keeps it, and so does whoever could change a database's limits,
// which replaces its container as a deploy does: on one instance that stays
// on it, and on a Relay it now covers every instance there. What each Relay
// lets Hearth do moves the same way the Relay moves it.
export const instanceDeployPermission: Migration = {
  id: 63,
  name: "instance_deploy_permission",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const addSelections = Effect.fnUntraced(function* (
      selections: string,
      owner: string,
      scopes: string
    ) {
      // A game server's configuration was given on the game server or its
      // Relay, a database's limits on the database or its Relay, and an
      // App's only on a Relay. Stored anywhere else, none did anything.
      yield* sql`
        INSERT IGNORE INTO ${sql(selections)}
          (${sql(owner)}, selection_kind, selection_key)
        SELECT DISTINCT s.${sql(owner)}, 'permission', ${migratedDeployPermission}
          FROM ${sql(selections)} s
          JOIN ${sql(scopes)} scope ON scope.id = s.${sql(owner)}
         WHERE (scope.resource_type IN ('relay', 'instance')
                AND ((s.selection_kind = 'permission'
                      AND s.selection_key IN
                        ('instance.configuration.write', 'instance.settings'))
                  OR (s.selection_kind = 'collection'
                      AND s.selection_key = 'instance.configuration.all')))
            OR (scope.resource_type IN ('relay', 'database')
                AND ((s.selection_kind = 'permission'
                      AND s.selection_key = 'database.limits.write')
                  OR (s.selection_kind = 'collection'
                      AND s.selection_key = 'database.limits.all')))
            OR (scope.resource_type = 'relay'
                AND ((s.selection_kind = 'permission'
                      AND s.selection_key = 'app.manage')
                  OR (s.selection_kind = 'collection'
                      AND s.selection_key IN ('app.manage.all', 'app.all'))))
      `
    })

    yield* addSelections(
      databaseTableName("access_selection"),
      "access_id",
      databaseTableName("access_grant")
    )
    yield* addSelections(
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
      const actions = migratedDeployActions(stored)
      if (actions.join() === stored.join()) continue
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
