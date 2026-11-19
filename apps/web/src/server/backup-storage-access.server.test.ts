import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { encryptWithKeyring, parseSecretKeyring } from "../../keyring.mjs"
import {
  relayBackupTaskSchema,
  type BackupStorageAccessRequest,
} from "@workspace/contracts"

import {
  reconcileBackupTaskEffect,
  settleBackupCopyEffect,
} from "@/effect/backups"

import { grantBackupStorageAccessEffect } from "@/server/backup-storage-access.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

const secrets = `1:${"x".repeat(32)}`
const relayId = "a".repeat(12)
const otherRelayId = "b".repeat(12)
const backupId = "11111111-1111-4111-8111-111111111111"
const storageId = "d".repeat(12)
const artifactId = "33333333-3333-4333-8333-333333333333"
const objectKey = `team/kiln/install/${relayId}/instance/instance-one/${backupId}/backup.zip`
const seededAt = Date.UTC(2026, 0, 1)

const encrypt = (plaintext: string, purpose: string) =>
  encryptWithKeyring(plaintext, parseSecretKeyring(secrets), purpose)

// A backup with one copy in a bucket, and the tasks under way for it.
const seed = (
  options: {
    artifact?: string
    backup?: string
    storage?: { deleting?: boolean; enabled?: boolean }
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
      object_key: objectKey,
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
        case: "the copy's backup was deleted",
        seeded: { backup: "deleted" },
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
        seeded: { ...stored, tasks: [{ kind: "restore", status: "succeeded" }] },
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

    // A delete that fails leaves the backup as it was, its copy still to
    // come. A refusal would have the Relay give the archive up for good.
    it.effect(
      "has the Relay ask again for an upload while the copy's backup is being deleted",
      () =>
        Effect.gen(function* () {
          yield* seed({ backup: "deleting" })

          assert.strictEqual((yield* ask("upload")).status, "later")
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

    // A backup's task ends once its archive is taken. A copy for a bucket
    // is sent afterwards, and Hearth is told how that went: until then the
    // backup isn't one to restore from, count, or delete a server over.
    const taken = (status: "available" | "failed" | "pending") =>
      relayBackupTaskSchema.parse({
        backupId,
        bytesCompleted: 12,
        bytesTotal: 12,
        createdAt: seededAt,
        error: null,
        finishedAt: seededAt + 1,
        input: {
          artifactKind: "archive",
          backupId,
          destination: { artifactId, kind: "s3" },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "manual",
          target: { id: "instance-one", kind: "instance" },
          taskId: "44444444-4444-4444-8444-444444444440",
        },
        inputRefreshRequired: false,
        kind: "create",
        result: {
          artifacts: [{ artifactId, error: null, status }],
          bytes: 12,
          checksumSha256: "a".repeat(64),
          filename: "backup.zip",
          warnings: [],
        },
        startedAt: seededAt,
        status: "succeeded",
        taskId: "44444444-4444-4444-8444-444444444440",
        updatedAt: seededAt + 1,
      })
    const creating = { tasks: [{ kind: "create", status: "running" }] }
    const recorded = Effect.gen(function* () {
      const [backup] = yield* selectRows<{ status: string }>("backup")
      const [copy] = yield* selectRows<{
        bytes: number | string | null
        checksum_sha256: string | null
        error: string | null
        status: string
      }>("backup_artifact")
      return { backup: backup?.status, copy }
    })
    const settle = (
      status: "available" | "failed",
      from = relayId,
      error: string | null = null
    ) =>
      settleBackupCopyEffect(from, {
        artifactId,
        error,
        errorCode: null,
        status,
      })

    it.effect(
      "keeps a backup under way while its only copy waits to be sent, and stores it when the Relay says so",
      () =>
        Effect.gen(function* () {
          yield* seed(creating)
          yield* reconcileBackupTaskEffect(taken("pending"), relayId)
          const waiting = yield* recorded

          const stranger = yield* settle("available", otherRelayId)
          const told = yield* settle("available")
          // Told again, as when its first answer was lost.
          const again = yield* settle("failed", relayId, "too late to matter")
          const stored = yield* recorded

          assert.deepInclude(waiting, { backup: "running" })
          assert.strictEqual(waiting.copy?.status, "running")
          assert.strictEqual(stranger.status, "unknown")
          assert.strictEqual(told.status, "recorded")
          assert.strictEqual(again.status, "recorded")
          assert.strictEqual(stored.backup, "available")
          assert.deepInclude(stored.copy, {
            checksum_sha256: "a".repeat(64),
            error: null,
            status: "available",
          })
          assert.strictEqual(Number(stored.copy?.bytes), 12)
        })
    )

    it.effect(
      "fails a backup whose only copy couldn't be sent, with why",
      () =>
        Effect.gen(function* () {
          yield* seed(creating)
          yield* reconcileBackupTaskEffect(taken("pending"), relayId)

          yield* settle("failed", relayId, "the bucket refused it")

          const failed = yield* recorded
          assert.strictEqual(failed.backup, "failed")
          assert.deepInclude(failed.copy, {
            error: "the bucket refused it",
            status: "failed",
          })
        })
    )

    // The Relay can send a copy before Hearth has read that its task ended.
    it.effect(
      "keeps a copy stored when the task's end, read later, still calls it waiting",
      () =>
        Effect.gen(function* () {
          yield* seed(creating)

          yield* settle("available")
          // Its size and checksum come with the task's end, and without
          // them it can't be restored: it isn't one to restore from yet.
          const early = yield* recorded
          yield* reconcileBackupTaskEffect(taken("pending"), relayId)

          const stored = yield* recorded
          assert.notStrictEqual(early.backup, "available")
          assert.strictEqual(stored.backup, "available")
          assert.deepInclude(stored.copy, {
            checksum_sha256: "a".repeat(64),
            status: "available",
          })
        })
    )

    // A backup with two copies for buckets, before Hearth has read how its
    // task ended: one copy stored, then the other reported failed. The
    // backup can't be restored yet, whichever outcome came last.
    it.effect(
      "doesn't call a backup available on one copy's account when another fails before the task's end is read",
      () =>
        Effect.gen(function* () {
          yield* seed(creating)
          yield* insertRows("backup_artifact", {
            id: "33333333-3333-4333-8333-33333333333b",
            backup_id: backupId,
            // Another destination's copy, already reported stored.
            destination_key: "e".repeat(12),
            storage_id: null,
            status: "available",
            object_key: `${objectKey}.other`,
            created_at: seededAt,
            updated_at: seededAt,
          })

          yield* settle("failed", relayId, "the bucket refused it")

          const [backup] = yield* selectRows<{ status: string }>("backup")
          assert.notStrictEqual(backup?.status, "available")
        })
    )

    it.effect(
      "doesn't bring back a backup being deleted when its copy turns out stored",
      () =>
        Effect.gen(function* () {
          yield* seed({ artifact: "running", backup: "deleting" })

          yield* settle("available")

          assert.strictEqual((yield* recorded).backup, "deleting")
        })
    )
  })
})
