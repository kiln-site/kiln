import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import {
  deleteBackupStorageEffect,
  saveBackupStorageEffect,
  setBackupPolicyStorageEffect,
} from "@/backups/destinations/s3"
import { BackupStorageError, CredentialError } from "@/effect/errors"
import { databaseTableName } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRows, selectRows } from "@/test/seed"

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

const insertPolicy = (targetId: string, storage: string | null) =>
  insertRows("backup_policy", {
    relay_id: "relay-one",
    target_kind: "instance",
    target_id: targetId,
    storage_id: storage,
    exclude_patterns: "[]",
    created_at: now,
    updated_at: now,
  })

const storageRow = Effect.map(
  selectRows<StorageRow>("backup_storage"),
  (rows) => rows[0]
)

const policyStorage = Effect.map(
  selectRows<{ storage_id: string | null }>("backup_policy"),
  (rows) => rows.map((row) => row.storage_id)
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
          yield* insertRows("backup_final_delete", {
            relay_id: "relay-one",
            target_id: "instance-one",
            backup_id: "final-backup",
            requested_by: "user-one",
            status: "deleting",
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

    it.effect(
      "does not start deleting when credentials cannot be decrypted",
      () =>
        Effect.gen(function* () {
          yield* seedStorage
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE ${sql(databaseTableName("backup_storage"))}
          SET access_key_id_ciphertext = ${"not-a-ciphertext"}`

          const failure = yield* Effect.flip(
            deleteBackupStorageEffect(storageId)
          )

          assert.instanceOf(failure, CredentialError)
          assert.strictEqual((yield* storageRow)?.deleting, 0)
          assert.strictEqual(purge.mock.calls.length, 0)
        })
    )

    it.effect(
      "keeps the destination marked deleting after a purge failure",
      () =>
        Effect.gen(function* () {
          yield* seedStorage
          yield* insertRepository("repo-one")
          yield* insertPolicy("instance-one", storageId)
          purge.mockReturnValueOnce(
            Effect.fail(
              BackupStorageError.make({
                code: "s3_request_failed",
                operation: "storage.deletePrefix",
                reason: "The S3-compatible storage request failed",
              })
            )
          )

          const failure = yield* Effect.flip(
            deleteBackupStorageEffect(storageId)
          )

          assertStorageError(failure, "s3_request_failed")
          const storage = yield* storageRow
          assert.strictEqual(storage?.deleting, 1)
          assert.isNotNull(storage?.last_error)
          assert.lengthOf(yield* selectRows("backup_repository"), 1)
          assert.deepStrictEqual(yield* policyStorage, [null])
        })
    )

    it.effect("purges restic prefixes, then removes the destination", () =>
      Effect.gen(function* () {
        yield* seedStorage
        yield* insertRepository("repo-one")
        yield* insertPolicy("instance-one", storageId)
        yield* insertBackup("deleted-backup", {
          repository_id: "repo-one",
          status: "deleted",
          storage_id: storageId,
        })

        yield* deleteBackupStorageEffect(storageId)

        assert.deepStrictEqual(
          purge.mock.calls.map(([credential, prefix]) => [
            credential.accessKeyId,
            credential.secretAccessKey,
            credential.bucket,
            prefix,
          ]),
          [["AKIAEXAMPLE", "s3-secret", "kiln-backups", repositoryPrefix]]
        )
        assert.lengthOf(yield* selectRows("backup_storage"), 0)
        assert.lengthOf(yield* selectRows("backup_repository"), 0)
        assert.deepStrictEqual(yield* policyStorage, [null])
        const backups = yield* selectRows<{
          repository_id: string | null
          storage_id: string | null
        }>("backup")
        assert.deepStrictEqual(
          backups.map((row) => [row.repository_id, row.storage_id]),
          [[null, null]]
        )
      })
    )
  })
})

describeMysql("backup storage policy", () => {
  layer(TestDatabase)((it) => {
    it.effect("assigns an available destination", () =>
      Effect.gen(function* () {
        yield* seedStorage

        yield* setBackupPolicyStorageEffect({
          relayId: "relay-one",
          storageId,
          targetId: "instance-one",
          targetKind: "instance",
        })

        assert.deepStrictEqual(yield* policyStorage, [storageId])
      })
    )

    it.effect("rejects a destination that is being deleted", () =>
      Effect.gen(function* () {
        yield* seedStorage
        yield* insertPolicy("instance-one", null)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE ${sql(databaseTableName("backup_storage"))}
          SET deleting = TRUE`

        const failure = yield* Effect.flip(
          setBackupPolicyStorageEffect({
            relayId: "relay-one",
            storageId,
            targetId: "instance-one",
            targetKind: "instance",
          })
        )

        assertStorageError(failure, "storage_unavailable")
        assert.deepStrictEqual(yield* policyStorage, [null])
      })
    )
  })
})
