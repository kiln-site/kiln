import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A Relay prunes a restic repository on its own, after a delete, and no
// longer holds the keys of one in a bucket. Hearth opens such a repository
// to a prune only when it admits it, so a repository records whether a
// delete Hearth asked for is owed a prune (`prune_owed`), and the prune it
// last admitted and when (`prune_task_id`, `prune_admitted_at`).
export const backupRepositoryPrunes: Migration = {
  id: 94,
  name: "backup_repository_prunes",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const repository = databaseTableName("backup_repository")
    const columns = yield* sql.unsafe<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ?`,
      [repository]
    )
    const has = (name: string) => columns.some((column) => column.name === name)
    if (!has("prune_owed")) {
      yield* sql.unsafe(`ALTER TABLE \`${repository}\`
  ADD COLUMN \`prune_owed\` tinyint(1) NOT NULL DEFAULT 0`)
    }
    if (!has("prune_task_id")) {
      yield* sql.unsafe(`ALTER TABLE \`${repository}\`
  ADD COLUMN \`prune_task_id\` char(36) NULL`)
    }
    if (!has("prune_admitted_at")) {
      yield* sql.unsafe(`ALTER TABLE \`${repository}\`
  ADD COLUMN \`prune_admitted_at\` bigint unsigned NULL`)
    }
  }),
}
