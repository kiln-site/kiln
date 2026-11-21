import { assert, layer } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import type { BackupStorageError } from "@/effect/errors"

import { relayBackupTaskSchema } from "@workspace/contracts"

import { saveBackupStorageEffect } from "@/backups/destinations/s3"
import { reconcileBackupTaskEffect } from "@/effect/backups"
import { Database } from "@/effect/database"
import { finalBackupStateEffect } from "@/effect/resource-deletions"
import { disposeAppRuntime } from "@/effect/runtime"
import { checkBucketCopiesEffect } from "@/lib/bucket-copy-checks.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, insertRows, selectRows } from "@/test/seed"

// A full backup's bucket copy counts once Hearth has seen it in the bucket,
// at the size its Relay reported uploading. The bucket is the one boundary:
// what it holds at each key, or how it answers.
const bucket = vi.hoisted(() => ({
  // A size, or a status the bucket answers with instead.
  objects: new Map<string, number | { status: number }>(),
  // Holds every look until opened, saying when one has started.
  looking: null as null | Promise<void>,
  started: () => {},
}))
vi.mock("@/backups/destinations/s3/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/backups/destinations/s3/client")>()
  const { Effect: E } = await import("effect")
  const { BackupStorageError: StorageError } = await import(
    "@/effect/errors"
  )
  return {
    ...original,
    headS3BackupObject: (_credential: unknown, objectKey: string) =>
      E.promise(async () => {
        bucket.started()
        await bucket.looking
        return bucket.objects.get(objectKey)
      }).pipe(
        E.flatMap(
          (
            held
          ): Effect.Effect<
            { kind: "missing" } | { bytes: number; kind: "found" },
            BackupStorageError
          > =>
          held === undefined
            ? E.succeed({ kind: "missing" as const })
            : typeof held === "number"
              ? E.succeed({ bytes: held, kind: "found" as const })
              : E.fail(
                  StorageError.make({
                    cause: { $metadata: { httpStatusCode: held.status } },
                    code: "s3_request_failed",
                    operation: "storage.head",
                    reason: "The bucket answered with an error",
                  })
                )
        )
      ),
  }
})
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))
// A destination's keys are kept encrypted.
vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

afterAll(() => disposeAppRuntime())

const now = Date.UTC(2026, 10, 1)
const relayId = "a".repeat(12)
const target = { id: "c".repeat(12), kind: "instance" as const }
const uploaded = 2048
// Each seed is a backup, its copies and its destination by IDs of their own,
// so nothing Hearth remembers of one destination or copy, as a bucket left
// alone a while, reaches another test.
let seeded = 0
let storageId = ""
let backupId = ""
let bucketCopy = ""
let localCopy = ""
let createTaskId = ""
let objectKey = ""
const uuid = (part: string) =>
  `${String(seeded).padStart(8, "0")}-0000-4000-8000-${part.padStart(12, "0")}`

// A full backup being made to the bucket, and to the Relay's own disk too
// when `local`, with its size limit.
const seed = (options: { local?: boolean; maxBytes?: number } = {}) =>
  Effect.gen(function* () {
    seeded += 1
    storageId = `d${String(seeded).padStart(11, "0")}`
    backupId = uuid("1")
    bucketCopy = uuid("a1")
    localCopy = uuid("a2")
    createTaskId = uuid("c1")
    objectKey = `team/kiln/kiln-test/${relayId}/instance/${target.id}/${backupId}/archive.zip`
    yield* resetDatabase
    yield* TestClock.setTime(now)
    bucket.objects.clear()
    bucket.looking = null
    bucket.started = () => {}
    yield* insertRelay(relayId)
    yield* saveBackupStorageEffect({
      accessKeyId: "AKIAKILNTESTKEY",
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
      secretAccessKey: "kiln-test-secret-access-key",
    })
    yield* insertBackup(backupId, {
      backup_mode: "full",
      object_key: objectKey,
      relay_id: relayId,
      status: "running",
      storage_id: storageId,
      target_id: target.id,
    })
    for (const [id, storage] of [
      [bucketCopy, storageId],
      ...(options.local ? [[localCopy, null] as const] : []),
    ] as const) {
      yield* insertRows("backup_artifact", {
        id,
        backup_id: backupId,
        destination_key: storage ?? "local",
        object_key: storage ? objectKey : null,
        status: "running",
        storage_id: storage,
        created_at: now,
        updated_at: now,
      })
    }
    yield* insertRows("backup_task", {
      id: createTaskId,
      backup_id: backupId,
      task_kind: "create",
      status: "running",
      reserved_bytes: options.maxBytes ?? null,
      created_at: now,
      updated_at: now,
    })
  })

// Its Relay reports the backup made and uploaded, `at` after now.
const reported = (at = 1, artifacts?: Array<{ artifactId: string }>) =>
  reconcileBackupTaskEffect(
    relayBackupTaskSchema.parse({
      backupId,
      bytesCompleted: uploaded,
      bytesTotal: uploaded,
      createdAt: now,
      error: null,
      finishedAt: now + at,
      input: {
        artifactKind: "archive",
        backupId,
        destination: {
          artifactId: bucketCopy,
          kind: "s3",
          objectKey,
          uploadUrl: "https://s3.example.test/upload",
        },
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "full",
        reason: "manual",
        target,
        taskId: createTaskId,
      },
      inputRefreshRequired: false,
      kind: "create",
      result: {
        artifacts: (artifacts ?? [{ artifactId: bucketCopy }]).map(
          ({ artifactId }) => ({ artifactId, error: null, status: "available" })
        ),
        bytes: uploaded,
        checksumSha256: "a".repeat(64),
        filename: `${backupId}.zip`,
        warnings: [],
      },
      startedAt: now,
      status: "succeeded",
      taskId: createTaskId,
      updatedAt: now + at,
    }),
    relayId
  )

