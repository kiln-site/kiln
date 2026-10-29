import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { reserveBackupRestoreEffect } from "@/effect/backups"
import { Database } from "@/effect/database"
import { ResourceDeletionConflictError } from "@/effect/resource-deletions"
import { disposeAppRuntime } from "@/effect/runtime"
import { testOperationsEngine } from "@/operations/test/engine"
import { insertSchedule } from "@/server/schedule-deployment.server"
import { stopScheduleDeliveries } from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql } from "@/test/database"
import {
  allow,
  appId,
  appRecords,
  at,
  databaseId,
  deletionOf,
  deletionRelay as relay,
  deletionUntil as until,
  finishBackup,
  insertDeletion,
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
import { insertBackup, insertRows, selectRows } from "@/test/seed"

import {
  cancelResourceDeletionEffect,
  deleteResource,
  keepResource,
  reconcileResourceDeletions,
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

const deleteServer = (user = owner, finalBackup = false, retryOf?: number) =>
  requestResourceDeletionEffect({
    finalBackup,
    kind: "instance",
    relayId,
    resourceId: serverId,
    ...(retryOf === undefined ? {} : { retryOf }),
    user,
  })

const keepServer = cancelResourceDeletionEffect({
  kind: "instance",
  relayId,
  resourceId: serverId,
  user: owner,
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

// A deletion stopped with the server frozen and a finished final backup.
const seedStoppedWithBackup = Effect.gen(function* () {
  yield* seed
  yield* insertBackup("final-backup", {
    reason: "final_delete",
    relay_id: relayId,
    target_id: serverId,
  })
  const id = randomUUID()
  yield* insertDeletion({
    backup_id: "final-backup",
    error: "The Relay couldn't remove it",
    final_backup: true,
    id,
    status: "failed",
  })
  relay.frozen.set(serverId, id)
})

// A finished archive of a target, kept on the Relay's disk.
const completeBackup = (target: { id: string; kind: string }) =>
  Effect.gen(function* () {
    const backupId = randomUUID()
    const archive = {
      bytes: 1024,
      checksum_sha256: "0".repeat(64),
      filename: "final.tar.gz",
    }
    yield* insertBackup(backupId, {
      ...archive,
      artifact_kind: target.kind === "instance" ? "archive" : "tar_archive",
      reason: "final_delete",
      relay_id: relayId,
      target_id: target.id,
      target_kind: target.kind,
    })
    yield* insertRows("backup_artifact", {
      ...archive,
      backup_id: backupId,
      created_at: at,
      destination_key: "local",
      id: randomUUID(),
      status: "available",
      updated_at: at,
    })
    return backupId
  })

describeMysql("Deleting a game server or database", () => {
  layer(Lanes, { timeout: 120_000 })((it) => {
    it.effect(
      "restores nothing of a resource its Relay began deleting, though its deletion stopped",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* seedApp()
          const server = yield* completeBackup({
            id: serverId,
            kind: "instance",
          })
          const volume = yield* completeBackup({
            id: `${appId}/data`,
            kind: "volume",
          })
          // Both stopped after their Relay was asked to delete them.
          for (const [resourceKind, resourceId] of [
            ["instance", serverId],
            ["app", appId],
          ]) {
            yield* insertDeletion({
              error: "The Relay couldn't remove it",
              relay_deleting_at: at,
              resource_id: resourceId,
              resource_kind: resourceKind,
              status: "failed",
            })
          }

          const refusals = yield* Effect.forEach([server, volume], (backupId) =>
            Effect.flip(
              reserveBackupRestoreEffect({
                backupId,
                dependsOnTaskId: null,
                requestedBy: owner.id,
                taskId: randomUUID(),
              })
            )
          )

          // An App's own volume goes with its App.
          assert.deepStrictEqual(
            refusals.map((refusal) =>
              "code" in refusal ? refusal.code : refusal._tag
            ),
            ["final_delete_in_progress", "final_delete_in_progress"]
          )
        })
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
      "won't keep an App its Relay began deleting, and finishes it on a retry without a new final backup",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* seedApp()
          // Its data goes, then both sends fail.
          relay.appDeletesFailingAfterData = 2

          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "app",
            relayId,
            resourceId: appId,
            storageId: null,
            user: owner,
          })
          yield* finishBackup(yield* nextBackup(appId, null))
          const stopped = yield* until(appId, ["completed", "failed"])
          const kept = yield* Effect.flip(
            cancelResourceDeletionEffect({
              kind: "app",
              relayId,
              resourceId: appId,
              user: owner,
            })
          )
          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "app",
            relayId,
            resourceId: appId,
            ...(stopped ? { retryOf: Number(stopped.attempt) } : {}),
            storageId: null,
            user: owner,
          })
          const done = yield* until(appId, ["completed"])

          assert.strictEqual(stopped?.status, "failed")
          assert.isNotNull(stopped?.relay_deleting_at)
          assert.strictEqual(
            kept.message,
            "Deleting it has already started; finish deleting it"
          )
          assert.strictEqual(done?.status, "completed")
          // Finished, not frozen or backed up again.
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "app.delete",
            "app.delete",
            "app.delete",
          ])
          assert.lengthOf(yield* selectRows("backup"), 1)
          assert.deepStrictEqual(yield* appRecords, [])
        }).pipe(TestClock.withLive),
      90_000
    )

    it.effect(
      "finishes an App's deletion its Relay stopped partway, rather than taking its missing containers as deleted",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* seedApp()
          relay.nextDelete = "stops-partway"

          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "app",
            relayId,
            resourceId: appId,
            user: owner,
          })
          const done = yield* until(appId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          // Sent again, which finished its folder.
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "app.delete",
            "app.delete",
          ])
          assert.isFalse(relay.appFolders.has(appId))
          assert.deepStrictEqual(yield* appRecords, [])
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
          assert.include(app?.error ?? "", "Relay disk is full")
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
      "freezes then deletes once, even when the delete's reply is lost, and not again when started again",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.nextDelete = "loses-reply"

          yield* deleteServer()
          const done = yield* until(serverId, ["completed", "failed"])
          // As after a restart, and as someone asking again.
          yield* reconcileResourceDeletions()
          yield* deleteServer()
          yield* Effect.sleep("1 second")

          assert.strictEqual(done?.status, "completed")
          assert.isNotNull(done?.relay_deleted_at)
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "instance.delete",
          ])
          assert.isFalse(relay.servers.has(serverId))
          assert.deepStrictEqual(yield* serverRecords, [])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "resumes a carried-over deletion with its final backup, taking no other",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertBackup("final-backup", {
            reason: "final_delete",
            relay_id: relayId,
            target_id: serverId,
          })
          yield* insertDeletion({
            backup_id: "final-backup",
            final_backup: true,
            status: "deleting",
          })

          yield* reconcileResourceDeletions()
          yield* reconcileResourceDeletions()
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "instance.delete",
          ])
          // Kept, as final backups are, and the only one.
          assert.deepStrictEqual(
            (yield* selectRows<{ id: string; status: string }>("backup")).map(
              (row) => [row.id, row.status]
            ),
            [["final-backup", "available"]]
          )
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "admits a deletion recorded without its operation, as after a stop between the two",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertDeletion({ status: "pending" })

          yield* reconcileResourceDeletions()
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(yield* serverRecords, [])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "deletes nothing when the final backup fails, keeping the server frozen until it's kept",
      () =>
        Effect.gen(function* () {
          yield* seed

          yield* deleteServer(owner, true)
          const backingUp = yield* until(serverId, ["backing_up"])
          yield* failBackup(backingUp?.backup_id ?? "")
          const failed = yield* until(serverId, ["failed", "completed"])

          assert.strictEqual(failed?.status, "failed")
          assert.strictEqual(failed?.error, "Relay disk is full")
          assert.deepStrictEqual(relay.changes, ["resource.freeze"])
          assert.isTrue(relay.servers.has(serverId))
          assert.isTrue(relay.frozen.has(serverId))
          assert.deepStrictEqual(yield* serverRecords, [serverId])

          yield* keepServer
          const kept = yield* until(serverId, ["cancelled", "failed"])

          assert.strictEqual(kept?.status, "cancelled")
          assert.isFalse(relay.frozen.has(serverId))
          assert.isTrue(relay.servers.has(serverId))
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "keeps a server durably: its final backup can't be reused, nothing retries meanwhile, and a stop resumes it",
      () =>
        Effect.gen(function* () {
          yield* seedStoppedWithBackup
          // Hearth stopped right after recording the keep, before its
          // operation was admitted.
          const database = yield* Database
          yield* database.execute(
            "test.recordKeep",
            `UPDATE kiln_resource_deletion
                SET status = 'cancelling', attempt = attempt + 1,
                    backup_id = NULL`
          )

          const refused = yield* Effect.flip(deleteServer(owner, true))
          yield* reconcileResourceDeletions()
          const kept = yield* until(serverId, ["cancelled", "failed"])

          assert.instanceOf(refused, ResourceDeletionConflictError)
          assert.include(refused.message, "still being kept")
          assert.strictEqual(kept?.status, "cancelled")
          assert.isFalse(relay.frozen.has(serverId))

          // Running again, it may have changed: deleting it takes a new
          // final backup, not the one from before.
          yield* deleteServer(owner, true)
          const backingUp = yield* until(serverId, ["backing_up"])

          assert.isNotNull(backingUp?.backup_id)
          assert.notStrictEqual(backingUp?.backup_id, "final-backup")

          yield* failBackup(backingUp?.backup_id ?? "")
          yield* until(serverId, ["failed"])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "refuses a retry that read the deletion before someone kept it",
      () =>
        Effect.gen(function* () {
          yield* seedStoppedWithBackup
          // The retry reads attempt 1, failed, then waits on its checks
          // while someone keeps the server.
          const read = yield* until(serverId, ["failed"])
          yield* keepServer
          yield* until(serverId, ["cancelled"])

          const refused = yield* Effect.flip(
            deleteServer(owner, false, Number(read?.attempt))
          )
          yield* Effect.sleep("500 millis")

          assert.instanceOf(refused, ResourceDeletionConflictError)
          assert.strictEqual((yield* deletionOf(serverId))?.status, "cancelled")
          assert.isTrue(relay.servers.has(serverId))
          assert.isFalse(relay.frozen.has(serverId))
          assert.deepStrictEqual(relay.changes, ["resource.unfreeze"])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "settles a keep and a retry asked at once one way, and says so to both",
      () =>
        Effect.gen(function* () {
          yield* seedStoppedWithBackup

          const [kept, retried] = yield* Effect.all(
            [
              Effect.result(keepServer),
              // As the page's "Try again" asks: from the attempt it showed.
              Effect.result(deleteServer(owner, false, 1)),
            ],
            { concurrency: "unbounded" }
          )
          const settled = yield* until(serverId, [
            "cancelled",
            "completed",
            "failed",
          ])

          // Exactly one went ahead, and the other was refused.
          assert.notStrictEqual(kept._tag, retried._tag)
          if (kept._tag === "Success") {
            assert.strictEqual(settled?.status, "cancelled")
            assert.isTrue(relay.servers.has(serverId))
            assert.isFalse(relay.frozen.has(serverId))
          } else {
            assert.strictEqual(settled?.status, "completed")
            assert.isFalse(relay.servers.has(serverId))
          }
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "keeps everything when the Relay refuses to delete, and finishes on a retry",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.nextDelete = "refuses"

          yield* deleteServer()
          const failed = yield* until(serverId, ["failed", "completed"])

          assert.strictEqual(failed?.status, "failed")
          assert.include(failed?.error ?? "", "couldn't remove it")
          assert.isNull(failed?.relay_deleted_at)
          assert.deepStrictEqual(yield* serverRecords, [serverId])

          yield* deleteServer()
          const done = yield* until(serverId, ["completed"])

          assert.strictEqual(done?.attempt, 2)
          assert.isFalse(relay.servers.has(serverId))
          assert.deepStrictEqual(yield* serverRecords, [])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "only cleans up on a retry after the Relay deleted it, whoever asks",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.servers.clear()
          yield* insertDeletion({
            error: "Cleaning up failed",
            relay_deleted_at: at,
            status: "failed",
          })

          yield* deleteServer(stranger, true)
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.changes, [])
          assert.deepStrictEqual(yield* serverRecords, [])
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
          assert.include(failed?.error ?? "", "Nothing was deleted")
          assert.deepStrictEqual(relay.changes, [])
          assert.deepStrictEqual(yield* serverRecords, [serverId])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "gives two first requests at once the one deletion",
      () =>
        Effect.gen(function* () {
          yield* seed

          const [first, second] = yield* Effect.all(
            [deleteServer(), deleteServer()],
            { concurrency: "unbounded" }
          )
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(first.id, second.id)
          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "instance.delete",
          ])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "keeps what's left of a database's data when the Relay lists nothing of it",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* allow("database", databaseId, ["database.delete"])
          yield* insertRows("database", {
            created_at: at,
            created_by: owner.id,
            database_id: databaseId,
            database_name: "db_main",
            engine: "postgres",
            name: "main",
            password_ciphertext: "ciphertext",
            relay_id: relayId,
            updated_at: at,
            username: "user_main",
          })
          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "database",
            relayId,
            resourceId: databaseId,
            user: owner,
          })
          const done = yield* until(databaseId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "database.delete",
          ])
          assert.deepStrictEqual(relay.deletedData, [false])
          assert.lengthOf(yield* selectRows("database"), 0)
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "refuses a schedule naming a game server being deleted, or one its Relay deleted",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertDeletion({ status: "backing_up" })
          const database = yield* Database
          const setDeletion = (set: string) =>
            database.execute(
              "test.setDeletion",
              `UPDATE kiln_resource_deletion SET ${set}`
            )
          const save = () =>
            database.transaction("test.schedule", (transaction) =>
              insertSchedule(
                transaction,
                {
                  actions: [],
                  continueOnFailure: false,
                  cron: "0 0 * * *",
                  enabled: true,
                  id: randomUUID(),
                  name: "Nightly",
                  revision: 1,
                  targets: [
                    {
                      id: serverId,
                      kind: "instance",
                      name: "Survival",
                      relayId,
                    },
                  ],
                  timezone: "UTC",
                },
                owner.id,
                at
              )
            )

          const underWay = yield* Effect.flip(save())
          // Stopped in cleanup, after the Relay deleted it.
          yield* setDeletion(`status = 'failed', relay_deleted_at = ${at}`)
          const gone = yield* Effect.flip(save())

          assert.strictEqual(underWay.message, "Survival is being deleted")
          assert.strictEqual(gone.message, "Survival was deleted")
          assert.lengthOf(yield* selectRows("schedule"), 0)

          // Kept, it's a target like any other again.
          yield* setDeletion(`status = 'cancelled', relay_deleted_at = NULL`)
          yield* save()
          assert.lengthOf(yield* selectRows("schedule_target"), 1)
        }).pipe(TestClock.withLive),
      60_000
    )
  })
})
