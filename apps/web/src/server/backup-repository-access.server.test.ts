import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import {
  backupFailureCodeFromMessage,
  backupRepositoryAccessRequestSchema,
  type BackupRepositoryAccessRequest,
} from "@workspace/contracts"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import { backupRepositoryAccessEffect } from "@/server/backup-repository-access.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
} from "@/test/seed"

const secrets = `1:${"x".repeat(32)}`
const storageId = "a1b2c3d4e5f6"
const bucketRepository = "66666666-6666-4666-8666-666666666666"
const diskRepository = "77777777-7777-4777-8777-777777777777"
const prefix = `team/kiln/kiln.dev/relay-one/restic/instance/server-one/${bucketRepository}`
const pack = "ab".repeat(32)

const encrypt = (plaintext: string, purpose: string) =>
  encryptWithKeyring(plaintext, parseSecretKeyring(secrets), purpose)

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertBackupStorage(storageId, {
    access_key_id_ciphertext: encrypt(
      "AKIAEXAMPLE",
      `kiln-backup-storage:${storageId}:access-key-id`
    ),
    force_path_style: true,
    secret_access_key_ciphertext: encrypt(
      "kiln-test-secret-access-key",
      `kiln-backup-storage:${storageId}:secret-access-key`
    ),
  })
  for (const [id, storage, object_prefix] of [
    [bucketRepository, storageId, prefix],
    [diskRepository, null, null],
  ] as const) {
    yield* insertRows("backup_repository", {
      created_at: Date.UTC(2026, 0, 1),
      id,
      object_prefix,
      password_ciphertext: "unused",
      relay_id: "relay-one",
      storage_id: storage,
      storage_key: storage ?? "local",
      target_id: "server-one",
      target_kind: "instance",
    })
  }
})

const read: BackupRepositoryAccessRequest = {
  file: `data/${pack}`,
  method: "GET",
  repositoryId: bucketRepository,
}

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", secrets)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describeMysql("backup repository access", () => {
  layer(TestDatabase)((it) => {
    it.effect("signs one request to one file, where restic keeps it", () =>
      Effect.gen(function* () {
        yield* seed
        const paths: Array<string> = []
        for (const request of [
          read,
          { ...read, method: "PUT" as const },
          { ...read, file: "config" },
          { ...read, file: `locks/${pack}`, method: "DELETE" as const },
        ]) {
          const reply = yield* backupRepositoryAccessEffect(
            "relay-one",
            request
          )
          if (reply.status !== "signed") return assert.fail(reply.status)
          const url = new URL(reply.url)
          assert.strictEqual(url.searchParams.get("X-Amz-Expires"), "600")
          assert.notInclude(reply.url, "kiln-test-secret-access-key")
          paths.push(url.pathname)
        }
        assert.deepStrictEqual(paths, [
          `/kiln-backups/${prefix}/data/ab/${pack}`,
          `/kiln-backups/${prefix}/data/ab/${pack}`,
          `/kiln-backups/${prefix}/config`,
          `/kiln-backups/${prefix}/locks/${pack}`,
        ])
      })
    )

    it.effect(
      "refuses another Relay's repository, and one not in a bucket",
      () =>
        Effect.gen(function* () {
          yield* seed
          const list = {
            folder: "snapshots",
            method: "LIST",
            repositoryId: bucketRepository,
          } as const
          for (const [relayId, request] of [
            ["relay-two", read],
            ["relay-two", list],
            ["relay-one", { ...read, repositoryId: diskRepository }],
            ["relay-one", { ...read, repositoryId: storageId }],
          ] as const) {
            const reply = yield* backupRepositoryAccessEffect(relayId, request)
            assert.strictEqual(reply.status, "refused")
          }
        })
    )

    it.effect(
      "lets a Relay a backup is linked to read its repository, and write once no other can",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertRelay("relay-one")
          yield* insertBackup("linked", {
            artifact_kind: "restic_snapshot",
            backup_mode: "incremental",
            linked_from_backup_id: "original",
            linked_from_target_id: "server-one",
            relay_id: "relay-two",
            repository_id: bucketRepository,
            status: "available",
            storage_id: storageId,
            target_id: "server-two",
          })
          const write = { ...read, method: "PUT" as const }
          const status = (relayId: string, request: typeof read) =>
            backupRepositoryAccessEffect(relayId, request).pipe(
              Effect.map((reply) => reply.status)
            )

          assert.strictEqual(yield* status("relay-two", read), "signed")
          assert.strictEqual(yield* status("relay-three", read), "refused")
          const refused = yield* backupRepositoryAccessEffect(
            "relay-two",
            write
          )
          assert.strictEqual(refused.status, "refused")
          assert.strictEqual(
            refused.status === "refused"
              ? backupFailureCodeFromMessage(refused.reason)
              : null,
            // restic then reads the repository without its lock.
            "storage_access_denied"
          )

          const database = yield* Database
          yield* database.execute(
            "test_relay_removed",
            `DELETE FROM ${databaseTable("relay")} WHERE id = ?`,
            ["relay-one"]
          )
          assert.strictEqual(yield* status("relay-two", write), "signed")
          assert.strictEqual(yield* status("relay-three", write), "refused")
        })
    )

    it.effect("refuses a destination being deleted", () =>
      Effect.gen(function* () {
        yield* seed
        const database = yield* Database
        yield* database.execute(
          "test_deleting",
          `UPDATE ${databaseTable("backup_storage")} SET deleting = TRUE
            WHERE id = ?`,
          [storageId]
        )
        const reply = yield* backupRepositoryAccessEffect("relay-one", read)
        assert.strictEqual(reply.status, "refused")
      })
    )

    it("takes no request for anything but a repository's files", () => {
      for (const request of [
        { ...read, file: "../other/config" },
        { ...read, file: `data/ab/${pack}` },
        { ...read, method: "LIST" },
        { ...read, repositoryPrefix: "team" },
        { folder: "..", method: "LIST", repositoryId: bucketRepository },
      ]) {
        assert.isFalse(
          backupRepositoryAccessRequestSchema.safeParse(request).success
        )
      }
    })
  })
})
