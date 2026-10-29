import { assert, layer } from "@effect/vitest"
import type { RelayBackupTask } from "@workspace/contracts"
import type { ScheduleDefinition } from "@workspace/contracts/schedules"
import { Effect, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { reconcileBackupTaskEffect } from "@/effect/backups"
import { disposeAppRuntime } from "@/effect/runtime"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  deployScheduleToRelay,
  insertSchedule,
  requestScheduleRedeployment,
  upsertDeployment,
} from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

// The Relay is the only fake: the schedules Hearth sends it, as it would
// store and run them.
const relay = vi.hoisted(() => ({
  applied: [] as Array<{
    actions: Array<{
      executions?: Array<{
        destination: unknown
        maxBytes?: number | null
        refusal?: string | null
        targetId: string
      }>
    }>
  }>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { id: string; revision: number }
  ) => {
    if (operation !== "schedule.apply") {
      throw new Error(`Unexpected Relay operation ${operation}`)
    }
    relay.applied.push(payload as unknown as (typeof relay.applied)[number])
    return {
      acknowledgedRevision: payload.revision,
      nextRunAt: null,
      scheduleId: payload.id,
    }
  },
}))

afterAll(() => disposeAppRuntime())

const relayId = "relay-one"
const at = 1_767_225_600_000
const turnedOff = "a".repeat(40)
const beingDeleted = "b".repeat(40)
const capped = "c".repeat(40)
const storageId = "11111111-1111-4111-8111-111111111111"

const target = (id: string) => ({
  id,
  kind: "instance" as const,
  name: id.slice(0, 4),
  relayId,
})

const backupSchedule = (
  destination: { kind: "local" } | { kind: "storage"; storageId: string },
  targets: ReadonlyArray<string>
): ScheduleDefinition => ({
  actions: [
    {
      destination,
      id: "22222222-2222-4222-8222-222222222222",
      mode: "full",
      name: "Nightly",
      type: "backup",
    },
  ],
  continueOnFailure: false,
  cron: "0 3 * * *",
  enabled: true,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Nightly backups",
  revision: 1,
  targets: targets.map(target),
  timezone: "UTC",
})

// The schedule saved, as Hearth keeps it, then sent to its Relay.
const deploy = (schedule: ScheduleDefinition) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.transaction("test.schedule", (transaction) =>
      insertSchedule(transaction, schedule, "owner", at)
    )
    const [persisted] = yield* Effect.promise(listPersistedRelays)
    yield* Effect.promise(async () => {
      await upsertDeployment(schedule.id, relayId, 1, "pending")
      await deployScheduleToRelay(schedule, schedule.targets, persisted)
    })
  })

// What the last schedule the Relay got says of each target's backup.
const executions = () =>
  Object.fromEntries(
    (relay.applied.at(-1)?.actions[0]?.executions ?? []).map((execution) => [
      execution.targetId,
      execution,
    ])
  )

const seed = Effect.gen(function* () {
  yield* resetDatabase
  relay.applied.length = 0
  yield* insertRelay(relayId)
})

