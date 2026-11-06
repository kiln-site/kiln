import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  dueInventoriesEffect,
  recordInventoryEffect,
  recordInventoryFailureEffect,
  requestHostInventoryEffect,
} from "@/effect/security"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

const relayId = "relay-a"
const collectedAt = Date.now()

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  yield* insertRows("security_sbom", {
    collected_at: collectedAt,
    document: "{}",
    relay_id: relayId,
    sbom_key: "host",
  })
})

const dueKeys = dueInventoriesEffect(relayId).pipe(
  Effect.map((due) => due.map((inventory) => inventory.sbomKey))
)

describeMysql("host inventories after a package update", () => {
  layer(TestDatabase)((it) => {
    it.effect("asks again once, then stops once it has one", () =>
      Effect.gen(function* () {
        yield* seed
        assert.deepStrictEqual(yield* dueKeys, [])

        const updatedAt = collectedAt + 1_000
        yield* requestHostInventoryEffect(relayId, updatedAt)
        assert.deepStrictEqual(yield* dueKeys, ["host"])

        yield* recordInventoryEffect(relayId, "host", {
          collectedAt: updatedAt + 1_000,
          distro: null,
          document: Buffer.from("{}"),
          generator: "syft",
          packageCount: 1,
        })
        // Every later sync reports the same finished update.
        yield* requestHostInventoryEffect(relayId, updatedAt)
        assert.deepStrictEqual(yield* dueKeys, [])
      })
    )

    it.effect("tries again after a failed attempt, not only the next day", () =>
      Effect.gen(function* () {
        yield* seed
        const updatedAt = collectedAt + 1_000
        yield* TestClock.setTime(updatedAt + 1_000)
        yield* requestHostInventoryEffect(relayId, updatedAt)
        yield* recordInventoryFailureEffect(relayId, "host", "Host was busy")
        assert.deepStrictEqual(yield* dueKeys, [])

        yield* TestClock.adjust("7 hours")
        assert.deepStrictEqual(yield* dueKeys, ["host"])
      })
    )

    it.effect("says how new an inventory has to be to count", () =>
      Effect.gen(function* () {
        yield* seed
        const updatedAt = collectedAt + 1_000
        yield* requestHostInventoryEffect(relayId, updatedAt)
        const [host] = yield* dueInventoriesEffect(relayId)
        assert.strictEqual(host?.requestedAt, updatedAt)
      })
    )

    it.effect("leaves an inventory newer than the update alone", () =>
      Effect.gen(function* () {
        yield* seed
        yield* requestHostInventoryEffect(relayId, collectedAt - 1_000)
        assert.deepStrictEqual(yield* dueKeys, [])
      })
    )
  })
})
