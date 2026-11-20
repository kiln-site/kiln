import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, beforeAll, beforeEach, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import {
  backupTaskInputSchema,
  relayBackupTaskSchema,
  type BackupTaskInput,
} from "@workspace/contracts"

import {
  interruptedBackupDeletesEffect,
  reconcileBackupTaskEffect,
  reserveBackupDeleteEffect,
} from "@/effect/backups"
import { Database } from "@/effect/database"
import { BackupStorageError } from "@/effect/errors"
import { disposeAppRuntime } from "@/effect/runtime"
import {
  carryOutBackupDelete,
  reconcileRelayBackups,
} from "@/lib/backup-reconciliation"
import { listPersistedRelays } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

const secrets = `1:${"x".repeat(32)}`
const relayId = "1".repeat(12)
const storageId = "2".repeat(12)
const backupId = "11111111-1111-4111-8111-111111111111"
const bucketCopy = "11111111-1111-4111-8111-1111111111a1"
const otherStorageId = "3".repeat(12)
const otherBucketCopy = "11111111-1111-4111-8111-1111111111a3"
const otherObjectKey = "other/kiln/install/relay/instance/one/archive.zip"
const relayCopy = "11111111-1111-4111-8111-1111111111a2"
const objectKey = "team/kiln/install/relay/instance/one/archive.zip"
const at = Date.UTC(2026, 10, 1)

// The two systems outside Hearth: the bucket, which here keeps what it is
// asked to delete and may refuse, and the Relay, which may be away.
const bucket = {
  deleted: [] as Array<string>,
  /** Every delete, or only the one of this object. */
  refuses: false as boolean | string,
  /** Whether requests to it fail without an answer. */
  unreachable: false,
}
const relay = { away: false, sent: [] as Array<BackupTaskInput> }

vi.mock("@/backups/destinations/s3/client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/backups/destinations/s3/client")
  >()),
  deleteS3BackupObject: (_credential: unknown, key: string) =>
    Effect.suspend(() => {
      const refused = bucket.refuses === true || bucket.refuses === key
      if (!refused && !bucket.unreachable) {
        return Effect.sync(() => void bucket.deleted.push(key))
      }
      return Effect.fail(
        BackupStorageError.make({
          cause: bucket.unreachable
            ? Object.assign(new Error("connect ETIMEDOUT"), {
                name: "TimeoutError",
              })
            : Object.assign(new Error("Access Denied"), {
                $metadata: { httpStatusCode: 403 },
                name: "AccessDenied",
              }),
          code: "s3_request_failed",
          operation: "storage.deleteObject",
          reason: "The S3-compatible storage request failed.",
        })
      )
    }),
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string, input: unknown) => {
    if (relay.away) throw new Error("The Relay is not connected")
    // It holds no tasks but the ones it is sent here.
    if (operation === "backup.task.list") return []
    if (operation !== "backup.task.enqueue") {
      throw new Error(`Unexpected Relay request ${operation}`)
    }
    const task = backupTaskInputSchema.parse(input)
    relay.sent.push(task)
    return relayTask(task, "queued")
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

function relayTask(
  input: BackupTaskInput,
  status: "queued" | "succeeded",
  result: unknown = null
) {
  return {
    backupId: input.backupId,
    bytesCompleted: 0,
    bytesTotal: null,
    createdAt: at,
    currentArtifactId: null,
    currentPath: null,
    error: null,
    errorCode: null,
    finishedAt: status === "succeeded" ? at + 1 : null,
    input,
    inputRefreshRequired: false,
    kind: input.kind,
    phase: null,
    result,
    startedAt: null,
    status,
    taskId: input.taskId,
    updatedAt: at + (status === "succeeded" ? 1 : 0),
  }
}

const encrypt = (plaintext: string, field: string, storage = storageId) =>
  encryptWithKeyring(
    plaintext,
    parseSecretKeyring(secrets),
    `kiln-backup-storage:${storage}:${field}`
  )

// A full backup with a copy in a bucket and, when asked, one on its Relay.
const seed = (options: {
  /** Still being made: its create is running, its copies not yet stored. */
  making?: boolean
  onRelay: boolean
  /** A copy in a second bucket too. */
  twoBuckets?: boolean
}) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRelay(relayId, { enabled: 1 })
    yield* insertBackupStorage(storageId, {
      access_key_id_ciphertext: encrypt("AKIAEXAMPLE", "access-key-id"),
      secret_access_key_ciphertext: encrypt("secret", "secret-access-key"),
    })
    yield* insertBackup(backupId, {
      object_key: options.onRelay ? null : objectKey,
      relay_id: relayId,
      status: options.making ? "running" : "available",
      storage_id: options.onRelay ? null : storageId,
    })
    if (options.making) {
      yield* insertRows("backup_task", {
        backup_id: backupId,
        created_at: at,
        id: createTask,
        status: "running",
        task_kind: "create",
        updated_at: at,
      })
    }
    const copy = (id: string, row: Record<string, unknown>) =>
      insertRows("backup_artifact", {
        backup_id: backupId,
        bytes: 10,
        checksum_sha256: "a".repeat(64),
        created_at: at,
        id,
        status: options.making ? "running" : "available",
        updated_at: at,
        ...row,
      })
    if (options.onRelay) yield* copy(relayCopy, { destination_key: "local" })
    yield* copy(bucketCopy, {
      created_at: at + 1,
      destination_key: storageId,
      object_key: objectKey,
      storage_id: storageId,
    })
    if (options.twoBuckets) {
      yield* insertBackupStorage(otherStorageId, {
        access_key_id_ciphertext: encrypt(
          "AKIAEXAMPLE",
          "access-key-id",
          otherStorageId
        ),
        secret_access_key_ciphertext: encrypt(
          "secret",
          "secret-access-key",
          otherStorageId
        ),
      })
      yield* copy(otherBucketCopy, {
        created_at: at + 2,
        destination_key: otherStorageId,
        object_key: otherObjectKey,
        storage_id: otherStorageId,
      })
    }
    const [persisted] = yield* Effect.promise(listPersistedRelays)
    return persisted!
  })

