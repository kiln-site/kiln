import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { Database } from "@/effect/database"
import { DatabaseError } from "@/effect/errors"
import {
  listInstanceDirectoryEffect,
  type DirectoryInstance,
} from "@/lib/instance-directory"
import {
  InstanceDirectorySource,
  syncInstanceDirectories,
} from "@/lib/instance-directory-sync"
import { subscribeRealtimeChanges } from "@/lib/realtime-source.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertInstance, insertRelay } from "@/test/seed"

const relayId = "r".repeat(43)
const server: DirectoryInstance = {
  id: "a".repeat(40),
  name: "Before",
  game: "Minecraft",
  implementation: "Paper",
  version: "1.21",
  connectAddress: "play.example.test:25565",
  tailscale: { enabled: false },
}

describeMysql("instance directory synchronization", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "fills in a recorded server after a database outage without another Relay change",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          // A record from before the directory existed, without metadata.
          yield* insertInstance(relayId, server.id, { source_name: "Before" })
          const database = yield* Database
          const unavailable = Deferred.makeUnsafe<void>()
          const committed = Deferred.makeUnsafe<void>()
          let available = false
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              subscribeRealtimeChanges((event) => {
                if (
                  event.type === "hearth.invalidate" &&
                  event.topics.includes("instance-directory")
                )
                  Deferred.doneUnsafe(committed, Effect.void)
              })
            ),
            (unsubscribe) => Effect.sync(unsubscribe)
          )
          const worker = yield* syncInstanceDirectories.pipe(
            Effect.provideService(Database, {
              ...database,
              execute: (operation, statement, values) =>
                Effect.suspend(() => {
                  if (available)
                    return database.execute(operation, statement, values)
                  Deferred.doneUnsafe(unavailable, Effect.void)
                  return Effect.fail(
                    DatabaseError.make({
                      operation,
                      cause: new Error("Database is unavailable"),
                    })
                  )
                }),
            }),
            Effect.provideService(InstanceDirectorySource, {
              instances: () => [server],
              subscribe: (notify) => {
                notify(relayId)
                return () => {}
              },
            }),
            Effect.scoped,
            Effect.forkChild
          )
          yield* Deferred.await(unavailable)
          yield* TestClock.adjust(1_000)
          assert.deepStrictEqual(yield* listInstanceDirectoryEffect(), [])
          available = true
          yield* TestClock.adjust(5_000)
          yield* Deferred.await(committed)
          assert.strictEqual(
            (yield* listInstanceDirectoryEffect())[0]?.name,
            "Before"
          )
          yield* Fiber.interrupt(worker)
        })
    )

    it.effect(
      "refreshes a recorded server and never removes it when a snapshot leaves it out",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertInstance(relayId, server.id, { source_name: "Before" })
          const initialCommit = Deferred.makeUnsafe<void>()
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              subscribeRealtimeChanges((event) => {
                if (
                  event.type === "hearth.invalidate" &&
                  event.topics.includes("instance-directory")
                )
                  Deferred.doneUnsafe(initialCommit, Effect.void)
              })
            ),
            (unsubscribe) => Effect.sync(unsubscribe)
          )
          const disconnected = Deferred.makeUnsafe<void>()
          let current: ReadonlyArray<DirectoryInstance> | null = [server]
          let changed!: (relayId: string) => void
          let released = false
          const worker = yield* syncInstanceDirectories.pipe(
            Effect.provideService(InstanceDirectorySource, {
              instances: () => {
                if (current === null)
                  Deferred.doneUnsafe(disconnected, Effect.void)
                return current
              },
              subscribe: (notify) => {
                changed = notify
                notify(relayId)
                return () => {
                  released = true
                }
              },
            }),
            Effect.scoped,
            Effect.forkChild
          )
          yield* Deferred.await(initialCommit)
          const flush = Effect.callback<void>((resume) => {
            const unsubscribe = subscribeRealtimeChanges((event) => {
              if (
                event.type === "hearth.invalidate" &&
                event.topics.includes("instance-directory")
              )
                resume(Effect.void)
            })
            changed(relayId)
            return Effect.sync(unsubscribe)
          })
          assert.strictEqual(
            (yield* listInstanceDirectoryEffect())[0]?.name,
            "Before"
          )
          current = [{ ...server, name: "After", version: "1.22" }]
          yield* flush
          assert.strictEqual(
            (yield* listInstanceDirectoryEffect())[0]?.version,
            "1.22"
          )
          current = null
          changed(relayId)
          yield* Deferred.await(disconnected)
          assert.strictEqual(
            (yield* listInstanceDirectoryEffect())[0]?.name,
            "After"
          )
          // A snapshot can briefly omit an instance that still exists, for
          // example while it is recreated. Its record, owner, and name stay.
          current = []
          yield* flush
          assert.strictEqual(
            (yield* listInstanceDirectoryEffect())[0]?.name,
            "After"
          )
          yield* Fiber.interrupt(worker)
          assert.strictEqual(released, true)
        })
    )
  })
})
