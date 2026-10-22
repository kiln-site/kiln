import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Databases, apps and Tailscale networks get an owner, as Relays and game
// servers have. An owner holds every permission on a database they own, and
// less on an app (see resource-permissions.ts).
//
// Existing rows go to someone who already holds every permission on them, so
// nobody gains access: their creator when that's an administrator or the
// Relay's owner, otherwise the Relay's owner. A creator whose Relay access
// was narrowed or revoked doesn't get it back. Game servers without an owner
// go to the Relay's owner provisionally, until the person its Relay's audit
// log says created one claims it, as before. Tailscale networks never
// recorded who added them and stay unowned.
export const resourceOwners: Migration = {
  id: 22,
  name: "resource_owners",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const relay = databaseTableName("relay")
    const user = databaseTableName("user")
    const instance = databaseTableName("instance")
    const columns = yield* sql<{ tableName: string; columnName: string }>`
      SELECT table_name AS tableName, column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND column_name = 'owner_id'
    `
    const hasOwner = (table: string) =>
      columns.some((column) => column.tableName === table)

    for (const [table, id] of [
      [databaseTableName("database"), "database_id"],
      [databaseTableName("app"), "app_id"],
    ] as const) {
      if (!hasOwner(table)) {
        yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ADD COLUMN \`owner_id\` varchar(36) DEFAULT NULL AFTER \`created_by\`,
  ADD KEY \`${table}_owner_idx\` (\`owner_id\`,\`relay_id\`,\`${id}\`)`)
      }
      yield* sql.unsafe(`UPDATE \`${table}\` t
  JOIN \`${relay}\` r ON r.id = t.relay_id
  LEFT JOIN \`${user}\` u ON u.id = t.created_by
  SET t.owner_id = CASE
    WHEN u.role = 'admin' OR r.created_by = t.created_by THEN t.created_by
    ELSE r.created_by
  END
  WHERE t.owner_id IS NULL`)
    }

    // Hearth can still learn who made one from its Relay's audit log, so the
    // Relay's owner holds it provisionally.
    const provisional = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${instance}
        AND column_name = 'owner_provisional'
    `
    if (provisional.length === 0) {
      yield* sql.unsafe(`ALTER TABLE \`${instance}\`
  ADD COLUMN \`owner_provisional\` tinyint(1) NOT NULL DEFAULT '0' AFTER \`owner_id\``)
    }
    yield* sql.unsafe(`UPDATE \`${instance}\` i
  JOIN \`${relay}\` r ON r.id = i.relay_id
  SET i.owner_id = r.created_by, i.owner_provisional = 1
  WHERE i.owner_id IS NULL AND r.created_by IS NOT NULL`)

    const tailscaleNetwork = databaseTableName("tailscale_network")
    if (!hasOwner(tailscaleNetwork)) {
      yield* sql.unsafe(`ALTER TABLE \`${tailscaleNetwork}\`
  ADD COLUMN \`owner_id\` varchar(36) DEFAULT NULL AFTER \`domain\``)
    }
  }),
}
