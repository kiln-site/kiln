import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { loadEnabledRelayForIssuanceEffect } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

describeMysql("Relay capability issuance lookup", () => {
  layer(TestDatabase)((it) => {
    it.effect("treats a missing or paused Relay as unavailable", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("paused-relay", { enabled: false })

        for (const id of ["paused-relay", "missing-relay"]) {
          const error = yield* Effect.flip(
            loadEnabledRelayForIssuanceEffect(id)
          )
          assert.strictEqual(error._tag, "ResourceNotFoundError")
        }
      })
    )
  })
})
