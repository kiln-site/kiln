import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// `relay.database.read` opened the Relay's own SQLite state in a tab of its
// own. That tab became opening relay.sqlite in the Relay's Files tab, which
// takes `relay.files.read`, so the permission allows nothing and is gone.
// Nothing recognizes it, or its block's collection, any more, and either
// would stop the grant or preset holding it from loading. What each Relay
// lets Hearth do drops it the same way the Relay drops it.
export const relayDatabasePermission: Migration = {
  id: 90,
  name: "relay_database_permission",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const selections of ["access_selection", "preset_selection"]) {
      yield* sql`
        DELETE FROM ${sql(databaseTableName(selections))}
         WHERE (selection_kind = 'permission'
                AND selection_key = 'relay.database.read')
            OR (selection_kind = 'collection'
                AND selection_key = 'relay.database.all')
      `
    }

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
      if (!Array.isArray(stored) || !stored.includes("relay.database.read")) {
        continue
      }
      const actions = stored.filter(
        (action) => action !== "relay.database.read"
      )
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
