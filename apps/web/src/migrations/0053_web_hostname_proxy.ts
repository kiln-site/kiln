import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A web hostname's record can go through Cloudflare's proxy: `proxied` is
// how Kiln keeps the record it owns, DNS-only until someone turns it on.
// A hostname whose name already had a record Kiln didn't make remembers
// that record's address, as last seen, so its owner can see it and have
// Kiln take it over.
export const webHostnameProxy: Migration = {
  id: 53,
  name: "web_hostname_proxy",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const hostname = databaseTableName("web_hostname")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${hostname}
         AND column_name = 'proxied'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${hostname}\`
  ADD COLUMN \`proxied\` tinyint(1) NOT NULL DEFAULT '0' AFTER \`target\`,
  ADD COLUMN \`existing_record_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER \`proxied\`,
  ADD COLUMN \`existing_record_type\` enum('A','AAAA','CNAME') DEFAULT NULL AFTER \`existing_record_id\`,
  ADD COLUMN \`existing_record_content\` varchar(255) DEFAULT NULL AFTER \`existing_record_type\`,
  ADD COLUMN \`existing_record_proxied\` tinyint(1) DEFAULT NULL AFTER \`existing_record_content\``)
  }),
}
