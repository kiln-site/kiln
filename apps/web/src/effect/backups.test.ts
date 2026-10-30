import { afterEach, assert, beforeEach, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import { encryptWithKeyring } from "../../keyring.mjs"
import { BackupStorageError } from "@/effect/errors"
import {
  linkInstanceBackupsEffect,
  purgeInstanceBackupRepositoriesEffect,
  reserveBackupCopyEffect,
  reserveBackupDeleteEffect,
} from "@/effect/backups"
import { deleteS3BackupPrefix } from "@/backups/destinations/s3"
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
  })
})
