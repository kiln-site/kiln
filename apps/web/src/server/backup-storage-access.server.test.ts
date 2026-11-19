import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import type { BackupStorageAccessRequest } from "@workspace/contracts"

import { Database } from "@/effect/database"
import { grantBackupStorageAccessEffect } from "@/server/backup-storage-access.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

const secrets = `1:${"x".repeat(32)}`
const relayId = "a".repeat(12)
const otherRelayId = "b".repeat(12)
const backupId = "11111111-1111-4111-8111-111111111111"
const storageId = "22222222-2222-4222-8222-222222222222"
const otherStorageId = "22222222-2222-4222-8222-22222222222f"
const artifactId = "33333333-3333-4333-8333-333333333333"
const taskId = "44444444-4444-4444-8444-444444444444"
const scheduleId = "55555555-5555-4555-8555-555555555555"
const actionId = "66666666-6666-4666-8666-666666666666"
const objectKey = `team/kiln/install/${relayId}/instance/instance-one/${backupId}/backup.zip`
const seededAt = Date.UTC(2026, 0, 1)

const encrypt = (plaintext: string, purpose: string) =>
  encryptWithKeyring(plaintext, parseSecretKeyring(secrets), purpose)

const insertStorage = (id: string, row: Record<string, boolean | string> = {}) =>
  insertBackupStorage(id, {
    access_key_id_ciphertext: encrypt(
      "AKIAEXAMPLE",
      `kiln-backup-storage:${id}:access-key-id`
    ),
    secret_access_key_ciphertext: encrypt(
      "s3-secret",
      `kiln-backup-storage:${id}:secret-access-key`
    ),
    ...row,
  })

// A backup with one copy in a bucket and one task under way for it.
const seed = (
  options: {
    artifact?: string
    backup?: Record<string, string>
    storage?: Record<string, boolean | string>
    task?: { kind?: string; status?: string }
  } = {}
) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRelay(relayId)
    yield* insertRelay(otherRelayId)
    yield* insertStorage(storageId, options.storage)
    yield* insertBackup(backupId, {
      relay_id: relayId,
      status: "queued",
      storage_id: storageId,
      object_key: objectKey,
      ...options.backup,
    })
    yield* insertRows("backup_artifact", {
      id: artifactId,
      backup_id: backupId,
      destination_key: storageId,
      storage_id: storageId,
      status: options.artifact ?? "queued",
      object_key: objectKey,
      created_at: seededAt,
      updated_at: seededAt,
    })
    yield* insertRows("backup_task", {
      id: taskId,
      backup_id: backupId,
      task_kind: options.task?.kind ?? "create",
      status: options.task?.status ?? "queued",
      created_at: seededAt,
      updated_at: seededAt,
    })
  })

// A schedule Hearth sent `deployedTo`, whose step backs up to `storage`.
const seedSchedule = (deployedTo: string, storage: string) =>
  Effect.gen(function* () {
    yield* insertUser("owner")
    yield* insertRows("schedule", {
      id: scheduleId,
      name: "Nightly",
      cron_expression: "0 3 * * *",
      created_by: "owner",
      created_at: seededAt,
      updated_at: seededAt,
    })
    yield* insertRows("schedule_action", {
      id: actionId,
      schedule_id: scheduleId,
      position: 0,
      action_type: "backup",
      action_config: JSON.stringify({
        destination: { kind: "storage", storageId: storage },
        id: actionId,
        mode: "full",
        name: "Scheduled backup",
        type: "backup",
      }),
      created_at: seededAt,
    })
    yield* insertRows("schedule_deployment", {
      schedule_id: scheduleId,
      relay_id: deployedTo,
      desired_revision: 1,
      created_at: seededAt,
      updated_at: seededAt,
    })
  })

const ask = (
  request: Partial<BackupStorageAccessRequest> = {},
  from = relayId,
  catalog: Effect.Effect<void, unknown> = Effect.void
) =>
  grantBackupStorageAccessEffect(
    from,
    { action: "upload", artifactId, backupId, taskId, ...request },
    catalog
  )

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", secrets)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

