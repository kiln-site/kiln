import { assert, layer } from "@effect/vitest"
import type { RelayBackupTask } from "@workspace/contracts"
import type { ScheduleDefinition } from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, vi } from "vite-plus/test"

import {
  deleteBackupStorageEffect,
  saveBackupStorageEffect,
} from "@/backups/destinations/s3"
import {
  insertAppDeploymentEffect,
  finishAppDeploymentEffect,
} from "@/effect/app-deployments"
import { Database } from "@/effect/database"
import {
  updateBackupLimitsEffect,
  reconcileBackupTaskEffect,
} from "@/effect/backups"
import { disposeAppRuntime } from "@/effect/runtime"
import {
  recordResourceDeletionStatusEffect,
  requestResourceDeletionRowEffect,
} from "@/effect/resource-deletions"
import { invalidateScheduleDeploymentsEffect } from "@/effect/schedule-invalidation"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { listPersistedRelays } from "@/lib/relay-registry"
import { scheduleProjectionGenerations } from "@/migrations/0043_schedule_projection_generations"
import {
  deployScheduleToRelay,
  insertSchedule,
  redeployUnacknowledgedSchedules,
  stopScheduleDeliveries,
  upsertDeployment,
} from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackupStorage,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

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
        appId?: string
        refusal?: string | null
        repositoryId?: string | null
        targetId: string
        targetKind: string
      }>
    }>
    generation?: number
  }>,
  meanwhile: null as null | (() => Promise<void>),
  // The volumes it reports, for an App's backup.
  volumes: [] as Array<Record<string, unknown>>,
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
        volumes: relay.volumes,
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
  relay.volumes = []
  yield* insertRelay(relayId)
})

