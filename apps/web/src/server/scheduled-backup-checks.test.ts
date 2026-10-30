import { assert, layer } from "@effect/vitest"
import type { ScheduleDefinition } from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  deleteBackupStorageEffect,
  saveBackupStorageEffect,
} from "@/backups/destinations/s3"
import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import { requestResourceDeletionRowEffect } from "@/effect/resource-deletions"
import { invalidateScheduleDeploymentsEffect } from "@/effect/schedule-invalidation"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  deployScheduleToRelay,
  insertSchedule,
  redeployUnacknowledgedSchedules,
  stopScheduleDeliveries,
  upsertDeployment,
} from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

// The Relay and S3 are the fakes: the schedules Hearth sends the Relay,
// which it takes as it would and acknowledges by the generation it now has,
// with something that may happen while one is on its way; and a bucket whose
// purge fails.
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
    generation?: number
  }>,
  meanwhile: null as null | (() => Promise<void>),
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { generation?: number; id: string; revision: number }
  ) => {
    if (operation === "relay.volumes.read") {
      return {
        measuring: false,
        protection: { ready: true, reason: null },
        uncovered: [],
        volumes: [],
      }
    }
    if (operation !== "schedule.apply") {
      throw new Error(`Unexpected Relay operation ${operation}`)
    }
    relay.applied.push(payload as unknown as (typeof relay.applied)[number])
    const meanwhile = relay.meanwhile
    relay.meanwhile = null
    await meanwhile?.()
    return {
      acknowledgedGeneration: payload.generation,
      acknowledgedRevision: payload.revision,
      nextRunAt: null,
      scheduleId: payload.id,
    }
  },
}))
vi.mock("@/backups/destinations/s3/client", async (importOriginal) => {
  const { Effect } = await import("effect")
  const { BackupStorageError } = await import("@/effect/errors")
  return {
    ...(await importOriginal<
      typeof import("@/backups/destinations/s3/client")
    >()),
    deleteS3BackupPrefix: () =>
      Effect.fail(
        new BackupStorageError({
          code: "access_denied",
          operation: "storage.deletePrefix",
          reason: "The bucket refused the purge",
        })
      ),
  }
})
vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

// Sends a test set off in the background finish before the database closes.
afterAll(async () => {
  await stopScheduleDeliveries()
  await disposeAppRuntime()
})

const relayId = "relay-one"
const owner = {
  email: "owner@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "owner",
  isDevelopmentBypass: false,
  name: "Owner",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser
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
  relay.meanwhile = null
  yield* insertRelay(relayId)
})

const repositoryId = "44444444-4444-4444-8444-444444444444"

describeMysql("Scheduled backups, checked before they run", () => {
  // Migrating a fresh database can take a while on a busy host.
  layer(TestDatabase, { timeout: 120_000 })((it) => {
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
          yield* deploy(
            backupSchedule({ kind: "local" }, [turnedOff, beingDeleted, capped])
          )
          yield* requestResourceDeletionRowEffect({
            finalBackup: false,
            kind: "instance",
            relayId,
            resourceId: beingDeleted,
            storageId: null,
            user: owner,
          })
          yield* Effect.promise(redeployUnacknowledgedSchedules)

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
      "stops backups to a destination being deleted, even when purging it then fails",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* saveBackupStorageEffect({
            accessKeyId: "access-key",
            allowPrivateNetwork: false,
            bucket: "kiln-backups",
            enabled: true,
            endpoint: "https://s3.example.test",
            forcePathStyle: false,
            id: storageId,
            name: "Team",
            objectPrefix: "team",
            ownerUserId: null,
            region: "us-east-1",
            secretAccessKey: "secret-key",
          })
          // Something stored there to purge, which the bucket refuses.
          yield* insertRows("backup_repository", {
            created_at: at,
            id: repositoryId,
            object_prefix: "team/restic/old",
            password_ciphertext: "repository-password",
            relay_id: relayId,
            storage_id: storageId,
            storage_key: storageId,
            target_id: capped,
            target_kind: "instance",
          })
          yield* deploy(
            backupSchedule({ kind: "storage", storageId }, [capped])
          )
          const before = executions()[capped]

          const failed = yield* Effect.flip(
            deleteBackupStorageEffect(storageId)
          )
          const [owed] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          yield* Effect.promise(redeployUnacknowledgedSchedules)

          assert.isNull(before?.refusal ?? null)
          assert.strictEqual(failed._tag, "BackupStorageError")
          assert.strictEqual(owed?.status, "pending")
          assert.strictEqual(
            executions()[capped]?.refusal,
            "its backup destination is being deleted"
          )
        }),
      30_000
    )

    it.effect(
      "counts a schedule delivered only once the Relay has the newest generation",
      () =>
        Effect.gen(function* () {
          yield* seed
          const database = yield* Database
          // Backups are turned off for the server while the schedule that
          // still allows them is on its way to the Relay.
          relay.meanwhile = () =>
            Effect.runPromise(
              database
                .transaction("test.turnOff", (transaction) =>
                  Effect.gen(function* () {
                    yield* transaction.execute(
                      `INSERT INTO kiln_backup_policy
                         (relay_id, target_kind, target_id, exclude_patterns,
                          admin_quantity_limit, created_at, updated_at)
                       VALUES (?, 'instance', ?, '[]', 0, ?, ?)`,
                      [relayId, capped, at, at]
                    )
                    yield* invalidateScheduleDeploymentsEffect(transaction, {
                      relayId,
                      target: { id: capped, kind: "instance" },
                    })
                  })
                )
                .pipe(Effect.asVoid)
            )

          yield* deploy(backupSchedule({ kind: "local" }, [capped]))
          const [afterOldAnswer] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          yield* Effect.promise(redeployUnacknowledgedSchedules)
          const [afterResend] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )

          // The first answer was for a generation the change superseded.
          assert.strictEqual(afterOldAnswer?.status, "pending")
          assert.isAbove(
            relay.applied.at(-1)?.generation ?? 0,
            relay.applied[0]?.generation ?? 0
          )
          assert.strictEqual(
            executions()[capped]?.refusal,
            "backups are turned off for it"
          )
          assert.strictEqual(afterResend?.status, "applied")
        })
    )
  })
})
