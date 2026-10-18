import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, vi } from "vite-plus/test"

import { ensureInstallationId } from "@/effect/installation"
import { databaseTableName } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

const relayId = "r".repeat(43)

afterEach(() => {
  vi.unstubAllEnvs()
})

describeMysql("Installation ID", () => {
  layer(TestDatabase)((it) => {
    it.effect("generates one ID that every later start keeps", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        vi.stubEnv("KILN_INSTALLATION_ID", "")

        const concurrent = yield* Effect.all(
          [ensureInstallationId(), ensureInstallationId()],
          { concurrency: "unbounded" }
        )
        const restarted = yield* ensureInstallationId()

        assert.match(concurrent[0], /^[0-9a-f-]{36}$/u)
        assert.deepStrictEqual(concurrent, [restarted, restarted])
      })
    )

    it.effect("keeps KILN_INSTALLATION_ID after the variable is removed", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        vi.stubEnv("KILN_INSTALLATION_ID", "")
        yield* ensureInstallationId()

        vi.stubEnv("KILN_INSTALLATION_ID", "kiln-production")
        const configured = yield* ensureInstallationId()
        vi.stubEnv("KILN_INSTALLATION_ID", "")
        const removed = yield* ensureInstallationId()

        assert.strictEqual(configured, "kiln-production")
        assert.strictEqual(removed, "kiln-production")
      })
    )

    it.effect(
      "moves platform backup settings from the fallback ID to the generated one",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          vi.stubEnv("KILN_INSTALLATION_ID", "")
          const sql = yield* SqlClient.SqlClient
          const policies = databaseTableName("backup_policy")
          yield* sql`
            INSERT INTO ${sql(policies)}
              (relay_id, target_kind, target_id, exclude_patterns,
               quantity_limit, created_at, updated_at)
            VALUES (${relayId}, 'platform', 'kiln', '[]', 7, 0, 0)
          `

          const installationId = yield* ensureInstallationId()

          const rows = yield* sql<{ target_id: string; quantity_limit: number }>`
            SELECT target_id, quantity_limit FROM ${sql(policies)}
            WHERE relay_id = ${relayId} AND target_kind = 'platform'
          `
          assert.deepStrictEqual(rows, [
            { quantity_limit: 7, target_id: installationId },
          ])
        })
    )
  })
})
