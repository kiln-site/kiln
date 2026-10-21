import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Why a backup task or one of its copies failed, as a code Relays send
// beside the message (see `backupFailureCodes`), so Hearth can explain it.
export const backupErrorCodes: Migration = {
  id: 19,
  name: "backup_error_codes",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const table of [
      databaseTableName("backup_task"),
      databaseTableName("backup_artifact"),
    ]) {
      const columns = yield* sql<{ columnName: string }>`
        SELECT column_name AS columnName
        FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ${table}
      `
      if (columns.some((column) => column.columnName === "error_code")) continue
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ADD COLUMN \`error_code\` varchar(64) DEFAULT NULL AFTER \`error\``)
    }
  }),
}
