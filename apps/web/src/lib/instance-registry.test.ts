import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as TestClock from "effect/testing/TestClock"

import {
  backfillInstanceSourceNamesEffect,
  registerPreparedInstanceEffect,
  recordCreatedInstanceEffect,
  removeDeletedInstanceEffect,
  reservePreparedInstanceEffect,
  syncInstanceRegistryEffect,
  updateInstanceSourceNameEffect,
  updateInstanceDirectoryEffect,
} from "@/lib/instance-registry"
import { databaseTableName } from "@/lib/database-config"
import type { DirectoryInstance } from "@/lib/instance-directory"
import { listInstanceDirectoryEffect } from "@/lib/instance-directory"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertInstance, insertRelay, selectRows } from "@/test/seed"
import { subscribeRealtimeChanges } from "@/lib/realtime-source.server"

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
      "lists recorded metadata and leaves out records no Relay has described",
      () =>
        Effect.gen(function* () {
          yield* seedRelay
          yield* insertInstance("relay-one", "old", {
            source_name: "Old server",
          })
          yield* registerPreparedInstanceEffect(
            "relay-one",
            server({ id: "new", name: "New server" }),
            "owner"
          )
          const rows = yield* listInstanceDirectoryEffect()
          assert.deepStrictEqual(
            rows.find((row) => row.id === "new"),
            {
              id: "new",
              relayId: "relay-one",
              name: "New server",
              brickId: "minecraft-paper",
              game: "Minecraft",
              implementation: "Paper",
              version: "1.21",
              connectAddress: "play.example.test:25565",
              tailscaleEnabled: false,
            }
          )
          assert.strictEqual(
            rows.some((row) => row.id === "old"),
            false
          )
        })
    )

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
            server({ id: "running", name: "Running" }),
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
            server({ id: "instance-one", name: "Survival" }),
            server({ id: "instance-two", name: "Survival" }),
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
            server({ id: "named", name: "Cached" }),
            server({ id: "unnamed", name: "Cached" }),
            server({ id: "deleted", name: "Stale cached server" }),
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

    it.effect(
      "refreshes recorded servers from live snapshots without creating others",
      () =>
        Effect.gen(function* () {
          yield* seedRelay
          yield* registerPreparedInstanceEffect(
            "relay-one",
            server({ id: "survival", name: "Survival" }),
            "owner"
          )
          yield* updateInstanceDirectoryEffect("relay-one", [
            {
              ...server({ id: "survival", name: "Survival" }),
              version: "1.22",
            },
            server({ id: "unrecorded", name: "Unrecorded" }),
          ])
          assert.deepStrictEqual(
            (yield* listInstanceDirectoryEffect()).map((row) => [
              row.id,
              row.version,
            ]),
            [["survival", "1.22"]]
          )
        })
    )

    it.effect(
      "never restores a deleted server from a snapshot read before the deletion",
      () =>
        Effect.gen(function* () {
          yield* seedRelay
          const survival = server({ id: "survival", name: "Survival" })
          yield* registerPreparedInstanceEffect("relay-one", survival, "owner")
          yield* removeDeletedInstanceEffect("relay-one", "survival")
          yield* updateInstanceDirectoryEffect("relay-one", [survival])
          assert.deepStrictEqual(yield* instances, {})
        })
    )

    it.effect("records a server Hearth created outside provisioning", () =>
      Effect.gen(function* () {
        yield* seedRelay
        yield* recordCreatedInstanceEffect(
          "relay-one",
          server({ id: "cli-server", name: "From the CLI" }),
          "user-one"
        )
        assert.deepStrictEqual(
          (yield* listInstanceDirectoryEffect()).map((row) => row.name),
          ["From the CLI"]
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
            deliveries.map(({ subject_id, scope_id }) => [subject_id, scope_id]),
            [["relay-owner", "cli-server"]]
          )
        })
    )

    it.effect("reserves servers being provisioned at the same time", () =>
      Effect.gen(function* () {
        yield* seedRelay
        yield* Effect.all(
          ["a", "b", "c", "d"].map((id) =>
            reservePreparedInstanceEffect(
              "relay-one",
              { id: id.repeat(40) },
              `user-${id}`
            )
          ),
          { concurrency: "unbounded" }
        )
        const owners = yield* instances
        for (const id of ["a", "b", "c", "d"])
          assert.strictEqual(owners[id.repeat(40)]?.ownerId, `user-${id}`)
      })
    )

    it.effect(
      "gives a server to its creator even if its Relay changed hands first",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-race", { created_by: "relay-owner" })
          const created = server({ id: "cli-server", name: "From the CLI" })
          yield* syncInstanceRegistryEffect("relay-race", [created])
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE ${sql(databaseTableName("relay"))} SET created_by = 'next-owner' WHERE id = 'relay-race'`

          yield* recordCreatedInstanceEffect("relay-race", created, "user-one")

          assert.strictEqual(
            (yield* instances)["cli-server"]?.ownerId,
            "user-one"
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

    it.effect(
      "keeps Hearth's deletion when a startup snapshot from before it commits later",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-startup-delete")
          const survival = server({ id: "survival", name: "Survival" })
          const lobby = server({ id: "lobby", name: "Lobby" })
          yield* registerPreparedInstanceEffect(
            "relay-startup-delete",
            survival,
            "owner"
          )
          yield* registerPreparedInstanceEffect(
            "relay-startup-delete",
            lobby,
            "owner"
          )
          yield* removeDeletedInstanceEffect("relay-startup-delete", "survival")
          yield* syncInstanceRegistryEffect("relay-startup-delete", [
            survival,
            lobby,
          ])
          assert.deepStrictEqual(Object.keys(yield* instances), ["lobby"])
        })
    )

    it.effect(
      "keeps Hearth's creation when a startup snapshot from before it commits later",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-startup-create")
          const lobby = server({ id: "lobby", name: "Lobby" })
          yield* recordCreatedInstanceEffect(
            "relay-startup-create",
            server({ id: "fresh", name: "Fresh" }),
            "user-one"
          )
          yield* syncInstanceRegistryEffect("relay-startup-create", [lobby])
          assert.deepStrictEqual(Object.keys(yield* instances).sort(), [
            "fresh",
            "lobby",
          ])
        })
    )

    it.effect(
      "tells open directories when Hearth records or removes a server",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-notify")
          const changed: Array<string | undefined> = []
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              subscribeRealtimeChanges((event) => {
                if (
                  event.type === "hearth.invalidate" &&
                  event.topics.includes("instance-directory")
                )
                  changed.push(event.scope?.relayId)
              })
            ),
            (unsubscribe) => Effect.sync(unsubscribe)
          )
          yield* recordCreatedInstanceEffect(
            "relay-notify",
            server({ id: "cli-server", name: "From the CLI" }),
            "user-one"
          )
          yield* removeDeletedInstanceEffect("relay-notify", "cli-server")
          assert.deepStrictEqual(changed, ["relay-notify", "relay-notify"])
        })
    )
  })
})