describeMysql("Scheduled backups, checked before they run", () => {
  // Migrating a fresh database can take a while on a busy host.
  layer(TestDatabase, { timeout: 120_000 })((it) => {
    it.effect(
      "waits for the sends under way as Hearth stops, and starts none after",
      () =>
        Effect.gen(function* () {
          // This module owns a one-way shutdown gate. Give this test its own
          // lifetime so other tests can still deliver schedules in any order.
          vi.resetModules()
          const isolated = yield* Effect.promise(
            () => import("@/server/schedule-deployment.server")
          )
          const runtime = yield* Effect.promise(() => import("@/effect/runtime"))
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await isolated.stopScheduleDeliveries()
              await runtime.disposeAppRuntime()
            })
          )
          const database = yield* Database
          const owe = database.transaction("test.owe", (transaction) =>
            invalidateScheduleDeploymentsEffect(transaction, {
              relayId,
              target: { id: capped, kind: "instance" },
            })
          )
          yield* seed
          yield* deploy(backupSchedule({ kind: "local" }, [capped]))
          let release!: () => void
          let started!: () => void
          const sending = new Promise<void>((resolve) => {
            started = resolve
          })
          const blocked = new Promise<void>((resolve) => {
            release = resolve
          })
          relay.meanwhile = () => {
            started()
            return blocked
          }
          yield* Effect.addFinalizer(() => Effect.sync(release))
          yield* owe

          isolated.deliverPendingSchedules()
          yield* Effect.promise(() => sending)
          let stopped = false
          const stopping = isolated.stopScheduleDeliveries().then(() => {
            stopped = true
          })
          // The Relay has not acknowledged this send yet. Reading its owed
          // deployment synchronizes with real I/O without waiting on a timer.
          const [inFlight] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          assert.strictEqual(inFlight?.status, "pending")
          assert.isFalse(stopped)
          release()
          yield* Effect.promise(() => stopping)
          const [delivered] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          assert.strictEqual(delivered?.status, "applied")
          // Owed again while stopping, as a deletion still running can.
          yield* owe
          isolated.deliverPendingSchedules()
          yield* Effect.promise(() => isolated.stopScheduleDeliveries())
          const [owed] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )

          // Left for the next Hearth's sweep.
          assert.strictEqual(owed?.status, "pending")
        }).pipe(Effect.scoped)
    )

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
      "sends an App's folder and each volume it owns, each checked as by hand",
      () =>
        Effect.gen(function* () {
          yield* seed
          const appId = "d".repeat(40)
          const otherAppId = "e".repeat(40)
          const volume = (owner: string, name: string) => ({
            createdAt: null,
            dockerName: `kiln-app-${owner.slice(0, 8)}_${name}`,
            id: `${owner}/${name}`,
            kind: "app",
            mountpoint: null,
            mounts: [],
            name,
            owner: { appId: owner, volume: name },
            sizeBytes: null,
            users: [{ appId: owner, configured: true, mounted: true }],
          })
          relay.volumes = [
            volume(appId, "data"),
            volume(appId, "cache"),
            volume(otherAppId, "data"),
          ]
          // Backups are off for the App's cache volume.
          yield* insertRows("backup_policy", {
            admin_quantity_limit: 0,
            created_at: at,
            exclude_patterns: "[]",
            relay_id: relayId,
            target_id: `${appId}/cache`,
            target_kind: "volume",
            updated_at: at,
          })
          const schedule = backupSchedule({ kind: "local" }, [])
          yield* deploy({
            ...schedule,
            targets: [{ id: appId, kind: "app", name: "Site", relayId }],
          })

          const sent = relay.applied.at(-1)?.actions[0]?.executions ?? []
          assert.deepStrictEqual(
            sent.map((execution) => [
              execution.targetKind,
              execution.targetId,
              execution.appId ?? null,
              execution.refusal ?? null,
            ]),
            [
              ["app", appId, null, null],
              ["volume", `${appId}/data`, appId, null],
              [
                "volume",
                `${appId}/cache`,
                appId,
                "backups are turned off for it",
              ],
            ]
          )
        })
    )

    it.effect("refreshes volume coverage after an App's first deployment", () =>
      Effect.gen(function* () {
        yield* seed
        const appId = "d".repeat(40)
        yield* deploy({
          ...backupSchedule({ kind: "local" }, []),
          targets: [{ id: appId, kind: "app", name: "Site", relayId }],
        })
        assert.deepStrictEqual(Object.keys(executions()), [appId])
        relay.volumes = [
          {
            createdAt: null,
            dockerName: "data",
            id: `${appId}/data`,
            kind: "app",
            mountpoint: null,
            mounts: [],
            name: "data",
            owner: { appId, volume: "data" },
            sizeBytes: null,
            users: [],
          },
        ]
        const id = "44444444-4444-4444-8444-444444444444"
        yield* insertRows("app", { app_id: appId, relay_id: relayId, name: "Site", config_ciphertext: "unused", created_by: "owner", created_at: at, updated_at: at })
        yield* insertAppDeploymentEffect({
          id,
          appId,
          relayId,
          branch: null,
          commitAuthor: null,
          commitMessage: null,
          commitSha: null,
          error: null,
          finishedAt: null,
          imageDigest: null,
          relayDeploymentId: "first",
          repository: null,
          rolling: null,
          sourceType: "compose",
          startedAt: new Date(at).toISOString(),
          status: "running",
          trigger: "manual",
          triggeredBy: "owner",
        })
        yield* finishAppDeploymentEffect(id, {
          error: null,
          finishedAt: new Date(at + 1000).toISOString(),
          rolling: false,
          status: "succeeded",
        })
        yield* Effect.promise(redeployUnacknowledgedSchedules)
        assert.deepStrictEqual(Object.keys(executions()), [
          appId,
          `${appId}/data`,
        ])
      })
    )

    for (const kind of ["app", "volume"] as const) {
      it.effect(
        `refreshes App backup admission when ${kind} policy changes`,
        () =>
          Effect.gen(function* () {
            yield* seed
            const appId = "d".repeat(40)
            const volumeId = `${appId}/data`
            relay.volumes = [
              {
                createdAt: null,
                dockerName: "data",
                id: volumeId,
                kind: "app",
                mountpoint: null,
                mounts: [],
                name: "data",
                owner: { appId, volume: "data" },
                sizeBytes: null,
                users: [],
              },
            ]
            yield* deploy({
              ...backupSchedule({ kind: "local" }, []),
              targets: [{ id: appId, kind: "app", name: "Site", relayId }],
            })
            const before = relay.applied.at(-1)?.generation ?? 0
            yield* updateBackupLimitsEffect({ admin: true, quantityLimit: null, relayId, retentionDays: null, sizeLimitBytes: 1024,
              targetId: kind === "app" ? appId : volumeId, targetKind: kind })
            yield* Effect.promise(redeployUnacknowledgedSchedules)
            assert.strictEqual(executions()[kind === "app" ? appId : volumeId]?.maxBytes, 1024)
            yield* updateBackupLimitsEffect({
              admin: true,
              quantityLimit: 0,
              relayId,
              retentionDays: null,
              sizeLimitBytes: 1024,
              targetId: kind === "app" ? appId : volumeId,
              targetKind: kind,
            })
            yield* Effect.promise(redeployUnacknowledgedSchedules)
            assert.isAbove(relay.applied.at(-1)?.generation ?? 0, before)
            assert.strictEqual(
              executions()[kind === "app" ? appId : volumeId]?.refusal,
              "backups are turned off for it"
            )
          })
      )
    }

    it.effect(
      "sends a schedule deployed before the upgrade again, with what it may back up now",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seed
          yield* deploy(backupSchedule({ kind: "local" }, [capped]))
          // As a Hearth from before generations left it: applied, and sent
          // without admission, while a size ceiling was set since.
          yield* sql.unsafe(
            `ALTER TABLE kiln_schedule_deployment
               DROP COLUMN desired_generation,
               DROP COLUMN acknowledged_generation`
          )
          yield* insertRows("backup_policy", {
            created_at: at,
            exclude_patterns: "[]",
            relay_id: relayId,
            size_limit_bytes: 2_048,
            target_id: capped,
            target_kind: "instance",
            updated_at: at,
          })
          const sent = relay.applied.length

          // Upgraded, the upgrade run twice, as after one stopped partway.
          yield* scheduleProjectionGenerations.run
          yield* scheduleProjectionGenerations.run
          const [upgraded] = yield* selectRows<{
            acknowledged_generation: number | null
            desired_generation: number
            status: string
          }>("schedule_deployment")
          yield* Effect.promise(redeployUnacknowledgedSchedules)
          const [resent] = yield* selectRows<{
            acknowledged_generation: number | null
            desired_generation: number
            status: string
          }>("schedule_deployment")

          assert.strictEqual(upgraded?.status, "applied")
          assert.strictEqual(Number(upgraded?.desired_generation), 1)
          assert.isNull(upgraded?.acknowledged_generation ?? null)
          assert.strictEqual(relay.applied.length, sent + 1)
          assert.strictEqual(executions()[capped]?.maxBytes, 2_048)
          assert.strictEqual(resent?.status, "applied")
          assert.strictEqual(
            Number(resent?.acknowledged_generation),
            Number(resent?.desired_generation)
          )
        })
    )

    it.effect(
      "stops a target's scheduled backups while its deletion runs, and resumes them once it stops",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* deploy(backupSchedule({ kind: "local" }, [capped]))
          const before = executions()[capped]

          const deletion = yield* requestResourceDeletionRowEffect({
            finalBackup: false,
            kind: "instance",
            relayId,
            resourceId: capped,
            storageId: null,
            user: owner,
          })
          const [owed] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          yield* Effect.promise(redeployUnacknowledgedSchedules)
          const during = executions()[capped]

          yield* recordResourceDeletionStatusEffect({
            attempt: deletion.attempt,
            error: "The Relay is unreachable",
            id: deletion.id,
            status: "failed",
          })
          const [owedAgain] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          yield* Effect.promise(redeployUnacknowledgedSchedules)
          const after = executions()[capped]

          assert.isNull(before?.refusal ?? null)
          assert.strictEqual(owed?.status, "pending")
          assert.strictEqual(during?.refusal, "it's being permanently deleted")
          assert.strictEqual(owedAgain?.status, "pending")
          assert.isNull(after?.refusal ?? null)
        })
    )

    it.effect(
      "stops an App's scheduled backups while its deletion runs, and resumes them once it stops",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* deploy({ ...backupSchedule({ kind: "local" }, []), targets: [{ id: capped, kind: "app", name: "Site", relayId }] })
          const before = executions()[capped]

          const deletion = yield* requestResourceDeletionRowEffect({
            finalBackup: false,
            kind: "app",
            relayId,
            resourceId: capped,
            storageId: null,
            user: owner,
          })
          const [owed] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          yield* Effect.promise(redeployUnacknowledgedSchedules)
          const during = executions()[capped]

          yield* recordResourceDeletionStatusEffect({
            attempt: deletion.attempt,
            error: "The Relay is unreachable",
            id: deletion.id,
            status: "failed",
          })
          const [owedAgain] = yield* selectRows<{ status: string }>(
            "schedule_deployment"
          )
          yield* Effect.promise(redeployUnacknowledgedSchedules)
          const after = executions()[capped]

          assert.isNull(before?.refusal ?? null)
          assert.strictEqual(owed?.status, "pending")
          assert.strictEqual(during?.refusal, "it's being permanently deleted")
          assert.strictEqual(owedAgain?.status, "pending")
          assert.isNull(after?.refusal ?? null)
        })
    )

    it.effect("refuses a backup to a disabled destination", () =>
      Effect.gen(function* () {
        yield* seed
        yield* insertBackupStorage(storageId, { enabled: false })

        yield* deploy(backupSchedule({ kind: "storage", storageId }, [capped]))
        const disabled = executions()[capped]

        assert.strictEqual(
          disabled?.refusal,
          "its backup destination is disabled"
        )
        assert.isNull(disabled?.destination ?? null)
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
          assert.strictEqual(relay.applied.length, 2)
          assert.isAbove(
            relay.applied[1]?.generation ?? 0,
            relay.applied[0]?.generation ?? 0
          )
          assert.strictEqual(
            executions()[capped]?.refusal,
            "backups are turned off for it"
          )
          assert.strictEqual(afterResend?.status, "applied")
        })
    )

    it.effect(
      "sends an incremental backup's repository with its schedule",
      () =>
        Effect.gen(function* () {
          yield* seed
          const schedule = backupSchedule({ kind: "local" }, [capped])
          const incremental: ScheduleDefinition = {
            ...schedule,
            actions: schedule.actions.map((action) =>
              action.type === "backup"
                ? { ...action, mode: "incremental" as const }
                : action
            ),
          }

          yield* deploy(incremental)
          const [repository] = yield* selectRows<{ id: string }>(
            "backup_repository"
          )

          assert.isDefined(repository)
          assert.strictEqual(executions()[capped]?.repositoryId, repository?.id)
        })
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
