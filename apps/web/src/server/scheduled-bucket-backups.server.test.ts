import { assert, layer } from "@effect/vitest"
import { backupTaskInputSchema } from "@workspace/contracts"
import {
  relayScheduleProjectionSchema,
  scheduledBackupId,
  scheduledBackupTaskId,
  type ScheduleDefinition,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { saveBackupStorageEffect } from "@/backups/destinations/s3"
import { Database } from "@/effect/database"
import { createAppRecordEffect } from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import { reconcileRelayBackups } from "@/lib/backup-reconciliation"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  deployScheduleToRelay,
  insertSchedule,
  stopScheduleDeliveries,
  upsertDeployment,
} from "@/server/schedule-deployment.server"
import { takeScheduledBucketBackups } from "@/server/scheduled-bucket-backups.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, selectRows } from "@/test/seed"

// The Relay is the only boundary. It takes a schedule and a backup task as
// a Relay does, refusing what it can't parse, and keeps what it was sent.
// It makes no backups: a task it is sent has failed by the next time Hearth
// lists them, so nothing is left for Hearth to follow.
const relay = vi.hoisted(() => ({
  // How often Hearth has asked what backups it holds.
  listed: 0,
  // Something that happens while Hearth reads the Relay's volumes.
  meanwhile: null as null | (() => Promise<void>),
  schedules: [] as Array<unknown>,
  tasks: new Map<string, Record<string, unknown>>(),
  // The Kiln volumes it has, each with the Apps that use it.
  volumes: [] as Array<{ id: string; users: Array<string> }>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string, payload: unknown) => {
    if (operation === "schedule.apply") {
      const projection = relayScheduleProjectionSchema.parse(payload)
      relay.schedules.push(payload)
      return {
        acknowledgedGeneration: projection.generation,
        acknowledgedRevision: projection.revision,
        nextRunAt: null,
        scheduleId: projection.id,
      }
    }
    // It takes whichever volumes an App's configuration says it mounts.
    if (operation === "app.volumes.write") return {}
    if (operation === "relay.volumes.read") {
      const meanwhile = relay.meanwhile
      relay.meanwhile = null
      await meanwhile?.()
      return {
        filesAvailable: false,
        measuring: false,
        missing: [],
        protection: { ready: true, reason: null },
        uncovered: [],
        volumes: relay.volumes.map(({ id, users }) => ({
          createdAt: null,
          dockerName: `kiln-${id.slice(0, 8)}`,
          id,
          kind: "kiln",
          mountpoint: null,
          mounts: [],
          name: "media",
          owner: null,
          sizeBytes: null,
          users: users.map((appId) => ({
            appId,
            configured: true,
            mounted: false,
          })),
        })),
      }
    }
    if (operation === "backup.task.list") {
      relay.listed += 1
      return [...relay.tasks.values()].map((task) => ({
        ...task,
        error: "This Relay makes no backups",
        finishedAt: at,
        status: "failed",
      }))
    }
    if (operation === "backup.task.enqueue") {
      const input = backupTaskInputSchema.parse(payload)
      const task = {
        backupId: input.backupId,
        bytesCompleted: 0,
        bytesTotal: null,
        createdAt: at,
        currentArtifactId: null,
        currentPath: null,
        error: null,
        errorCode: null,
        finishedAt: null,
        input,
        inputRefreshRequired: false,
        kind: input.kind,
        phase: null,
        result: null,
        startedAt: null,
        status: "queued",
        taskId: input.taskId,
        updatedAt: at,
      }
      relay.tasks.set(input.taskId, task)
      return task
    }
    throw new Error(`Unexpected Relay request ${operation}`)
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))
// A destination's keys are kept encrypted.
vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

afterAll(async () => {
  await stopScheduleDeliveries()
  await disposeAppRuntime()
})

const at = 1_767_225_600_000
const relayId = "a".repeat(12)
const otherRelayId = "b".repeat(12)
const server = "1".repeat(12)
const otherServer = "2".repeat(12)
const storageId = "d".repeat(12)
const volume = "3".repeat(40)
const database = "4".repeat(12)
const scheduleId = "33333333-3333-4333-8333-333333333333"
const toBucket = "22222222-2222-4222-8222-222222222222"
const toDisk = "44444444-4444-4444-8444-444444444444"
const stoppedToBucket = "55555555-5555-4555-8555-555555555555"
const batchId = "66666666-6666-4666-8666-666666666666"
const accessKeyId = "AKIAKILNTESTKEY"
const secretAccessKey = "kiln-test-secret-access-key"

const schedule: ScheduleDefinition = {
  actions: [
    {
      destination: { kind: "storage", storageId },
      id: toBucket,
      mode: "full",
      name: "Nightly",
      type: "backup",
    },
    {
      destination: { kind: "local" },
      id: toDisk,
      mode: "full",
      name: "Nightly, kept here",
      type: "backup",
    },
    {
      consistency: "stopped",
      destination: { kind: "storage", storageId },
      id: stoppedToBucket,
      mode: "full",
      name: "Nightly, stopped",
      type: "backup",
    },
  ],
  continueOnFailure: false,
  cron: "0 3 * * *",
  enabled: true,
  id: scheduleId,
  name: "Nightly backups",
  revision: 1,
  // A game server, a volume and a database, and Kiln itself.
  targets: [
    { id: server, kind: "instance", name: "Lobby", relayId },
    { id: volume, kind: "volume", name: "Media", relayId },
    { id: database, kind: "database", name: "Shop", relayId },
    { id: relayId, kind: "relay", name: "Kiln", relayId },
  ],
}

const destination = (enabled: boolean) =>
  saveBackupStorageEffect({
    accessKeyId,
    allowPrivateNetwork: false,
    bucket: "kiln-backups",
    enabled,
    endpoint: "https://s3.example.test",
    forcePathStyle: false,
    id: storageId,
    name: "Team",
    objectPrefix: "team",
    ownerUserId: null,
    region: "us-east-1",
    secretAccessKey,
  })

// Two Relays, a bucket, and a schedule that backs one Relay's game server
// up to it, saved as Hearth keeps it and sent to that Relay.
const seed = Effect.gen(function* () {
  yield* resetDatabase
  relay.meanwhile = null
  relay.schedules.length = 0
  relay.tasks.clear()
  relay.volumes = []
  yield* insertRelay(relayId, { enabled: 1 })
  yield* insertRelay(otherRelayId, { enabled: 1 })
  yield* destination(true)
  const database = yield* Database
  yield* database.transaction("test.schedule", (transaction) =>
    insertSchedule(transaction, schedule, "owner", at)
  )
  const persisted = (yield* Effect.promise(listPersistedRelays)).find(
    ({ id }) => id === relayId
  )
  yield* Effect.promise(async () => {
    await upsertDeployment(scheduleId, relayId, 1, "pending")
    await deployScheduleToRelay(schedule, schedule.targets, persisted)
  })
})

type Member = {
  targetId: string
  targetKind: "database" | "instance" | "relay" | "volume"
}
const ask = (
  from: string,
  asked: Partial<{
    actionId: string
    batchId: string
    members: Array<Member>
    revision: number
  }> = {}
) =>
  Effect.promise(() =>
    takeScheduledBucketBackups(from, {
      actionId: asked.actionId ?? toBucket,
      ...(asked.batchId ? { batchId: asked.batchId } : {}),
      members: asked.members ?? [{ targetId: server, targetKind: "instance" }],
      revision: asked.revision ?? schedule.revision,
      scheduledAt: at,
      scheduleId,
    })
  )

const idOf = (member: Member, actionId = toBucket) =>
  scheduledBackupId({ ...member, actionId, scheduledAt: at, scheduleId })

// Hearth sends what it took on its next pass over the Relay's backups, a
// moment later, and follows each task until it has ended. That moment is
// the test's to pass: each pass is started, then read after while it has
// its turn, until no task is left to follow and Hearth has stopped asking
// the Relay, so nothing of this test runs on into the next.
const passesRun = Effect.gen(function* () {
  const giveUpAt = performance.now() + 30_000
  let quiet = 0
  while (performance.now() < giveUpAt) {
    const listed = relay.listed
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000))
    let ended = false
    for (let read = 0; read < 25; read += 1) {
      const tasks = yield* selectRows<{ status: string }>("backup_task")
      ended =
        tasks.length > 0 && tasks.every(({ status }) => status === "failed")
    }
    quiet = ended && relay.listed === listed ? quiet + 1 : 0
    if (quiet === 2) return
  }
  return yield* Effect.die("Hearth never finished with the Relay's backups")
})
const inTestTime = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  Effect.sync(() =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  ).pipe(
    Effect.andThen(test),
    Effect.ensuring(Effect.sync(() => vi.useRealTimers()))
  )

