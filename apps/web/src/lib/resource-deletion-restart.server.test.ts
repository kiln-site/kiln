import { assert, layer } from "@effect/vitest"
import { Effect, Exit, Layer, Ref, Schedule, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import { OperationsEngine } from "@/operations/engine"
import {
  OperationsEngineService,
  type OperationsEngineContext,
} from "@/operations/engine-service"
import { stopScheduleDeliveries } from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql } from "@/test/database"
import {
  deletionRelay as relay,
  deletionUntil as until,
  owner,
  relayId,
  seedDeletion as seed,
  serverId,
  serverRecords,
} from "@/test/resource-deletion"

import {
  deleteResource,
  keepResource,
  requestResourceDeletionEffect,
} from "./resource-deletion.server"

// The Relay is the only fake (test/resource-deletion.ts). This suite runs
// its own engines, one Hearth after another, so it has a file of its own.
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  ...(await import("@/test/resource-deletion")).deletionRelayConnection,
}))
vi.mock("@/lib/authorization-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization-delivery")>()),
  wakeAuthorizationDelivery: () => undefined,
}))

// Schedule sends its deletions set off in the background finish before
// the database closes.
afterAll(async () => {
  await stopScheduleDeliveries()
  await disposeAppRuntime()
})

describeMysql("A deletion across a Hearth restart", () => {
  layer(TestDatabase, { timeout: 120_000 })((it) => {
    it.effect(
      "finishes a deletion whose Hearth stopped while the Relay deleted it, deleting once",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const database = yield* Database
          // The engine running now, as Hearth's engine service hands it out.
          const current = yield* Ref.make<OperationsEngineContext | null>(null)
          const service = OperationsEngineService.of({
            engine: Ref.get(current).pipe(
              Effect.flatMap((engine) =>
                engine ? Effect.succeed(engine) : Effect.never
              )
            ),
          })
          const startHearth = Effect.gen(function* () {
            const scope = yield* Scope.make()
            const engine = yield* Layer.buildWithScope(
              Layer.mergeAll(deleteResource.layer, keepResource.layer).pipe(
                Layer.provideMerge(OperationsEngine),
                Layer.provide(Layer.succeed(SqlClient.SqlClient)(sql)),
                Layer.provide(Layer.succeed(Database)(database)),
                Layer.provide(Layer.succeed(OperationsEngineService)(service))
              ),
              scope
            )
            yield* Ref.set(current, engine)
            return scope
          })

          yield* seed
          // The Relay deletes it, but Hearth stops before the answer comes.
          relay.nextDelete = "stalls"
          const first = yield* startHearth
          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: owner,
          }).pipe(Effect.provideService(OperationsEngineService, service))
          yield* Effect.sync(() => relay.changes).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (changes) => changes.includes("instance.delete"),
            }),
            Effect.timeout("30 seconds")
          )
          yield* Scope.close(first, Exit.void).pipe(
            Effect.timeoutOption("10 seconds")
          )
          const stopped = yield* until(serverId, ["deleting"])

          const second = yield* startHearth
          const done = yield* until(serverId, ["completed", "failed"])
          yield* Scope.close(second, Exit.void).pipe(
            Effect.timeoutOption("10 seconds")
          )

          assert.strictEqual(stopped?.status, "deleting")
          assert.strictEqual(done?.status, "completed")
          // Asked about, not sent again.
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "instance.delete",
          ])
          assert.deepStrictEqual(yield* serverRecords, [])
        }).pipe(TestClock.withLive),
      120_000
    )
  })
})
