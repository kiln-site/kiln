import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as TestClock from "effect/testing/TestClock"

import {
  registerPreparedInstanceEffect,
  recordCreatedInstanceEffect,
  reservePreparedInstanceEffect,
  syncInstanceRegistryEffect,
} from "@/lib/instance-registry"
import { databaseTableName } from "@/lib/database-config"
import type { DirectoryInstance } from "@/lib/instance-directory"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

const server = (
  value: Pick<DirectoryInstance, "id" | "name">
): DirectoryInstance => ({
  ...value,
  brickId: "minecraft-paper",
  game: "Minecraft",
  implementation: "Paper",
  version: "1.21",
  connectAddress: "play.example.test:25565",
  tailscale: { enabled: false },
})

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
            server({ id: "instance-one", name: "Survival" }),
            "user-one"
          )
          // A later registration never takes ownership away.
          yield* registerPreparedInstanceEffect(
            "relay-one",
            server({ id: "instance-one", name: "Survival" }),
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
      "gives a server to the person who created it even if a snapshot recorded it first",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-race", { created_by: "relay-owner" })
          const created = server({ id: "cli-server", name: "From the CLI" })
          // A snapshot read after the create lands first: the Relay's owner
          // holds it until Hearth records who made it.
          yield* syncInstanceRegistryEffect("relay-race", [created])
          assert.strictEqual(
            (yield* instances)["cli-server"]?.ownerId,
            "relay-owner"
          )

          yield* recordCreatedInstanceEffect("relay-race", created, "user-one")

          assert.strictEqual(
            (yield* instances)["cli-server"]?.ownerId,
            "user-one"
          )
          // The stand-in's sessions on it end: their Relay hears of it.
          const deliveries = yield* selectRows<{
            subject_id: string
            scope_id: string
          }>("authorization_delivery")
          assert.deepEqual(
            deliveries.map(({ subject_id, scope_id }) => [
              subject_id,
              scope_id,
            ]),
            [["relay-owner", "cli-server"]]
          )
        })
    )

    it.effect(
      "keeps an owner the server was transferred to before its creator was recorded",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-race", { created_by: "relay-owner" })
          const created = server({ id: "cli-server", name: "From the CLI" })
          yield* syncInstanceRegistryEffect("relay-race", [created])
          const sql = yield* SqlClient.SqlClient
          // As a transfer writes it.
          yield* sql`UPDATE ${sql(databaseTableName("instance"))} SET owner_id = 'recipient', owner_provisional = 0 WHERE instance_id = 'cli-server'`

          yield* recordCreatedInstanceEffect("relay-race", created, "user-one")
          // A retried record changes nothing either.
          yield* recordCreatedInstanceEffect("relay-race", created, "user-one")

          assert.strictEqual(
            (yield* instances)["cli-server"]?.ownerId,
            "recipient"
          )
        })
    )
  })
})