const backups = () =>
  selectRows<{
    artifact_kind: string
    batch_id: string | null
    consistency: string | null
    id: string
    object_key: string | null
    reason: string
    relay_id: string
    storage_id: string | null
    target_id: string
    target_kind: string
  }>("backup")

describeMysql("A schedule's backups to a bucket", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "sends a Relay nothing of the bucket, and takes each backup it says is due as a signed upload",
      () =>
        Effect.gen(function* () {
          yield* seed
          const backupId = idOf({ targetId: server, targetKind: "instance" })

          // Asked twice, as each target of a batch asks for all of it.
          const taken = yield* ask(relayId)
          yield* ask(relayId)
          yield* passesRun

          assert.deepStrictEqual(taken, { taken: true })
          // Where it goes is Hearth's to say: the schedule's destination,
          // in that Relay's folder of it.
          const [cataloged, ...rest] = yield* backups()
          assert.lengthOf(rest, 0)
          assert.deepInclude(cataloged, {
            id: backupId,
            reason: "scheduled",
            relay_id: relayId,
            storage_id: storageId,
            target_id: server,
          })
          assert.match(
            cataloged?.object_key ?? "",
            new RegExp(
              `^team/kiln/[^/]+/${relayId}/instance/${server}/${backupId}/`
            )
          )
          // The Relay holds a task with a signed upload to that object.
          const [task] = [...relay.tasks.values()]
          assert.deepInclude(task?.input, {
            backupId,
            kind: "create",
            reason: "scheduled",
          })
          const sent = task?.input as
            | { destination?: { uploadUrl?: string } }
            | undefined
          assert.include(
            sent?.destination?.uploadUrl ?? "",
            cataloged?.object_key ?? "nothing"
          )
          // And it never held the bucket's secret: its schedule says
          // nothing of the bucket, and its task only signs that one upload.
          assert.notInclude(JSON.stringify(relay.schedules), accessKeyId)
          assert.notInclude(
            JSON.stringify([relay.schedules, task]),
            secretAccessKey
          )
        }).pipe(inTestTime),
      60_000
    )

    it.effect(
      "takes a stopped batch as one, and Kiln's own backup as the platform's",
      () =>
        Effect.gen(function* () {
          yield* seed
          const members: Array<Member> = [
            { targetId: volume, targetKind: "volume" },
            { targetId: database, targetKind: "database" },
          ]
          const kiln: Member = { targetId: relayId, targetKind: "relay" }

          const batch = yield* ask(relayId, {
            actionId: stoppedToBucket,
            batchId,
            members,
          })
          const own = yield* ask(relayId, { members: [kiln] })
          yield* passesRun

          assert.deepStrictEqual(
            [batch, own],
            [{ taken: true }, { taken: true }]
          )
          const cataloged = new Map(
            (yield* backups()).map((backup) => [backup.id, backup])
          )
          // The batch's two are one stopped batch, to the Relay too, so it
          // takes them in one stopped window.
          for (const member of members) {
            const id = idOf(member, stoppedToBucket)
            assert.deepInclude(cataloged.get(id), {
              batch_id: batchId,
              consistency: "stopped",
              target_id: member.targetId,
            })
            assert.deepInclude(
              relay.tasks.get(scheduledBackupTaskId(id))?.input,
              { batch: { id: batchId, size: 2 }, consistency: "stopped" }
            )
          }
          // Kiln is the platform, by this installation's ID, in a batch of
          // nothing.
          assert.deepInclude(cataloged.get(idOf(kiln)), {
            artifact_kind: "platform_bundle",
            batch_id: null,
            target_id: "kiln-test",
            target_kind: "platform",
          })
          assert.strictEqual(cataloged.size, 3)
        }).pipe(inTestTime),
      60_000
    )

    it.effect(
      "takes nothing a Relay asks for beyond what its own schedule sends to the bucket",
      () =>
        Effect.gen(function* () {
          yield* seed

          const refused = [
            // Another Relay asks for this Relay's backup.
            yield* ask(otherRelayId),
            // A game server the schedule doesn't back up.
            yield* ask(relayId, {
              members: [{ targetId: otherServer, targetKind: "instance" }],
            }),
            // A step whose backups stay on the Relay.
            yield* ask(relayId, { actionId: toDisk }),
          ]

          assert.isTrue(refused.every(({ taken }) => !taken))
          assert.lengthOf(yield* backups(), 0)
        }),
      60_000
    )

    it.effect(
      "records nothing of a bucket from a backup a Relay says it made itself",
      () =>
        Effect.gen(function* () {
          yield* seed
          // A Relay reports two scheduled backups Hearth never heard of: one
          // in the bucket, at an object of another Relay's, and one on its
          // disk that names the bucket.
          const made = (part: number, destination: Record<string, unknown>) => {
            const backupId = `0000000${part}-0000-4000-8000-000000000001`
            const taskId = `0000000${part}-0000-4000-8000-000000000002`
            relay.tasks.set(taskId, {
              backupId,
              bytesCompleted: 0,
              bytesTotal: null,
              createdAt: at,
              currentArtifactId: null,
              currentPath: null,
              error: null,
              errorCode: null,
              finishedAt: null,
              input: {
                artifactKind: "archive",
                backupId,
                catalog: { name: "Nightly", storageId },
                destination: {
                  artifactId: `0000000${part}-0000-4000-8000-000000000003`,
                  ...destination,
                },
                exclude: [],
                kind: "create",
                maxBytes: null,
                mode: "full",
                reason: "scheduled",
                target: { id: server, kind: "instance" },
                taskId,
              },
              inputRefreshRequired: false,
              kind: "create",
              phase: null,
              result: null,
              startedAt: null,
              status: "queued",
              taskId,
              updatedAt: at,
            })
            return backupId
          }
          made(1, {
            bucket: "kiln-backups",
            endpoint: "https://s3.example.test",
            kind: "s3",
            objectKey: `team/kiln/kiln-test/${otherRelayId}/instance/${otherServer}/x/backup.zip`,
            region: "us-east-1",
          })
          const onDisk = made(2, { kind: "local" })
          const [persisted] = (yield* Effect.promise(
            listPersistedRelays
          )).filter(({ id }) => id === relayId)

          yield* Effect.promise(() => reconcileRelayBackups(persisted!))

          const [cataloged, ...rest] = yield* backups()
          assert.lengthOf(rest, 0)
          assert.deepInclude(cataloged, {
            id: onDisk,
            object_key: null,
            storage_id: null,
          })
          const copies = yield* selectRows<{
            object_key: string | null
            storage_id: string | null
          }>("backup_artifact")
          assert.deepStrictEqual(
            copies.map(({ object_key, storage_id }) => [
              object_key,
              storage_id,
            ]),
            [[null, null]]
          )
        }),
      60_000
    )

    it.effect(
      "takes nothing whose ID another backup already has",
      () =>
        Effect.gen(function* () {
          yield* seed
          // The run's backup ID, held by a backup of another Relay's.
          yield* insertBackup(
            idOf({ targetId: server, targetKind: "instance" }),
            { relay_id: otherRelayId, target_id: otherServer }
          )

          const refused = yield* ask(relayId)

          assert.isFalse(refused.taken)
          const [kept, ...rest] = yield* backups()
          assert.lengthOf(rest, 0)
          assert.deepInclude(kept, {
            reason: "manual",
            relay_id: otherRelayId,
          })
          assert.lengthOf(yield* selectRows("backup_task"), 0)
        }),
      60_000
    )

    it.effect(
      "takes nothing for a run started before its schedule was saved",
      () =>
        Effect.gen(function* () {
          yield* seed
          // The run was started under revision 1; the schedule is now 2.
          const database = yield* Database
          yield* database.execute(
            "test.save",
            `UPDATE kiln_schedule SET revision = 2 WHERE id = ?`,
            [scheduleId]
          )

          const stale = yield* ask(relayId, { revision: 1 })

          assert.isFalse(stale.taken)
          assert.lengthOf(yield* backups(), 0)

          // Saved in the moment Hearth reads the step, before it holds the
          // schedule's lane: refused once it does.
          yield* seed
          const app = "5".repeat(12)
          const media = "6".repeat(40)
          relay.volumes = [{ id: media, users: [app] }]
          yield* createAppRecordEffect({
            appId: app,
            createdBy: "owner",
            mounts: [
              {
                id: "mount0media",
                readOnly: false,
                service: null,
                source: { type: "volume", volumeId: media },
                target: "/data",
              },
            ],
            name: "Site",
            relayId,
          })
          const appStep = "99999999-9999-4999-8999-999999999999"
          const appSchedule: ScheduleDefinition = {
            ...schedule,
            actions: [{ ...schedule.actions[0]!, id: appStep }],
            id: "88888888-8888-4888-8888-888888888888",
            targets: [{ id: app, kind: "app", name: "Site", relayId }],
          }
          yield* database.transaction("test.schedule", (transaction) =>
            insertSchedule(transaction, appSchedule, "owner", at)
          )
          relay.meanwhile = () =>
            Effect.runPromise(
              database.execute(
                "test.save",
                `UPDATE kiln_schedule SET revision = revision + 1 WHERE id = ?`,
                [appSchedule.id]
              )
            ).then(() => undefined)

          const saved = yield* Effect.promise(() =>
            takeScheduledBucketBackups(relayId, {
              actionId: appStep,
              batchId,
              members: [{ targetId: media, targetKind: "volume" }],
              revision: appSchedule.revision,
              scheduledAt: at,
              scheduleId: appSchedule.id,
            })
          )

          assert.isFalse(saved.taken)
          assert.lengthOf(yield* backups(), 0)
        }),
      60_000
    )

    it.effect(
      "takes nothing once it would no longer let the backup run",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* destination(false)

          const refused = yield* ask(relayId)

          assert.isFalse(refused.taken)
          assert.lengthOf(yield* backups(), 0)
        }),
      60_000
    )
  })
})
