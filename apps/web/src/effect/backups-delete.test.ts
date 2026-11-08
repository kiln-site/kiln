import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { relayBackupTaskSchema } from "@workspace/contracts"

import {
  listDispatchableBackupTasksEffect,
  reconcileBackupTaskEffect,
  reserveBackupDeleteEffect,
  reserveInstanceBackupEffect,
  settleUndispatchableBackupTaskEffect,
} from "@/effect/backups"
import { BackupStorageError } from "@/effect/errors"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRows, selectRows } from "@/test/seed"

const now = Date.UTC(2026, 10, 1)
const relayId = "relay-one"
const backupId = "11111111-1111-4111-8111-111111111111"
const artifactId = "11111111-1111-4111-8111-1111111111a1"
const createTaskId = "11111111-1111-4111-8111-1111111111c1"
const deleteTaskId = "11111111-1111-4111-8111-1111111111d1"

const fresh = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
})

const task = (id: string, row: Record<string, unknown>) =>
  insertRows("backup_task", {
    id,
    backup_id: backupId,
    created_at: now,
    updated_at: now,
    ...row,
  })

const artifact = (row: Record<string, unknown>) =>
  insertRows("backup_artifact", {
    id: artifactId,
    backup_id: backupId,
    destination_key: "local",
    created_at: now,
    updated_at: now,
    ...row,
  })

const state = Effect.gen(function* () {
  const [backup] = (yield* selectRows<{ id: string; status: string }>(
    "backup"
  )).filter((row) => row.id === backupId)
  const artifacts = (yield* selectRows<{ backup_id: string; status: string }>(
    "backup_artifact"
  )).filter((row) => row.backup_id === backupId)
  const tasks = (yield* selectRows<{
    backup_id: string
    depends_on_task_id: string | null
    id: string
    status: string
    task_kind: string
  }>("backup_task")).filter((row) => row.backup_id === backupId)
  return {
    artifacts: artifacts.map((row) => row.status),
    backup: backup?.status,
    tasks: Object.fromEntries(tasks.map((row) => [row.id, row])),
  }
})

// An incremental backup of a game server an older release deleted: its
// repository went with the server, then a person asked to delete the
// record, and the delete could never be sent.
const seedOrphan = Effect.gen(function* () {
  yield* insertBackup(backupId, {
    artifact_kind: "restic_snapshot",
    backup_mode: "incremental",
    reason: "scheduled",
    relay_id: relayId,
    repository_id: null,
    status: "deleting",
  })
  yield* artifact({ status: "failed" })
  yield* task(createTaskId, { status: "failed", task_kind: "create" })
  yield* task(deleteTaskId, { status: "queued", task_kind: "delete" })
})

