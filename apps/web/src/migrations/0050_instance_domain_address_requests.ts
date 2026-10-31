import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// When a change that may move a game server's address last asked for its
// domains to follow, until a check that read the address after it answers,
// so the DNS worker finishes a check that never ran.
export const instanceDomainAddressRequests: Migration = {
  id: 50,
  name: "instance_domain_address_requests",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const domain = databaseTableName("instance_domain")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${domain}
         AND column_name = 'address_requested_at'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${domain}\`
  ADD COLUMN \`address_requested_at\` bigint unsigned DEFAULT NULL`)
  }),
}
