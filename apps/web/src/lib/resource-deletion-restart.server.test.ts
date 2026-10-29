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
  appId,
  appRecords,
  deletionRelay as relay,
  deletionUntil as until,
  finishBackup,
  nextBackup,
  owner,
  relayId,
  seedApp,
  seedDeletion as seed,
  serverId,
  serverRecords,
  volumeId,
} from "@/test/resource-deletion"
import { selectRows } from "@/test/seed"

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

// Hearths that run one after another on one database: each start builds a
// new engine, which Hearth's engine service then hands out.
const hearths = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const database = yield* Database
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
  return { service, startHearth }
})

const stopHearth = (scope: Scope.Closeable) =>
  Scope.close(scope, Exit.void).pipe(Effect.timeoutOption("10 seconds"))

describeMysql("A deletion across a Hearth restart", () => {
  layer(TestDatabase, { timeout: 120_000 })((it) => {
    it.effect(
      "finishes a deletion whose Hearth stopped while the Relay deleted it, deleting once",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths

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
          yield* stopHearth(first)
          const stopped = yield* until(serverId, ["deleting"])

          const second = yield* startHearth
          const done = yield* until(serverId, ["completed", "failed"])
          yield* stopHearth(second)

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

    it.effect(
      "takes an App's final backups across a restart, each once, then deletes it",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          const otherApp = "c".repeat(40)
          yield* seed
          yield* seedApp([
            // Its own, which only it uses: backed up, then deleted with it.
            {
              id: `${appId}/data`,
              owner: appId,
              users: [{ appId, configured: false }],
            },
            // Its own, but another App mounts it too: it stays.
            {
              id: `${appId}/shared`,
              owner: appId,
              users: [
                { appId, configured: false },
                { appId: otherApp, configured: false },
              ],
            },
            // A Kiln volume its configuration mounts: it stays.
            { id: volumeId, users: [{ appId, configured: true }] },
          ])

          const first = yield* startHearth
          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: owner,
          }).pipe(Effect.provideService(OperationsEngineService, service))
          const folder = yield* nextBackup(appId, null)
          yield* finishBackup(folder)
          const data = yield* nextBackup(appId, folder)
          // Hearth stops while the volume's backup runs.
          yield* stopHearth(first)

          const second = yield* startHearth
          yield* finishBackup(data)
          const done = yield* until(appId, ["completed", "failed"])
          yield* stopHearth(second)

          assert.strictEqual(done?.status, "completed")
          const backups = yield* selectRows<{
            reason: string
            target_id: string
            target_kind: string
          }>("backup")
          assert.sameDeepMembers(
            backups.map((backup) => [
              backup.target_kind,
              backup.target_id,
              backup.reason,
            ]),
            [
              ["app", appId, "final_delete"],
              ["volume", `${appId}/data`, "final_delete"],
            ]
          )
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "app.delete",
          ])
          assert.sameMembers(
            relay.volumes.map((volume) => volume.id),
            [`${appId}/shared`, volumeId]
          )
          assert.deepStrictEqual(yield* appRecords, [])
        }).pipe(TestClock.withLive),
      120_000
    )
  })
})
