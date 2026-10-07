import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTablePrefix } from "@/lib/database-config"

// Kiln no longer lets a browser skip two-factor sign-in. Better Auth renews a
// trusted device on every sign-in, so issued cookies would never lapse unless
// their records are removed.
export const revokeTrustedDevices: Migration = {
  id: 3,
  name: "revoke_trusted_devices",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      DELETE FROM ${sql(`${databaseTablePrefix()}verification`)}
      WHERE identifier LIKE 'trust-device-%'
    `
  }),
}