// What every delete does, whoever asks: reserve it, and carry out one of
// a backup nothing is still making.
const reserve = (taskId: string) =>
  reserveBackupDeleteEffect({ backupId, requestedBy: null, taskId })
const carryOut = (
  persisted: Awaited<ReturnType<typeof listPersistedRelays>>[number],
  taskId: string,
  unanswering?: Set<string>
) =>
  Effect.gen(function* () {
    const reservation = yield* reserve(taskId)
    if (reservation.kind !== "dispatch") return assert.fail("no delete")
    return yield* Effect.promise(() =>
      carryOutBackupDelete(persisted, reservation, { unanswering })
    )
  })

const state = Effect.gen(function* () {
  const [backup] = yield* selectRows<{ status: string }>("backup")
  const copies = yield* selectRows<{
    error: string | null
    error_code: string | null
    id: string
    status: string
  }>("backup_artifact")
  const tasks = yield* selectRows<{ id: string; status: string }>("backup_task")
  return {
    backup: backup?.status,
    copies: Object.fromEntries(copies.map((copy) => [copy.id, copy])),
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task.status])),
  }
})

const createTask = "11111111-1111-4111-8111-1111111111c1"
const firstDelete = "11111111-1111-4111-8111-1111111111d1"
// The deletes Hearth has yet to see through, as its sweep reads them.
const interrupted = interruptedBackupDeletesEffect({
  limit: 10,
  relayIds: [relayId],
})
const secondDelete = "11111111-1111-4111-8111-1111111111d2"

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", secrets)
})
beforeEach(() => {
  bucket.deleted = []
  bucket.refuses = false
  bucket.unreachable = false
  relay.away = false
  relay.sent = []
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await disposeAppRuntime()
})

