import {
  migratedLimitActions,
  migratedLimitsPermission,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Every kind of instance takes `instance.limits.write` to change its
// resource limits, so `database.limits.write` is gone and configuring an
// App (`app.manage`) no longer changes its limits. Whoever could change a
// database's or an App's keeps that: on one database it stays on it, and on
// a Relay it now covers every instance there.
//
// A game server's already had this name, as part of its configuration: it
// came with reading that configuration, and with selecting all of it. It
// is a block of its own now, so whoever held it keeps reading the
// configuration, and whoever selected all of the configuration keeps the
// limits. What each Relay lets Hearth do moves the same way the Relay
// moves it.
export const instanceLimitsPermission: Migration = {
  id: 65,
  name: "instance_limits_permission",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const moveSelections = Effect.fnUntraced(function* (
      selections: string,
      owner: string,
      scopes: string
    ) {
      // What changing a game server's limits used to bring with it, for
      // whoever held it before anyone else is given it below.
      yield* sql`
        INSERT IGNORE INTO ${sql(selections)}
          (${sql(owner)}, selection_kind, selection_key)
        SELECT DISTINCT s.${sql(owner)}, 'permission', 'instance.configuration.read'
          FROM ${sql(selections)} s
          JOIN ${sql(scopes)} scope ON scope.id = s.${sql(owner)}
         WHERE scope.resource_type IN ('relay', 'instance')
           AND s.selection_kind = 'permission'
           AND s.selection_key = 'instance.limits.write'
      `
      // A database's limits were given on the database or its Relay, an
      // App's only on a Relay, and a game server's configuration on the
      // game server or its Relay. Stored anywhere else, none did anything.
      yield* sql`
        INSERT IGNORE INTO ${sql(selections)}
          (${sql(owner)}, selection_kind, selection_key)
        SELECT DISTINCT s.${sql(owner)}, 'permission', ${migratedLimitsPermission}
          FROM ${sql(selections)} s
          JOIN ${sql(scopes)} scope ON scope.id = s.${sql(owner)}
         WHERE (scope.resource_type IN ('relay', 'database')
                AND ((s.selection_kind = 'permission'
                      AND s.selection_key = 'database.limits.write')
                  OR (s.selection_kind = 'collection'
                      AND s.selection_key = 'database.limits.all')))
            OR (scope.resource_type = 'relay'
                AND ((s.selection_kind = 'permission'
                      AND s.selection_key = 'app.manage')
                  OR (s.selection_kind = 'collection'
                      AND s.selection_key IN ('app.manage.all', 'app.all'))))
            OR (scope.resource_type IN ('relay', 'instance')
                AND s.selection_kind = 'collection'
                AND s.selection_key = 'instance.configuration.all')
      `
      // Nothing recognizes these any more, wherever they were stored, and a
      // collection nothing recognizes would stop its grant from loading.
      yield* sql`
        DELETE FROM ${sql(selections)}
         WHERE (selection_kind = 'permission'
                AND selection_key = 'database.limits.write')
            OR (selection_kind = 'collection'
                AND selection_key = 'database.limits.all')
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
      const actions = migratedLimitActions(stored)
      if (actions.join() === stored.join()) continue
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
