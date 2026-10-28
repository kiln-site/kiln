import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  layer,
} from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"
import type { RelayBackupTask } from "@workspace/contracts"

import { encryptWithKeyring } from "../../keyring.mjs"
import { BackupLimitError, BackupStorageError } from "@/effect/errors"
import {
  backupReservation,
  canReuseBackupExport,
  getBackupPolicyEffect,
  linkInstanceBackupsEffect,
  purgeInstanceBackupRepositoriesEffect,
  reserveBackupDeleteEffect,
  reserveBackupCopyEffect,
  reserveBackupRestoreEffect,
  reserveInstanceBackupEffect,
  reconcileBackupTaskEffect,
  shouldApplyRelayBackupTaskSnapshot,
  updateBackupExcludesEffect,
  updateBackupLimitsEffect,
} from "@/effect/backups"
import { deleteS3BackupPrefix } from "@/backups/destinations/s3"
import { databaseTableName } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"
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

describe("backup limits", () => {
  it("reuses an unexpired export while polling even if remaining is under the requested TTL", () => {
    expect(
      canReuseBackupExport({
        remainingMs: 15 * 60 * 60 * 1_000 - 1_500,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: false,
      })
    ).toBe(true)
    expect(
      canReuseBackupExport({
        remainingMs: 15 * 60 * 60 * 1_000 - 1_500,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: true,
      })
    ).toBe(true)
    expect(
      canReuseBackupExport({
        remainingMs: 60_000,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: true,
      })
    ).toBe(true)
    expect(
      canReuseBackupExport({
        remainingMs: 59_000,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: true,
      })
    ).toBe(false)
    expect(
      canReuseBackupExport({
        remainingMs: 0,
        requestedTtlMs: 60_000,
        requireFullTtl: false,
      })
    ).toBe(false)
  })

  it("caps a backup at the space kept, and refuses only when backups are off", () => {
    expect(
      backupReservation({
        quantityLimit: 5,
        requestedMaxBytes: 800,
        sizeLimit: 1_000,
      })
    ).toEqual({ maxBytes: 800 })
    expect(
      backupReservation({
        quantityLimit: 1,
        requestedMaxBytes: null,
        sizeLimit: 1_000,
      })
    ).toEqual({ maxBytes: 1_000 })
    expect(() =>
      backupReservation({
        quantityLimit: 0,
        requestedMaxBytes: null,
        sizeLimit: null,
      })
    ).toThrow(BackupLimitError)
  })
})

describe("Relay backup task snapshots", () => {
  it("rejects stale Relay snapshots after a task has completed", () => {
    const completed = {
      bytesCompleted: 256,
      relayUpdatedAt: 300,
      status: "succeeded" as const,
    }

    expect(
      shouldApplyRelayBackupTaskSnapshot(completed, {
        bytesCompleted: 128,
        status: "running",
        updatedAt: 200,
      })
    ).toBe(false)
    expect(
      shouldApplyRelayBackupTaskSnapshot(completed, {
        bytesCompleted: 0,
        status: "queued",
        updatedAt: 100,
      })
    ).toBe(false)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { ...completed, relayUpdatedAt: null },
        { bytesCompleted: 128, status: "running", updatedAt: 400 }
      )
    ).toBe(false)
  })

  it("allows newer snapshots and same-millisecond forward progress", () => {
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 64, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 128, status: "running", updatedAt: 200 }
      )
    ).toBe(true)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 0, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 256, status: "succeeded", updatedAt: 100 }
      )
    ).toBe(true)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 256, relayUpdatedAt: 100, status: "succeeded" },
        { bytesCompleted: 128, status: "running", updatedAt: 100 }
      )
    ).toBe(false)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 64, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 128, status: "running", updatedAt: 100 }
      )
    ).toBe(true)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 128, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 128, status: "running", updatedAt: 100 }
      )
    ).toBe(false)
  })
})

interface BackupTableRow {
  id: string
  artifact_kind: string
  backup_mode: string
  bytes: number | string | null
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

interface RepositoryTableRow {
  id: string
  object_prefix: string | null
  storage_id: string | null
  storage_key: string
  target_id: string
}

const byId = <T extends { id: string }>(rows: ReadonlyArray<T>) =>
  new Map(rows.map((row) => [row.id, row]))

const backups = selectRows<BackupTableRow>("backup").pipe(Effect.map(byId))
const artifacts = selectRows<ArtifactTableRow>("backup_artifact").pipe(
  Effect.map(byId)
)
const repositories = selectRows<RepositoryTableRow>("backup_repository")

const fresh = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
})

