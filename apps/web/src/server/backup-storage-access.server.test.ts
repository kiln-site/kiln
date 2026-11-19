import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import {
  relayBackupTaskSchema,
  type BackupStorageAccessRequest,
} from "@workspace/contracts"

import { backupObjectKey } from "@/backups/destinations/s3/client"
import { reconcileBackupTaskEffect } from "@/effect/backups"
import { Database } from "@/effect/database"
import { grantBackupStorageAccessEffect } from "@/server/backup-storage-access.server"
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
const relayId = "a".repeat(12)
const otherRelayId = "b".repeat(12)
const backupId = "11111111-1111-4111-8111-111111111111"
const storageId = "22222222-2222-4222-8222-222222222222"
const otherStorageId = "22222222-2222-4222-8222-22222222222f"
const artifactId = "33333333-3333-4333-8333-333333333333"
const taskId = "44444444-4444-4444-8444-444444444444"
const safetyTaskId = "44444444-4444-4444-8444-44444444444f"
const scheduleId = "55555555-5555-4555-8555-555555555555"
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
    task?: { dependsOn?: string; kind?: string; status?: string }
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
    if (options.task?.dependsOn) {
      yield* insertRows("backup_task", {
        id: safetyTaskId,
        backup_id: backupId,
        task_kind: "create",
        status: options.task.dependsOn,
        created_at: seededAt,
        updated_at: seededAt,
      })
    }
    yield* insertRows("backup_task", {
      id: taskId,
      backup_id: backupId,
      task_kind: options.task?.kind ?? "create",
      status: options.task?.status ?? "queued",
      depends_on_task_id: options.task?.dependsOn ? safetyTaskId : null,
      created_at: seededAt,
      updated_at: seededAt,
    })
  })

// A schedule on `deployedTo`, and the backups to buckets in the version of
// it that Relay last acknowledged: null when it has acknowledged none.
const seedSchedule = (
  deployedTo: string,
  held: ReadonlyArray<{
    storageId: string
    targetId: string
    targetKind: string
  }> | null,
  status: "applied" | "pending" = "applied"
) =>
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
    yield* insertRows("schedule_deployment", {
      schedule_id: scheduleId,
      relay_id: deployedTo,
      desired_revision: 1,
      desired_generation: 1,
      acknowledged_revision: held ? 1 : null,
      acknowledged_generation: held ? 1 : null,
      acknowledged_backups: held ? JSON.stringify(held) : null,
      status,
      created_at: seededAt,
      updated_at: seededAt,
    })
  })

const here = {
  storageId,
  targetId: "instance-one",
  targetKind: "instance",
}

