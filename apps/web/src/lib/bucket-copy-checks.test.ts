import { assert, layer } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import type { BackupStorageError } from "@/effect/errors"

import { relayBackupTaskSchema } from "@workspace/contracts"

import { saveBackupStorageEffect } from "@/backups/destinations/s3"
import {
  reconcileBackupTaskEffect,
  reserveBackupDeleteEffect,
} from "@/effect/backups"
import { Database } from "@/effect/database"
import { finalBackupStateEffect } from "@/effect/resource-deletions"
import { disposeAppRuntime } from "@/effect/runtime"
import {
  checkBucketCopiesEffect,
  requestBucketCopyChecks,
} from "@/lib/bucket-copy-checks.server"
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
let secondCopy = ""
let secondStorageId = ""
let secondObjectKey = ""
let createTaskId = ""
let objectKey = ""
const uuid = (part: string) =>
  `${String(seeded).padStart(8, "0")}-0000-4000-8000-${part.padStart(12, "0")}`

// A full backup being made to the bucket, and to the Relay's own disk too
// when `local`, with its size limit.
const seed = (
  options: { local?: boolean; maxBytes?: number; second?: boolean } = {}
) =>
  Effect.gen(function* () {
    seeded += 1
    storageId = `d${String(seeded).padStart(11, "0")}`
    backupId = uuid("1")
    bucketCopy = uuid("a1")
    localCopy = uuid("a2")
    secondCopy = uuid("a3")
    secondStorageId = `e${String(seeded).padStart(11, "0")}`
    secondObjectKey = `${objectKey}.second`
    createTaskId = uuid("c1")
    objectKey = `team/kiln/kiln-test/${relayId}/instance/${target.id}/${backupId}/archive.zip`
    yield* resetDatabase
    yield* TestClock.setTime(now)
    bucket.objects.clear()
    bucket.looking = null
    bucket.started = () => {}
    yield* insertRelay(relayId)
    for (const [id, name] of [
      [storageId, "Team"],
      [secondStorageId, "Offsite"],
    ] as const) {
      yield* saveBackupStorageEffect({
        accessKeyId: "AKIAKILNTESTKEY",
        allowPrivateNetwork: false,
        bucket: "kiln-backups",
        enabled: true,
        endpoint: "https://s3.example.test",
        forcePathStyle: false,
        id,
        name,
        objectPrefix: "team",
        ownerUserId: null,
        region: "us-east-1",
        secretAccessKey: "kiln-test-secret-access-key",
      })
    }
    yield* insertBackup(backupId, {
      backup_mode: "full",
      object_key: objectKey,
      relay_id: relayId,
      status: "running",
      storage_id: storageId,
      target_id: target.id,
    })
    for (const [id, storage, key] of [
      [bucketCopy, storageId, objectKey],
      ...(options.local ? [[localCopy, null, null] as const] : []),
      ...(options.second
        ? [[secondCopy, secondStorageId, secondObjectKey] as const]
        : []),
    ] as const) {
      yield* insertRows("backup_artifact", {
        id,
        backup_id: backupId,
        destination_key: storage ?? "local",
        object_key: key,
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

// Its Relay reports the backup made and uploaded, `at` after now, of
// `bytes`, finished by its own clock at `finishedAt`.
const reported = (
  at = 1,
  artifacts?: Array<{ artifactId: string }>,
  report: { bytes?: number; finishedAt?: number | null } = {}
) =>
  reconcileBackupTaskEffect(
    relayBackupTaskSchema.parse({
      backupId,
      bytesCompleted: report.bytes ?? uploaded,
      bytesTotal: report.bytes ?? uploaded,
      createdAt: now,
      error: null,
      finishedAt:
        report.finishedAt === undefined ? now + at : report.finishedAt,
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
        bytes: report.bytes ?? uploaded,
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

// More backups' bucket copies on `storage`, uploaded and waiting to be seen
// by `seenBy`, each answered with `answer(index)`.
const waitingCopies = (
  count: number,
  storage: string,
  seenBy: number,
  answer: (index: number) => number | { status: number }
) =>
  Effect.gen(function* () {
    for (let index = 0; index < count; index += 1) {
      const id = `${String(seeded).padStart(8, "0")}-${storage.slice(0, 4)}-4000-8000-${String(index).padStart(12, "0")}`
      const key = `${objectKey}.${storage}.${index}`
      yield* insertBackup(id, {
        backup_mode: "full",
        relay_id: relayId,
        status: "running",
        storage_id: storage,
        target_id: target.id,
      })
      yield* insertRows("backup_artifact", {
        id: id.replace("-4000-", "-4001-"),
        backup_id: id,
        bytes: uploaded,
        destination_key: storage,
        object_key: key,
        seen_by: seenBy + index,
        status: "running",
        storage_id: storage,
        created_at: now,
        updated_at: now,
      })
      yield* insertRows("backup_task", {
        id: id.replace("-4000-", "-4002-"),
        backup_id: id,
        task_kind: "create",
        status: "succeeded",
        created_at: now,
        updated_at: now,
      })
      bucket.objects.set(key, answer(index))
    }
  })

// Looks as the worker does, one after another while one says more could be
// reached.
const lookUntilDone = Effect.gen(function* () {
  for (let look = 0; look < 30; look += 1) {
    const { more } = yield* checkBucketCopiesEffect()
    if (!more) return
  }
})

const copyStatuses = (storage: string) =>
  Effect.map(
    selectRows<{ id: string; status: string; storage_id: string | null }>(
      "backup_artifact"
    ),
    (rows) => rows.filter(({ storage_id }) => storage_id === storage)
  )

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
          // Its Relay says nothing of when it finished: the hour is
          // Hearth's, from when it first waited.
          yield* reported(1, undefined, { finishedAt: null })
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

    it.effect(
      "looks again at a copy reported anew while Hearth looked at the old report",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* reported()
          bucket.objects.set(objectKey, uploaded)
          let answer = () => {}
          bucket.looking = new Promise((resolve) => {
            answer = resolve
          })
          const started = new Promise<void>((resolve) => {
            bucket.started = resolve
          })

          // Hearth looks for 2 KiB; meanwhile a newer report says 3 KiB.
          const looking = yield* Effect.forkChild(checkBucketCopiesEffect())
          yield* Effect.promise(() => started)
          yield* reported(10, undefined, { bytes: uploaded + 1024 })
          answer()
          yield* Fiber.join(looking)

          // What it saw settles nothing of the newer report.
          assert.strictEqual(
            (yield* state).copies.get(bucketCopy)?.status,
            "running"
          )
          bucket.looking = null
          bucket.objects.set(objectKey, uploaded + 1024)
          yield* checkBucketCopiesEffect()
          assert.strictEqual(
            (yield* state).copies.get(bucketCopy)?.status,
            "available"
          )
        })
    )

    it.effect(
      "settles a backup whose two bucket copies Hearth settles at once",
      () =>
        Effect.gen(function* () {
          for (const [first, second, expected] of [
            [undefined, undefined, "failed"],
            [uploaded, undefined, "available"],
          ] as const) {
            yield* seed({ second: true })
            yield* reported(1, [
              { artifactId: bucketCopy },
              { artifactId: secondCopy },
            ])
            if (first !== undefined) bucket.objects.set(objectKey, first)
            if (second !== undefined) {
              bucket.objects.set(secondObjectKey, second)
            }
            // Both looks answer together.
            let answer = () => {}
            bucket.looking = new Promise((resolve) => {
              answer = resolve
            })
            const looking = yield* Effect.forkChild(checkBucketCopiesEffect())
            yield* Effect.promise(() => new Promise((r) => setImmediate(r)))
            answer()
            yield* Fiber.join(looking)

            assert.strictEqual((yield* state).backup?.status, expected)
          }
        })
    )

    it.effect(
      "looks at one destination's copies though another's fill a look",
      () =>
        Effect.gen(function* () {
          yield* seed({ second: true })
          yield* reported(1, [
            { artifactId: bucketCopy },
            { artifactId: secondCopy },
          ])
          // The first destination has a hundred more copies waiting, each
          // due before the second's, and it can't be asked.
          const database = yield* Database
          for (let index = 0; index < 100; index += 1) {
            const id = `${String(seeded).padStart(8, "0")}-1111-4000-8000-${String(index).padStart(12, "0")}`
            yield* insertBackup(id, {
              backup_mode: "full",
              relay_id: relayId,
              status: "running",
              storage_id: storageId,
              target_id: target.id,
            })
            yield* insertRows("backup_artifact", {
              id: id.replace("-1111-", "-2222-"),
              backup_id: id,
              bytes: uploaded,
              destination_key: storageId,
              object_key: `${objectKey}.${index}`,
              seen_by: now + 1_000,
              status: "running",
              storage_id: storageId,
              created_at: now,
              updated_at: now,
            })
            yield* insertRows("backup_task", {
              id: id.replace("-1111-", "-3333-"),
              backup_id: id,
              task_kind: "create",
              status: "succeeded",
              created_at: now,
              updated_at: now,
            })
            bucket.objects.set(`${objectKey}.${index}`, { status: 503 })
          }
          yield* database.execute(
            "test.later",
            `UPDATE kiln_backup_artifact SET seen_by = ? WHERE id = ?`,
            [now + 2_000, secondCopy]
          )
          bucket.objects.set(objectKey, { status: 503 })
          bucket.objects.set(secondObjectKey, uploaded)

          // One look, as the sweep makes one every ten minutes, reaches the
          // second destination's copy all the same.
          yield* checkBucketCopiesEffect()

          assert.strictEqual(
            (yield* state).copies.get(secondCopy)?.status,
            "available"
          )
        })
    )

    it.effect(
      "settles nothing of a copy Hearth's copy worker took over while Hearth looked",
      () =>
        Effect.gen(function* () {
          yield* seed({ local: true })
          yield* reported(1, [
            { artifactId: bucketCopy },
            { artifactId: localCopy },
          ])
          bucket.objects.set(objectKey, uploaded)
          let answer = () => {}
          bucket.looking = new Promise((resolve) => {
            answer = resolve
          })
          const started = new Promise<void>((resolve) => {
            bucket.started = resolve
          })

          // Hearth looks; meanwhile its copy worker takes the copy's row to
          // copy the backup there again, from the copy on the Relay's disk.
          const looking = yield* Effect.forkChild(checkBucketCopiesEffect())
          yield* Effect.promise(() => started)
          yield* insertRows("backup_copy_task", {
            id: uuid("e1"),
            backup_id: backupId,
            source_artifact_id: localCopy,
            destination_artifact_id: bucketCopy,
            status: "running",
            requested_by: "user-one",
            created_at: now,
            updated_at: now,
          })
          answer()
          yield* Fiber.join(looking)

          // The worker's copy is the worker's to settle.
          assert.strictEqual(
            (yield* state).copies.get(bucketCopy)?.status,
            "running"
          )
        })
    )

    it.effect(
      "keeps a backup waiting whose delete ended with its bucket copy kept",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* reported()
          const deleteTaskId = uuid("d2")
          yield* reserveBackupDeleteEffect({
            backupId,
            requestedBy: "user-one",
            taskId: deleteTaskId,
          })

          // The delete ends, but the bucket refused to delete the copy.
          yield* reconcileBackupTaskEffect(
            relayBackupTaskSchema.parse({
              backupId,
              bytesCompleted: 0,
              bytesTotal: null,
              createdAt: now,
              error: null,
              finishedAt: now + 5,
              input: {
                backupId,
                destination: { artifactId: bucketCopy, kind: "local" },
                kind: "delete",
                target,
                taskId: deleteTaskId,
              },
              inputRefreshRequired: false,
              kind: "delete",
              result: {
                artifacts: [
                  {
                    artifactId: bucketCopy,
                    error: "The bucket refused the delete",
                    status: "failed",
                  },
                ],
                warnings: [],
              },
              startedAt: now,
              status: "succeeded",
              taskId: deleteTaskId,
              updatedAt: now + 5,
            }),
            relayId
          )

          assert.strictEqual((yield* state).backup?.status, "running")
        })
    )

    it.effect("sees a backlog of one destination's copies, a bounded look at a time", () =>
      Effect.gen(function* () {
        yield* seed()
        // Ninety backups' bucket copies, all uploaded and all there.
        yield* waitingCopies(90, storageId, now + 60 * 60_000, () => uploaded)

        yield* lookUntilDone

        const seen = (yield* copyStatuses(storageId)).filter(
          ({ status }) => status === "available"
        )
        assert.lengthOf(seen, 90)
      })
    )

    it.effect(
      "sees a backlog through the looks one wake-up starts",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* waitingCopies(90, storageId, now + 60 * 60_000, () => uploaded)
          vi.useFakeTimers({ now, toFake: ["setTimeout", "clearTimeout", "Date"] })

          // One wake-up, as a report or the sweep gives; each look asks for
          // the next while it leaves copies another could reach.
          requestBucketCopyChecks()
          let seen = 0
          // Each tick passes a look's wait for the next, then lets the look's
          // own reads and writes, which take real time, finish.
          for (let tick = 0; tick < 400 && seen < 90; tick += 1) {
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_100))
            yield* Effect.promise(
              () => new Promise((resolve) => setImmediate(resolve))
            )
            seen = (yield* copyStatuses(storageId)).filter(
              ({ status }) => status === "available"
            ).length
          }

          assert.strictEqual(seen, 90)
        }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers()))),
      60_000
    )

    it.effect(
      "asks a bucket that can't be reached about no more than its share, late copies among them",
      () =>
        Effect.gen(function* () {
          yield* seed()
          // A hundred copies past their deadline that Hearth never looked
          // for, on a bucket that can't be reached, and one due on another.
          yield* waitingCopies(100, storageId, now - 200_000, () => ({
            status: 503,
          }))
          yield* waitingCopies(1, secondStorageId, now + 60 * 60_000, () =>
            uploaded
          )

          yield* checkBucketCopiesEffect()

          const down = yield* copyStatuses(storageId)
          assert.isAtMost(
            down.filter(({ status }) => status === "failed").length,
            10
          )
          const [other] = yield* copyStatuses(secondStorageId)
          assert.strictEqual(other?.status, "available")
        })
    )

    it.effect(
      "leaves a destination whose keys can't be read alone, rather than look again and again",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* waitingCopies(11, storageId, now + 60 * 60_000, () => uploaded)
          const database = yield* Database
          yield* database.execute(
            "test.keys",
            `UPDATE kiln_backup_storage SET access_key_id_ciphertext = ? WHERE id = ?`,
            ["v1.1.unreadable.unreadable.unreadable", storageId]
          )

          yield* lookUntilDone

          // Nothing more to look for while it rests, and none failed.
          assert.isFalse((yield* checkBucketCopiesEffect()).more)
          assert.isTrue(
            (yield* copyStatuses(storageId)).every(
              ({ status }) => status === "running"
            )
          )
        })
    )

    it.effect(
      "looks afresh at a copy reported anew after the bucket refused the old report",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* reported()
          bucket.objects.set(objectKey, { status: 403 })
          yield* checkBucketCopiesEffect()

          // Reported anew at another size, and now readable at it, after
          // its deadline.
          yield* reported(10, undefined, { bytes: uploaded + 1024 })
          bucket.objects.set(objectKey, uploaded + 1024)
          yield* TestClock.adjust("61 minutes")
          yield* checkBucketCopiesEffect()

          assert.strictEqual(
            (yield* state).copies.get(bucketCopy)?.status,
            "available"
          )
        })
    )

    it.effect(
      "looks for a copy behind others the bucket refuses to show",
      () =>
        Effect.gen(function* () {
          yield* seed()
          // Ten older copies the bucket answers 403 for, one at a time, and
          // an eleventh it shows.
          yield* waitingCopies(11, storageId, now + 60 * 60_000, (index) =>
            index < 10 ? { status: 403 } : uploaded
          )

          yield* lookUntilDone

          const copies = yield* copyStatuses(storageId)
          const last = copies.find(({ id }) => id.endsWith("000000000010"))
          assert.strictEqual(last?.status, "available")
        })
    )

    it.effect(
      "gives a copy past its deadline that Hearth never looked for one look",
      () =>
        Effect.gen(function* () {
          yield* seed()
          // Waiting since before a long backlog, now past its hour, and there.
          yield* waitingCopies(1, storageId, now - 1_000, () => uploaded)

          yield* checkBucketCopiesEffect()

          const [copy] = (yield* copyStatuses(storageId)).filter(({ id }) =>
            id.endsWith("000000000000")
          )
          assert.strictEqual(copy?.status, "available")
        })
    )

    it.effect("keeps a backup waiting whose delete failed", () =>
      Effect.gen(function* () {
        yield* seed()
        yield* reported()
        const deleteTaskId = uuid("d1")
        yield* reserveBackupDeleteEffect({
          backupId,
          requestedBy: "user-one",
          taskId: deleteTaskId,
        })

        yield* reconcileBackupTaskEffect(
          relayBackupTaskSchema.parse({
            backupId,
            bytesCompleted: 0,
            bytesTotal: null,
            createdAt: now,
            error: "The bucket refused the delete",
            finishedAt: now + 5,
            input: {
              backupId,
              destination: { artifactId: bucketCopy, kind: "local" },
              kind: "delete",
              target,
              taskId: deleteTaskId,
            },
            inputRefreshRequired: false,
            kind: "delete",
            result: null,
            startedAt: now,
            status: "failed",
            taskId: deleteTaskId,
            updatedAt: now + 5,
          }),
          relayId
        )

        // Its bucket copy still waits to be seen, so it isn't failed.
        assert.strictEqual((yield* state).backup?.status, "running")
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