const insertPolicy = (row: Parameters<typeof insertRows>[1] & object) =>
  insertRows("backup_policy", {
    relay_id: "relay-one",
    target_kind: "instance",
    target_id: "instance-one",
    exclude_patterns: "[]",
    created_at: now,
    updated_at: now,
    ...row,
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

const insertTask = (
  id: string,
  backupId: string,
  row: Parameters<typeof insertRows>[1] & object = {}
) =>
  insertRows("backup_task", {
    id,
    backup_id: backupId,
    task_kind: "create",
    status: "succeeded",
    created_at: now,
    updated_at: now,
    ...row,
  })

const reserve = (
  input: Partial<Parameters<typeof reserveInstanceBackupEffect>[0]> & {
    backupId: string
  }
) =>
  reserveInstanceBackupEffect({
    createdBy: "user-one",
    mode: "full",
    name: input.backupId,
    relayId: "relay-one",
    requestedMaxBytes: null,
    targetId: "instance-one",
    taskId: `${input.backupId}-task`,
    ...input,
  })

const deletionId = "00000000-0000-4000-8000-0000000000de"

// A deletion of instance-one waiting for its final backup, or past it.
const insertDeletion = (status: string, backupId: string | null = null) =>
  Effect.gen(function* () {
    yield* insertRelay("relay-one")
    yield* insertRows("resource_deletion", {
      id: deletionId,
      relay_id: "relay-one",
      resource_kind: "instance",
      resource_id: "instance-one",
      final_backup: true,
      backup_id: backupId,
      status,
      requested_by: "user-one",
      actor: JSON.stringify({ id: "user-one" }),
      created_at: now,
      updated_at: now,
    })
  })

describeMysql("backup reservations", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "takes a backup past the target's limits, for retention to make room",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertPolicy({ quantity_limit: 1, size_limit_bytes: 2_048 })
          yield* insertBackup("kept", { bytes: 2_048 })
          yield* insertBackup("running", { status: "running" })

          const next = yield* reserve({ backupId: "next" })

          // As large as everything kept, at most.
          assert.strictEqual(next.maxBytes, 2_048)
          assert.isTrue((yield* backups).has("next"))
        })
    )

    it.effect(
      "refuses backups a platform ceiling turns off, final-deletion ones too",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertPolicy({ admin_quantity_limit: 0 })

          const manual = yield* Effect.flip(reserve({ backupId: "manual" }))
          yield* insertDeletion("pending")
          const final = yield* Effect.flip(
            reserve({ backupId: "final", deletionId, reason: "final_delete" })
          )

          assert.instanceOf(manual, BackupLimitError)
          assert.instanceOf(final, BackupLimitError)
          assert.strictEqual((yield* backups).size, 0)
        })
    )

    it.effect(
      "lets final-deletion backups past the owner's limits but not a ceiling's size",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertPolicy({
            quantity_limit: 1,
            size_limit_bytes: 512,
            admin_size_limit_bytes: 2_048,
          })
          yield* insertDeletion("pending")

          const final = yield* reserve({
            backupId: "final",
            deletionId,
            reason: "final_delete",
          })

          assert.strictEqual(final.maxBytes, 2_048)
          // Its deletion follows it by its ID from now on.
          const deletions = yield* selectRows<{
            backup_id: string
            status: string
          }>("resource_deletion")
          assert.deepStrictEqual(
            deletions.map((row) => [row.backup_id, row.status]),
            [["final", "backing_up"]]
          )
        })
    )

    it.effect(
      "takes one final backup per deletion, and none for no deletion",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertDeletion("pending")

          yield* reserve({
            backupId: "final",
            deletionId,
            reason: "final_delete",
          })
          const again = yield* Effect.flip(
            reserve({ backupId: "again", deletionId, reason: "final_delete" })
          )
          const unowned = yield* Effect.flip(
            reserve({ backupId: "unowned", reason: "final_delete" })
          )

          assert.instanceOf(again, BackupStorageError)
          assert.instanceOf(unowned, BackupStorageError)
          assert.deepStrictEqual([...(yield* backups).keys()], ["final"])
        })
    )

    it.effect("rejects new reservations while final deletion is active", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* insertBackup("final")
        yield* insertDeletion("backing_up", "final")

        const error = yield* Effect.flip(reserve({ backupId: "blocked" }))

        assert.instanceOf(error, BackupStorageError)
        assert.strictEqual(
          (error as BackupStorageError).code,
          "final_delete_in_progress"
        )
        assert.deepStrictEqual([...(yield* backups).keys()], ["final"])
      })
    )

    it.effect("requires exactly one destination for incremental backups", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* insertBackupStorage(storageId)

        const error = yield* Effect.flip(
          reserve({
            backupId: "incremental",
            mode: "incremental",
            storageIds: [null, storageId],
          })
        )

        assert.instanceOf(error, BackupStorageError)
        assert.strictEqual((yield* backups).size, 0)
      })
    )

    it.effect(
      "refuses incremental S3 destinations with an unsafe bucket, region, or prefix",
      () =>
        Effect.gen(function* () {
          yield* fresh
          const unsafe: ReadonlyArray<Record<string, string>> = [
            { bucket: "Not_A_Bucket" },
            { region: "US_EAST_1" },
            { object_prefix: "team/foo bar" },
          ]
          for (const [index, row] of unsafe.entries()) {
            const id = `2222222${index}-2222-4222-8222-222222222222`
            yield* insertBackupStorage(id, { name: id, ...row })
            const error = yield* Effect.flip(
              reserve({
                backupId: `unsafe-${index}`,
                mode: "incremental",
                storageIds: [id],
              })
            )
            assert.instanceOf(error, BackupStorageError, JSON.stringify(row))
          }
          assert.strictEqual((yield* backups).size, 0)
          assert.lengthOf(yield* repositories, 0)

          // The same reservation succeeds against a safe destination.
          yield* insertBackupStorage(storageId)
          yield* reserve({
            backupId: "safe",
            mode: "incremental",
            storageIds: [storageId],
          })
          assert.isTrue((yield* backups).has("safe"))
        })
    )

    it.effect(
      "keeps incremental backups in one restic repository per destination",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackupStorage(storageId, { object_prefix: "team" })

          const first = yield* reserve({
            backupId: "backup-one",
            mode: "incremental",
            storageIds: [storageId],
          })
          const second = yield* reserve({
            backupId: "backup-two",
            mode: "incremental",
            storageIds: [storageId],
          })

          const [repository, ...others] = yield* repositories
          assert.lengthOf(others, 0)
          assert.isDefined(repository)
          assert.strictEqual(repository.storage_id, storageId)
          assert.strictEqual(repository.storage_key, storageId)
          assert.strictEqual(
            repository.object_prefix,
            `team/kiln/kiln.dev/relay-one/restic/instance/instance-one/${repository.id}`
          )
          // The password is stored encrypted and handed back unchanged.
          assert.isString(first.repositoryPassword)
          assert.strictEqual(
            second.repositoryPassword,
            first.repositoryPassword
          )

          const backup = (yield* backups).get("backup-one")
          assert.strictEqual(backup?.artifact_kind, "restic_snapshot")
          assert.strictEqual(backup?.backup_mode, "incremental")
          assert.strictEqual(backup?.repository_id, repository.id)
          assert.isNull(backup?.object_key)
          const artifact = [...(yield* artifacts).values()].find(
            (row) => row.backup_id === "backup-one"
          )
          assert.strictEqual(artifact?.destination_key, "restic")
          assert.strictEqual(artifact?.storage_id, storageId)
          assert.strictEqual(artifact?.status, "queued")
          assert.isNull(artifact?.object_key)
        })
    )

    it.effect("keeps pre-restore safety backups as full archives", () =>
      Effect.gen(function* () {
        yield* fresh

        const dispatch = yield* reserve({
          backupId: "safety",
          mode: "incremental",
          reason: "pre_restore",
        })

        assert.strictEqual(dispatch.mode, "full")
        const backup = (yield* backups).get("safety")
        assert.strictEqual(backup?.backup_mode, "full")
        assert.strictEqual(backup?.artifact_kind, "archive")
        assert.strictEqual(backup?.reason, "pre_restore")
        assert.lengthOf(yield* repositories, 0)
      })
    )
  })
})

