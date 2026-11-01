import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import { exclusive, partKey, resourceKey } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"
import { testOperationsEngine } from "@/operations/test/engine"
import { stopScheduleDeliveries } from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql } from "@/test/database"
import { selectRows } from "@/test/seed"
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
  cancelResourceDeletionEffect,
  deleteResource,
  keepResource,
  reconcileResourceDeletions,
  requestResourceDeletionEffect,
} from "./resource-deletion.server"
import { rewriteTailscaleDns } from "./tailscale-dns.server"

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
  Layer.mergeAll(
    deleteResource.layer,
    keepResource.layer,
    rewriteTailscaleDns.layer
  )
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
    const network = "e".repeat(40)
    const peer = `instance:${"f".repeat(40)}`

    it.effect(
      "writes its Tailscale network's DNS without it, then deletes it and takes it off the network",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.stacks.set(network, [`instance:${serverId}`, peer])

          yield* deleteServer()
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          // Written once, while it was frozen and still a member.
          assert.deepStrictEqual(relay.stackDns.get(network), [
            peer.replaceAll(":", "-"),
          ])
          assert.deepStrictEqual(relay.stacks.get(network), [peer])
        }).pipe(TestClock.withLive),
      90_000
    )

    it.effect(
      "gives a game server it keeps its Tailscale DNS back",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.stacks.set(network, [`instance:${serverId}`, peer])

          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "instance",
            relayId,
            resourceId: serverId,
            storageId: null,
            user: owner,
          })
          yield* failBackup(yield* nextBackup(serverId, null))
          yield* until(serverId, ["failed"])
          // Frozen and not deleted, it has no DNS.
          assert.deepStrictEqual(relay.stackDns.get(network), [
            peer.replaceAll(":", "-"),
          ])

          yield* cancelResourceDeletionEffect({
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: owner,
          })
          const kept = yield* until(serverId, ["cancelled", "failed"])

          assert.strictEqual(kept?.status, "cancelled")
          assert.deepStrictEqual(relay.stackDns.get(network), [
            `instance-${serverId}`,
            peer.replaceAll(":", "-"),
          ])
          assert.deepStrictEqual(relay.stacks.get(network), [
            `instance:${serverId}`,
            peer,
          ])
        }).pipe(TestClock.withLive),
      90_000
    )

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
          // The App's build stopped, both frozen, and nothing deleted, on the
          // Relay or in Hearth.
          assert.deepStrictEqual(relay.changes, [
            "app.deployment.abort",
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
      "deletes an App whose build it stopped, once what deploys it is done",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* seedApp([])
          // A deployment runs, holding the App's #deploy until it sees its
          // build end, and another waits behind it.
          const deploy = [
            exclusive(partKey(resourceKey("app", relayId, appId), "deploy")),
          ]
          const ended = yield* Deferred.make<void>()
          const running = yield* inLanes(
            "test.deploy",
            "Deploying this App",
            deploy,
            Deferred.await(ended)
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          const next = yield* inLanes(
            "test.deploy",
            "Deploying this App",
            deploy,
            Effect.void
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: owner,
          })

          // It asked for the build to stop, and waits its turn rather than
          // being refused: queued once, however often it's taken up again.
          assert.deepStrictEqual(relay.changes, ["app.deployment.abort"])
          yield* reconcileResourceDeletions()
          yield* reconcileResourceDeletions()
          const queued = (yield* selectRows<{ kind: string; state: string }>(
            "operation"
          )).filter((row) => row.kind === "resource.delete")
          assert.deepStrictEqual(
            queued.map((row) => row.state),
            ["waiting"]
          )
          yield* Deferred.succeed(ended, undefined)
          yield* Fiber.join(running)
          yield* Fiber.join(next)
          assert.strictEqual(
            (yield* until(appId, ["completed", "failed"]))?.status,
            "completed"
          )
          assert.deepStrictEqual(yield* appRecords, [])
        }).pipe(TestClock.withLive),
      60_000
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

          // Nor an App's build stopped for them.
          yield* seedApp([])
          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: stranger,
          }).pipe(Effect.ignore)
          yield* until(appId, ["failed", "completed"])
          assert.deepStrictEqual(relay.changes, [])
          assert.deepStrictEqual(yield* appRecords, [appId])
        }).pipe(TestClock.withLive),
      60_000
    )
  })
})
