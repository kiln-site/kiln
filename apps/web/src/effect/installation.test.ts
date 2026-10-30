import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, vi } from "vite-plus/test"

import { ensureInstallationId } from "@/effect/installation"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

afterEach(() => {
  vi.unstubAllEnvs()
})

describeMysql("Installation ID", () => {
  layer(TestDatabase)((it) => {
    it.effect("generates one ID that every later start keeps", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        vi.stubEnv("KILN_INSTALLATION_ID", "")

        const generated = yield* ensureInstallationId()
        const restarted = yield* ensureInstallationId()

        assert.match(generated, /^[0-9a-f-]{36}$/u)
        assert.strictEqual(restarted, generated)
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
  })
})