describeMysql("backup policies", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps user limits, admin limits, and excludes independent", () =>
      Effect.gen(function* () {
        yield* fresh
        const target = {
          relayId: "relay-one",
          targetId: "database-one",
          targetKind: "database" as const,
        }

        yield* updateBackupLimitsEffect({
          ...target,
          admin: false,
          quantityLimit: 6,
          retentionDays: 30,
          sizeLimitBytes: 2_048,
        })
        yield* updateBackupLimitsEffect({
          ...target,
          admin: true,
          quantityLimit: 12,
          retentionDays: 90,
          sizeLimitBytes: 4_096,
        })
        yield* updateBackupExcludesEffect({ ...target, exclude: ["cache/**"] })
        yield* updateBackupExcludesEffect({
          relayId: "relay-one",
          targetId: "kiln.dev",
          targetKind: "platform",
          exclude: ["logs/**"],
        })

        assert.deepStrictEqual(
          yield* getBackupPolicyEffect("relay-one", "database", "database-one"),
          {
            adminQuantityLimit: 12,
            adminRetentionDays: 90,
            adminSizeLimitBytes: 4_096,
            exclude: ["cache/**"],
            quantityLimit: 6,
            retentionDays: 30,
            sizeLimitBytes: 2_048,
            storageId: null,
          }
        )
        assert.deepStrictEqual(
          yield* getBackupPolicyEffect("relay-one", "platform", "kiln.dev"),
          {
            adminQuantityLimit: null,
            adminRetentionDays: null,
            adminSizeLimitBytes: null,
            exclude: ["logs/**"],
            quantityLimit: null,
            retentionDays: null,
            sizeLimitBytes: null,
            storageId: null,
          }
        )
      })
    )
  })
})

