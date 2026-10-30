import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import {
  deleteBackupStorageEffect,
  saveBackupStorageEffect,
} from "@/backups/destinations/s3"
import { BackupStorageError } from "@/effect/errors"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, insertRows, selectRows } from "@/test/seed"

import { deleteS3BackupPrefix } from "./client"

// S3 itself is the boundary: prefix purges are recorded instead of sent.
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>()
  return { ...actual, deleteS3BackupPrefix: vi.fn(() => Effect.void) }
})

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const now = Date.UTC(2026, 0, 1)
const storageId = "11111111-1111-4111-8111-111111111111"
const repositoryPrefix =
  "team/kiln/kiln.dev/relay-one/restic/instance/instance-one/repo-one"

interface StorageRow {
  deleting: number
  last_error: string | null
}

const purge = vi.mocked(deleteS3BackupPrefix)

// A destination saved through production code, so its credentials are
// really encrypted.
const seedStorage = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
  purge.mockClear()
  purge.mockImplementation(() => Effect.void)
  yield* saveBackupStorageEffect({
    accessKeyId: "AKIAEXAMPLE",
    allowPrivateNetwork: true,
    bucket: "kiln-backups",
    enabled: true,
    endpoint: "https://s3.example.com",
    forcePathStyle: true,
    id: storageId,
    name: "minio",
    objectPrefix: "team",
    ownerUserId: null,
    region: "us-east-1",
    secretAccessKey: "s3-secret",
  })
})

const insertRepository = (id: string, row: Record<string, string> = {}) =>
  insertRows("backup_repository", {
    id,
    relay_id: "relay-one",
    target_kind: "instance",
    target_id: "instance-one",
    storage_id: storageId,
    storage_key: storageId,
    object_prefix: repositoryPrefix,
    password_ciphertext: "repository-password",
    created_at: now,
    ...row,
  })

const storageRow = Effect.map(
  selectRows<StorageRow>("backup_storage"),
  (rows) => rows[0]
)

function assertStorageError(
  failure: unknown,
  code: BackupStorageError["code"]
) {
  assert.instanceOf(failure, BackupStorageError)
  assert.strictEqual((failure as BackupStorageError).code, code)
}

describeMysql("backup storage deletion", () => {
  layer(TestDatabase)((it) => {
    it.effect("refuses destinations that still hold cataloged backups", () =>
      Effect.gen(function* () {
        yield* seedStorage
        yield* insertBackup("backup-one", { storage_id: storageId })

        const failure = yield* Effect.flip(deleteBackupStorageEffect(storageId))

        assertStorageError(failure, "storage_in_use")
        assert.strictEqual((yield* storageRow)?.deleting, 0)
        assert.strictEqual(purge.mock.calls.length, 0)
      })
    )

    it.effect("refuses destinations that still hold replica artifacts", () =>
      Effect.gen(function* () {
        yield* seedStorage
        yield* insertBackup("local-backup")
        yield* insertRows("backup_artifact", {
          id: "artifact-one",
          backup_id: "local-backup",
          destination_key: storageId,
          storage_id: storageId,
          status: "available",
          created_at: now,
          updated_at: now,
        })

        const failure = yield* Effect.flip(deleteBackupStorageEffect(storageId))

        assertStorageError(failure, "storage_in_use")
        assert.strictEqual((yield* storageRow)?.deleting, 0)
        assert.strictEqual(purge.mock.calls.length, 0)
      })
    )

    it.effect(
      "refuses destinations used by an active final server deletion",
      () =>
        Effect.gen(function* () {
          yield* seedStorage
          yield* insertRepository("repo-one")
          yield* insertBackup("final-backup")
          yield* insertRelay("relay-one")
          yield* insertRows("resource_deletion", {
            id: "00000000-0000-4000-8000-0000000000de",
            relay_id: "relay-one",
            resource_kind: "instance",
            resource_id: "instance-one",
            final_backup: true,
            backup_id: "final-backup",
            status: "deleting",
            requested_by: "user-one",
            actor: JSON.stringify({ id: "user-one" }),
            created_at: now,
            updated_at: now,
          })

          const failure = yield* Effect.flip(
            deleteBackupStorageEffect(storageId)
          )

          assertStorageError(failure, "storage_in_use")
          assert.strictEqual((yield* storageRow)?.deleting, 0)
          assert.lengthOf(yield* selectRows("backup_repository"), 1)
          assert.strictEqual(purge.mock.calls.length, 0)
        })
    )
  })
})
