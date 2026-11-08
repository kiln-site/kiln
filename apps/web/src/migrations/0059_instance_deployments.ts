import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Deployments are of any instance, not only Apps: a game server's install,
// reinstall, and change of Brick are recorded beside App deployments. The
// table keys on the instance's kind and ID, without a foreign key to either
// kind's table, so deleting a resource removes its deployments explicitly.
// A game server's deployment names the Brick it installed and has no
// source type.
export const instanceDeployments: Migration = {
  id: 59,
  name: "instance_deployments",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const legacy = databaseTableName("app_deployment")
    const table = databaseTableName("deployment")
    const tableExists = (name: string) =>
      sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ${name}
      `.pipe(Effect.map(([found]) => Number(found?.count ?? 0) > 0))

    if (!(yield* tableExists(table)) && (yield* tableExists(legacy))) {
      yield* sql.unsafe(`RENAME TABLE \`${legacy}\` TO \`${table}\``)
    }

    const foreignKeys = yield* sql<{ name: string }>`
      SELECT constraint_name AS name FROM information_schema.table_constraints
       WHERE table_schema = DATABASE() AND table_name = ${table}
         AND constraint_type = 'FOREIGN KEY'
    `
    for (const { name } of foreignKeys) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``)
    }

    const columns = new Set(
      (yield* sql<{ name: string }>`
        SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ${table}
      `).map((column) => column.name)
    )
    const indexes = new Set(
      (yield* sql<{ name: string }>`
        SELECT DISTINCT index_name AS name FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ${table}
      `).map((index) => index.name)
    )

    const changes = [
      ...(columns.has("instance_kind")
        ? []
        : [
            "ADD COLUMN `instance_kind` enum('app','server') NOT NULL DEFAULT 'app' AFTER `id`",
          ]),
      ...(columns.has("app_id")
        ? [
            "CHANGE `app_id` `instance_id` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
          ]
        : []),
      ...(columns.has("brick_id")
        ? []
        : [
            "ADD COLUMN `brick_id` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER `source_type`",
            "ADD COLUMN `brick_name` varchar(255) DEFAULT NULL AFTER `brick_id`",
          ]),
      "MODIFY `source_type` enum('image','dockerfile','compose','github') DEFAULT NULL",
      "MODIFY `trigger` enum('manual','push','poll','redeploy','update','install','reinstall','brick') NOT NULL",
      // Index names follow the table's.
      ...[...indexes].flatMap((name) =>
        name !== "PRIMARY" && name.startsWith(`${legacy}_`)
          ? [`DROP INDEX \`${name}\``]
          : []
      ),
      ...(indexes.has(`${table}_instance_idx`)
        ? []
        : [
            `ADD KEY \`${table}_instance_idx\` (\`instance_kind\`,\`instance_id\`,\`started_at\`)`,
          ]),
      ...(indexes.has(`${table}_started_idx`)
        ? []
        : [`ADD KEY \`${table}_started_idx\` (\`started_at\`)`]),
      ...(indexes.has(`${table}_status_idx`)
        ? []
        : [`ADD KEY \`${table}_status_idx\` (\`status\`)`]),
    ]
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ${changes.join(",\n  ")}`)
  }),
}
