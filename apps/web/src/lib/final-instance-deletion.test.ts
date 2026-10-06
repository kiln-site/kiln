import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import { saveBackupStorageEffect } from "@/backups/destinations/s3"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  deleteInstanceWithoutFinalBackup,
  ensureFinalInstanceDeletion,
  processFinalInstanceDeletions,
} from "@/lib/final-instance-deletion"
import { listPersistedRelays } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertGrant,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

// The Relay and S3 are the only fakes: a Relay holding servers, and a bucket
// holding object keys as `<bucket>/<key>`.
const fake = vi.hoisted(() => ({
  bucket: new Set<string>(),
  relayServers: new Set<string>(),
  relayDeleteFailure: null as null | "refuses" | "loses-response",
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string, payload: unknown) => {
    if (operation === "instance.delete") {
      const { instanceId } = payload as { instanceId: string }
      if (fake.relayDeleteFailure === "refuses") {
        throw new Error("Relay could not remove the server")
      }
      fake.relayServers.delete(instanceId)
      if (fake.relayDeleteFailure === "loses-response") {
        throw new Error("Relay connection closed")
      }
      return { deleted: true, instanceId }
    }
    if (operation === "relay.snapshot") {
      return relaySnapshot([...fake.relayServers])
    }
    throw new Error(`Unexpected Relay operation ${operation}`)
  },
}))

vi.mock("@/backups/destinations/s3/client", async (importOriginal) => {
  const { Effect } = await import("effect")
  return {
    ...(await importOriginal<
      typeof import("@/backups/destinations/s3/client")
    >()),
    deleteS3BackupPrefix: (credential: { bucket: string }, prefix: string) =>
      Effect.sync(() => {
        for (const object of fake.bucket) {
          if (object.startsWith(`${credential.bucket}/${prefix}`)) {
            fake.bucket.delete(object)
          }
        }
      }),
  }
})

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const at = 1_767_225_600_000
const relayId = "relay-one"
const instanceId = "a1".repeat(20)
const otherInstanceId = "b2".repeat(20)
const storageId = "11111111-1111-4111-8111-111111111111"
const resticPrefix = `team/restic/${instanceId}`
const archiveObject = `kiln-backups/team/archives/${instanceId}/final.tar.zst`
const otherServerObject = `kiln-backups/team/restic/${otherInstanceId}/config`

const user = {
  id: "user-one",
  role: "user",
  email: "user-one@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  name: "User One",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

// A server on the Relay with incremental snapshots in an S3 restic
// repository, a final archive backup, and a final-deletion plan.
const seedServer = (input: {
  backupStatus: "available" | "failed"
  deletionStatus: "backing_up" | "deleting" | "failed"
}) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRelay(relayId)
    yield* saveBackupStorageEffect({
      accessKeyId: "access-key",
      allowPrivateNetwork: false,
      bucket: "kiln-backups",
      enabled: true,
      endpoint: "https://s3.example.test",
      forcePathStyle: false,
      id: storageId,
      name: "Team",
      objectPrefix: "team",
      ownerUserId: null,
      region: "us-east-1",
      secretAccessKey: "secret-key",
    })
    yield* insertRows("backup_repository", {
      id: "repository-one",
      relay_id: relayId,
      target_kind: "instance",
      target_id: instanceId,
      storage_id: storageId,
      storage_key: storageId,
      object_prefix: resticPrefix,
      password_ciphertext: "repository-password",
      created_at: at,
    })
    yield* insertBackup("snapshot-one", {
      relay_id: relayId,
      target_id: instanceId,
      storage_id: storageId,
      artifact_kind: "restic_snapshot",
      backup_mode: "incremental",
      repository_id: "repository-one",
    })
    yield* insertBackup("final-backup", {
      relay_id: relayId,
      target_id: instanceId,
      storage_id: storageId,
      reason: "final_delete",
      status: input.backupStatus,
    })
    yield* insertRows("backup_task", {
      id: "final-backup-task",
      backup_id: "final-backup",
      task_kind: "create",
      status: input.backupStatus === "available" ? "succeeded" : "failed",
      error: input.backupStatus === "failed" ? "Relay disk is full" : null,
      created_at: at,
      updated_at: at,
    })
    yield* insertRows("backup_final_delete", {
      relay_id: relayId,
      target_id: instanceId,
      backup_id: "final-backup",
      requested_by: user.id,
      status: input.deletionStatus,
      created_at: at,
      updated_at: at,
    })

    fake.relayDeleteFailure = null
    fake.relayServers.clear()
    fake.relayServers.add(instanceId)
    fake.bucket.clear()
    fake.bucket.add(`kiln-backups/${resticPrefix}/config`)
    fake.bucket.add(`kiln-backups/${resticPrefix}/data/00/0011`)
    fake.bucket.add(otherServerObject)
    if (input.backupStatus === "available") fake.bucket.add(archiveObject)

    const relay = (yield* Effect.promise(listPersistedRelays)).find(
      (candidate) => candidate.id === relayId
    )
    if (!relay) throw new Error("Seeded Relay is missing")
    return relay
  })