describeMysql("Scheduled backups, checked before they run", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "refuses, in the schedule it sends, a backup Hearth would refuse by hand",
      () =>
        Effect.gen(function* () {
          yield* seed
          const policy = (targetId: string, row: Record<string, unknown>) =>
            insertRows("backup_policy", {
              created_at: at,
              exclude_patterns: "[]",
              relay_id: relayId,
              target_id: targetId,
              target_kind: "instance",
              updated_at: at,
              ...row,
            })
          // An administrator turned backups off for one server, another is
          // being deleted, and a third may write at most 2 KiB.
          yield* policy(turnedOff, { admin_quantity_limit: 0 })
          yield* policy(capped, { size_limit_bytes: 2_048 })
          yield* insertBackup("final-backup", {
            reason: "final_delete",
            relay_id: relayId,
            target_id: beingDeleted,
          })
          yield* insertRows("backup_final_delete", {
            backup_id: "final-backup",
            created_at: at,
            relay_id: relayId,
            requested_by: "owner",
            status: "backing_up",
            target_id: beingDeleted,
            updated_at: at,
          })

          yield* deploy(
            backupSchedule({ kind: "local" }, [turnedOff, beingDeleted, capped])
          )

          const sent = executions()
          assert.strictEqual(
            sent[turnedOff]?.refusal,
            "backups are turned off for it"
          )
          assert.strictEqual(
            sent[beingDeleted]?.refusal,
            "it's being permanently deleted"
          )
          assert.isNull(sent[capped]?.refusal ?? null)
          assert.deepStrictEqual(sent[capped]?.destination, { kind: "local" })
          assert.strictEqual(sent[capped]?.maxBytes, 2_048)
        })
    )

    it.effect(
      "refuses a backup to a destination that's disabled or being deleted, and sends it again when that changes",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertBackupStorage(storageId, { enabled: false })

          yield* deploy(
            backupSchedule({ kind: "storage", storageId }, [capped])
          )
          const disabled = executions()[capped]

          // Enabled again, but now being deleted: the schedule goes out
          // again without anyone editing it.
          const database = yield* Database
          yield* database.execute(
            "test.storageDeleting",
            `UPDATE kiln_backup_storage SET enabled = 1, deleting = 1`
          )
          const sentBefore = relay.applied.length
          yield* Effect.promise(() =>
            requestScheduleRedeployment({ storageId })
          )
          yield* Effect.sync(() => relay.applied.length).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (count) => count > sentBefore,
            }),
            Effect.timeout("20 seconds")
          )

          assert.strictEqual(
            disabled?.refusal,
            "its backup destination is disabled"
          )
          assert.isNull(disabled?.destination ?? null)
          assert.strictEqual(
            executions()[capped]?.refusal,
            "its backup destination is being deleted"
          )
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "catalogs an incremental scheduled backup in the repository its schedule names",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertRows("backup_repository", {
            created_at: at,
            id: repositoryId,
            object_prefix: null,
            password_ciphertext: "repository-password",
            relay_id: relayId,
            storage_id: null,
            storage_key: "local",
            target_id: capped,
            target_kind: "instance",
          })

          yield* reconcileBackupTaskEffect(
            scheduledSnapshot(
              repositoryId,
              "40000000-0000-4000-8000-000000000001"
            ),
            relayId
          )
          // Its repository went, as when its destination was deleted,
          // after the schedule that names it was sent.
          yield* reconcileBackupTaskEffect(
            scheduledSnapshot(
              "55555555-5555-4555-8555-555555555555",
              "40000000-0000-4000-8000-000000000002"
            ),
            relayId
          )
          // Reported again by the Relay, it stays failed.
          yield* reconcileBackupTaskEffect(
            scheduledSnapshot(
              "55555555-5555-4555-8555-555555555555",
              "40000000-0000-4000-8000-000000000002"
            ),
            relayId
          )

          const cataloged = Object.fromEntries(
            (yield* selectRows<{
              id: string
              repository_id: string | null
              status: string
            }>("backup")).map((row) => [row.id, row])
          )
          assert.deepInclude(
            cataloged["40000000-0000-4000-8000-000000000001"],
            { repository_id: repositoryId, status: "available" }
          )
          assert.deepInclude(
            cataloged["40000000-0000-4000-8000-000000000002"],
            { repository_id: null, status: "failed" }
          )
        })
    )
  })
})

const repositoryId = "44444444-4444-4444-8444-444444444444"

function scheduledSnapshot(
  repository: string,
  backupId: string
): RelayBackupTask {
  const taskId = backupId.replace(/^4/u, "6")
  return {
    backupId,
    bytesCompleted: 256,
    bytesTotal: 256,
    createdAt: at,
    currentArtifactId: null,
    currentPath: null,
    error: null,
    errorCode: null,
    finishedAt: at + 5_000,
    input: {
      artifactKind: "restic_snapshot",
      backupId,
      catalog: {
        name: "Nightly",
        repositoryId: repository,
        storageId: null,
      },
      destination: {
        artifactId: backupId.replace(/^4/u, "7"),
        kind: "restic",
        repository: { kind: "local" },
      },
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "incremental",
      reason: "scheduled",
      target: { id: capped, kind: "instance" },
      taskId,
    },
    inputRefreshRequired: false,
    kind: "create",
    phase: null,
    result: { bytes: 256, snapshotId: "abcdef12", warnings: [] },
    startedAt: at,
    status: "succeeded",
    taskId,
    updatedAt: at + 5_000,
  } as RelayBackupTask
}
