import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { relayBackupTaskSchema } from "@workspace/contracts"

import { reconcileBackupTaskEffect } from "@/effect/backups"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

// What a Relay reports of its backup tasks reaches Hearth's records only
// for its own backups, as the tasks Hearth gave it: a Relay that reports
// another's task, or a task as another kind, changes nothing.

const now = Date.UTC(2026, 10, 1)
const relayOne = "a".repeat(12)
const relayTwo = "b".repeat(12)
const backupId = "11111111-1111-4111-8111-111111111111"
const artifactId = "11111111-1111-4111-8111-1111111111a1"
const createTaskId = "11111111-1111-4111-8111-1111111111c1"
const target = { id: "c".repeat(12), kind: "instance" as const }

const fresh = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
  yield* insertRelay(relayOne)
  yield* insertRelay(relayTwo)
})

// A manual backup on Relay one, still being made.
const seedRunning = Effect.gen(function* () {
  yield* insertBackup(backupId, {
    relay_id: relayOne,
    status: "running",
    target_id: target.id,
  })
  yield* insertRows("backup_artifact", {
    id: artifactId,
    backup_id: backupId,
    destination_key: "local",
    status: "running",
    created_at: now,
    updated_at: now,
  })
  yield* insertRows("backup_task", {
    id: createTaskId,
    backup_id: backupId,
    task_kind: "create",
    status: "running",
    created_at: now,
    updated_at: now,
  })
})

const finishedCreate = relayBackupTaskSchema.parse({
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
})

const backupState = Effect.gen(function* () {
  const backups = yield* selectRows<{ id: string; status: string }>("backup")
  const artifacts = yield* selectRows<{ backup_id: string; id: string }>(
    "backup_artifact"
  )
  const tasks = yield* selectRows<{
    backup_id: string
    id: string
    status: string
  }>("backup_task")
  return { artifacts, backups, tasks }
})

// A schedule's backup to a Relay's own disk, which Hearth hears of only
// from the Relay's report.
const scheduledReport = (ids: {
  artifactId: string
  backupId: string
  target?: { id: string; kind: "database" | "instance" }
  taskId: string
}) =>
  relayBackupTaskSchema.parse({
    backupId: ids.backupId,
    bytesCompleted: 0,
    bytesTotal: null,
    createdAt: now,
    error: null,
    finishedAt: null,
    input: {
      artifactKind: "archive",
      backupId: ids.backupId,
      catalog: { name: "Nightly", storageId: null },
      destination: { artifactId: ids.artifactId, kind: "local" },
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "full",
      reason: "scheduled",
      target: ids.target ?? target,
      taskId: ids.taskId,
    },
    inputRefreshRequired: false,
    kind: "create",
    result: null,
    startedAt: null,
    status: "queued",
    taskId: ids.taskId,
    updatedAt: now,
  })