// Hearth holds every bucket's keys, so what this refuses is all that keeps
// a Relay out of backups that aren't its own task's.
describeMysql("backup storage access", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "signs one upload of the task's own copy, good for minutes, with no checksum of a body it never saw",
      () =>
        Effect.gen(function* () {
          yield* seed()

          const answer = yield* ask()

          assert.strictEqual(answer.status, "granted")
          if (answer.status !== "granted") return
          assert.strictEqual(answer.method, "PUT")
          const url = new URL(answer.url)
          assert.strictEqual(url.hostname, "kiln-backups.s3.example.com")
          assert.strictEqual(decodeURIComponent(url.pathname), `/${objectKey}`)
          assert.strictEqual(url.searchParams.get("X-Amz-Expires"), "600")
          assert.isNotNull(url.searchParams.get("X-Amz-Signature"))
          // A signed checksum of an empty body made buckets that check it
          // refuse the archive.
          assert.isFalse(
            [...url.searchParams.keys()].some((name) =>
              name.toLowerCase().includes("checksum")
            )
          )
          assert.notInclude(JSON.stringify(answer), "s3-secret")
        })
    )

    const refusals: ReadonlyArray<{
      case: string
      from?: string
      request?: Partial<BackupStorageAccessRequest>
      seeded?: Parameters<typeof seed>[0]
    }> = [
      {
        case: "another Relay asks for it",
        from: otherRelayId,
      },
      {
        case: "the copy is another backup's",
        request: { artifactId: "33333333-3333-4333-8333-33333333333f" },
      },
      {
        case: "the task is another backup's",
        request: { backupId: "11111111-1111-4111-8111-11111111111f" },
      },
      {
        case: "a create asks to read the copy",
        request: { action: "download" as const },
      },
      {
        case: "a create asks to delete the copy",
        request: { action: "delete" as const },
      },
      { case: "the task has ended", seeded: { task: { status: "succeeded" } } },
      { case: "the copy is already stored", seeded: { artifact: "available" } },
      {
        case: "its destination is disabled",
        seeded: { storage: { enabled: false } },
      },
      {
        case: "its destination is being deleted",
        seeded: { storage: { deleting: true } },
      },
    ]
    it.effect.each(refusals)(
      "refuses an upload when $case",
      ({ from, request, seeded }) =>
      Effect.gen(function* () {
        yield* seed(seeded)

        const answer = yield* ask(request, from)

        assert.strictEqual(answer.status, "refused")
      })
    )

    it.effect(
      "lets a restore read a stored copy, even from a destination being deleted, and nothing write it",
      () =>
        Effect.gen(function* () {
          yield* seed({
            artifact: "available",
            backup: { status: "available" },
            storage: { deleting: true },
            task: { kind: "restore" },
          })

          const read = yield* ask({ action: "download" })
          const write = yield* ask({ action: "upload" })
          const remove = yield* ask({ action: "delete" })

          assert.strictEqual(read.status, "granted")
          assert.strictEqual(read.status === "granted" && read.method, "GET")
          assert.strictEqual(write.status, "refused")
          assert.strictEqual(remove.status, "refused")
        })
    )

    it.effect("lets a delete remove a copy and nothing else", () =>
      Effect.gen(function* () {
        yield* seed({
          artifact: "deleting",
          backup: { status: "deleting" },
          task: { kind: "delete" },
        })

        const remove = yield* ask({ action: "delete" })
        const read = yield* ask({ action: "download" })

        assert.strictEqual(remove.status, "granted")
        assert.strictEqual(
          remove.status === "granted" && remove.method,
          "DELETE"
        )
        assert.strictEqual(read.status, "refused")
      })
    )

    // The Relay starts a scheduled backup on its own, so only a schedule
    // Hearth sent it says the backup may go to that bucket.
    it.effect.each([
      {
        case: "it names the step of a schedule Hearth sent it that backs up there",
        deployedTo: relayId,
        expected: "granted",
        schedule: { actionId, id: scheduleId },
        storage: storageId,
      },
      {
        case: "it names no schedule",
        deployedTo: relayId,
        expected: "refused",
        schedule: undefined,
        storage: storageId,
      },
      {
        case: "the schedule was sent to another Relay",
        deployedTo: otherRelayId,
        expected: "refused",
        schedule: { actionId, id: scheduleId },
        storage: storageId,
      },
      {
        case: "the schedule's step backs up somewhere else",
        deployedTo: relayId,
        expected: "refused",
        schedule: { actionId, id: scheduleId },
        storage: otherStorageId,
      },
    ])(
      "answers a scheduled backup's upload $expected when $case",
      ({ deployedTo, expected, schedule, storage }) =>
        Effect.gen(function* () {
          yield* seed({ backup: { reason: "scheduled" } })
          yield* insertStorage(otherStorageId)
          yield* seedSchedule(deployedTo, storage)

          const answer = yield* ask(schedule ? { schedule } : {})

          assert.strictEqual(answer.status, expected)
        })
    )

    it.effect(
      "refuses a schedule's backup to someone else's personal destination",
      () =>
        Effect.gen(function* () {
          yield* seed({ backup: { reason: "scheduled" } })
          yield* seedSchedule(relayId, storageId)
          yield* insertUser("someone-else")
          const database = yield* Database
          yield* database.execute(
            "test.personal_storage",
            "UPDATE kiln_backup_storage SET owner_user_id = 'someone-else'"
          )

          const answer = yield* ask({ schedule: { actionId, id: scheduleId } })

          assert.strictEqual(answer.status, "refused")
        })
    )

    // A backup taken while Hearth was away asks before Hearth has heard of
    // it.
    it.effect(
      "reads in the Relay's tasks for an upload it hasn't heard of, and only for an upload",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const services = yield* Effect.context<SqlClient.SqlClient>()
          let cataloged = 0
          const catalog = Effect.suspend(() => {
            cataloged += 1
            return seed().pipe(Effect.orDie, Effect.provideContext(services))
          })

          const read = yield* ask({ action: "download" }, relayId, catalog)
          assert.strictEqual(read.status, "refused")
          assert.strictEqual(cataloged, 0)

          const upload = yield* ask({}, relayId, catalog)
          assert.strictEqual(upload.status, "granted")
          assert.strictEqual(cataloged, 1)
        })
    )
  })
})
