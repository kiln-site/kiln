import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"

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
