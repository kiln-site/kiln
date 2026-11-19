import { assert, layer } from "@effect/vitest"
import { Effect, Result } from "effect"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import {
  relayBackupTaskSchema,
  type BackupStorageAccessRequest,
} from "@workspace/contracts"

import { backupObjectKey } from "@/backups/destinations/s3/client"
import {
  admitOfferedBackupEffect,
  reconcileBackupTaskEffect,
} from "@/effect/backups"
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
const storageId = "d".repeat(12)
const artifactId = "33333333-3333-4333-8333-333333333333"
const objectKey = backupObjectKey({
  artifactKind: "archive",
  backupId,
  installationId: "kiln-test",
  objectPrefix: "team",
  relayId,
  targetId: "instance-one",
  targetKind: "instance",
})
const seededAt = Date.UTC(2026, 0, 1)

const encrypt = (plaintext: string, purpose: string) =>
  encryptWithKeyring(plaintext, parseSecretKeyring(secrets), purpose)

// A backup with one copy in a bucket, and the tasks under way for it.
const seed = (
  options: {
    artifact?: string
    backup?: string
    /** Where the copy is filed, when not where Hearth files it. */
    objectKey?: string
    storage?: {
      access_key_id_ciphertext?: string
      deleting?: boolean
      enabled?: boolean
    }
    tasks?: ReadonlyArray<{ kind: string; status: string }>
  } = {}
) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRelay(relayId)
    yield* insertRelay(otherRelayId)
    yield* insertBackupStorage(storageId, {
      access_key_id_ciphertext: encrypt(
        "AKIAEXAMPLE",
        `kiln-backup-storage:${storageId}:access-key-id`
      ),
      secret_access_key_ciphertext: encrypt(
        "s3-secret",
        `kiln-backup-storage:${storageId}:secret-access-key`
      ),
      ...options.storage,
    })
    yield* insertBackup(backupId, {
      relay_id: relayId,
      status: options.backup ?? "queued",
      storage_id: storageId,
      object_key: objectKey,
    })
    yield* insertRows("backup_artifact", {
      id: artifactId,
      backup_id: backupId,
      destination_key: storageId,
      storage_id: storageId,
      status: options.artifact ?? "queued",
      object_key: options.objectKey ?? objectKey,
      created_at: seededAt,
      updated_at: seededAt,
    })
    for (const [index, task] of (options.tasks ?? []).entries()) {
      yield* insertRows("backup_task", {
        id: `44444444-4444-4444-8444-44444444444${index}`,
        backup_id: backupId,
        task_kind: task.kind,
        status: task.status,
        created_at: seededAt,
        updated_at: seededAt,
      })
    }
  })

const ask = (
  action: BackupStorageAccessRequest["action"],
  from = relayId,
  copy = artifactId
) => grantBackupStorageAccessEffect(from, { action, artifactId: copy })

const stored = { artifact: "available", backup: "available" }
const restoring = [{ kind: "restore", status: "running" }]

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", secrets)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

