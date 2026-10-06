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
  clampBackupExportTtlMs,
  effectiveBackupLimit,
  getBackupPolicyEffect,
  purgeInstanceBackupRepositoriesEffect,
  reserveBackupCopyEffect,
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
  it("uses the stricter user or platform limit", () => {
    expect(effectiveBackupLimit(null, null)).toBeNull()
    expect(effectiveBackupLimit(10, null)).toBe(10)
    expect(effectiveBackupLimit(null, 8)).toBe(8)
    expect(effectiveBackupLimit(10, 8)).toBe(8)
  })

  it("clamps incremental export TTLs to the signed-URL bounds", () => {
    expect(clampBackupExportTtlMs(1_000)).toBe(60_000)
    expect(clampBackupExportTtlMs(15 * 60_000)).toBe(15 * 60_000)
    expect(clampBackupExportTtlMs(30 * 24 * 60 * 60 * 1_000)).toBe(
      7 * 24 * 60 * 60 * 1_000
    )
  })

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

  it("reserves remaining bytes and rejects exhausted limits", () => {
    expect(
      backupReservation({
        quantityLimit: 5,
        quantityUsed: 2,
        requestedMaxBytes: 800,
        sizeLimit: 1_000,
        sizeUsed: 400,
      })
    ).toEqual({ maxBytes: 600 })
    expect(() =>
      backupReservation({
        quantityLimit: 2,
        quantityUsed: 2,
        requestedMaxBytes: null,
        sizeLimit: null,
        sizeUsed: 0,
      })
    ).toThrow(BackupLimitError)
    expect(() =>
      backupReservation({
        quantityLimit: null,
        quantityUsed: 0,
        requestedMaxBytes: null,
        sizeLimit: 1_000,
        sizeUsed: 1_000,
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

describeMysql("backup reservations", () => {
  layer(TestDatabase)((it) => {
    it.effect("counts deleting and in-flight backups toward size limits", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* insertPolicy({ quantity_limit: 5, size_limit_bytes: 2_048 })
        yield* insertBackup("deleting", { status: "deleting", bytes: 1_024 })
        yield* insertBackup("failed", { status: "failed", bytes: 5_000 })
        yield* insertBackup("deleted", { status: "deleted", bytes: 5_000 })

        const first = yield* reserve({ backupId: "first" })
        // The queued backup's reservation now fills the rest of the limit.
        const second = yield* Effect.flip(reserve({ backupId: "second" }))

        assert.strictEqual(first.maxBytes, 1_024)
        assert.instanceOf(second, BackupLimitError)
        assert.strictEqual((second as BackupLimitError).kind, "size")
        assert.isFalse((yield* backups).has("second"))
      })
    )

    it.effect(
      "bypasses user limits for final-deletion backups but keeps admin caps",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertPolicy({
            quantity_limit: 0,
            size_limit_bytes: 0,
            admin_quantity_limit: 2,
            admin_size_limit_bytes: 2_048,
          })
          yield* insertBackup("existing", { bytes: 1_024 })

          const manual = yield* Effect.flip(reserve({ backupId: "manual" }))
          const final = yield* reserve({
            backupId: "final",
            reason: "final_delete",
          })

          assert.instanceOf(manual, BackupLimitError)
          assert.strictEqual(final.maxBytes, 1_024)
          const [task] = yield* selectRows<{
            reserved_bytes: number | string
            backup_id: string
          }>("backup_task")
          assert.strictEqual(task?.backup_id, "final")
          assert.strictEqual(Number(task?.reserved_bytes), 1_024)
          const finalDeletes = yield* selectRows<{
            backup_id: string
            status: string
          }>("backup_final_delete")
          assert.deepStrictEqual(
            finalDeletes.map((row) => [row.backup_id, row.status]),
            [["final", "backing_up"]]
          )
        })
    )

    it.effect("rejects new reservations while final deletion is active", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* insertBackup("final")
        yield* insertRows("backup_final_delete", {
          relay_id: "relay-one",
          target_id: "instance-one",
          backup_id: "final",
          requested_by: "user-one",
          status: "backing_up",
          created_at: now,
          updated_at: now,
        })

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
          sizeLimitBytes: 2_048,
        })
        yield* updateBackupLimitsEffect({
          ...target,
          admin: true,
          quantityLimit: 12,
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
            adminSizeLimitBytes: 4_096,
            exclude: ["cache/**"],
            quantityLimit: 6,
            sizeLimitBytes: 2_048,
            storageId: null,
          }
        )
        assert.deepStrictEqual(
          yield* getBackupPolicyEffect("relay-one", "platform", "kiln.dev"),
          {
            adminQuantityLimit: null,
            adminSizeLimitBytes: null,
            exclude: ["logs/**"],
            quantityLimit: null,
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
