import { assert, layer } from "@effect/vitest"
import {
  backupArtifactFilename,
  backupTaskInputSchema,
  relayBackupTaskSchema,
} from "@workspace/contracts"
import {
  relayScheduleProjectionSchema,
  scheduledBackupId,
  type ScheduledBucketBackupReply,
  type ScheduleDefinition,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { saveBackupStorageEffect } from "@/backups/destinations/s3"
import { Database } from "@/effect/database"
import { createAppRecordEffect } from "@/effect/managed-apps"
import { reconcileBackupTaskEffect } from "@/effect/backups"
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
  // Holds every task sent to it on its way, until opened.
  arriving: null as null | Promise<void>,
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
            composeKey: null,
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
      await relay.arriving
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
  relay.arriving = null
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
    members: Array<Member>
    revision: number
    scheduledAt: number
    together: true
  }> = {}
) =>
  Effect.promise(() =>
    takeScheduledBucketBackups(from, {
      actionId: asked.actionId ?? toBucket,
      members: asked.members ?? [{ targetId: server, targetKind: "instance" }],
      revision: asked.revision ?? schedule.revision,
      scheduledAt: asked.scheduledAt ?? at,
      scheduleId,
      ...(asked.together ? { together: true as const } : {}),
    })
  )

// The IDs Hearth answered for what it took of one thing.
const takenOf = (reply: ScheduledBucketBackupReply, member: Member) => {
  const backup = reply.taken
    ? reply.backups.find(
        ({ targetId, targetKind }) =>
          targetId === member.targetId && targetKind === member.targetKind
      )
    : undefined
  if (!backup) throw new Error("Hearth didn't take it")
  return backup
}

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
          const member: Member = { targetId: server, targetKind: "instance" }

          // Asked twice, as each target of a batch asks for all of it: the
          // same backup, by the same IDs, both times.
          const taken = yield* ask(relayId)
          const again = yield* ask(relayId)
          yield* passesRun

          const { backupId, taskId } = takenOf(taken, member)
          assert.deepStrictEqual(takenOf(again, member), takenOf(taken, member))
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
          // The Relay holds a task with a signed upload to that object,
          // under the ID Hearth answered.
          const [task, ...others] = [...relay.tasks.values()]
          assert.lengthOf(others, 0)
          assert.deepInclude(task?.input, {
            backupId,
            kind: "create",
            reason: "scheduled",
            taskId,
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
            members,
            together: true,
          })
          const own = yield* ask(relayId, { members: [kiln] })
          yield* passesRun

          const cataloged = new Map(
            (yield* backups()).map((backup) => [backup.id, backup])
          )
          // The batch's two are one stopped batch, named by Hearth, to the
          // Relay too, so it takes them in one stopped window.
          const batchId = cataloged.get(takenOf(batch, members[0]!).backupId)
            ?.batch_id
          assert.isString(batchId)
          for (const member of members) {
            const { backupId, taskId } = takenOf(batch, member)
            assert.deepInclude(cataloged.get(backupId), {
              batch_id: batchId,
              consistency: "stopped",
              target_id: member.targetId,
            })
            assert.deepInclude(relay.tasks.get(taskId)?.input, {
              batch: { id: batchId!, size: 2 },
              consistency: "stopped",
            })
          }
          // Kiln is the platform, by this installation's ID, in a batch of
          // nothing.
          assert.deepInclude(cataloged.get(takenOf(own, kiln).backupId), {
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
          // The one it leaves out isn't news when it is reported again, as
          // the Relay reports it on every pass.
          const inBucket = relayBackupTaskSchema.parse(
            relay.tasks.get("00000001-0000-4000-8000-000000000002")
          )
          assert.isFalse(yield* reconcileBackupTaskEffect(inBucket, relayId))
        }),
      60_000
    )

    it.effect(
      "takes a run whose IDs a Relay worked out and used first",
      () =>
        Effect.gen(function* () {
          yield* seed
          // Another Relay holds a backup under the ID the run's backup would
          // have by the schedule's own formula, which any Relay can work out.
          const member: Member = { targetId: server, targetKind: "instance" }
          const squatted = scheduledBackupId({
            ...member,
            actionId: toBucket,
            scheduledAt: at,
            scheduleId,
          })
          yield* insertBackup(squatted, {
            relay_id: otherRelayId,
            target_id: otherServer,
          })

          const taken = yield* ask(relayId)

          // Hearth's IDs are its own: the run is taken all the same.
          assert.notStrictEqual(takenOf(taken, member).backupId, squatted)
          assert.lengthOf(yield* backups(), 2)
        }),
      60_000
    )

    it.effect(
      "takes no run again whose rows no longer hold the object Hearth chose",
      () =>
        Effect.gen(function* () {
          // Rows at a run's IDs whose object differs from Hearth's, as one
          // a release before this one cataloged from a Relay's report, or
          // differs only in case: another object in a bucket, though
          // MySQL's collation calls them equal.
          const member: Member = { targetId: server, targetKind: "instance" }
          for (const moved of [
            () =>
              `team/kiln/kiln-test/${otherRelayId}/instance/${otherServer}/x/backup.zip`,
            (chosen: string) => chosen.replace("team/", "Team/"),
          ]) {
            yield* seed
            const taken = yield* ask(relayId)
            const { backupId } = takenOf(taken, member)
            const chosen = `team/kiln/kiln-test/${relayId}/instance/${server}/${backupId}/${backupArtifactFilename(backupId, "archive")}`
            const database = yield* Database
            for (const table of ["kiln_backup", "kiln_backup_artifact"]) {
              yield* database.execute(
                "test.move",
                `UPDATE ${table} SET object_key = ? WHERE object_key = ?`,
                [moved(chosen), chosen]
              )
            }

            const refused = yield* ask(relayId)

            assert.isFalse(refused.taken)
          }
        }),
      60_000
    )

    it.effect(
      "works on a few of one Relay's takes at once, lets a few more wait, and refuses the rest",
      () =>
        Effect.gen(function* () {
          yield* seed
          let arrive = () => {}
          relay.arriving = new Promise((resolve) => {
            arrive = resolve
          })
          const run = (minute: number) =>
            ask(relayId, { scheduledAt: at + minute * 60_000 })

          // Four runs taken, each holding its turn while its task is on its
          // way to the Relay.
          const four = yield* Effect.forEach([1, 2, 3, 4], run)
          assert.isTrue(four.every(({ taken }) => taken))

          // Twelve more wait for a turn; one past those is refused at once.
          const waiting = Array.from({ length: 12 }, (_, index) =>
            Effect.runPromise(run(5 + index))
          )
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0))
          assert.isFalse((yield* run(17)).taken)
          // Those waiting are refused once they have waited longer than the
          // Relay waits for an answer.
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(21_000))
          const refused = yield* Effect.promise(() => Promise.all(waiting))
          assert.isTrue(refused.every(({ taken }) => !taken))
          assert.lengthOf(yield* backups(), 4)

          // Once their tasks have arrived, the next is taken.
          arrive()
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000))
          assert.isTrue((yield* run(6)).taken)
          yield* passesRun
        }).pipe(inTestTime),
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
              members: [{ targetId: media, targetKind: "volume" }],
              revision: appSchedule.revision,
              scheduledAt: at,
              scheduleId: appSchedule.id,
              together: true,
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
