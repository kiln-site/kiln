import {
  migratedFileActions,
  migratedFilePermissions,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// What a grant or preset that selected everything about Apps keeps for
// their files, which that selection no longer covers.
const everyAppFilePermission = migratedFilePermissions("app.files.write")!

// An App's files take the file permissions every instance's files do, so
// `app.files.*` is gone. Grants and presets on a Relay, the only place App
// permissions were given, keep what they allowed on an App's files under
// `instance.files.*`; there those also cover the Relay's game servers. What
// each Relay lets Hearth do moves the same way the Relay moves it.
export const instanceFilePermissions: Migration = {
  id: 61,
  name: "instance_file_permissions",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const moveSelections = Effect.fnUntraced(function* (
      selections: string,
      owner: string,
      scopes: string
    ) {
      const rows = yield* sql<{
        owner: string
        kind: "collection" | "permission"
        selected: string
      }>`
        SELECT s.${sql(owner)} AS owner, s.selection_kind AS kind,
               s.selection_key AS selected
          FROM ${sql(selections)} s
          JOIN ${sql(scopes)} scope ON scope.id = s.${sql(owner)}
         WHERE scope.resource_type = 'relay'
           AND ((s.selection_kind = 'permission'
                 AND s.selection_key IN ('app.files.read', 'app.files.write'))
             OR (s.selection_kind = 'collection'
                 AND s.selection_key IN ('app.files.all', 'app.all')))
      `
      for (const row of rows) {
        const permissions =
          row.kind === "collection"
            ? everyAppFilePermission
            : (migratedFilePermissions(row.selected) ?? [])
        for (const permission of permissions) {
          yield* sql`
            INSERT IGNORE INTO ${sql(selections)}
              (${sql(owner)}, selection_kind, selection_key)
            VALUES (${row.owner}, 'permission', ${permission})
          `
        }
      }
      // Nothing recognizes these any more, wherever they were stored, and a
      // collection nothing recognizes would stop its grant from loading.
      yield* sql`
        DELETE FROM ${sql(selections)}
         WHERE (selection_kind = 'permission'
                AND selection_key IN ('app.files.read', 'app.files.write'))
            OR (selection_kind = 'collection'
                AND selection_key = 'app.files.all')
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
      const actions = migratedFileActions(stored)
      if (actions.join() === stored.join()) continue
      yield* sql`
        UPDATE ${sql(relays)} SET client_actions = ${JSON.stringify(actions)}
         WHERE id = ${client.id}
      `
    }
  }),
}
