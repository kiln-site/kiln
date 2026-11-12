import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import {
  requestNamedVolumeDeletionRowEffect,
  requestResourceDeletionRowEffect,
} from "@/effect/resource-deletions"
import { disposeAppRuntime } from "@/effect/runtime"
import { exclusive, partKey, resourceKey } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"
import { testOperationsEngine } from "@/operations/test/engine"
import { stopScheduleDeliveries } from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"
import {
  appId,
  appRecords,
  deletionRelay as relay,
  deletionUntil as until,
  nextBackup,
  operationsEnded,
  owner,
  relayId,
  seedApp,
  seedDeletion as seed,
  seedNetwork,
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
    storageId: null,
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
  layer(Lanes)((it) => {
    const network = "e".repeat(12)
    const peer = `instance:${"f".repeat(12)}`

    it.effect(
      "deletes nothing while a Relay its Tailscale network is on is paused",
      () =>
        Effect.gen(function* () {
          const paused = "4".repeat(12)
          yield* seed
          yield* insertRelay(paused, { enabled: false })
          yield* seedNetwork(network, [`instance:${serverId}`, peer], [paused])

          yield* deleteServer()
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(done?.status, "failed")
          assert.match(done?.error ?? "", /paused/)
          assert.isTrue(relay.servers.has(serverId))
          assert.isUndefined(relay.stackDns.get(network))
        }).pipe(TestClock.withLive),
      90_000
    )

    it.effect(
      "gives a game server it keeps its Tailscale DNS back",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* seedNetwork(network, [`instance:${serverId}`, peer])

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
          // Its deletion is recorded failed before its operation lets the
          // game server go; keeping it waits for that.
          yield* operationsEnded
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

    // The volumes an App used are no App's: its deletion removes the App
    // alone, whoever else uses them or doesn't. What it keeps is on them,
    // so nothing is backed up first, even when a final backup is asked for.
    it.effect(
      "deletes an App without any volume it used, and takes no backup of it",
      () =>
        Effect.gen(function* () {
          const otherApp = "c".repeat(12)
          const shared = "d".repeat(40)
          yield* seed
          yield* seedApp([
            { id: volumeId, users: [{ appId, configured: true }] },
            {
              id: shared,
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
          const done = yield* until(appId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.isFalse(relay.apps.has(appId))
          assert.deepStrictEqual(
            relay.volumes.map((volume) => volume.id),
            [volumeId, shared]
          )
          assert.lengthOf(yield* selectRows("backup"), 0)
        }).pipe(TestClock.withLive),
      90_000
    )

    // Asked to, an App's deletion deletes volumes after it: those named,
    // once the App is gone from its Relay, and no other.
    it.effect(
      "deletes the volumes named with an App once it is gone, and no other",
      () =>
        Effect.gen(function* () {
          const otherApp = "c".repeat(12)
          const shared = "d".repeat(40)
          yield* seed
          yield* seedApp([
            { id: volumeId, users: [{ appId, configured: true }] },
            {
              id: shared,
              users: [
                { appId, configured: false },
                { appId: otherApp, configured: false },
              ],
            },
          ])

          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: owner,
            volumeIds: [volumeId],
          })
          const app = yield* until(appId, ["completed", "failed"])
          const volume = yield* until(volumeId, ["completed", "failed"])

          assert.strictEqual(app?.status, "completed")
          assert.strictEqual(volume?.status, "completed")
          assert.deepStrictEqual(
            relay.volumes.map((candidate) => candidate.id),
            [shared]
          )
          // The volume goes only after the App that used it.
          assert.isBelow(
            relay.changes.indexOf("app.delete"),
            relay.changes.indexOf("relay.volumes.delete")
          )
        }).pipe(TestClock.withLive),
      90_000
    )

    // An App's deletion that stopped after handing a volume off is tried
    // again to hand off the rest. The volume handed off has its own
    // deletion by then, which may have failed and been kept: asking again
    // must not start it again and delete what someone chose to keep.
    it.effect(
      "asks for a named volume's deletion once, and never again after it is kept",
      () =>
        Effect.gen(function* () {
          const other = "e".repeat(40)
          yield* seed
          yield* seedApp([
            { id: volumeId, users: [{ appId, configured: true }] },
            { id: other, users: [{ appId, configured: true }] },
          ])
          const parent = yield* requestResourceDeletionRowEffect({
            finalBackup: false,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: owner,
            volumeIds: [volumeId, other],
          })
          const ask = requestNamedVolumeDeletionRowEffect({
            namedBy: parent.id,
            relayId,
            user: owner,
            volumeId,
          })

          const first = yield* ask
          assert.strictEqual(first?.status, "pending")
          // Its own deletion failed, and someone kept the volume.
          const database = yield* Database
          yield* database.execute(
            "test.keepVolume",
            `UPDATE kiln_resource_deletion
                SET status = 'cancelled' WHERE id = ?`,
            [first!.id]
          )

          assert.isNull(yield* ask)
          const rows = yield* selectRows<{
            attempt: number
            resource_id: string
            status: string
            volume_ids: unknown
          }>("resource_deletion")
          const kept = rows.find((row) => row.resource_id === volumeId)
          assert.deepInclude(kept, { attempt: 1, status: "cancelled" })
          // The other is still the App's deletion's to hand off.
          assert.deepStrictEqual(
            rows.find((row) => row.resource_id === appId)?.volume_ids,
            [other]
          )
        }).pipe(TestClock.withLive),
      90_000
    )

    it.effect(
      "deletes nothing of a volume when its final backup fails",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* seedApp([{ id: volumeId }])

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

          assert.strictEqual(volume?.status, "failed")
          // Frozen, and nothing deleted, on the Relay or in Hearth.
          assert.deepStrictEqual(relay.changes, ["resource.freeze"])
          assert.isTrue(relay.apps.has(appId))
          assert.deepStrictEqual(
            relay.volumes.map((candidate) => candidate.id),
            [volumeId]
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