describeMysql("Relay backup reports", () => {
  layer(TestDatabase)((it) => {
    it.effect("leave another Relay's backup as it was", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* seedRunning
        const before = yield* backupState

        // Relay two reports Relay one's backup finished.
        const changed = yield* reconcileBackupTaskEffect(
          finishedCreate,
          relayTwo
        )

        assert.isFalse(changed)
        assert.deepStrictEqual(yield* backupState, before)

        // From its own Relay, the same report is applied.
        assert.isTrue(
          yield* reconcileBackupTaskEffect(finishedCreate, relayOne)
        )
        const [backup] = (yield* backupState).backups
        assert.strictEqual(backup?.status, "available")
      })
    )

    it.effect("apply only as the kind of task Hearth has it as", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* seedRunning
        const before = yield* backupState

        // The backup's own Relay reports its create as a delete that
        // succeeded.
        const changed = yield* reconcileBackupTaskEffect(
          relayBackupTaskSchema.parse({
            backupId,
            bytesCompleted: 0,
            bytesTotal: null,
            createdAt: now,
            error: null,
            finishedAt: now + 1,
            input: {
              backupId,
              destination: { artifactId, kind: "local" },
              kind: "delete",
              target,
              taskId: createTaskId,
            },
            inputRefreshRequired: false,
            kind: "delete",
            result: { artifacts: [], warnings: [] },
            startedAt: now,
            status: "succeeded",
            taskId: createTaskId,
            updatedAt: now + 1,
          }),
          relayOne
        )

        assert.isFalse(changed)
        assert.deepStrictEqual(yield* backupState, before)
      })
    )

    it.effect("leave a copy Hearth is making elsewhere to the copy", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* seedRunning
        yield* reconcileBackupTaskEffect(finishedCreate, relayOne)
        // A person then copies the backup to a bucket.
        const storageId = "44444444-4444-4444-8444-444444444444"
        const copyId = "44444444-4444-4444-8444-4444444444a4"
        yield* insertBackupStorage(storageId)
        yield* insertRows("backup_artifact", {
          id: copyId,
          backup_id: backupId,
          destination_key: storageId,
          storage_id: storageId,
          status: "queued",
          created_at: now,
          updated_at: now,
        })
        yield* insertRows("backup_copy_task", {
          id: "44444444-4444-4444-8444-4444444444c4",
          backup_id: backupId,
          source_artifact_id: artifactId,
          destination_artifact_id: copyId,
          status: "queued",
          requested_by: "user-one",
          created_at: now,
          updated_at: now,
        })
        const copyStatus = Effect.map(
          selectRows<{ id: string; status: string }>("backup_artifact"),
          (rows) => rows.find(({ id }) => id === copyId)?.status
        )

        // The create's Relay reports it again, newer, naming the copy, and
        // then naming nothing.
        for (const [later, artifacts] of [
          [10, [{ artifactId: copyId, error: null, status: "available" }]],
          [20, []],
        ] as const) {
          yield* reconcileBackupTaskEffect(
            relayBackupTaskSchema.parse({
              ...finishedCreate,
              result: { ...finishedCreate.result, artifacts },
              updatedAt: now + later,
            }),
            relayOne
          )
          assert.strictEqual(yield* copyStatus, "queued")
        }
      })
    )

    it.effect("apply a restore only into the resource Hearth sent it to", () =>
      Effect.gen(function* () {
        yield* fresh
        yield* seedRunning
        yield* reconcileBackupTaskEffect(finishedCreate, relayOne)
        const restoreTaskId = "55555555-5555-4555-8555-5555555555c5"
        // Restored where it was taken from: the task names no other target.
        yield* insertRows("backup_task", {
          id: restoreTaskId,
          backup_id: backupId,
          task_kind: "restore",
          status: "queued",
          created_at: now,
          updated_at: now,
        })
        const restored = (into: { id: string; kind: "instance" }) =>
          relayBackupTaskSchema.parse({
            backupId,
            bytesCompleted: 2048,
            bytesTotal: 2048,
            createdAt: now,
            error: null,
            finishedAt: now + 5,
            input: {
              backupId,
              kind: "restore",
              source: {
                bytes: 2048,
                checksumSha256: "a".repeat(64),
                kind: "local",
              },
              target: into,
              taskId: restoreTaskId,
            },
            inputRefreshRequired: false,
            kind: "restore",
            result: { artifacts: [], warnings: [] },
            startedAt: now,
            status: "succeeded",
            taskId: restoreTaskId,
            updatedAt: now + 5,
          })
        const restoreStatus = Effect.map(
          selectRows<{ id: string; status: string }>("backup_task"),
          (rows) => rows.find(({ id }) => id === restoreTaskId)?.status
        )

        assert.isFalse(
          yield* reconcileBackupTaskEffect(
            restored({ id: "d".repeat(12), kind: "instance" }),
            relayOne
          )
        )
        assert.strictEqual(yield* restoreStatus, "queued")

        assert.isTrue(
          yield* reconcileBackupTaskEffect(restored(target), relayOne)
        )
        assert.strictEqual(yield* restoreStatus, "succeeded")
      })
    )

    it.effect("add nothing beside a backup whose ID they reuse", () =>
      Effect.gen(function* () {
        const fresh2 = (n: number) => `22222222-2222-4222-8222-22222222222${n}`
        // Each of a reported backup's three IDs taken by Relay one's
        // backup in turn, the others new.
        const cases = [
          { artifactId: fresh2(1), backupId, taskId: fresh2(2) },
          { artifactId, backupId: fresh2(3), taskId: fresh2(4) },
          { artifactId: fresh2(5), backupId: fresh2(6), taskId: createTaskId },
        ]
        for (const ids of cases) {
          yield* fresh
          yield* seedRunning
          const before = yield* backupState

          for (const relayId of [relayOne, relayTwo]) {
            const changed = yield* reconcileBackupTaskEffect(
              scheduledReport(ids),
              relayId
            )
            assert.isFalse(changed)
            assert.deepStrictEqual(yield* backupState, before)
          }
        }
      })
    )

    it.effect(
      "catalog no schedule's backup of a game server Hearth has on another Relay",
      () =>
        Effect.gen(function* () {
          yield* fresh
          // The instance directory binds the server's ID to Relay two.
          yield* insertRows("instance_id", {
            id: target.id,
            kind: "server",
            relay_id: relayTwo,
            created_at: now,
          })
          const ids = {
            artifactId: "33333333-3333-4333-8333-3333333333a1",
            backupId: "33333333-3333-4333-8333-333333333331",
            taskId: "33333333-3333-4333-8333-3333333333c1",
          }

          assert.isFalse(
            yield* reconcileBackupTaskEffect(scheduledReport(ids), relayOne)
          )
          assert.lengthOf((yield* backupState).backups, 0)

          // Its own Relay's report of it is cataloged.
          assert.isTrue(
            yield* reconcileBackupTaskEffect(scheduledReport(ids), relayTwo)
          )
          const { artifacts, backups, tasks } = yield* backupState
          assert.deepStrictEqual(
            [backups.length, artifacts.length, tasks.length],
            [1, 1, 1]
          )
        })
    )
  })
})