describeMysql("final deletion repository purge", () => {
  layer(TestDatabase)((it) => {
    const repositoryPrefix = "team/restic/instance-one/repository-one"

    const seedRepositories = Effect.gen(function* () {
      yield* fresh
      const purpose = (field: string) =>
        `kiln-backup-storage:${storageId}:${field}`
      yield* insertBackupStorage(storageId, {
        access_key_id_ciphertext: encryptWithKeyring(
          "AKIAEXAMPLE",
          betterAuthSecrets(),
          purpose("access-key-id")
        ),
        secret_access_key_ciphertext: encryptWithKeyring(
          "s3-secret",
          betterAuthSecrets(),
          purpose("secret-access-key")
        ),
      })
      for (const [id, targetId] of [
        ["repository-one", "instance-one"],
        ["repository-other", "instance-two"],
      ]) {
        yield* insertRows("backup_repository", {
          id,
          relay_id: "relay-one",
          target_kind: "instance",
          target_id: targetId,
          storage_id: storageId,
          storage_key: storageId,
          object_prefix:
            id === "repository-one" ? repositoryPrefix : `team/${id}`,
          password_ciphertext: "password",
          created_at: now,
        })
      }
      yield* insertBackup("incremental", {
        backup_mode: "incremental",
        artifact_kind: "restic_snapshot",
        repository_id: "repository-one",
        storage_id: storageId,
      })
      yield* insertArtifact("incremental-artifact", "incremental", {
        destination_key: "restic",
        storage_id: storageId,
      })
      yield* insertBackup("full")
      yield* insertArtifact("full-artifact", "full")
      yield* insertBackup("other-target", {
        target_id: "instance-two",
        backup_mode: "incremental",
        artifact_kind: "restic_snapshot",
        repository_id: "repository-other",
        storage_id: storageId,
      })
    })

    it.effect(
      "purges remote data before deleting the incremental catalog",
      () =>
        Effect.gen(function* () {
          yield* seedRepositories
          vi.mocked(deleteS3BackupPrefix).mockClear()
          vi.mocked(deleteS3BackupPrefix).mockReturnValue(Effect.void)

          yield* purgeInstanceBackupRepositoriesEffect(
            "relay-one",
            "instance-one"
          )

          // Only this instance's repository is purged from the bucket.
          expect(vi.mocked(deleteS3BackupPrefix).mock.calls).toEqual([
            [
              expect.objectContaining({
                accessKeyId: "AKIAEXAMPLE",
                bucket: "kiln-backups",
                secretAccessKey: "s3-secret",
              }),
              repositoryPrefix,
            ],
          ])
          const backupRows = yield* backups
          assert.strictEqual(backupRows.get("incremental")?.status, "deleted")
          assert.isNull(backupRows.get("incremental")?.repository_id ?? null)
          assert.strictEqual(backupRows.get("full")?.status, "available")
          assert.strictEqual(
            backupRows.get("other-target")?.status,
            "available"
          )
          const artifactRows = yield* artifacts
          assert.strictEqual(
            artifactRows.get("incremental-artifact")?.status,
            "deleted"
          )
          assert.strictEqual(
            artifactRows.get("full-artifact")?.status,
            "available"
          )
          assert.deepStrictEqual(
            (yield* repositories).map((row) => row.id),
            ["repository-other"]
          )
        })
    )

    it.effect("keeps the incremental catalog when the remote purge fails", () =>
      Effect.gen(function* () {
        yield* seedRepositories
        vi.mocked(deleteS3BackupPrefix).mockReturnValueOnce(
          Effect.fail(
            BackupStorageError.make({
              code: "s3_request_failed",
              operation: "storage.deletePrefix",
              reason: "purge failed",
            })
          )
        )

        const error = yield* Effect.flip(
          purgeInstanceBackupRepositoriesEffect("relay-one", "instance-one")
        )

        assert.instanceOf(error, BackupStorageError)
        const backupRows = yield* backups
        assert.strictEqual(backupRows.get("incremental")?.status, "available")
        assert.strictEqual(
          backupRows.get("incremental")?.repository_id,
          "repository-one"
        )
        assert.strictEqual(
          (yield* artifacts).get("incremental-artifact")?.status,
          "available"
        )
        assert.sameMembers(
          (yield* repositories).map((row) => row.id),
          ["repository-one", "repository-other"]
        )
      })
    )
  })
})