describeMysql("deleting a backup's stored copies in a bucket", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "deletes a backup kept only in a bucket while its Relay is away",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed({ onRelay: false })
          relay.away = true

          const carried = yield* carryOut(persisted, firstDelete)

          assert.deepStrictEqual(carried, { kept: null, sent: true })
          assert.deepStrictEqual(bucket.deleted, [objectKey])
          const after = yield* state
          assert.strictEqual(after.backup, "deleted")
          assert.strictEqual(after.copies[bucketCopy]?.status, "deleted")
          assert.strictEqual(after.tasks[firstDelete], "succeeded")
        })
    )

    it.effect(
      "sends its Relay only the copy on the Relay's disk, and ends with the Relay's answer",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed({ onRelay: true })

          yield* carryOut(persisted, firstDelete)

          assert.deepStrictEqual(bucket.deleted, [objectKey])
          const [sent] = relay.sent
          if (sent?.kind !== "delete") return assert.fail("no delete sent")
          // The Relay's own disk, which its ID names.
          assert.deepStrictEqual(sent.destination, {
            artifactId: relayCopy,
            destinationId: relayId,
            kind: "local",
          })
          assert.deepStrictEqual(sent.replicas, [])
          const waiting = yield* state
          assert.strictEqual(waiting.backup, "deleting")
          assert.strictEqual(waiting.copies[bucketCopy]?.status, "deleted")

          yield* reconcileBackupTaskEffect(
            relayBackupTaskSchema.parse(
              relayTask(sent, "succeeded", {
                artifacts: [
                  { artifactId: relayCopy, error: null, status: "deleted" },
                ],
                warnings: [],
              })
            ),
            relayId
          )

          assert.strictEqual((yield* state).backup, "deleted")
        })
    )

    // The copy is still in the bucket, so the backup must still say so:
    // marking it deleted would leave an object nothing lists. And a delete
    // that can't finish takes nothing: the Relay's copy stays restorable.
    it.effect(
      "keeps a backup whole when its bucket refuses, and deletes it when asked again",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed({ onRelay: true })
          bucket.refuses = true

          const refused = yield* carryOut(persisted, firstDelete)

          assert.include(refused.kept, "AccessDenied")
          assert.deepStrictEqual(relay.sent, [])
          const kept = yield* state
          assert.strictEqual(kept.backup, "available")
          assert.strictEqual(kept.copies[relayCopy]?.status, "available")
          assert.strictEqual(kept.copies[bucketCopy]?.status, "available")
          assert.include(kept.copies[bucketCopy]?.error, "AccessDenied")
          assert.strictEqual(
            kept.copies[bucketCopy]?.error_code,
            "storage_access_denied"
          )
          assert.strictEqual(kept.tasks[firstDelete], "failed")

          bucket.refuses = false
          yield* carryOut(persisted, secondDelete)

          assert.deepStrictEqual(bucket.deleted, [objectKey])
          assert.strictEqual(
            (yield* state).copies[bucketCopy]?.status,
            "deleted"
          )
          assert.strictEqual(relay.sent.length, 1)
        })
    )

    // Reserved, then Hearth stopped before it deleted anything. Its Relay
    // must not be sent the delete meanwhile, or it and the operation that
    // takes the delete up again would both be at it.
    it.effect(
      "leaves a delete Hearth didn't see through to no Relay, and finishes it when taken up again",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed({ onRelay: true })
          yield* reserve(firstDelete)

          yield* Effect.promise(() => reconcileRelayBackups(persisted))

          assert.deepStrictEqual(relay.sent, [])
          assert.deepStrictEqual(bucket.deleted, [])
          assert.deepStrictEqual(yield* interrupted, [
            { backupId, relayId },
          ])

          // Asked for again, it is the same delete, and goes on though the
          // game server it is of has begun to be deleted since.
          yield* insertUser("owner")
          yield* insertRows("resource_deletion", {
            actor: JSON.stringify({ id: "owner" }),
            created_at: at,
            final_backup: false,
            id: "11111111-1111-4111-8111-1111111111e1",
            relay_deleting_at: at,
            relay_id: relayId,
            requested_by: "owner",
            resource_id: "instance-one",
            resource_kind: "instance",
            status: "failed",
            updated_at: at,
          })
          yield* carryOut(persisted, secondDelete)

          assert.deepStrictEqual(bucket.deleted, [objectKey])
          assert.deepStrictEqual(yield* interrupted, [])
          const after = yield* state
          assert.deepStrictEqual(Object.keys(after.tasks), [firstDelete])
          const [sent] = relay.sent
          if (sent?.kind !== "delete") return assert.fail("no delete sent")
          assert.strictEqual(sent.taskId, firstDelete)
          assert.strictEqual(sent.destination.kind, "local")
        })
    )

    // An upload may still be running, and only the Relay's queue knows
    // when it has ended. So the whole delete is the Relay's, and stays the
    // Relay's even once the create has finished and stored its copy.
    it.effect(
      "leaves a backup still being made to its Relay, bucket copy and all",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed({ making: true, onRelay: false })
          const waiting = yield* reserve(firstDelete)
          assert.deepStrictEqual(waiting, {
            createTaskId: createTask,
            kind: "waiting",
          })

          // The create finished all the same, before it could be stopped.
          const database = yield* Database
          yield* database.execute(
            "test.created",
            "UPDATE kiln_backup_task SET status = 'succeeded' WHERE id = ?",
            [createTask]
          )
          yield* database.execute(
            "test.stored",
            "UPDATE kiln_backup_artifact SET status = 'available' WHERE id = ?",
            [bucketCopy]
          )
          assert.deepStrictEqual(yield* interrupted, [])

          yield* Effect.promise(() => reconcileRelayBackups(persisted))

          assert.deepStrictEqual(bucket.deleted, [])
          const [sent] = relay.sent
          if (sent?.kind !== "delete") return assert.fail("no delete sent")
          assert.deepStrictEqual(sent.destination, {
            artifactId: bucketCopy,
            destinationId: storageId,
            kind: "s3",
          })

          // Asked for again, it is still the Relay's.
          const again = yield* reserve(secondDelete)
          if (again.kind !== "dispatch") return assert.fail("no delete")
          assert.deepStrictEqual(again.stored, [])
        })
    )

    // A delete that ends part way must leave the catalog saying what the
    // buckets hold: a copy one gave up is gone from it, and one a bucket
    // kept is still listed, with the Relay's copy untouched.
    it.effect(
      "records each bucket's answer as it comes, when one gives its copy up and another keeps its own",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed({ onRelay: true, twoBuckets: true })
          bucket.refuses = otherObjectKey

          const carried = yield* carryOut(persisted, firstDelete)

          assert.include(carried.kept, "AccessDenied")
          assert.deepStrictEqual(relay.sent, [])
          const after = yield* state
          assert.strictEqual(after.backup, "available")
          assert.strictEqual(after.copies[relayCopy]?.status, "available")
          assert.strictEqual(after.copies[otherBucketCopy]?.status, "available")
          // The older copy is asked for first.
          assert.deepStrictEqual(bucket.deleted, [objectKey])
          assert.strictEqual(after.copies[bucketCopy]?.status, "deleted")
        })
    )

    // Retention deletes many backups in one pass. A bucket that is down
    // must cost the pass one wait, not one for each backup it holds: the
    // rest of the pass leaves it alone, even if it is back.
    it.effect(
      "leaves a destination alone for the rest of a pass it didn't answer in",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed({ onRelay: false })
          bucket.unreachable = true
          const unanswering = new Set<string>()

          yield* carryOut(persisted, firstDelete, unanswering)
          bucket.unreachable = false
          const again = yield* carryOut(persisted, secondDelete, unanswering)

          assert.include(again.kept, "didn't answer")
          assert.deepStrictEqual(bucket.deleted, [])
          const after = yield* state
          assert.strictEqual(after.backup, "available")
          assert.strictEqual(after.tasks[secondDelete], "failed")
        })
    )

    // A bucket that refuses one copy, as one under a retention lock, may
    // still give up the next.
    it.effect("asks a destination again that refused a copy", () =>
      Effect.gen(function* () {
        const persisted = yield* seed({ onRelay: false })
        bucket.refuses = true
        const unanswering = new Set<string>()

        yield* carryOut(persisted, firstDelete, unanswering)
        bucket.refuses = false
        yield* carryOut(persisted, secondDelete, unanswering)

        assert.strictEqual((yield* state).backup, "deleted")
      })
    )
  })
})