const state = Effect.gen(function* () {
  const [backup] = yield* selectRows<{
    bytes: number | string | null
    status: string
  }>("backup")
  const copies = new Map(
    (yield* selectRows<{
      bytes: number | string | null
      error: string | null
      id: string
      status: string
    }>("backup_artifact")).map((copy) => [copy.id, copy])
  )
  return { backup, copies }
})

describeMysql("Bucket copies Hearth looks for", () => {
  layer(TestDatabase)((it) => {
    it.effect("counts one once Hearth has seen it, at that size", () =>
      Effect.gen(function* () {
        yield* seed()
        yield* reported()

        // Uploaded, by its Relay's word: waiting to be seen.
        let after = yield* state
        assert.strictEqual(after.copies.get(bucketCopy)?.status, "running")
        assert.strictEqual(after.backup?.status, "running")
        assert.strictEqual(
          (yield* finalBackupStateEffect(backupId)).state === "available",
          false
        )

        bucket.objects.set(objectKey, uploaded)
        yield* checkBucketCopiesEffect()

        after = yield* state
        assert.strictEqual(after.copies.get(bucketCopy)?.status, "available")
        assert.strictEqual(Number(after.copies.get(bucketCopy)?.bytes), uploaded)
        assert.strictEqual(after.backup?.status, "available")
      })
    )

    it.effect(
      "fails one whose size in the bucket isn't what its Relay uploaded, or is over its limit",
      () =>
        Effect.gen(function* () {
          for (const [held, maxBytes] of [
            [uploaded - 1, undefined],
            [uploaded, uploaded - 1],
          ] as const) {
            yield* seed({ maxBytes })
            yield* reported()
            bucket.objects.set(objectKey, held)

            yield* checkBucketCopiesEffect()

            const after = yield* state
            assert.strictEqual(after.copies.get(bucketCopy)?.status, "failed")
            assert.strictEqual(after.backup?.status, "failed")
            // A final backup that never counted lets nothing be deleted.
            assert.notStrictEqual(
              (yield* finalBackupStateEffect(backupId)).state,
              "available"
            )
          }
        })
    )

    it.effect("fails one that isn't in the bucket", () =>
      Effect.gen(function* () {
        yield* seed()
        yield* reported()

        yield* checkBucketCopiesEffect()

        const after = yield* state
        assert.strictEqual(after.copies.get(bucketCopy)?.status, "failed")
        assert.include(after.copies.get(bucketCopy)?.error ?? "", "isn't in")
      })
    )

    it.effect(
      "keeps one waiting while the bucket can't say, and fails it an hour on, saying why",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* reported()
          bucket.objects.set(objectKey, { status: 403 })

          yield* checkBucketCopiesEffect()
          assert.strictEqual(
            (yield* state).copies.get(bucketCopy)?.status,
            "running"
          )

          yield* TestClock.adjust("61 minutes")
          yield* checkBucketCopiesEffect()

          const copy = (yield* state).copies.get(bucketCopy)
          assert.strictEqual(copy?.status, "failed")
          assert.include(copy?.error ?? "", "403")
        })
    )

    it.effect("keeps what Hearth saw, whatever a later report says", () =>
      Effect.gen(function* () {
        yield* seed()
        yield* reported()
        bucket.objects.set(objectKey, uploaded)
        yield* checkBucketCopiesEffect()

        // The create reported again, newer.
        yield* reported(10)

        const after = yield* state
        assert.strictEqual(after.copies.get(bucketCopy)?.status, "available")
        assert.strictEqual(after.backup?.status, "available")
      })
    )

    it.effect(
      "counts a copy on the Relay's disk at once, while the bucket copy waits",
      () =>
        Effect.gen(function* () {
          yield* seed({ local: true })
          yield* reported(1, [
            { artifactId: bucketCopy },
            { artifactId: localCopy },
          ])

          const after = yield* state
          assert.strictEqual(after.copies.get(localCopy)?.status, "available")
          assert.strictEqual(after.copies.get(bucketCopy)?.status, "running")
          assert.strictEqual(after.backup?.status, "available")
        })
    )

    it.effect("brings nothing back of a backup deleted while Hearth looked", () =>
      Effect.gen(function* () {
        yield* seed()
        yield* reported()
        bucket.objects.set(objectKey, uploaded)
        let answer = () => {}
        bucket.looking = new Promise((resolve) => {
          answer = resolve
        })

        // Hearth looks; meanwhile the backup is deleted.
        const started = new Promise<void>((resolve) => {
          bucket.started = resolve
        })
        const looking = yield* Effect.forkChild(checkBucketCopiesEffect())
        yield* Effect.promise(() => started)
        const database = yield* Database
        yield* database.execute(
          "test.deleted",
          `UPDATE kiln_backup SET status = 'deleted' WHERE id = ?`,
          [backupId]
        )
        yield* database.execute(
          "test.deleted",
          `UPDATE kiln_backup_artifact SET status = 'deleted' WHERE backup_id = ?`,
          [backupId]
        )
        answer()
        yield* Fiber.join(looking)

        const after = yield* state
        assert.strictEqual(after.backup?.status, "deleted")
        assert.strictEqual(after.copies.get(bucketCopy)?.status, "deleted")
      })
    )
  })
})