describeMysql("deleting backups whatever their state", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "removes a record Hearth can no longer read, finishing the delete it had queued",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* seedOrphan

          const reservation = yield* reserveBackupDeleteEffect({
            backupId,
            requestedBy: "user-one",
            taskId: "11111111-1111-4111-8111-1111111111d2",
          })

          assert.deepStrictEqual(reservation, { kind: "removed" })
          const after = yield* state
          assert.strictEqual(after.backup, "deleted")
          assert.deepStrictEqual(after.artifacts, ["deleted"])
          assert.strictEqual(after.tasks[deleteTaskId]?.status, "succeeded")
          assert.strictEqual(Object.keys(after.tasks).length, 2)
        })
    )

    it.effect(
      "settles a queued delete Hearth can't send for that record without anyone asking again",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* seedOrphan

          const outcome = yield* settleUndispatchableBackupTaskEffect({
            code: "repository_missing",
            reason: "Hearth no longer has this backup's restic repository",
            taskId: deleteTaskId,
          })

          assert.strictEqual(outcome, "removed")
          const after = yield* state
          assert.strictEqual(after.backup, "deleted")
          assert.strictEqual(after.tasks[deleteTaskId]?.status, "succeeded")
        })
    )

    it.effect(
      "deletes a backup still being made only after its create ends",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackup(backupId, { relay_id: relayId, status: "running" })
          yield* artifact({ status: "running" })
          yield* task(createTaskId, { status: "running", task_kind: "create" })

          const reservation = yield* reserveBackupDeleteEffect({
            backupId,
            requestedBy: "user-one",
            taskId: deleteTaskId,
          })

          assert.deepStrictEqual(reservation, {
            createTaskId,
            kind: "waiting",
          })
          assert.strictEqual((yield* state).backup, "deleting")
          assert.strictEqual(
            (yield* state).tasks[deleteTaskId]?.depends_on_task_id,
            createTaskId
          )
          // Not sent while the create may still write what it deletes.
          const waiting = yield* listDispatchableBackupTasksEffect(relayId)
          assert.isFalse(waiting.some((entry) => entry.taskId === deleteTaskId))

          // Cancelled on its Relay: the delete goes, and a second request
          // to delete it sends the same task rather than another.
          yield* reconcileBackupTaskEffect(
            relayBackupTaskSchema.parse({
              backupId,
              bytesCompleted: 0,
              bytesTotal: null,
              createdAt: now,
              error: "Cancelled by user",
              finishedAt: now + 1,
              input: {
                artifactKind: "archive",
                backupId,
                destination: { kind: "local" },
                exclude: [],
                kind: "create",
                maxBytes: null,
                mode: "full",
                reason: "manual",
                target: { id: "instance-one", kind: "instance" },
                taskId: createTaskId,
              },
              inputRefreshRequired: false,
              kind: "create",
              result: null,
              startedAt: now,
              status: "cancelled",
              taskId: createTaskId,
              updatedAt: now + 1,
            }),
            relayId
          )
          const ready = yield* listDispatchableBackupTasksEffect(relayId)
          assert.isTrue(ready.some((entry) => entry.taskId === deleteTaskId))
          const again = yield* reserveBackupDeleteEffect({
            backupId,
            requestedBy: "user-one",
            taskId: "11111111-1111-4111-8111-1111111111d3",
          })
          assert.strictEqual(again.kind, "dispatch")
          assert.strictEqual(
            again.kind === "dispatch" ? again.dispatch.taskId : null,
            deleteTaskId
          )
        })
    )

    it.effect(
      "keeps what a create finished meanwhile, so a delete that fails leaves a valid backup",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackup(backupId, { relay_id: relayId, status: "running" })
          yield* artifact({ status: "running" })
          yield* task(createTaskId, { status: "running", task_kind: "create" })
          yield* reserveBackupDeleteEffect({
            backupId,
            requestedBy: "user-one",
            taskId: deleteTaskId,
          })
          const target = { id: "instance-one", kind: "instance" as const }

          // The create finished before the cancel reached it.
          yield* reconcileBackupTaskEffect(
            relayBackupTaskSchema.parse({
              backupId,
              bytesCompleted: 2048,
              bytesTotal: 2048,
              createdAt: now,
              error: null,
              finishedAt: now + 1,
              input: {
                artifactKind: "archive",
                backupId,
                destination: { artifactId, kind: "local" },
                exclude: [],
                kind: "create",
                maxBytes: null,
                mode: "full",
                reason: "manual",
                target,
                taskId: createTaskId,
              },
              inputRefreshRequired: false,
              kind: "create",
              result: {
                artifacts: [{ artifactId, error: null, status: "available" }],
                bytes: 2048,
                checksumSha256: "a".repeat(64),
                filename: `${backupId}.zip`,
                warnings: [],
              },
              startedAt: now,
              status: "succeeded",
              taskId: createTaskId,
              updatedAt: now + 1,
            }),
            relayId
          )
          assert.strictEqual((yield* state).backup, "deleting")
          assert.deepStrictEqual((yield* state).artifacts, ["available"])

          // Its delete then fails: the backup is whole again.
          yield* reconcileBackupTaskEffect(
            relayBackupTaskSchema.parse({
              backupId,
              bytesCompleted: 0,
              bytesTotal: null,
              createdAt: now + 2,
              error: "The Relay's disk is read-only",
              finishedAt: now + 3,
              input: {
                backupId,
                destination: { artifactId, kind: "local" },
                kind: "delete",
                target,
                taskId: deleteTaskId,
              },
              inputRefreshRequired: false,
              kind: "delete",
              result: null,
              startedAt: now + 2,
              status: "failed",
              taskId: deleteTaskId,
              updatedAt: now + 3,
            }),
            relayId
          )
          const after = yield* state
          assert.strictEqual(after.backup, "available")
          assert.deepStrictEqual(after.artifacts, ["available"])
          const [record] = (yield* selectRows<{
            checksum_sha256: string | null
            id: string
          }>("backup")).filter((row) => row.id === backupId)
          assert.strictEqual(record?.checksum_sha256, "a".repeat(64))
        })
    )

    it.effect(
      "keeps a failed backup failed when deleting it doesn't finish",
      () =>
        Effect.gen(function* () {
          yield* fresh
          yield* insertBackup(backupId, { relay_id: relayId, status: "failed" })
          yield* artifact({ status: "failed" })
          yield* task(createTaskId, { status: "failed", task_kind: "create" })

          const reservation = yield* reserveBackupDeleteEffect({
            backupId,
            requestedBy: "user-one",
            taskId: deleteTaskId,
          })
          assert.strictEqual(reservation.kind, "dispatch")
          yield* reconcileBackupTaskEffect(
            relayBackupTaskSchema.parse({
              backupId,
              bytesCompleted: 0,
              bytesTotal: null,
              createdAt: now,
              error: "The Relay could not reach the destination",
              finishedAt: now + 1,
              input: {
                backupId,
                destination: { artifactId, kind: "local" },
                kind: "delete",
                target: { id: "instance-one", kind: "instance" },
                taskId: deleteTaskId,
              },
              inputRefreshRequired: false,
              kind: "delete",
              result: null,
              startedAt: now,
              status: "failed",
              taskId: deleteTaskId,
              updatedAt: now + 1,
            }),
            relayId
          )

          const after = yield* state
          assert.strictEqual(after.backup, "failed")
          assert.deepStrictEqual(after.artifacts, ["failed"])
        })
    )

    it.effect(
      "won't finally delete a resource a restore is going into, whichever backup it restores",
      () =>
        Effect.gen(function* () {
          yield* fresh
          // A's backup, queued to restore into B.
          yield* insertBackup(backupId, {
            relay_id: relayId,
            target_id: "instance-a",
          })
          yield* artifact({ status: "available" })
          yield* task(createTaskId, { status: "succeeded", task_kind: "create" })
          yield* task("11111111-1111-4111-8111-1111111111e1", {
            status: "queued",
            target_id: "instance-b",
            target_kind: "instance",
            task_kind: "restore",
          })
          const finalBackupOf = (targetId: string) =>
            reserveInstanceBackupEffect({
              backupId: crypto.randomUUID(),
              createdBy: "user-one",
              name: "final",
              reason: "final_delete",
              relayId,
              requestedMaxBytes: null,
              storageIds: [null],
              targetId,
              taskId: crypto.randomUUID(),
            }).pipe(Effect.flip)

          const intoB = yield* finalBackupOf("instance-b")
          assert.instanceOf(intoB, BackupStorageError)
          assert.strictEqual(intoB.code, "restore_in_progress")
          // A, which the restore only reads from, isn't held by it; with no
          // deletion waiting, its reservation stops later for that.
          const fromA = yield* finalBackupOf("instance-a")
          assert.instanceOf(fromA, BackupStorageError)
          assert.strictEqual(fromA.code, "reservation_failed")
        })
    )
  })
})
