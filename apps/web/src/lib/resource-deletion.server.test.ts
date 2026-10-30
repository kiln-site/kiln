import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import { testOperationsEngine } from "@/operations/test/engine"
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
  stranger,
  volumeId,
} from "@/test/resource-deletion"

import {
  deleteResource,
  keepResource,
  requestResourceDeletionEffect,
} from "./resource-deletion.server"

// The Relay is the only fake (test/resource-deletion.ts).
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

const Lanes = testOperationsEngine(
  Layer.mergeAll(deleteResource.layer, keepResource.layer)
).pipe(Layer.provideMerge(TestDatabase))

const deleteServer = (user = owner) =>
  requestResourceDeletionEffect({
    finalBackup: false,
    kind: "instance",
    relayId,
    resourceId: serverId,
    user,
  })

// The Relay reports a final backup failed, as reconciling records it.
const failBackup = (backupId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.execute(
      "test.failBackup",
      `UPDATE kiln_backup SET status = 'failed' WHERE id = ?`,
      [backupId]
    )
    yield* database.execute(
      "test.failBackupTask",
      `UPDATE kiln_backup_task SET status = 'failed',
              error = 'Relay disk is full'
        WHERE backup_id = ?`,
      [backupId]
    )
  })

describeMysql("Deleting a game server or database", () => {
  layer(Lanes, { timeout: 120_000 })((it) => {
    it.effect(
      "keeps an App's volume its deletion didn't plan to take, though nothing else uses it any more",
      () =>
        Effect.gen(function* () {
          const otherApp = "c".repeat(40)
          yield* seed
          yield* seedApp([
            {
              id: `${appId}/data`,
              owner: appId,
              users: [{ appId, configured: false }],
            },
            {
              id: `${appId}/shared`,
              owner: appId,
              users: [
                { appId, configured: false },
                { appId: otherApp, configured: false },
              ],
            },
          ])

          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: owner,
          })
          const folder = yield* nextBackup(appId, null)
          // The other App goes while the folder is backed up: the volume
          // it used is no longer anyone else's, but wasn't backed up.
          const shared = relay.volumes.find(
            (volume) => volume.id === `${appId}/shared`
          )!
          shared.users = [{ appId, configured: false }]
          yield* finishBackup(folder)
          yield* finishBackup(yield* nextBackup(appId, folder))
          const done = yield* until(appId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.appDeletes, [[`${appId}/data`]])
          assert.deepStrictEqual(
            relay.volumes.map((volume) => volume.id),
            [`${appId}/shared`]
          )
        }).pipe(TestClock.withLive),
      90_000
    )

    it.effect(
      "deletes nothing of an App or a volume when any of its final backups fails",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* seedApp([
            {
              id: `${appId}/data`,
              owner: appId,
              users: [{ appId, configured: false }],
            },
            { id: volumeId },
          ])

          // The App's folder is backed up, then its volume's backup fails.
          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: owner,
          })
          const folder = yield* nextBackup(appId, null)
          yield* finishBackup(folder)
          yield* failBackup(yield* nextBackup(appId, folder))
          const app = yield* until(appId, ["completed", "failed"])
          // A Kiln volume's only backup fails.
          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "volume",
            relayId,
            resourceId: volumeId,
            storageId: null,
            user: owner,
          })
          yield* failBackup(yield* nextBackup(volumeId, null))
          const volume = yield* until(volumeId, ["completed", "failed"])

          assert.strictEqual(app?.status, "failed")
          assert.strictEqual(volume?.status, "failed")
          // Frozen, and nothing deleted, on the Relay or in Hearth.
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "resource.freeze",
          ])
          assert.isTrue(relay.apps.has(appId))
          assert.deepStrictEqual(
            relay.volumes.map((candidate) => candidate.id),
            [`${appId}/data`, volumeId]
          )
          assert.deepStrictEqual(yield* appRecords, [appId])
        }).pipe(TestClock.withLive),
      90_000
    )

    it.effect(
      "touches nothing when the person who asked can no longer delete it",
      () =>
        Effect.gen(function* () {
          yield* seed

          yield* deleteServer(stranger)
          const failed = yield* until(serverId, ["failed", "completed"])

          assert.strictEqual(failed?.status, "failed")
          assert.deepStrictEqual(relay.changes, [])
          assert.deepStrictEqual(yield* serverRecords, [serverId])
        }).pipe(TestClock.withLive),
      60_000
    )
  })
})
