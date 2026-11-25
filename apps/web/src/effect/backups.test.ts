import { afterEach, assert, beforeEach, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { BackupStorageError, DatabaseError } from "@/effect/errors"
import {
  linkBackupEffect,
  linkInstanceBackupsEffect,
  listDispatchableBackupTasksEffect,
  reserveBackupCopyEffect,
  reserveBackupDeleteEffect,
} from "@/effect/backups"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

// S3 is the one external system here; everything else runs against MySQL.
vi.mock("@/backups/destinations/s3", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/backups/destinations/s3")>()
  return {
    ...actual,
    deleteS3BackupPrefix: vi.fn(() => Effect.void),
  }
})

const now = Date.UTC(2026, 8, 1)
const storageId = "11111111-1111-4111-8111-111111111111"

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
  vi.stubEnv("KILN_INSTALLATION_ID", "kiln.dev")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

interface BackupTableRow {
  id: string
  artifact_kind: string
  backup_mode: string
  batch_id: string | null
  bytes: number | string | null
  consistency: string | null
  created_at: number | string
  created_by: string | null
  deleted_at: number | string | null
  filename: string | null
  name: string
  object_key: string | null
  reason: string
  relay_id: string
  repository_id: string | null
  status: string
  storage_id: string | null
  target_id: string
  target_kind: string
}

interface ArtifactTableRow {
  id: string
  backup_id: string
  bytes: number | string | null
  deleted_at: number | string | null
  destination_key: string
  error: string | null
  filename: string | null
  object_key: string | null
  status: string
  storage_id: string | null
}

const byId = <T extends { id: string }>(rows: ReadonlyArray<T>) =>
  new Map(rows.map((row) => [row.id, row]))

const backups = selectRows<BackupTableRow>("backup").pipe(Effect.map(byId))
const artifacts = selectRows<ArtifactTableRow>("backup_artifact").pipe(
  Effect.map(byId)
)

const fresh = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
})

const insertArtifact = (
  id: string,
  backupId: string,
  row: Parameters<typeof insertRows>[1] & object = {}
) =>
  insertRows("backup_artifact", {
    id,
    backup_id: backupId,
    destination_key: "local",
    status: "available",
    created_at: now,
    updated_at: now,
    ...row,
  })

describeMysql("backup copy reservation", () => {
  layer(TestDatabase)((it) => {
    const input = {
      artifactKind: "archive" as const,
      backupId: "backup-one",
      filename: "backup.zip",
      relayId: "relay-one",
      requestedBy: "user-one",
      sourceArtifactId: "source-artifact",
      storageId,
      targetId: "instance-one",
      targetKind: "instance" as const,
    }

    const seedSource = (ownerUserId: string | null) =>
      Effect.gen(function* () {
        yield* fresh
        yield* insertBackupStorage(storageId, {
          owner_user_id: ownerUserId,
          object_prefix: "backups",
        })
        yield* insertBackup("backup-one", { filename: "backup.zip" })
        yield* insertArtifact("source-artifact", "backup-one")
      })

    const copyTasks = selectRows<{
      id: string
      destination_artifact_id: string
      error: string | null
      source_artifact_id: string
      requested_by: string
      status: string
    }>("backup_copy_task")

    it.effect("refuses a destination owned by another user", () =>
      Effect.gen(function* () {
        yield* seedSource("user-two")

        const error = yield* Effect.flip(reserveBackupCopyEffect(input))

        assert.instanceOf(error, BackupStorageError)
        assert.deepStrictEqual(
          [...(yield* artifacts).keys()],
          ["source-artifact"]
        )
        assert.lengthOf(yield* copyTasks, 0)
      })
    )
  })
})