// Hearth holds every bucket's keys, so what this refuses is all that keeps
// a Relay out of copies that aren't its to touch.
describeMysql("backup storage access", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "signs one upload of a copy not yet stored, good for minutes, and gives away no key",
      () =>
        Effect.gen(function* () {
          yield* seed()

          const answer = yield* ask("upload")

          assert.strictEqual(answer.status, "granted")
          if (answer.status !== "granted") return
          assert.strictEqual(answer.method, "PUT")
          const url = new URL(answer.url)
          assert.strictEqual(decodeURIComponent(url.pathname), `/${objectKey}`)
          assert.strictEqual(url.searchParams.get("X-Amz-Expires"), "600")
          assert.isNotNull(url.searchParams.get("X-Amz-Signature"))
          assert.notInclude(JSON.stringify(answer), "s3-secret")
        })
    )

    // A copy cataloged while Relays held the keys can carry a path its
    // Relay named. Under the destination's folder, Hearth files a backup
    // at one path only.
    it.effect(
      "signs no upload to a path that isn't the one Hearth files that backup at",
      () =>
        Effect.gen(function* () {
          yield* seed({
            objectKey: objectKey.replace(
              backupId,
              "99999999-9999-4999-8999-999999999999"
            ),
          })

          const answer = yield* ask("upload")

          assert.strictEqual(answer.status, "refused")
        })
    )

    it.effect.each([
      {
        action: "upload" as const,
        case: "another Relay asks to write it",
        from: otherRelayId,
      },
      {
        action: "upload" as const,
        case: "the copy named isn't one Hearth knows",
        copy: "33333333-3333-4333-8333-33333333333f",
      },
      {
        action: "upload" as const,
        case: "the copy is already stored",
        seeded: stored,
      },
      {
        action: "upload" as const,
        case: "its destination is disabled",
        seeded: { storage: { enabled: false } },
      },
      {
        action: "upload" as const,
        case: "its destination is being deleted",
        seeded: { storage: { deleting: true } },
      },
      {
        action: "download" as const,
        case: "it asks to read a copy with no restore under way",
        seeded: stored,
      },
      {
        action: "download" as const,
        case: "it asks to read after the restore ended",
        seeded: {
          ...stored,
          tasks: [{ kind: "restore", status: "succeeded" }],
        },
      },
      {
        action: "download" as const,
        case: "another Relay asks to read it during a restore",
        from: otherRelayId,
        seeded: { ...stored, tasks: restoring },
      },
      {
        action: "download" as const,
        case: "it asks to read a copy not yet stored",
        seeded: { tasks: restoring },
      },
      // Unanswered, the Relay would take Hearth for away and keep the
      // backup waiting for good.
      {
        action: "upload" as const,
        case: "Hearth can't read the keys it holds for the destination",
        seeded: { storage: { access_key_id_ciphertext: "not-a-ciphertext" } },
      },
      {
        action: "delete" as const,
        case: "it asks to delete a copy of a backup Hearth isn't deleting",
        seeded: stored,
      },
      {
        action: "delete" as const,
        case: "it asks to delete from a destination being deleted",
        seeded: {
          artifact: "deleting",
          backup: "deleting",
          storage: { deleting: true },
        },
      },
    ])("refuses when $case", ({ action, copy, from, seeded }) =>
      Effect.gen(function* () {
        yield* seed(seeded)

        const answer = yield* ask(action, from, copy)

        assert.strictEqual(answer.status, "refused")
      })
    )

    it.effect(
      "lets a restore under way read a stored copy, even from a destination being deleted",
      () =>
        Effect.gen(function* () {
          yield* seed({
            ...stored,
            storage: { deleting: true },
            tasks: restoring,
          })

          const answer = yield* ask("download")

          assert.strictEqual(answer.status, "granted")
          assert.strictEqual(
            answer.status === "granted" && answer.method,
            "GET"
          )
        })
    )

    it.effect("lets a copy be deleted while Hearth deletes its backup", () =>
      Effect.gen(function* () {
        yield* seed({ artifact: "available", backup: "deleting" })

        const answer = yield* ask("delete")

        assert.strictEqual(answer.status, "granted")
        assert.strictEqual(
          answer.status === "granted" && answer.method,
          "DELETE"
        )
      })
    )

    // The Relay starts a schedule's backup itself and offers it to Hearth,
    // choosing its IDs and saying which destination and schedule step it
    // is for. Hearth keeps it in a bucket only when its own record of that
    // schedule says so, and chooses the path itself.
    const scheduleId = "55555555-5555-4555-8555-555555555555"
    const actionId = "66666666-6666-4666-8666-666666666666"
    const otherStorageId = "e".repeat(12)
    const offeredIds = {
      artifactId: "33333333-3333-4333-8333-3333333333a1",
      backupId: "11111111-1111-4111-8111-1111111111a1",
      taskId: "44444444-4444-4444-8444-4444444444a1",
    }
    // A schedule that backs up `target` on the Relay `on`, to `destination`,
    // as Hearth last sent it there: `told` is whether Hearth admitted that
    // backup when it did.
    const seedSchedule = (
      options: {
        destination?: string
        mode?: "full" | "incremental"
        on?: string
        row?: Record<string, number | string>
        target?: { id: string; kind: string }
        /** False: refused as it was sent. Null: not sent since the update. */
        told?: boolean | null
      } = {}
    ) =>
      Effect.gen(function* () {
        const target = options.target ?? {
          id: "instance-one",
          kind: "instance",
        }
        yield* insertUser("owner")
        yield* insertRows("schedule", {
          id: scheduleId,
          name: "Nightly",
          cron_expression: "0 3 * * *",
          created_by: "owner",
          created_at: seededAt,
          updated_at: seededAt,
          ...options.row,
        })
        yield* insertRows("schedule_deployment", {
          schedule_id: scheduleId,
          relay_id: options.on ?? relayId,
          desired_revision: 1,
          backup_executions:
            options.told === null
              ? null
              : JSON.stringify(
                  options.told === false
                    ? []
                    : [
                        {
                          actionId,
                          mode: options.mode ?? "full",
                          repositoryId: null,
                          storageId: options.destination ?? storageId,
                          targetId: target.id,
                          targetKind: target.kind,
                        },
                      ]
                ),
          created_at: seededAt,
          updated_at: seededAt,
        })
      })
    const offered = (
      options: {
        ids?: typeof offeredIds
        /** A path that came with a copy the Relay has still to send. */
        namedAt?: string
        schedule?: { actionId: string; id: string } | null
        /** Where a Relay that held the bucket's keys says it put the copy. */
        uploadedTo?: string
      } = {}
    ) => {
      const ids = options.ids ?? offeredIds
      const named = options.uploadedTo ?? options.namedAt
      const stored = options.uploadedTo !== undefined
      return relayBackupTaskSchema.parse({
        backupId: ids.backupId,
        bytesCompleted: 0,
        bytesTotal: null,
        createdAt: seededAt,
        error: null,
        finishedAt: stored ? seededAt + 1 : null,
        input: {
          artifactKind: "archive",
          backupId: ids.backupId,
          catalog: {
            name: "Nightly",
            ...(options.schedule === null
              ? {}
              : { schedule: options.schedule ?? { actionId, id: scheduleId } }),
            storageId,
          },
          destination: {
            artifactId: ids.artifactId,
            kind: "s3",
            ...(named === undefined ? {} : { objectKey: named }),
          },
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
              artifacts: [
                {
                  artifactId: ids.artifactId,
                  error: null,
                  status: "available",
                },
              ],
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
    }
    const catalogedCopy = (ids = offeredIds) =>
      Effect.gen(function* () {
        const copies = yield* selectRows<{
          id: string
          object_key: string | null
          status: string
          storage_id: string | null
        }>("backup_artifact")
        const tasks = yield* selectRows<{ error: string | null; id: string }>(
          "backup_task"
        )
        return {
          copy: copies.find(({ id }) => id === ids.artifactId),
          error: tasks.find(({ id }) => id === ids.taskId)?.error ?? null,
        }
      })
    const ownPath = (ids = offeredIds) =>
      backupObjectKey({
        artifactKind: "archive",
        backupId: ids.backupId,
        installationId: "kiln-test",
        objectPrefix: "",
        relayId,
        targetId: "instance-one",
        targetKind: "instance",
      })
    const emptyRelay = Effect.gen(function* () {
      yield* resetDatabase
      yield* insertRelay(relayId)
      yield* insertRelay(otherRelayId)
      yield* insertBackupStorage(storageId, { object_prefix: "team" })
      yield* insertBackupStorage(otherStorageId)
    })

    it.effect(
      "admits a backup its own schedule sends there, at a path Hearth chooses, and signs its upload",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* seedSchedule()

          yield* reconcileBackupTaskEffect(offered(), relayId)
          const { copy } = yield* catalogedCopy()
          const upload = yield* ask("upload", relayId, offeredIds.artifactId)

          assert.strictEqual(copy?.status, "running")
          assert.strictEqual(copy?.object_key, `team/${ownPath()}`)
          assert.strictEqual(upload.status, "granted")
        })
    )

    it.effect.each([
      {
        case: "it names no schedule",
        seeded: seedSchedule(),
        task: offered({ schedule: null }),
        why: "which schedule",
      },
      {
        case: "its schedule is off that Relay now",
        seeded: seedSchedule({ on: otherRelayId }),
        task: offered(),
        why: "No schedule of this Relay's",
      },
      {
        case: "its schedule backs up something else there now",
        seeded: seedSchedule({
          target: { id: "instance-two", kind: "instance" },
        }),
        task: offered(),
        why: "doesn't take that backup",
      },
      {
        case: "Hearth refused that backup as it sent the schedule",
        seeded: seedSchedule({ told: false }),
        task: offered(),
        why: "doesn't take that backup",
      },
      {
        case: "its schedule was removed since",
        seeded: seedSchedule({ row: { deleted_at: seededAt } }),
        task: offered(),
        why: "No schedule of this Relay's",
      },
      {
        case: "its schedule backs up somewhere else",
        seeded: seedSchedule({ destination: otherStorageId }),
        task: offered(),
        why: "doesn't take that backup",
      },
      {
        case: "its schedule takes incremental backups there now",
        seeded: seedSchedule({ mode: "incremental" }),
        task: offered(),
        why: "doesn't take that backup",
      },
    ])(
      "catalogs a schedule's backup as failed, and signs nothing for it, when $case",
      ({ seeded, task, why }) =>
        Effect.gen(function* () {
          yield* emptyRelay
          yield* seeded

          yield* reconcileBackupTaskEffect(task, relayId)
          const { copy, error } = yield* catalogedCopy()
          const upload = yield* ask("upload", relayId, offeredIds.artifactId)

          assert.strictEqual(copy?.status, "failed")
          assert.include(error ?? "", why)
          assert.strictEqual(upload.status, "refused")
          // Nothing of it is in the bucket, so its record doesn't stand in
          // the way of deleting the destination.
          assert.isNull(copy?.storage_id)
        })
    )

    // An App is backed up as the volumes it uses, which Hearth lists as it
    // sends the schedule: those volumes, and no other.
    it.effect(
      "admits a backup of a volume Hearth told the Relay to take, and of no other",
      () =>
        Effect.gen(function* () {
          yield* emptyRelay
          const told = "f".repeat(40)
          yield* seedSchedule({ target: { id: told, kind: "volume" } })
          const task = offered()
          if (task.input.kind !== "create") return
          const of = (id: string, ids = offeredIds) => ({
            ...task,
            backupId: ids.backupId,
            input: {
              ...task.input,
              artifactKind: "tar_archive" as const,
              backupId: ids.backupId,
              destination: { artifactId: ids.artifactId, kind: "s3" as const },
              target: { id, kind: "volume" as const },
              taskId: ids.taskId,
            },
            taskId: ids.taskId,
          })

          const own = yield* admitOfferedBackupEffect(of(told), relayId)
          const other = yield* admitOfferedBackupEffect(
            of("e".repeat(40), {
              artifactId: "33333333-3333-4333-8333-3333333333a3",
              backupId: "11111111-1111-4111-8111-1111111111a3",
              taskId: "44444444-4444-4444-8444-4444444444a3",
            }),
            relayId
          )

          assert.strictEqual(own.status, "admitted")
          assert.strictEqual(other.status, "refused")
        })
    )

    // Just after an update Hearth has yet to send a schedule again, and so
    // has kept no list of what it told the Relay to take. A backup taken
    // then waits on the Relay; reading the Relay's tasks meanwhile must
    // not record it as refused, which would be the answer when the Relay
    // offers it.
    it.effect(
      "decides nothing of a backup whose schedule it has yet to send again, and admits it once it has",
      () =>
        Effect.gen(function* () {
          yield* emptyRelay
          yield* seedSchedule({ told: null })

          yield* reconcileBackupTaskEffect(offered(), relayId)
          const early = yield* Effect.result(
            admitOfferedBackupEffect(offered(), relayId)
          )
          const before = (yield* catalogedCopy()).copy

          const database = yield* Database
          yield* database.execute(
            "test.sent_again",
            "UPDATE kiln_schedule_deployment SET backup_executions = ?",
            [
              JSON.stringify([
                {
                  actionId,
                  mode: "full",
                  storageId,
                  targetId: "instance-one",
                  targetKind: "instance",
                },
              ]),
            ]
          )
          const later = yield* admitOfferedBackupEffect(offered(), relayId)

          assert.isUndefined(before)
          assert.isTrue(Result.isFailure(early))
          assert.strictEqual(later.status, "admitted")
        })
    )

    // A Relay can be paired with several Hearths, and each reads its tasks.
    it.effect(
      "catalogs nothing for a backup taken by a schedule this Hearth never had",
      () =>
        Effect.gen(function* () {
          yield* emptyRelay

          yield* reconcileBackupTaskEffect(offered(), relayId)
          const answer = yield* admitOfferedBackupEffect(offered(), relayId)

          assert.isUndefined((yield* catalogedCopy()).copy)
          assert.strictEqual(answer.status, "refused")
        })
    )

    it.effect("admits an offer again that it has already admitted", () =>
      Effect.gen(function* () {
        yield* emptyRelay
        yield* seedSchedule()

        const first = yield* admitOfferedBackupEffect(offered(), relayId)
        const again = yield* admitOfferedBackupEffect(offered(), relayId)

        assert.deepStrictEqual(
          [first.status, first.cataloged, again.status, again.cataloged],
          ["admitted", true, "admitted", false]
        )
      })
    )

    // An offer is the Relay's word. It may put a new backup in Hearth's
    // records; it changes nothing of one that is already there.
    it.effect(
      "refuses an offer that names a backup Hearth made, and leaves that backup as it was",
      () =>
        Effect.gen(function* () {
          yield* seed({
            ...stored,
            tasks: [{ kind: "create", status: "succeeded" }],
          })
          yield* seedSchedule()
          const taken = {
            artifactId,
            backupId,
            taskId: "44444444-4444-4444-8444-444444444440",
          }

          const answer = yield* admitOfferedBackupEffect(
            offered({ ids: taken }),
            relayId
          )

          assert.strictEqual(answer.status, "refused")
          const [task] = yield* selectRows<{ status: string }>("backup_task")
          const [copy] = yield* selectRows<{ status: string }>(
            "backup_artifact"
          )
          assert.deepStrictEqual(
            [task?.status, copy?.status],
            ["succeeded", "available"]
          )
        })
    )

    it.effect(
      "refuses a schedule's backup to someone else's personal destination",
      () =>
        Effect.gen(function* () {
          yield* emptyRelay
          yield* seedSchedule()
          yield* insertUser("someone-else")
          const database = yield* Database
          yield* database.execute(
            "test.personal_storage",
            "UPDATE kiln_backup_storage SET owner_user_id = 'someone-else'"
          )

          yield* reconcileBackupTaskEffect(offered(), relayId)

          const { copy, error } = yield* catalogedCopy()
          assert.strictEqual(copy?.status, "failed")
          assert.include(error ?? "", "someone else's personal one")
        })
    )

    // Naming a backup Hearth made by hand must not get the Relay that
    // backup's bucket.
    it.effect(
      "catalogs nothing for an offered backup that names a backup Hearth already has",
      () =>
        Effect.gen(function* () {
          yield* seed({ artifact: "available", backup: "available" })
          yield* seedSchedule()
          const claimed = { ...offeredIds, backupId }

          yield* reconcileBackupTaskEffect(offered({ ids: claimed }), relayId)
          const upload = yield* ask("upload", relayId, claimed.artifactId)

          assert.isUndefined((yield* catalogedCopy(claimed)).copy)
          assert.strictEqual(upload.status, "refused")
        })
    )

    // What a Relay says of a copy, that it is already in the bucket and
    // where, is not taken: it would be a bucket and a folder no schedule
    // was checked for. The backup is admitted as any is, or not at all.
    it.effect(
      "takes no Relay's word that a copy is already stored, or where",
      () =>
        Effect.gen(function* () {
          yield* emptyRelay
          yield* seedSchedule()

          const unnamed = yield* admitOfferedBackupEffect(
            offered({
              ids: {
                artifactId: "33333333-3333-4333-8333-3333333333a2",
                backupId: "11111111-1111-4111-8111-1111111111a2",
                taskId: "44444444-4444-4444-8444-4444444444a2",
              },
              schedule: null,
              uploadedTo: `old-folder/${ownPath()}`,
            }),
            relayId
          )
          yield* reconcileBackupTaskEffect(
            offered({ uploadedTo: `old-folder/${ownPath()}` }),
            relayId
          )

          assert.strictEqual(unnamed.status, "refused")
          assert.strictEqual(
            (yield* catalogedCopy()).copy?.object_key,
            `team/${ownPath()}`
          )
        })
    )

    // Hearth signs no upload to a path a Relay named.
    it.effect(
      "sends a copy still to be sent where Hearth says, whatever path came with it",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* seedSchedule()

          yield* reconcileBackupTaskEffect(
            offered({ namedAt: `someone-elses-folder/${ownPath()}` }),
            relayId
          )
          const { copy } = yield* catalogedCopy()
          const upload = yield* ask("upload", relayId, offeredIds.artifactId)

          assert.strictEqual(copy?.object_key, `team/${ownPath()}`)
          assert.strictEqual(upload.status, "granted")
          if (upload.status !== "granted") return
          assert.strictEqual(
            decodeURIComponent(new URL(upload.url).pathname),
            `/team/${ownPath()}`
          )
        })
    )

    // The destination was deleted while the Relay held the archive.
    it.effect(
      "catalogs a schedule's backup whose destination is gone as failed",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* seedSchedule()

          yield* reconcileBackupTaskEffect(offered(), relayId)

          const { copy, error } = yield* catalogedCopy()
          assert.strictEqual(copy?.status, "failed")
          assert.isNull(copy?.storage_id)
          assert.include(error ?? "", "destination was gone")
        })
    )
  })
})
