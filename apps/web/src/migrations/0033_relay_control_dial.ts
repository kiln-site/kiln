import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Relays can open their control connection to Hearth, as well as answer
// Hearth's (lib/relay-control-dial.server.ts). `control_dial` is which of
// the two Hearth keeps when both work: Hearth, as every Relay saved before
// did, or the Relay.
export const relayControlDial: Migration = {
  id: 33,
  name: "relay_control_dial",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const relay = databaseTableName("relay")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${relay}
    `
    if (!columns.some(({ columnName }) => columnName === "control_dial")) {
      yield* sql.unsafe(`ALTER TABLE \`${relay}\`
  ADD COLUMN \`control_dial\` enum('hearth','relay') NOT NULL DEFAULT 'hearth'`)
    }
  }),
}
