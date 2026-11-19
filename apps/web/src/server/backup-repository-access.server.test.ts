import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import {
  relayBackupTaskSchema,
  type BackupRepositoryAccessRequest,
} from "@workspace/contracts"

import { reconcileBackupTaskEffect } from "@/effect/backups"

import {
  admitRepositoryPruneEffect,
  closeRepositoryPrunesEffect,
  grantBackupRepositoryAccessEffect,
} from "@/server/backup-repository-access.server"
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
const repositoryId = "22222222-2222-4222-8222-222222222222"
const storageId = "d".repeat(12)
const taskId = "44444444-4444-4444-8444-444444444440"
const prefix = `team/kiln/install/${relayId}/restic/instance/instance-one/${repositoryId}`
const file = "ab".repeat(32)
const HOUR = 60 * 60 * 1_000
// When the tests take place, by the clock Hearth reads.
const NOW = Date.UTC(2026, 5, 1)

const encrypt = (plaintext: string, purpose: string) =>
  encryptWithKeyring(plaintext, parseSecretKeyring(secrets), purpose)

type Seed = {
  /** Whether the repository holds a backup already, or one being deleted. */
  backup?: "available" | "deleting"
  /** The snapshot the backup is, once it has one. */
  snapshot?: string
  kind?: "create" | "restore" | "delete" | "export"
  /** Whether the repository is in the bucket, or on the Relay's disk. */
  local?: boolean
  status?: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  storage?: { deleting?: boolean; enabled?: boolean }
}

// A backup kept in a restic repository in a bucket, and one task for it.
const seed = (options: Seed = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW)
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
    const stored = options.local ? null : storageId
    yield* insertRows("backup_repository", {
      id: repositoryId,
      relay_id: relayId,
      target_kind: "instance",
      target_id: "instance-one",
      storage_id: stored,
      storage_key: stored ?? "local",
      object_prefix: options.local ? null : prefix,
      password_ciphertext: encrypt(
        "repo-password",
        "kiln-restic-repository-password"
      ),
      created_at: NOW,
    })
    yield* insertBackup(backupId, {
      artifact_kind: "restic_snapshot",
      relay_id: relayId,
      repository_id: repositoryId,
      status: options.backup ?? "queued",
      storage_id: stored,
      ...(options.snapshot ? { restic_snapshot_id: options.snapshot } : {}),
    })
    // Hearth stores times as epoch milliseconds.
    yield* insertRows("backup_task", {
      id: taskId,
      backup_id: backupId,
      task_kind: options.kind ?? "create",
      status: options.status ?? "running",
      finished_at:
        options.status === undefined || options.status === "queued"
          ? null
          : NOW,
      created_at: NOW,
      updated_at: NOW,
    })
  })

type Asked = Partial<BackupRepositoryAccessRequest> & { from?: string }

const ask = ({ from = relayId, ...request }: Asked) =>
  grantBackupRepositoryAccessEffect(from, {
    method: "GET",
    name: request.type === "config" ? null : file,
    taskId,
    type: "data",
    ...request,
  })

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", secrets)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