const deleteTask = (
  task: Partial<RelayBackupTask> & Pick<RelayBackupTask, "result" | "status">
) =>
  ({
    backupId: "backup-one",
    bytesCompleted: 0,
    bytesTotal: null,
    createdAt: 50,
    currentArtifactId: null,
    currentPath: null,
    error: null,
    finishedAt: 200,
    input: {
      backupId: "backup-one",
      destination: {
        artifactId: "artifact-one",
        kind: "local",
      },
      kind: "delete",
      target: { id: "instance-one", kind: "instance" },
      taskId: "task-one",
    },
    inputRefreshRequired: false,
    kind: "delete",
    phase: null,
    startedAt: 100,
    taskId: "task-one",
    updatedAt: 200,
    ...task,
  }) as RelayBackupTask

describeMysql("backup reconciliation", () => {
  layer(TestDatabase)((it) => {
    it.effect("adopts Relay-owned scheduled backups into the catalog", () =>
      Effect.gen(function* () {
        yield* fresh
        const backupId = "10000000-0000-4000-8000-000000000001"
        const artifactId = "00000000-0000-4000-8000-000000000001"
        const task = {
          backupId,
          bytesCompleted: 256,
          bytesTotal: 256,
          createdAt: Date.UTC(2026, 7, 21, 10, 29, 15),
          currentArtifactId: null,
          currentPath: null,
          error: null,
          errorCode: null,
          finishedAt: Date.UTC(2026, 7, 21, 10, 29, 20),
          input: {
            artifactKind: "archive",
            backupId,
            catalog: {
              name: "scheduled-2026.08.21-10.29.15Z",
              storageId: null,
            },
            destination: { artifactId, kind: "local" },
            exclude: [],
            kind: "create",
            maxBytes: null,
            mode: "full",
            reason: "scheduled",
            target: { id: "instance-one", kind: "instance" },
            taskId: "task-one",
          },
          inputRefreshRequired: false,
          kind: "create",
          phase: null,
          result: {
            bytes: 256,
            checksumSha256: "a".repeat(64),
            filename: "backup-one.zip",
            warnings: [],
          },
          startedAt: Date.UTC(2026, 7, 21, 10, 29, 15),
          status: "succeeded",
          taskId: "task-one",
          updatedAt: Date.UTC(2026, 7, 21, 10, 29, 20),
        } satisfies RelayBackupTask

        const changed = yield* reconcileBackupTaskEffect(task, "relay-a")

        assert.isTrue(changed)
        const backup = (yield* backups).get(backupId)
        assert.deepInclude(backup, {
          relay_id: "relay-a",
          target_kind: "instance",
          target_id: "instance-one",
          storage_id: null,
          artifact_kind: "archive",
          backup_mode: "full",
          reason: "scheduled",
          status: "available",
          name: "scheduled-2026.08.21-10.29.15Z",
          filename: "backup-one.zip",
          created_by: null,
        })
        assert.strictEqual(Number(backup?.bytes), 256)
        assert.strictEqual(Number(backup?.created_at), task.createdAt)
        const artifact = (yield* artifacts).get(artifactId)
        assert.strictEqual(artifact?.backup_id, backupId)
        assert.strictEqual(artifact?.destination_key, "local")
        assert.strictEqual(artifact?.status, "available")
        const tasks = yield* selectRows<{ id: string; status: string }>(
          "backup_task"
        )
        assert.deepStrictEqual(
          tasks.map((row) => [row.id, row.status]),
          [["task-one", "succeeded"]]
        )
      })
    )

    it.effect(
      "does not resurrect a deleted backup from its historical create task",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackup("backup-one", { status: "deleted" })
          yield* insertArtifact("artifact-one", "backup-one", {
            status: "deleted",
          })
          yield* insertTask("task-one", "backup-one", { status: "queued" })

          yield* reconcileBackupTaskEffect({
            backupId: "backup-one",
            bytesCompleted: 256,
            bytesTotal: 256,
            createdAt: 50,
            currentArtifactId: null,
            currentPath: null,
            error: null,
            errorCode: null,
            finishedAt: 200,
            input: {
              artifactKind: "archive",
              backupId: "backup-one",
              destination: { artifactId: "artifact-one", kind: "local" },
              exclude: [],
              kind: "create",
              maxBytes: null,
              mode: "full",
              reason: "manual",
              replicas: [],
              target: { id: "instance-one", kind: "instance" },
              taskId: "task-one",
            },
            inputRefreshRequired: false,
            kind: "create",
            phase: null,
            result: {
              bytes: 256,
              checksumSha256: "a".repeat(64),
              filename: "backup-one.zip",
              warnings: [],
            },
            startedAt: 100,
            status: "succeeded",
            taskId: "task-one",
            updatedAt: 200,
          })

          assert.strictEqual(
            (yield* backups).get("backup-one")?.status,
            "deleted"
          )
          assert.strictEqual(
            (yield* artifacts).get("artifact-one")?.status,
            "deleted"
          )
        })
    )

    it.effect("keeps artifacts available when their deletion fails", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* insertBackup("backup-one", { status: "deleting" })
        yield* insertArtifact("artifact-one", "backup-one", {
          status: "deleting",
        })
        yield* insertArtifact("artifact-two", "backup-one", {
          status: "deleting",
          destination_key: storageId,
        })
        yield* insertTask("task-one", "backup-one", {
          task_kind: "delete",
          status: "running",
          relay_updated_at_ms: 100,
        })

        yield* reconcileBackupTaskEffect(
          deleteTask({
            status: "succeeded",
            result: {
              artifacts: [
                {
                  artifactId: "artifact-one",
                  error: "Temporary S3 delete failure",
                  status: "failed",
                },
                { artifactId: "artifact-two", error: null, status: "deleted" },
              ],
              warnings: [],
            },
          })
        )

        const artifactRows = yield* artifacts
        assert.deepInclude(artifactRows.get("artifact-one"), {
          status: "available",
          error: "Temporary S3 delete failure",
          deleted_at: null,
        })
        assert.strictEqual(artifactRows.get("artifact-two")?.status, "deleted")
        assert.strictEqual(
          Number(artifactRows.get("artifact-two")?.deleted_at),
          200
        )
        const backup = (yield* backups).get("backup-one")
        assert.strictEqual(backup?.status, "available")
        assert.isNull(backup?.deleted_at)
      })
    )

    it.effect(
      "deletes every artifact of an incremental backup once its snapshot is forgotten",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackup("backup-one", {
            artifact_kind: "restic_snapshot",
            backup_mode: "incremental",
            status: "deleting",
          })
          // Legacy installs also copied the backup into a storage-keyed
          // artifact; the Relay reports only the one it was sent.
          yield* insertArtifact("backup-one", "backup-one")
          yield* insertArtifact("artifact-one", "backup-one", {
            destination_key: "restic",
          })
          yield* insertTask("task-one", "backup-one", {
            task_kind: "delete",
            status: "running",
            relay_updated_at_ms: 100,
          })

          yield* reconcileBackupTaskEffect(
            deleteTask({
              status: "succeeded",
              result: {
                artifacts: [
                  { artifactId: "backup-one", error: null, status: "deleted" },
                ],
                warnings: [],
              },
            })
          )

          const artifactRows = yield* artifacts
          assert.strictEqual(artifactRows.get("backup-one")?.status, "deleted")
          assert.strictEqual(
            artifactRows.get("artifact-one")?.status,
            "deleted"
          )
          const backup = (yield* backups).get("backup-one")
          assert.strictEqual(backup?.status, "deleted")
          assert.strictEqual(Number(backup?.deleted_at), 200)
        })
    )

    it.effect(
      "keeps a deleted backup deleted when a retried delete fails",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackup("backup-one", {
            artifact_kind: "restic_snapshot",
            backup_mode: "incremental",
            status: "deleted",
          })
          yield* insertArtifact("artifact-one", "backup-one", {
            destination_key: "restic",
            status: "deleted",
          })
          yield* insertTask("task-one", "backup-one", {
            task_kind: "delete",
            status: "running",
            relay_updated_at_ms: 100,
          })

          yield* reconcileBackupTaskEffect(
            deleteTask({
              error: "repository is already locked",
              result: null,
              status: "failed",
            })
          )

          assert.strictEqual(
            (yield* backups).get("backup-one")?.status,
            "deleted"
          )
          assert.strictEqual(
            (yield* artifacts).get("artifact-one")?.status,
            "deleted"
          )
        })
    )

    it.effect(
      "makes an incremental backup available whichever artifact its snapshot reports",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackup("backup-one", {
            artifact_kind: "restic_snapshot",
            backup_mode: "incremental",
            status: "running",
          })
          yield* insertArtifact("artifact-one", "backup-one", {
            destination_key: "restic",
            status: "running",
          })
          yield* insertTask("task-one", "backup-one", {
            status: "running",
            relay_updated_at_ms: 100,
          })

          // The task was dispatched with a legacy artifact since removed.
          yield* reconcileBackupTaskEffect({
            ...deleteTask({
              result: {
                artifacts: [
                  {
                    artifactId: "backup-one",
                    error: null,
                    status: "available",
                  },
                ],
                bytes: 256,
                snapshotId: "a".repeat(64),
                warnings: [],
              },
              status: "succeeded",
            }),
            input: {
              artifactKind: "restic_snapshot",
              backupId: "backup-one",
              destination: {
                artifactId: "backup-one",
                kind: "restic",
                repository: { kind: "local" },
              },
              exclude: [],
              kind: "create",
              maxBytes: null,
              mode: "incremental",
              reason: "manual",
              target: { id: "instance-one", kind: "instance" },
              taskId: "task-one",
            },
            kind: "create",
          } as RelayBackupTask)

          assert.strictEqual(
            (yield* artifacts).get("artifact-one")?.status,
            "available"
          )
          assert.strictEqual(
            (yield* backups).get("backup-one")?.status,
            "available"
          )
        })
    )

    it.effect("reconciles delete progress one artifact at a time", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* insertBackup("backup-one", { status: "deleting" })
        yield* insertArtifact("artifact-done", "backup-one", {
          status: "deleting",
        })
        yield* insertArtifact("artifact-current", "backup-one", {
          destination_key: storageId,
        })
        yield* insertArtifact("artifact-later", "backup-one", {
          destination_key: "33333333-3333-4333-8333-333333333333",
        })
        yield* insertTask("task-one", "backup-one", {
          task_kind: "delete",
          status: "running",
          relay_updated_at_ms: 100,
        })

        yield* reconcileBackupTaskEffect(
          deleteTask({
            currentArtifactId: "artifact-current",
            finishedAt: null,
            status: "running",
            result: {
              artifacts: [
                { artifactId: "artifact-done", error: null, status: "deleted" },
              ],
              warnings: [],
            },
          })
        )

        const artifactRows = yield* artifacts
        assert.strictEqual(artifactRows.get("artifact-done")?.status, "deleted")
        assert.strictEqual(
          Number(artifactRows.get("artifact-done")?.deleted_at),
          200
        )
        assert.strictEqual(
          artifactRows.get("artifact-current")?.status,
          "deleting"
        )
        assert.strictEqual(
          artifactRows.get("artifact-later")?.status,
          "available"
        )
        assert.strictEqual(
          (yield* backups).get("backup-one")?.status,
          "deleting"
        )
      })
    )
  })
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

    it.effect("queues one durable copy per destination and retries it", () =>
      Effect.gen(function* () {
        yield* seedSource("user-one")

        const reserved = yield* reserveBackupCopyEffect(input)

        const artifact = (yield* artifacts).get(reserved.artifactId)
        assert.deepInclude(artifact, {
          backup_id: "backup-one",
          destination_key: storageId,
          storage_id: storageId,
          status: "queued",
          filename: "backup.zip",
          object_key: reserved.objectKey,
        })
        expect(yield* copyTasks).toEqual([
          expect.objectContaining({
            id: reserved.taskId,
            destination_artifact_id: reserved.artifactId,
            source_artifact_id: "source-artifact",
            requested_by: "user-one",
            status: "queued",
          }),
        ])

        // A copy already in flight is not queued twice.
        const duplicate = yield* Effect.flip(reserveBackupCopyEffect(input))
        assert.instanceOf(duplicate, BackupStorageError)

        // After a failure the same destination artifact is queued again.
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE ${sql(databaseTableName("backup_artifact"))}
          SET status = 'failed' WHERE id = ${reserved.artifactId}`
        yield* sql`UPDATE ${sql(databaseTableName("backup_copy_task"))}
          SET status = 'failed', error = 'copy failed'`
        const retried = yield* reserveBackupCopyEffect(input)

        assert.strictEqual(retried.artifactId, reserved.artifactId)
        assert.strictEqual(
          (yield* artifacts).get(reserved.artifactId)?.status,
          "queued"
        )
        const tasks = yield* copyTasks
        assert.lengthOf(tasks, 1)
        assert.deepInclude(tasks[0], {
          id: retried.taskId,
          error: null,
          status: "queued",
        })
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
      "links only archives the copy's Relay can reach, and never incremental ones",
      () =>
        Effect.gen(function* () {
          yield* seedBackups

          const elsewhere = yield* linkInstanceBackupsEffect({
            from: source,
            linkedBy: "user-one",
            to: { instanceId: "instance-two", relayId: "relay-two" },
          })
          const here = yield* linkInstanceBackupsEffect({
            from: source,
            linkedBy: "user-one",
            to: { instanceId: "instance-three", relayId: "relay-one" },
          })

          assert.strictEqual(elsewhere, 1)
          assert.deepStrictEqual(
            (yield* linkedTo("relay-two", "instance-two")).map((row) => ({
              linked: row.linked_from_backup_id,
              objectKey: row.object_key,
              target: row.linked_from_target_id,
            })),
            [
              {
                linked: "s3-archive",
                objectKey: "kiln/s3-archive.zip",
                target: "instance-one",
              },
            ]
          )
          assert.strictEqual(here, 2)
          assert.sameMembers(
            (yield* linkedTo("relay-one", "instance-three")).map(
              (row) => row.linked_from_backup_id
            ),
            ["s3-archive", "local-archive"]
          )
        })
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
          assert.isNull(original)
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
          assert.deepInclude(last, {
            archive: { backupId: "s3-archive", targetId: "instance-one" },
            kind: "delete",
          })
          assert.strictEqual(
            last?.artifacts[0]?.objectKey,
            "kiln/s3-archive.zip"
          )
        })
    )

    it.effect("links each archive to a copy only once", () =>
      Effect.gen(function* () {
        yield* seedBackups
        const link = linkInstanceBackupsEffect({
          from: source,
          linkedBy: "user-one",
          to: { instanceId: "instance-two", relayId: "relay-two" },
        })

        yield* link
        // As a migration resumed after linking, before it noted so, does.
        const again = yield* link

        assert.strictEqual(again, 0)
        assert.lengthOf(yield* linkedTo("relay-two", "instance-two"), 1)
      })
    )

    it.effect(
      "deletes a stored copy of an archive once no backup sharing it keeps that copy",
      () =>
        Effect.gen(function* () {
          yield* seedBackups
          // The S3 archive is also kept on the Relay; only S3 follows a copy
          // to another Relay.
          yield* insertArtifact("s3-archive-local", "s3-archive", {
            bytes: 10,
            checksum_sha256: "a".repeat(64),
          })
          yield* linkInstanceBackupsEffect({
            from: source,
            linkedBy: "user-one",
            to: { instanceId: "instance-two", relayId: "relay-two" },
          })
          const [linked] = yield* linkedTo("relay-two", "instance-two")

          const original = yield* reserveBackupDeleteEffect({
            backupId: "s3-archive",
            requestedBy: "user-one",
            taskId: "delete-original",
          })

          // Its Relay's copy goes; the S3 one the copy shares stays.
          assert.deepStrictEqual(
            original?.artifacts.map((artifact) => artifact.artifactId),
            ["s3-archive-local"]
          )
          assert.strictEqual(
            (yield* artifacts).get("s3-artifact")?.status,
            "deleted"
          )
          const last = yield* reserveBackupDeleteEffect({
            backupId: linked!.id,
            requestedBy: "user-one",
            taskId: "delete-linked",
          })
          assert.deepStrictEqual(
            last?.artifacts.map((artifact) => artifact.objectKey),
            ["kiln/s3-archive.zip"]
          )
        })
    )

    it.effect("restores a linked backup from the archive it shares", () =>
      Effect.gen(function* () {
        yield* seedBackups
        yield* linkInstanceBackupsEffect({
          from: source,
          linkedBy: "user-one",
          to: { instanceId: "instance-two", relayId: "relay-two" },
        })
        const [linked] = yield* linkedTo("relay-two", "instance-two")

        const restore = yield* reserveBackupRestoreEffect({
          backupId: linked!.id,
          dependsOnTaskId: null,
          requestedBy: "user-one",
          taskId: "restore-linked",
        })

        assert.deepInclude(restore, {
          archive: { backupId: "s3-archive", targetId: "instance-one" },
          backupId: linked!.id,
          objectKey: "kiln/s3-archive.zip",
          target: { id: "instance-two", kind: "instance" },
        })
      })
    )
  })
})
