import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"

import {
  backfillInstanceSourceNamesEffect,
  registerPreparedInstanceEffect,
  reservePreparedInstanceEffect,
  syncInstanceRegistryEffect,
  updateInstanceSourceNameEffect,
} from "@/lib/instance-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertInstance, insertRelay, selectRows } from "@/test/seed"

interface InstanceRow {
  instance_id: string
  display_name: string | null
  source_name: string | null
  owner_id: string | null
  provisioning_reserved_until: number | null
}

const instances = Effect.map(selectRows<InstanceRow>("instance"), (rows) =>
  Object.fromEntries(
    rows.map((row) => [
      row.instance_id,
      {
        displayName: row.display_name,
        sourceName: row.source_name,
        ownerId: row.owner_id,
        reserved: row.provisioning_reserved_until !== null,
      },
    ])
  )
)

const seedRelay = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay("relay-one")
  yield* TestClock.setTime(1_000)
})

describeMysql("instance registry", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "registers a prepared instance for its first owner and queues post-provisioning",
      () =>
        Effect.gen(function* () {
          yield* seedRelay
          yield* reservePreparedInstanceEffect(
            "relay-one",
            { id: "instance-one" },
            "user-one"
          )
          yield* registerPreparedInstanceEffect(
            "relay-one",
            { id: "instance-one", name: "Survival" },
            "user-one"
          )
          // A later registration never takes ownership away.
          yield* registerPreparedInstanceEffect(
            "relay-one",
            { id: "instance-one", name: "Survival" },
            "user-two"
          )

          assert.deepEqual(yield* instances, {
            "instance-one": {
              displayName: null,
              sourceName: "Survival",
              ownerId: "user-one",
              reserved: false,
            },
          })
          const queued = yield* selectRows<{ instance_id: string }>(
            "instance_post_provision"
          )
          assert.deepEqual(
            queued.map((row) => row.instance_id),
            ["instance-one"]
          )
        })
    )

    it.effect(
      "prunes instances missing from a snapshot unless their owner reservation is live",
      () =>
        Effect.gen(function* () {
          yield* seedRelay
          yield* insertInstance("relay-one", "gone")
          yield* reservePreparedInstanceEffect(
            "relay-one",
            { id: "provisioning" },
            "user-one"
          )

          yield* syncInstanceRegistryEffect("relay-one", [
            { id: "running", name: "Running" },
          ])
          assert.deepEqual(Object.keys(yield* instances).sort(), [
            "provisioning",
            "running",
          ])
          assert.strictEqual(
            (yield* instances).provisioning?.ownerId,
            "user-one"
          )

          yield* TestClock.adjust(2 * 60_000)
          yield* syncInstanceRegistryEffect("relay-one", [])
          assert.deepEqual(yield* instances, {})
        })
    )

    it.effect(
      "stores Relay names outside the unique display name and keeps local fields",
      () =>
        Effect.gen(function* () {
          yield* seedRelay
          yield* insertInstance("relay-one", "instance-one", {
            display_name: "Lobby",
            source_name: "Old",
            owner_id: "user-one",
          })
          yield* insertInstance("relay-one", "removed")

          yield* syncInstanceRegistryEffect("relay-one", [
            { id: "instance-one", name: "Survival" },
            { id: "instance-two", name: "Survival" },
          ])

          assert.deepEqual(yield* instances, {
            "instance-one": {
              displayName: "Lobby",
              sourceName: "Survival",
              ownerId: "user-one",
              reserved: false,
            },
            "instance-two": {
              displayName: null,
              sourceName: "Survival",
              ownerId: null,
              reserved: false,
            },
          })
        })
    )

    it.effect(
      "backfills only missing names and renames only the named instance",
      () =>
        Effect.gen(function* () {
          yield* seedRelay
          yield* insertInstance("relay-one", "named", { source_name: "Kept" })
          yield* insertInstance("relay-one", "unnamed")
          yield* insertInstance("relay-one", "bystander", {
            source_name: "Bystander",
          })

          yield* backfillInstanceSourceNamesEffect("relay-one", [
            { id: "named", name: "Cached" },
            { id: "unnamed", name: "Cached" },
          ])
          yield* updateInstanceSourceNameEffect("relay-one", {
            id: "bystander",
            name: "Renamed",
          })

          const names = Object.fromEntries(
            Object.entries(yield* instances).map(([id, row]) => [
              id,
              row.sourceName,
            ])
          )
          assert.deepEqual(names, {
            bystander: "Renamed",
            named: "Kept",
            unnamed: "Cached",
          })
        })
    )
  })
})