// Hearth holds every bucket's keys, so what this refuses is all that keeps
// a Relay's restic out of what isn't its task's to touch.
describeMysql("backup repository access", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "signs one request for one file where the repository keeps it, good for minutes, and gives away no key",
      () =>
        Effect.gen(function* () {
          yield* seed()

          const pack = yield* ask({ method: "PUT" })
          assert.strictEqual(pack.status, "granted")
          if (pack.status !== "granted") return
          assert.strictEqual(pack.method, "PUT")
          const url = new URL(pack.url)
          assert.strictEqual(
            decodeURIComponent(url.pathname),
            `/${prefix}/data/ab/${file}`
          )
          assert.strictEqual(url.searchParams.get("X-Amz-Expires"), "600")
          assert.isNotNull(url.searchParams.get("X-Amz-Signature"))
          assert.notInclude(JSON.stringify(pack), "s3-secret")

          const where = function* (request: Asked) {
            const answer = yield* ask(request)
            return answer.status === "granted"
              ? decodeURIComponent(new URL(answer.url).pathname)
              : answer.status
          }
          assert.strictEqual(
            yield* where({ type: "config" }),
            `/${prefix}/config`
          )
          assert.strictEqual(
            yield* where({ method: "HEAD", type: "snapshots" }),
            `/${prefix}/snapshots/${file}`
          )
        })
    )

    it.effect.each<{ asked: Asked; case: string; seeded?: Seed }>([
      {
        asked: { method: "PUT", type: "snapshots" },
        case: "a backup records its snapshot",
      },
      {
        asked: { method: "PUT", type: "config" },
        case: "a backup makes the repository the first time",
      },
      {
        asked: { method: "DELETE", type: "locks" },
        case: "a backup clears a lock",
      },
      {
        asked: { method: "PUT" },
        case: "a backup adds data to a repository that holds backups",
        seeded: { backup: "available" },
      },
      {
        asked: { method: "GET", type: "index" },
        case: "a restore reads",
        seeded: { kind: "restore" },
      },
      {
        asked: { method: "PUT", type: "locks" },
        case: "a restore locks the repository",
        seeded: { kind: "restore" },
      },
      {
        asked: { method: "GET" },
        case: "a restore reads from a destination that's disabled",
        seeded: { kind: "restore", storage: { enabled: false } },
      },
      {
        asked: { method: "DELETE", type: "snapshots" },
        case: "a delete forgets a snapshot",
        seeded: { kind: "delete", status: "queued" },
      },
    ])("grants it when $case", ({ asked, seeded }) =>
      Effect.gen(function* () {
        yield* seed(seeded)
        assert.strictEqual((yield* ask(asked)).status, "granted")
      })
    )

    it.effect.each<{ asked: Asked; case: string; seeded?: Seed }>([
      { asked: { from: otherRelayId }, case: "another Relay asks" },
      {
        asked: { taskId: "66666666-6666-4666-8666-666666666666" },
        case: "it names a task Hearth doesn't know",
      },
      {
        asked: {},
        case: "its task has ended",
        seeded: { status: "succeeded" },
      },
      {
        asked: {},
        case: "its backup's repository is on the Relay's own disk",
        seeded: { local: true },
      },
      {
        asked: { method: "DELETE" },
        case: "a backup would remove data",
      },
      {
        asked: { method: "DELETE", type: "snapshots" },
        case: "a backup would forget a snapshot",
      },
      {
        asked: { method: "PUT" },
        case: "a restore would write data",
        seeded: { kind: "restore" },
      },
      {
        asked: { method: "PUT", type: "config" },
        case: "a restore would replace the repository's config",
        seeded: { kind: "restore" },
      },
      {
        asked: { method: "DELETE", type: "snapshots" },
        case: "an export would forget a snapshot",
        seeded: { kind: "export" },
      },
      {
        asked: { method: "DELETE" },
        case: "a delete would remove data itself",
        seeded: { kind: "delete" },
      },
      {
        asked: { method: "DELETE", name: "cd".repeat(32), type: "snapshots" },
        case: "a delete would forget a snapshot other than its backup's",
        seeded: { kind: "delete", snapshot: "abababab" },
      },
      // Until restic has forgotten it, a backup being deleted is in the
      // repository still, and is there again if the delete fails.
      {
        asked: { method: "PUT", type: "config" },
        case: "a backup would replace the config of a repository whose last backup is being deleted",
        seeded: { backup: "deleting" },
      },
      {
        asked: { method: "PUT", type: "snapshots" },
        case: "a delete would write a snapshot",
        seeded: { kind: "delete" },
      },
      {
        asked: { method: "PUT", type: "config" },
        case: "a backup would replace the config of a repository that holds backups",
        seeded: { backup: "available" },
      },
      {
        asked: { method: "PUT", type: "keys" },
        case: "a backup would replace the keys of a repository that holds backups",
        seeded: { backup: "available" },
      },
      {
        asked: { method: "PUT" },
        case: "a backup goes to a destination that's disabled",
        seeded: { storage: { enabled: false } },
      },
      {
        asked: {},
        case: "the destination is being deleted",
        seeded: { kind: "restore", storage: { deleting: true } },
      },
      {
        asked: { name: file, type: "config" },
        case: "it names a file under the repository's config",
      },
      {
        asked: { name: null, type: "data" },
        case: "it names a folder as a file",
      },
      {
        asked: { method: "LIST", name: null, type: "config" },
        case: "it would list what isn't a folder",
      },
    ])("refuses when $case", ({ asked, seeded }) =>
      Effect.gen(function* () {
        yield* seed(seeded)
        assert.strictEqual((yield* ask(asked)).status, "refused")
      })
    )

    // The Relay starts a schedule's backup itself and offers it to Hearth
    // before it runs. Hearth opens the repository to it only when its own
    // record of that schedule says the backup goes to that destination.
    const scheduleId = "77777777-7777-4777-8777-777777777777"
    const actionId = "88888888-8888-4888-8888-888888888888"
    const scheduledTaskId = "44444444-4444-4444-8444-4444444444a1"
    const scheduledBackupId = "11111111-1111-4111-8111-1111111111a1"
    const otherStorageId = "e".repeat(12)
    const seedSchedule = (deployedTo = relayId, destination = storageId) =>
      Effect.gen(function* () {
        const at = NOW
        yield* insertBackupStorage(otherStorageId)
        yield* insertUser("owner")
        yield* insertRows("schedule", {
          id: scheduleId,
          name: "Nightly",
          cron_expression: "0 3 * * *",
          created_by: "owner",
          created_at: at,
          updated_at: at,
        })
        yield* insertRows("schedule_deployment", {
          schedule_id: scheduleId,
          relay_id: deployedTo,
          desired_revision: 1,
          backup_executions: JSON.stringify([
            {
              actionId,
              mode: "incremental",
              repositoryId,
              storageId: destination,
              targetId: "instance-one",
              targetKind: "instance",
            },
          ]),
          created_at: at,
          updated_at: at,
        })
      })
    // The task as the Relay offers it, or, `taken`, as a Relay that held
    // the bucket's keys reports one it already finished.
    const offered = (taken = false, destination = storageId) =>
      relayBackupTaskSchema.parse({
        backupId: scheduledBackupId,
        bytesCompleted: 0,
        bytesTotal: null,
        createdAt: NOW,
        error: null,
        finishedAt: taken ? NOW : null,
        input: {
          artifactKind: "restic_snapshot",
          backupId: scheduledBackupId,
          catalog: {
            name: "Nightly",
            repositoryId,
            // Which schedule took it is said only since Relays offer them.
            ...(taken ? {} : { schedule: { actionId, id: scheduleId } }),
            storageId: destination,
          },
          destination: {
            artifactId: "33333333-3333-4333-8333-3333333333a1",
            kind: "restic",
            repository: { kind: "s3", repositoryId },
          },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "incremental",
          reason: "scheduled",
          target: { id: "instance-one", kind: "instance" },
          taskId: scheduledTaskId,
        },
        inputRefreshRequired: false,
        kind: "create",
        result: taken
          ? { bytes: 12, snapshotId: "abcdef12", warnings: [] }
          : null,
        startedAt: NOW,
        status: taken ? "succeeded" : "running",
        taskId: scheduledTaskId,
        updatedAt: NOW,
      })
    const cataloged = Effect.gen(function* () {
      const backups = yield* selectRows<{ id: string; status: string }>(
        "backup"
      )
      return backups.find(({ id }) => id === scheduledBackupId)?.status
    })

    it.effect(
      "opens the repository to a backup its own schedule sends there",
      () =>
        Effect.gen(function* () {
          yield* seed()
          yield* seedSchedule()

          yield* reconcileBackupTaskEffect(offered(), relayId)
          const answer = yield* ask({ method: "PUT", taskId: scheduledTaskId })

          assert.strictEqual(yield* cataloged, "running")
          assert.strictEqual(answer.status, "granted")
        })
    )

    it.effect.each([
      { case: "another Relay's", seeded: seedSchedule(otherRelayId) },
      {
        case: "one that backs up somewhere else",
        seeded: seedSchedule(relayId, otherStorageId),
      },
    ])(
      "catalogs a schedule's backup as failed, and opens nothing to it, when its schedule is $case",
      ({ seeded }) =>
        Effect.gen(function* () {
          yield* seed()
          yield* seeded

          yield* reconcileBackupTaskEffect(offered(), relayId)
          const answer = yield* ask({ method: "PUT", taskId: scheduledTaskId })

          assert.strictEqual(yield* cataloged, "failed")
          assert.strictEqual(answer.status, "refused")
          // Nor is it tied to the repository: deleting its record removes
          // the record, and opens the repository to no delete.
          const refused = (yield* selectRows<{
            id: string
            repository_id: string | null
          }>("backup")).find(({ id }) => id === scheduledBackupId)
          assert.isNull(refused?.repository_id)
        })
    )

    // A server can have a repository in each of several destinations. A
    // backup admitted for one mustn't open another's.
    it.effect(
      "opens nothing to a backup that names its schedule's destination and another's repository",
      () =>
        Effect.gen(function* () {
          yield* seed()
          // The schedule backs up elsewhere; the repository is in `storageId`.
          yield* seedSchedule(relayId, otherStorageId)

          yield* reconcileBackupTaskEffect(
            offered(false, otherStorageId),
            relayId
          )
          const answer = yield* ask({ method: "PUT", taskId: scheduledTaskId })

          assert.strictEqual(yield* cataloged, "failed")
          assert.strictEqual(answer.status, "refused")
        })
    )

    // A prune is a task the Relay starts itself, and it removes data: the
    // one thing here that can destroy every backup in a repository. Hearth
    // opens a repository to one only for a delete Hearth asked for.
    const pruneId = "55555555-5555-4555-8555-555555555555"
    const target = { id: "instance-one", kind: "instance" as const }
    const prune = (id = pruneId, repository: object = { kind: "s3", repositoryId }) =>
      relayBackupTaskSchema.parse({
        backupId: "11111111-1111-4111-8111-1111111111c1",
        bytesCompleted: 0,
        bytesTotal: null,
        createdAt: NOW,
        error: null,
        finishedAt: null,
        input: {
          backupId: "11111111-1111-4111-8111-1111111111c1",
          kind: "prune",
          repository,
          target,
          taskId: id,
        },
        inputRefreshRequired: false,
        kind: "prune",
        result: null,
        startedAt: NOW,
        status: "running",
        taskId: id,
        updatedAt: NOW,
      })
    // How the Relay says the seeded task ended, as Hearth reads its tasks.
    const ended = (
      kind: "create" | "delete",
      status: "succeeded" | "failed" | "cancelled"
    ) =>
      reconcileBackupTaskEffect(
        relayBackupTaskSchema.parse({
          backupId,
          bytesCompleted: 0,
          bytesTotal: null,
          createdAt: NOW,
          error: status === "succeeded" ? null : `it ${status}`,
          finishedAt: NOW + 1,
          input:
            kind === "delete"
              ? {
                  backupId,
                  destination: {
                    kind: "restic",
                    repository: { kind: "s3", repositoryId },
                    snapshotId: "a1b2c3d4",
                  },
                  kind,
                  target,
                  taskId,
                }
              : {
                  artifactKind: "restic_snapshot",
                  backupId,
                  destination: {
                    kind: "restic",
                    repository: { kind: "s3", repositoryId },
                  },
                  exclude: [],
                  kind,
                  maxBytes: null,
                  mode: "incremental",
                  reason: "manual",
                  target,
                  taskId,
                },
          inputRefreshRequired: false,
          kind,
          result:
            status !== "succeeded"
              ? null
              : kind === "delete"
                ? { warnings: [] }
                : { bytes: 1, snapshotId: "a1b2c3d4", warnings: [] },
          startedAt: NOW,
          status,
          taskId,
          updatedAt: NOW + 1,
        }),
        relayId
      )
    const asPrune = (asked: Asked) => ask({ ...asked, taskId: pruneId })

    it.effect(
      "admits a prune once a delete Hearth asked for has ended, and opens only what a prune rewrites",
      () =>
        Effect.gen(function* () {
          yield* seed({ kind: "delete" })
          yield* ended("delete", "succeeded")

          const admitted = yield* admitRepositoryPruneEffect(relayId, prune())

          assert.strictEqual(admitted.status, "admitted")
          const granted = (asked: Asked) =>
            Effect.map(asPrune(asked), (answer) => answer.status === "granted")
          assert.isTrue(yield* granted({ method: "DELETE" }))
          assert.isTrue(yield* granted({ method: "PUT", type: "index" }))
          assert.isTrue(yield* granted({ method: "GET", type: "snapshots" }))
          // Not a snapshot, nor what the whole repository is read with.
          assert.isFalse(yield* granted({ method: "DELETE", type: "snapshots" }))
          assert.isFalse(yield* granted({ method: "DELETE", type: "keys" }))
          assert.isFalse(
            yield* granted({ method: "PUT", name: null, type: "config" })
          )
        })
    )

    // One prune covers a repository's deletes. Admitting it spends what
    // was owed, so a Relay can't prune again on the strength of one delete.
    it.effect(
      "admits one prune for a delete, the same one again, and no second",
      () =>
        Effect.gen(function* () {
          yield* seed({ kind: "delete" })
          yield* ended("delete", "succeeded")
          const another = "55555555-5555-4555-8555-555555555556"

          const first = yield* admitRepositoryPruneEffect(relayId, prune())
          const again = yield* admitRepositoryPruneEffect(relayId, prune())
          const second = yield* admitRepositoryPruneEffect(
            relayId,
            prune(another)
          )

          assert.strictEqual(first.status, "admitted")
          assert.strictEqual(again.status, "admitted")
          assert.strictEqual(second.status, "refused")
          assert.strictEqual(
            (yield* ask({ method: "DELETE", taskId: another })).status,
            "refused"
          )
        })
    )

    // A delete can stay open a long time, as with its Relay away. It opens
    // the repository to one prune, not to each one offered meanwhile.
    it.effect(
      "admits one prune for a delete still under way, and no other while it stays so",
      () =>
        Effect.gen(function* () {
          yield* seed({ kind: "delete" })

          const first = yield* admitRepositoryPruneEffect(relayId, prune())
          yield* closeRepositoryPrunesEffect(relayId, [pruneId])
          const second = yield* admitRepositoryPruneEffect(
            relayId,
            prune("55555555-5555-4555-8555-555555555558")
          )

          assert.strictEqual(first.status, "admitted")
          assert.strictEqual(second.status, "refused")
        })
    )

    // The Relay prunes as soon as its deletes have run, which is usually
    // before Hearth has read that the last of them ended. That delete is
    // covered by the prune admitted then: read as ended afterwards, it
    // must not leave a second prune to be had at any later time.
    it.effect(
      "admits a prune while a delete Hearth asked for is under way, and none for that delete once it has ended",
      () =>
        Effect.gen(function* () {
          yield* seed({ kind: "delete" })

          const admitted = yield* admitRepositoryPruneEffect(relayId, prune())
          yield* closeRepositoryPrunesEffect(relayId, [pruneId])
          yield* ended("delete", "succeeded")
          const later = yield* admitRepositoryPruneEffect(
            relayId,
            prune("55555555-5555-4555-8555-555555555557")
          )

          assert.strictEqual(admitted.status, "admitted")
          assert.strictEqual(later.status, "refused")
        })
    )

    it.effect.each<{
      case: string
      from?: string
      offered?: ReturnType<typeof prune>
      seeded?: Seed
      reported?: ReturnType<typeof ended>
    }>([
      { case: "nothing has been deleted there" },
      {
        case: "a backup was taken there",
        reported: ended("create", "succeeded"),
      },
      {
        case: "a backup failed there, as a Relay can make one",
        reported: ended("create", "failed"),
      },
      {
        case: "a backup was cancelled there",
        reported: ended("create", "cancelled"),
      },
      {
        case: "the delete Hearth asked for failed",
        seeded: { kind: "delete" },
        reported: ended("delete", "failed"),
      },
      {
        case: "another Relay offers it",
        from: otherRelayId,
        seeded: { kind: "delete" },
      },
      {
        case: "its repository is on the Relay's own disk",
        offered: prune(pruneId, { kind: "local" }),
        seeded: { kind: "delete" },
      },
      {
        case: "it names a repository Hearth doesn't know",
        offered: prune(pruneId, {
          kind: "s3",
          repositoryId: "22222222-2222-4222-8222-22222222222f",
        }),
        seeded: { kind: "delete" },
      },
    ])(
      "admits no prune, and opens nothing to one, when $case",
      ({ from = relayId, offered = prune(), reported, seeded }) =>
        Effect.gen(function* () {
          yield* seed(seeded)
          if (reported) yield* reported

          const answer = yield* admitRepositoryPruneEffect(from, offered)

          assert.strictEqual(answer.status, "refused")
          assert.strictEqual(
            (yield* asPrune({ from, method: "DELETE" })).status,
            "refused"
          )
        })
    )

    it.effect(
      "closes the repository to a prune once Hearth reads that it ended, or a day on",
      () =>
        Effect.gen(function* () {
          yield* seed({ kind: "delete" })
          yield* admitRepositoryPruneEffect(relayId, prune())
          assert.strictEqual(
            (yield* asPrune({ method: "DELETE" })).status,
            "granted"
          )

          yield* TestClock.setTime(NOW + 25 * HOUR)
          const stale = yield* asPrune({ method: "DELETE" })
          yield* TestClock.setTime(NOW)
          yield* closeRepositoryPrunesEffect(relayId, [pruneId])
          const closed = yield* asPrune({ method: "DELETE" })

          assert.strictEqual(stale.status, "refused")
          assert.strictEqual(closed.status, "refused")
        })
    )

    // What a Relay says it has already taken into a bucket's repository is
    // not taken on its word: it would be a repository no schedule was
    // checked for, and opening one is what an admitted backup gets.
    it.effect(
      "takes no Relay's word that a snapshot is already in a bucket's repository",
      () =>
        Effect.gen(function* () {
          yield* seed()

          yield* reconcileBackupTaskEffect(offered(true), relayId)

          assert.strictEqual(yield* cataloged, "failed")
        })
    )

    // The Relay says what kind of place its backup goes to. Hearth goes by
    // the destination, which is where it looks for the repository.
    it.effect(
      "checks the schedule of a backup for a bucket's repository though the Relay calls it its own disk's",
      () =>
        Effect.gen(function* () {
          yield* seed()
          // The schedule backs up elsewhere.
          yield* seedSchedule(relayId, otherStorageId)
          const task = offered()
          if (task.input.kind !== "create") return

          yield* reconcileBackupTaskEffect(
            {
              ...task,
              input: {
                ...task.input,
                destination: {
                  artifactId: "33333333-3333-4333-8333-3333333333a1",
                  kind: "restic",
                  repository: { kind: "local" },
                },
              },
            },
            relayId
          )
          const answer = yield* ask({ method: "PUT", taskId: scheduledTaskId })

          assert.strictEqual(yield* cataloged, "failed")
          assert.strictEqual(answer.status, "refused")
        })
    )
  })
})
