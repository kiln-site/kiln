import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import type { BackupDispatch } from "@/effect/backups"
import { prepareBackupTaskEffect } from "@/lib/backup-task-prepare"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertBackupStorage, insertRows } from "@/test/seed"

const secrets = `1:${"x".repeat(32)}`
const backupId = "11111111-1111-4111-8111-111111111111"
const storageId = "22222222-2222-4222-8222-222222222222"
const artifactId = "33333333-3333-4333-8333-333333333333"
const taskId = "44444444-4444-4444-8444-444444444444"
const createTaskId = "55555555-5555-4555-8555-555555555555"
const repositoryId = "66666666-6666-4666-8666-666666666666"
const storedPrefix =
  "team/kiln/kiln.dev/relay-one/restic/instance/instance-one/repo-one"

// Ciphertexts are encrypted for the purposes Hearth uses on disk, so a purpose
// change that would orphan stored credentials fails here.
const encrypt = (plaintext: string, purpose: string) =>
  encryptWithKeyring(plaintext, parseSecretKeyring(secrets), purpose)

const seedResticBackup = (options: { enabled: boolean }) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertBackupStorage(storageId, {
      access_key_id_ciphertext: encrypt(
        "AKIAEXAMPLE",
        `kiln-backup-storage:${storageId}:access-key-id`
      ),
      allow_private_network: true,
      enabled: options.enabled,
      force_path_style: true,
      secret_access_key_ciphertext: encrypt(
        "s3-secret",
        `kiln-backup-storage:${storageId}:secret-access-key`
      ),
    })
    yield* insertRows("backup_repository", {
      id: repositoryId,
      relay_id: "relay-one",
      target_kind: "instance",
      target_id: "instance-one",
      storage_id: storageId,
      storage_key: storageId,
      object_prefix: storedPrefix,
      password_ciphertext: encrypt(
        "repo-password",
        "kiln-restic-repository-password"
      ),
      created_at: Date.UTC(2026, 0, 1),
    })
    yield* insertBackup(backupId, {
      artifact_kind: "restic_snapshot",
      repository_id: repositoryId,
      storage_id: storageId,
    })
  })

const incrementalCreate: BackupDispatch = {
  artifactKind: "restic_snapshot",
  artifacts: [{ artifactId, objectKey: null, storageId }],
  backupId,
  exclude: [],
  kind: "create",
  maxBytes: null,
  mode: "incremental",
  reason: "manual",
  target: { id: "instance-one", kind: "instance" },
  taskId,
}

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", secrets)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describeMysql("restic backup dispatch", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "sends the stored repository prefix and decrypted credentials",
      () =>
        Effect.gen(function* () {
          yield* seedResticBackup({ enabled: true })

          const prepared = yield* prepareBackupTaskEffect(incrementalCreate)

          assert.strictEqual(prepared.kind, "create")
          if (
            prepared.kind !== "create" ||
            prepared.destination.kind !== "restic"
          ) {
            return assert.fail("expected restic create dispatch")
          }
          assert.deepStrictEqual(prepared.destination.repository, {
            accessKeyId: "AKIAEXAMPLE",
            allowPrivateNetwork: true,
            bucket: "kiln-backups",
            endpoint: "https://s3.example.com",
            forcePathStyle: true,
            kind: "s3",
            region: "us-east-1",
            repositoryPrefix: storedPrefix,
            secretAccessKey: "s3-secret",
          })
          assert.strictEqual(
            prepared.destination.repositoryPassword,
            "repo-password"
          )
        })
    )

    it.effect("keeps tag-based restic deletes on the restic path", () =>
      Effect.gen(function* () {
        // A disabled destination must still accept deletes of its backups.
        yield* seedResticBackup({ enabled: false })

        const prepared = yield* prepareBackupTaskEffect({
          artifacts: [{ artifactId, objectKey: null, storageId }],
          backupId,
          createTaskId,
          kind: "delete",
          target: { id: "instance-one", kind: "instance" },
          taskId,
        })

        if (
          prepared.kind !== "delete" ||
          prepared.destination.kind !== "restic"
        ) {
          return assert.fail("expected restic delete dispatch")
        }
        assert.strictEqual(prepared.destination.createTaskId, createTaskId)
        assert.isFalse("snapshotId" in prepared.destination)
        assert.strictEqual(prepared.destination.repository.kind, "s3")
        if (prepared.destination.repository.kind === "s3") {
          assert.strictEqual(
            prepared.destination.repository.repositoryPrefix,
            storedPrefix
          )
        }
      })
    )

    it.effect(
      "refuses incremental create dispatch to a disabled destination",
      () =>
        Effect.gen(function* () {
          yield* seedResticBackup({ enabled: false })

          const error = yield* Effect.flip(
            prepareBackupTaskEffect(incrementalCreate)
          )

          assert.strictEqual(error._tag, "BackupStorageError")
          assert.strictEqual(
            "code" in error ? error.code : undefined,
            "invalid_backup_destination"
          )
        })
    )
  })
})