describeMysql("linked backups", () => {
  layer(TestDatabase)((it) => {
    const storageId = "5b0f3c1e-2a4d-4e6f-8a9b-0c1d2e3f4a5b"
    const source = { instanceId: "instance-one", relayId: "relay-one" }
    // A full archive in S3, one kept on the Relay, and an incremental one.
    const seedBackups = Effect.gen(function* () {
      yield* fresh
      yield* insertBackupStorage(storageId)
      yield* insertBackup("s3-archive", {
        bytes: 10,
        checksum_sha256: "a".repeat(64),
        object_key: "kiln/s3-archive.zip",
        storage_id: storageId,
      })
      yield* insertArtifact("s3-artifact", "s3-archive", {
        bytes: 10,
        checksum_sha256: "a".repeat(64),
        destination_key: storageId,
        object_key: "kiln/s3-archive.zip",
        storage_id: storageId,
      })
      yield* insertBackup("local-archive", { bytes: 10 })
      yield* insertArtifact("local-artifact", "local-archive", { bytes: 10 })
      yield* insertBackup("incremental", {
        artifact_kind: "restic_snapshot",
        backup_mode: "incremental",
      })
      yield* insertArtifact("incremental-artifact", "incremental")
    })
    const linkedTo = (relayId: string, instanceId: string) =>
      selectRows<
        BackupTableRow & {
          linked_from_backup_id: string | null
          linked_from_target_id: string | null
          target_id: string
        }
      >("backup").pipe(
        Effect.map((rows) =>
          rows.filter(
            (row) => row.relay_id === relayId && row.target_id === instanceId
          )
        )
      )

    it.effect(
      "keeps a shared archive until the last backup linked to it is deleted",
      () =>
        Effect.gen(function* () {
          yield* seedBackups
          yield* linkInstanceBackupsEffect({
            from: source,
            linkedBy: "user-one",
            to: { instanceId: "instance-two", relayId: "relay-two" },
          })
          const [linked] = yield* linkedTo("relay-two", "instance-two")

          // The original goes first, as when the old server is cleaned up.
          const original = yield* reserveBackupDeleteEffect({
            backupId: "s3-archive",
            requestedBy: "user-one",
            taskId: "delete-original",
          })
          assert.deepStrictEqual(original, { kind: "removed" })
          assert.strictEqual(
            (yield* backups).get("s3-archive")?.status,
            "deleted"
          )
          assert.strictEqual(
            (yield* backups).get(linked!.id)?.status,
            "available"
          )

          // The last record sharing it deletes the archive itself, by the
          // backup it was made as.
          const last = yield* reserveBackupDeleteEffect({
            backupId: linked!.id,
            requestedBy: "user-one",
            taskId: "delete-linked",
          })
          assert.strictEqual(last.kind, "dispatch")
          const dispatch = last.kind === "dispatch" ? last.dispatch : null
          assert.deepInclude(dispatch, {
            archive: { backupId: "s3-archive", targetId: "instance-one" },
            kind: "delete",
          })
          assert.strictEqual(
            dispatch?.artifacts[0]?.objectKey,
            "kiln/s3-archive.zip"
          )
        })
    )

    it.effect(
      "links a snapshot in a bucket to a resource on another Relay, once, as only a record",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackupStorage(storageId, { object_prefix: "backups" })
          yield* insertRelay("relay-one")
          yield* insertRows("backup_repository", {
            id: "repository",
            created_at: now,
            object_prefix: "backups/x",
            password_ciphertext: "unused",
            relay_id: "relay-one",
            storage_id: storageId,
            storage_key: storageId,
            target_id: "instance-one",
            target_kind: "instance",
          })
          for (const [id, storage] of [
            ["in-bucket", storageId],
            ["on-relay", null],
          ] as const) {
            yield* insertBackup(id, {
              artifact_kind: "restic_snapshot",
              backup_mode: "incremental",
              relay_id: "relay-one",
              repository_id: "repository",
              restic_snapshot_id: "abcdef12",
              status: "available",
              storage_id: storage,
              target_id: "instance-one",
            })
            yield* insertArtifact(`${id}-artifact`, id, {
              destination_key: storage ?? "local",
              storage_id: storage,
            })
          }
          const link = (backupId: string) =>
            linkBackupEffect({
              backupId,
              linkedBy: "user-one",
              to: { relayId: "relay-two", targetId: "instance-two" },
            })

          const id = yield* link("in-bucket")
          assert.strictEqual(yield* link("in-bucket"), id)
          assert.deepInclude((yield* backups).get(id), {
            artifact_kind: "restic_snapshot",
            backup_mode: "incremental",
            relay_id: "relay-two",
            repository_id: "repository",
            status: "available",
            target_id: "instance-two",
          })
          // What's on a Relay's disk is that Relay's alone.
          assert.instanceOf(
            yield* Effect.flip(link("on-relay")),
            BackupStorageError
          )

          // The repository is another Relay's to write to, so only the link
          // goes, and what it was linked from still restores.
          assert.deepStrictEqual(
            yield* reserveBackupDeleteEffect({
              backupId: id,
              requestedBy: "user-one",
              taskId: "delete-link",
            }),
            { kind: "removed" }
          )
          assert.strictEqual(
            (yield* backups).get("in-bucket")?.status,
            "available"
          )
        })
    )
  })
})

describeMysql("dispatching a Relay's backup tasks", () => {
  layer(TestDatabase)((it) => {
    it.effect("goes on past a deadlock", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one")
        yield* insertBackup("backup", {})
        const task = (id: string, row: Record<string, unknown>) =>
          insertRows("backup_task", {
            backup_id: "backup",
            created_at: now,
            id,
            updated_at: now,
            ...row,
          })
        yield* task("safety", { status: "failed", task_kind: "create" })
        yield* task("restore", {
          depends_on_task_id: "safety",
          status: "queued",
          task_kind: "restore",
        })
        const database = yield* Database
        let deadlocks = 0
        const contended = Database.of({
          ...database,
          execute: (operation, statement, values) =>
            Effect.suspend(() =>
              operation === "backup_dependency_failures" && deadlocks++ === 0
                ? Effect.fail(
                    DatabaseError.make({ operation, cause: { errno: 1213 } })
                  )
                : database.execute(operation, statement, values)
            ),
        })

        yield* listDispatchableBackupTasksEffect("relay-one").pipe(
          Effect.provideService(Database, contended)
        )

        const tasks = yield* selectRows<{ id: string; status: string }>(
          "backup_task"
        )
        assert.strictEqual(
          tasks.find(({ id }) => id === "restore")?.status,
          "failed"
        )
      })
    )
  })
})