const bucketObjects = () => [...fake.bucket].sort()

const finalDeletions = selectRows<{ status: string; error: string | null }>(
  "backup_final_delete"
)

const backupStatuses = selectRows<{ id: string; status: string }>(
  "backup"
).pipe(
  Effect.map((rows) =>
    Object.fromEntries(rows.map((row) => [row.id, row.status]))
  )
)

const repositoryIds = selectRows<{ id: string }>("backup_repository").pipe(
  Effect.map((rows) => rows.map((row) => row.id))
)

describeMysql("final instance deletion", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "purges the server's S3 snapshots only after the Relay removed it, keeping the final backup",
      () =>
        Effect.gen(function* () {
          const relay = yield* seedServer({
            backupStatus: "available",
            deletionStatus: "backing_up",
          })

          const pending = yield* Effect.promise(() =>
            processFinalInstanceDeletions(relay)
          )

          assert.isFalse(pending)
          assert.isFalse(fake.relayServers.has(instanceId))
          assert.deepStrictEqual(bucketObjects(), [
            archiveObject,
            otherServerObject,
          ])
          assert.deepStrictEqual(yield* repositoryIds, [])
          assert.deepStrictEqual(yield* backupStatuses, {
            "final-backup": "available",
            "snapshot-one": "deleted",
          })
          assert.strictEqual((yield* finalDeletions)[0]?.status, "completed")
        })
    )

    it.effect(
      "keeps S3 snapshots while the Relay still has the server, then finishes on retry",
      () =>
        Effect.gen(function* () {
          const relay = yield* seedServer({
            backupStatus: "available",
            deletionStatus: "deleting",
          })
          const before = bucketObjects()
          fake.relayDeleteFailure = "refuses"

          const pending = yield* Effect.promise(() =>
            processFinalInstanceDeletions(relay)
          )

          assert.isTrue(pending)
          assert.isTrue(fake.relayServers.has(instanceId))
          assert.deepStrictEqual(bucketObjects(), before)
          assert.deepStrictEqual(yield* repositoryIds, ["repository-one"])
          assert.strictEqual(
            (yield* backupStatuses)["snapshot-one"],
            "available"
          )
          const retrying = (yield* finalDeletions)[0]
          assert.strictEqual(retrying?.status, "deleting")
          assert.strictEqual(
            retrying?.error,
            "Relay could not remove the server"
          )

          // The Relay removes the server this time but the reply is lost; its
          // snapshot shows the server is gone, so the purge goes ahead.
          fake.relayDeleteFailure = "loses-response"

          const stillPending = yield* Effect.promise(() =>
            processFinalInstanceDeletions(relay)
          )

          assert.isFalse(stillPending)
          assert.deepStrictEqual(bucketObjects(), [
            archiveObject,
            otherServerObject,
          ])
          assert.deepStrictEqual(yield* repositoryIds, [])
          assert.strictEqual((yield* finalDeletions)[0]?.status, "completed")
        })
    )

    it.effect("never deletes the server when its final backup failed", () =>
      Effect.gen(function* () {
        const relay = yield* seedServer({
          backupStatus: "failed",
          deletionStatus: "backing_up",
        })
        const before = bucketObjects()

        const pending = yield* Effect.promise(() =>
          processFinalInstanceDeletions(relay)
        )

        assert.isFalse(pending)
        assert.isTrue(fake.relayServers.has(instanceId))
        assert.deepStrictEqual(bucketObjects(), before)
        assert.deepStrictEqual(yield* repositoryIds, ["repository-one"])
        const failed = (yield* finalDeletions)[0]
        assert.strictEqual(failed?.status, "failed")
        assert.strictEqual(failed?.error, "Relay disk is full")
      })
    )

    it.effect(
      "deletes without a backup after a failed final backup and clears the failed plan",
      () =>
        Effect.gen(function* () {
          const relay = yield* seedServer({
            backupStatus: "failed",
            deletionStatus: "failed",
          })

          yield* Effect.promise(() =>
            deleteInstanceWithoutFinalBackup({
              instanceId,
              relay,
              requestedBy: user.id,
            })
          )

          assert.isFalse(fake.relayServers.has(instanceId))
          assert.deepStrictEqual(bucketObjects(), [otherServerObject])
          assert.deepStrictEqual(yield* repositoryIds, [])
          assert.deepStrictEqual(yield* finalDeletions, [])
        })
    )

    it.effect(
      "refuses a personal final-backup destination without backup.download and leaves the plan untouched",
      () =>
        Effect.gen(function* () {
          const relay = yield* seedServer({
            backupStatus: "failed",
            deletionStatus: "failed",
          })
          const personalStorageId = "22222222-2222-4222-8222-222222222222"
          yield* insertUser(user.id)
          yield* insertBackupStorage(personalStorageId, {
            owner_user_id: user.id,
            name: "Personal",
          })
          // Allowed to delete the server and back it up, not to download.
          yield* insertGrant({
            id: "grant-one",
            userId: user.id,
            relayId,
            resourceType: "instance",
            resourceId: instanceId,
            role: null,
          })
          yield* insertRows(
            "access_selection",
            ["instance.delete", "backup.create"].map((key) => ({
              access_id: "grant-one",
              selection_kind: "permission",
              selection_key: key,
            }))
          )

          const error = yield* Effect.promise(() =>
            ensureFinalInstanceDeletion({
              instanceId,
              relay,
              requestedBy: user.id,
              storageId: personalStorageId,
              user,
            }).then(
              () => null,
              (cause: unknown) => cause
            )
          )

          assert.instanceOf(error, Error)
          assert.include(error.message, "permission")
          assert.deepStrictEqual(yield* backupStatuses, {
            "final-backup": "failed",
            "snapshot-one": "available",
          })
          assert.strictEqual((yield* finalDeletions)[0]?.status, "failed")
          assert.isTrue(fake.relayServers.has(instanceId))
        })
    )
  })
})

function relaySnapshot(instanceIds: ReadonlyArray<string>) {
  return {
    instances: instanceIds.map((id) => ({
      id,
      shortId: id.slice(0, 8),
      name: "Survival",
      service: "survival",
      directory: "/data/survival",
      containerId: null,
      desiredState: "stopped",
      observedState: "stopped",
      status: "stopped",
      game: "Minecraft",
      implementation: "paper",
      javaVersion: "21",
      version: "1.21",
      connectAddress: "play.example.test:25565",
    })),
    node: {
      id: relayId,
      name: "Relay One",
      version: "test",
      platform: "linux",
      arch: "arm64",
      connectedAt: "2026-01-01T00:00:00.000Z",
      cpu: { cores: 4, loadPercent: 0 },
      memory: { totalBytes: 1, usedBytes: 0 },
      storage: { totalBytes: 1, usedBytes: 0 },
      docker: { available: true, version: "test" },
    },
  }
}