// A backup a schedule started, as its Relay reports it: the Relay chose
// its IDs and says which destination it is for.
const scheduledTask = (
  ids: { artifactId: string; backupId: string; taskId: string },
  stored?: { objectKey: string }
) =>
  relayBackupTaskSchema.parse({
    backupId: ids.backupId,
    bytesCompleted: 0,
    bytesTotal: null,
    createdAt: seededAt,
    error: null,
    finishedAt: stored ? seededAt + 1 : null,
    input: {
      artifactKind: "archive",
      backupId: ids.backupId,
      catalog: { name: "Nightly", storageId },
      destination: { artifactId: ids.artifactId, kind: "s3", ...stored },
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "full",
      reason: "scheduled",
      target: { id: "instance-one", kind: "instance" },
      taskId: ids.taskId,
    },
    inputRefreshRequired: false,
    kind: "create",
    result: stored
      ? {
          bytes: 12,
          checksumSha256: "a".repeat(64),
          filename: "backup.zip",
          warnings: [],
        }
      : null,
    startedAt: seededAt,
    status: stored ? "succeeded" : "running",
    taskId: ids.taskId,
    updatedAt: seededAt + 1,
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

    it.effect(
      "lets a restore read only the copy Hearth would name, once what it waits on succeeded",
      () =>
        Effect.gen(function* () {
          const restoring = {
            artifact: "available",
            backup: { status: "available" },
          }
          // Its safety backup hasn't finished.
          yield* seed({
            ...restoring,
            task: { dependsOn: "running", kind: "restore" },
          })
          const early = yield* ask({ action: "download" })

          yield* seed({
            ...restoring,
            task: { dependsOn: "succeeded", kind: "restore" },
          })
          const ready = yield* ask({ action: "download" })
          // The Relay has a copy of its own, which the restore reads.
          yield* insertRows("backup_artifact", {
            id: "33333333-3333-4333-8333-33333333333e",
            backup_id: backupId,
            destination_key: "local",
            storage_id: null,
            status: "available",
            created_at: seededAt + 1,
            updated_at: seededAt + 1,
          })
          const local = yield* ask({ action: "download" })

          assert.strictEqual(early.status, "refused")
          assert.strictEqual(ready.status, "granted")
          assert.strictEqual(local.status, "refused")
        })
    )

    // The Relay starts a scheduled backup on its own, so only a schedule it
    // acknowledged holding says the backup may go to that bucket.
    it.effect.each([
      {
        case: "a schedule it acknowledged backs that up there",
        deployedTo: relayId,
        expected: "granted",
        held: [here],
      },
      {
        case: "the schedule is another Relay's",
        deployedTo: otherRelayId,
        expected: "refused",
        held: [here],
      },
      {
        case: "its schedule backs up somewhere else",
        deployedTo: relayId,
        expected: "refused",
        held: [{ ...here, storageId: otherStorageId }],
      },
      {
        case: "its schedule backs up something else there",
        deployedTo: relayId,
        expected: "refused",
        held: [{ ...here, targetId: "instance-two" }],
      },
      {
        case: "Hearth refused that backup in the schedule it sent",
        deployedTo: relayId,
        expected: "refused",
        held: [],
      },
    ])(
      "answers a scheduled backup's upload $expected when $case",
      ({ deployedTo, expected, held }) =>
        Effect.gen(function* () {
          yield* seed({ backup: { reason: "scheduled" } })
          yield* insertStorage(otherStorageId)
          yield* seedSchedule(deployedTo, held)

          const answer = yield* ask()

          assert.strictEqual(answer.status, expected)
        })
    )

    // A schedule Hearth means to send is no leave yet: the Relay asks again
    // once it has it, rather than the backup ending or going ahead.
    it.effect.each([
      { case: "hasn't acknowledged at all", held: null },
      { case: "acknowledged before it backed up there", held: [] },
    ])(
      "tells a scheduled backup's upload to ask later while the Relay $case a schedule Hearth owes it",
      ({ held }) =>
        Effect.gen(function* () {
          yield* seed({ backup: { reason: "scheduled" } })
          yield* seedSchedule(relayId, held, "pending")

          const answer = yield* ask()

          assert.strictEqual(answer.status, "later")
        })
    )

    // The Relay chooses a scheduled backup's IDs. Naming a backup Hearth
    // made by hand must not get it that backup's bucket.
    it.effect(
      "catalogs nothing for a scheduled backup that names a backup Hearth already has",
      () =>
        Effect.gen(function* () {
          // A backup made by hand, stored, in a bucket no schedule uses.
          yield* seed({
            artifact: "available",
            backup: { status: "available" },
            task: { status: "succeeded" },
          })
          const services = yield* Effect.context<Database>()
          const claimed = {
            artifactId: "33333333-3333-4333-8333-33333333333d",
            taskId: "44444444-4444-4444-8444-44444444444d",
          }
          const catalog = reconcileBackupTaskEffect(
            scheduledTask({ ...claimed, backupId }),
            relayId
          ).pipe(Effect.asVoid, Effect.provideContext(services))

          const answer = yield* ask(claimed, relayId, catalog)

          assert.strictEqual(answer.status, "refused")
          const tasks = yield* selectRows<{ id: string }>("backup_task")
          const copies = yield* selectRows<{ id: string }>("backup_artifact")
          assert.deepStrictEqual(
            tasks.map((task) => task.id),
            [taskId]
          )
          assert.deepStrictEqual(
            copies.map((copy) => copy.id),
            [artifactId]
          )
        })
    )

    // A Relay from before this one held the bucket's keys and may have
    // uploaded a backup Hearth hadn't cataloged, under the folder the
    // destination had then. Only that folder is taken on its word.
    it.effect(
      "files an older Relay's upload where it says only when the rest of the path is Hearth's own",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertStorage(storageId, { object_prefix: "team" })
          const uploaded = (index: string, objectKey: (own: string) => string) =>
            Effect.gen(function* () {
              const ids = {
                artifactId: `33333333-3333-4333-8333-3333333333a${index}`,
                backupId: `11111111-1111-4111-8111-1111111111a${index}`,
                taskId: `44444444-4444-4444-8444-4444444444a${index}`,
              }
              const own = backupObjectKey({
                artifactKind: "archive",
                backupId: ids.backupId,
                installationId: "kiln-test",
                objectPrefix: "",
                relayId,
                targetId: "instance-one",
                targetKind: "instance",
              })
              yield* reconcileBackupTaskEffect(
                scheduledTask(ids, { objectKey: objectKey(own) }),
                relayId
              )
              const copies = yield* selectRows<{
                id: string
                object_key: string
              }>("backup_artifact")
              return {
                filed: copies.find((copy) => copy.id === ids.artifactId)
                  ?.object_key,
                own,
              }
            })

          const moved = yield* uploaded("1", (own) => `old-folder/${own}`)
          const elsewhere = yield* uploaded(
            "2",
            () => `team/kiln/kiln-test/${otherRelayId}/instance/x/y/backup.zip`
          )

          assert.strictEqual(moved.filed, `old-folder/${moved.own}`)
          assert.strictEqual(elsewhere.filed, `team/${elsewhere.own}`)
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
