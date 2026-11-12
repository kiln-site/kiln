import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Fiber, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import type { RelayBackupTask } from "@workspace/contracts"
import type { RelayScheduleProjection } from "@workspace/contracts/schedules"

import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"

import { ScheduleManager, type ScheduleManagerOptions } from "./schedules.js"

const directories: Array<string> = []
const managers: Array<ScheduleManager> = []
const runtimes: Array<
  ReturnType<typeof ManagedRuntime.make<RelayStateStore, unknown>>
> = []
const minuteMs = 60_000

beforeEach(() => {
  // Only virtual time is faked; immediates and file I/O stay real so the
  // Effect scheduler and schedule persistence keep running.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
  vi.setSystemTime(new Date("2026-01-15T12:00:30.000Z"))
})

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close()
  vi.useRealTimers()
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { force: true, maxRetries: 5, recursive: true })
      )
  )
})

/**
 * Advances virtual time in `stepMs` increments until `assertion` passes,
 * giving real file I/O a chance to finish between steps.
 */
async function advanceUntil(assertion: () => void | Promise<void>, stepMs = 0) {
  const startedAt = performance.now()
  while (true) {
    try {
      await assertion()
      return
    } catch (error) {
      if (performance.now() - startedAt > 3_000) throw error
    }
    await vi.advanceTimersByTimeAsync(stepMs)
    await yieldToEventLoop()
  }
}

async function manager(
  overrides: Partial<{
    enqueueBackup: ScheduleManagerOptions["enqueueBackup"]
    listAppIds: ScheduleManagerOptions["listAppIds"]
    findInstance: (instanceId: string) => Promise<object | null>
    sendConsoleCommand: (instanceId: string, command: string) => Promise<void>
    listDatabaseIds: ScheduleManagerOptions["listDatabaseIds"]
    runContainerCommand: ScheduleManagerOptions["runContainerCommand"]
    runPower: ScheduleManagerOptions["runPower"]
  }> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-schedules-"))
  directories.push(directory)
  const options: Omit<ScheduleManagerOptions, "state"> = {
    enqueueBackup:
      overrides.enqueueBackup ??
      (async () => {
        throw new Error("not used")
      }),
    findInstance: overrides.findInstance ?? (async () => null),
    getBackup: async () => null,
    listAppIds: overrides.listAppIds ?? (async () => new Set()),
    listDatabaseIds: overrides.listDatabaseIds ?? (async () => new Set()),
    platformTargetId: () => "platform",
    relayId: "relay-a",
    powerIntent: () => "0",
    isPaused: () => false,
    runContainerCommand:
      overrides.runContainerCommand ??
      (async () => {
        throw new Error("not used")
      }),
    runPower: overrides.runPower ?? (async () => undefined),
    sendConsoleCommand: overrides.sendConsoleCommand ?? (async () => undefined),
    stateDirectory: directory,
  }
  const filename = join(directory, "relay.sqlite")
  const start = async () => {
    const runtime = ManagedRuntime.make(makeRelayStateLayer(filename))
    runtimes.push(runtime)
    const store = await runtime.runPromise(RelayStateStore)
    const schedules = await ScheduleManager.make({
      ...options,
      state: store.schedules,
    })
    managers.push(schedules)
    return schedules
  }
  const schedules = await start()
  return { filename, restart: start, schedules }
}

const projection: RelayScheduleProjection = {
  actions: [
    {
      command: "say hello",
      id: "8ff172c1-dc22-45fa-8457-b899ca25a8f8",
      type: "console_command",
    },
  ],
  cron: "daily",
  enabled: true,
  id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
  name: "Daily greeting",
  revision: 1,
  targets: [
    {
      id: "server-a",
      kind: "instance",
      name: "Server A",
      relayId: "relay-a",
    },
  ],
}

async function latestRun(schedules: ScheduleManager) {
  return (await schedules.overview([projection.id])).runs[0]
}

function runNow(schedules: ScheduleManager) {
  return schedules.runNow({
    revision: projection.revision,
    scheduleId: projection.id,
  })
}

describe("Relay schedule persistence", () => {
  it("records an occurrence that fell due while the Relay was down as missed", async () => {
    const commands: Array<string> = []
    const { restart, schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    const applied = await schedules.apply({ ...projection, cron: "* * * * *" })
    schedules.close()
    vi.advanceTimersByTime(2 * minuteMs)

    const recovered = await restart()
    const worker = Effect.runFork(recovered.run())
    try {
      await advanceUntil(async () =>
        expect(await latestRun(recovered)).toMatchObject({
          scheduledAt: applied.nextRunAt,
          status: "missed",
        })
      )
      expect(
        (await recovered.overview()).deployments[0]?.nextRunAt
      ).toBeGreaterThan(Date.now())
      expect(commands).toEqual([])
    } finally {
      await Effect.runPromise(Fiber.interrupt(worker))
    }
  })
})

describe("Relay schedule time zone", () => {
  it("runs schedules in UTC whatever the Relay's own time zone, including ones stored with a zone", async () => {
    const processTimeZone = process.env.TZ
    process.env.TZ = "America/New_York"
    try {
      const { filename, restart, schedules } = await manager()
      const applied = await schedules.apply(projection)
      expect(applied.nextRunAt).toBe(Date.parse("2026-01-16T00:00:00.000Z"))
      schedules.close()

      // As a Relay stored it before schedules ran in UTC: with a zone, and
      // next running at midnight in that zone.
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            UPDATE relay_schedules
            SET definition_json = json_set(definition_json, '$.timezone', 'America/New_York'),
              next_run_at = ${Date.parse("2026-01-16T05:00:00.000Z")}
          `
          // The migrator runs what follows the newest one it recorded.
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 39`
        }).pipe(Effect.provide(SqliteClient.layer({ filename })))
      )

      const recovered = await restart()
      expect((await recovered.overview()).deployments).toMatchObject([
        { nextRunAt: Date.parse("2026-01-16T00:00:00.000Z") },
      ])
      await expect(runNow(recovered)).resolves.toMatchObject({
        scheduleId: projection.id,
        status: "running",
      })
    } finally {
      if (processTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = processTimeZone
    }
  })
})

describe("Relay schedule commands in containers", () => {
  const databaseId = "d".repeat(12)
  const databaseKey = `relay-a:database:${databaseId}`
  const databaseCommands: RelayScheduleProjection = {
    ...projection,
    actions: [
      {
        command: "./migrate",
        id: "5d8f43a2-6a0e-4d36-9c11-3b1f4f5e2a10",
        authorizedTargets: 2,
        targetKeys: [databaseKey],
        type: "console_command",
      },
      {
        command: "./vacuum",
        id: "a4c1e6b9-2f7d-4c0a-8e35-7b9d2c6f1e44",
        authorizedTargets: 2,
        targetKeys: [databaseKey],
        type: "console_command",
      },
      {
        command: "./report",
        id: "e2b7d9c4-1a3f-4e8b-9c62-5d0f7a8b3c19",
        authorizedTargets: 2,
        targetKeys: [databaseKey],
        type: "console_command",
      },
    ],
    targets: [
      {
        id: databaseId,
        kind: "database",
        name: "Main database",
        relayId: "relay-a",
      },
    ],
  }

  it("never runs a stored command or kill on a database it doesn't name", async () => {
    const consoleCommands: Array<string> = []
    const containerCommands: Array<string> = []
    const power: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      listDatabaseIds: async () => new Set([databaseId]),
      runContainerCommand: async (_target, command) => {
        containerCommands.push(command)
        return { exitCode: 0, output: "", truncated: false, unknown: null }
      },
      runPower: async (kind, id, action) => {
        power.push(`${kind}:${id}:${action}`)
      },
      sendConsoleCommand: async (instanceId, command) => {
        consoleCommands.push(`${instanceId}:${command}`)
      },
    })
    // No step names its targets, so each means the game server alone.
    await schedules.apply({
      ...projection,
      actions: [
        projection.actions[0]!,
        {
          action: "kill",
          id: "0e9a7f5c-77e8-4b39-8c1a-6d5bb9c0b3a1",
          type: "power",
        },
      ],
      targets: [...projection.targets, ...databaseCommands.targets],
    })

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    )
    expect(consoleCommands).toEqual(["server-a:say hello"])
    expect(power).toEqual(["instance:server-a:kill"])
    expect(containerCommands).toEqual([])
    expect((await latestRun(schedules))?.targetRuns[1]).toMatchObject({
      attempts: [{ status: "skipped_policy" }, { status: "skipped_policy" }],
      status: "noop",
      target: { kind: "database" },
    })
  })

  it("reports a command the Relay stopped during as unknown and never runs it again", async () => {
    const commands: Array<string> = []
    const { restart, schedules } = await manager({
      listDatabaseIds: async () => new Set([databaseId]),
      // The Relay stops while the second command runs, so it never answers.
      runContainerCommand: async (_target, command) => {
        commands.push(command)
        if (command === "./migrate") {
          return { exitCode: 0, output: "", truncated: false, unknown: null }
        }
        return new Promise(() => undefined)
      },
    })
    await schedules.apply({ ...databaseCommands, cron: "hourly" })
    await runNow(schedules)
    await advanceUntil(() =>
      expect(commands).toEqual(["./migrate", "./vacuum"])
    )
    schedules.close()

    const recovered = await restart()
    const run = await latestRun(recovered)
    expect(run).toMatchObject({
      status: "interrupted",
      targetRuns: [
        {
          attempts: [
            { result: { exitCode: 0 }, status: "succeeded" },
            {
              error:
                "The Relay stopped before this command finished, so it may have run",
              status: "unknown",
            },
          ],
          status: "interrupted",
        },
      ],
    })
    // The worker carries on with later occurrences, never this one again.
    const worker = Effect.runFork(recovered.run())
    try {
      await vi.advanceTimersByTimeAsync(30 * minuteMs)
      await yieldToEventLoop()
      expect(commands).toEqual(["./migrate", "./vacuum"])
      expect((await recovered.overview([projection.id])).runs).toHaveLength(1)
    } finally {
      await Effect.runPromise(Fiber.interrupt(worker))
    }
  })
})

// An App is backed up by its volumes. Apps that use the same volume are
// backed up together: asked for once for each App, the volume would be one
// backup made twice, or one App's backup said done without it.
describe("Relay scheduled App backups", () => {
  const [site, blog] = ["a".repeat(12), "b".repeat(12)] as [string, string]
  const [media, uploads] = ["1".repeat(40), "2".repeat(40)] as [string, string]
  const local = { destination: { kind: "local" as const }, mode: "full" as const }
  const nightly: RelayScheduleProjection = {
    ...projection,
    actions: [
      {
        destination: { kind: "local" },
        executions: [
          { ...local, appIds: [site, blog], targetId: media, targetKind: "volume" },
          { ...local, appIds: [site], targetId: uploads, targetKind: "volume" },
        ],
        id: "c5a1b9d2-3e4f-4a6b-8c7d-9e0f1a2b3c4d",
        mode: "full",
        name: "Nightly",
        type: "backup",
      },
    ],
    targets: [site, blog].map((id) => ({
      id,
      kind: "app" as const,
      name: id.slice(0, 4),
      relayId: "relay-a",
    })),
  }
  // The backup queue: a task for each backup asked for, by its ID, done at
  // once.
  const queue = () => {
    const tasks = new Map<string, RelayBackupTask>()
    const enqueueBackup: ScheduleManagerOptions["enqueueBackup"] = async (
      input
    ) => {
      const known = tasks.get(input.taskId)
      if (known) return known
      const task = {
        backupId: input.backupId,
        input,
        status: "succeeded",
        taskId: input.taskId,
      } as unknown as RelayBackupTask
      tasks.set(input.taskId, task)
      return task
    }
    return { enqueueBackup, tasks }
  }
  it("backs up Apps that share a volume together, the volume once", async () => {
    const { enqueueBackup, tasks } = queue()
    const { schedules } = await manager({
      enqueueBackup,
      listAppIds: async () => new Set([site, blog]),
    })
    await schedules.apply(nightly)

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    )
    const made = [...tasks.values()].map(({ input }) => input)
    // Its volumes, and nothing else: no backup of an App itself.
    expect(made.map((input) => input.target)).toEqual(
      expect.arrayContaining([
        { id: media, kind: "volume" },
        { id: uploads, kind: "volume" },
      ])
    )
    expect(made).toHaveLength(2)
    // Cataloged as one batch of the two, whichever App asked first.
    expect(
      new Set(made.map((input) => "catalog" in input && input.catalog?.batchId))
        .size
    ).toBe(1)
    expect((await latestRun(schedules))?.targetRuns).toMatchObject([
      { status: "succeeded" },
      { status: "succeeded" },
    ])
  })

  // The schedule is sent again whenever an App is deployed. A run that
  // falls just before that may name a volume the App has since let go of.
  it("fails only the App whose volume is gone, the rest still backed up", async () => {
    const { enqueueBackup: succeed, tasks } = queue()
    const gone = "The volume no longer exists on this Relay"
    const { schedules } = await manager({
      enqueueBackup: async (input) => {
        const task = await succeed(input)
        return input.kind === "create" && input.target.id === uploads
          ? { ...task, error: gone, status: "failed" }
          : task
      },
      listAppIds: async () => new Set([site, blog]),
    })
    await schedules.apply(nightly)

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("partial")
    )
    // Both were asked for: the one that is there was not held back.
    expect(tasks.size).toBe(2)
    const [siteRun, blogRun] = (await latestRun(schedules))?.targetRuns ?? []
    expect(siteRun).toMatchObject({
      attempts: [{ error: gone, status: "failed" }],
      status: "failed",
    })
    // It shares a volume with the other, and uses none of what is gone.
    expect(blogRun).toMatchObject({ status: "succeeded" })
  })
  // Stopped is chosen so an App's files and its database agree. Dumped as
  // the App runs, the database would be of another moment than the files.
  it("takes a stopped step's database in one batch with its App's volumes", async () => {
    const database = "d".repeat(12)
    const { enqueueBackup, tasks } = queue()
    const { schedules } = await manager({
      enqueueBackup,
      listAppIds: async () => new Set([site]),
      listDatabaseIds: async () => new Set([database]),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          consistency: "stopped",
          destination: { kind: "local" },
          executions: [
            { ...local, appIds: [site], targetId: uploads, targetKind: "volume" },
            { ...local, targetId: database, targetKind: "database" },
          ],
          id: "e7c3d1f4-5a6b-4c8d-9e0f-1a2b3c4d5e6f",
          mode: "full",
          name: "Nightly",
          type: "backup",
        },
      ],
      targets: [
        { id: site, kind: "app", name: "Site", relayId: "relay-a" },
        { id: database, kind: "database", name: "Site", relayId: "relay-a" },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    )
    const made = [...tasks.values()].map(({ input }) => input)
    expect(made.map((input) => input.target.kind).sort()).toEqual([
      "database",
      "volume",
    ])
    // One stopped window for the two: the dump waits for the App to stop.
    const batches = made.map((input) => ("batch" in input ? input.batch : null))
    expect(new Set(batches.map((batch) => batch?.id)).size).toBe(1)
    expect(batches.map((batch) => batch?.size)).toEqual([2, 2])
    expect(
      made.map((input) => "consistency" in input && input.consistency)
    ).toEqual(["stopped", "stopped"])
  })
  // A target the step doesn't run on in an occurrence, as one that is gone
  // or whose earlier step failed, is backed up by no other target's run.
  it("leaves a database the step skips out of the batch its App asks for", async () => {
    const database = "d".repeat(12)
    const { enqueueBackup, tasks } = queue()
    const { schedules } = await manager({
      enqueueBackup,
      listAppIds: async () => new Set([site]),
      // The database is gone from the Relay.
      listDatabaseIds: async () => new Set(),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          consistency: "stopped",
          destination: { kind: "local" },
          executions: [
            { ...local, appIds: [site], targetId: uploads, targetKind: "volume" },
            { ...local, targetId: database, targetKind: "database" },
          ],
          id: "f8d4e2a5-6b7c-4d9e-8f1a-2b3c4d5e6f7a",
          mode: "full",
          name: "Nightly",
          type: "backup",
        },
      ],
      targets: [
        { id: site, kind: "app", name: "Site", relayId: "relay-a" },
        { id: database, kind: "database", name: "Site", relayId: "relay-a" },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.targetRuns).toHaveLength(2)
    )
    const made = [...tasks.values()].map(({ input }) => input)
    expect(made.map((input) => input.target)).toEqual([
      { id: uploads, kind: "volume" },
    ])
    // Alone, it is the App's stopped backup, in no batch.
    expect("batch" in made[0]! && made[0].batch).toBeFalsy()
  })
})

describe("Relay scheduled App backups, of an App that keeps nothing", () => {
  it("skips an App with no volumes, and doesn't pass for a backup made", async () => {
    const appId = "c".repeat(12)
    const { schedules } = await manager({
      listAppIds: async () => new Set([appId]),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: { kind: "local" },
          executions: [],
          id: "d6b2c0e3-4f5a-4b7c-9d8e-0f1a2b3c4d5e",
          mode: "full",
          name: "Nightly",
          type: "backup",
        },
      ],
      targets: [{ id: appId, kind: "app", name: "Site", relayId: "relay-a" }],
    })

    await runNow(schedules)

    // Nothing was asked of the backup queue, which would refuse it here,
    // and the run doesn't say a backup succeeded.
    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("noop")
    )
    expect((await latestRun(schedules))?.targetRuns[0]?.attempts).toMatchObject(
      [
        {
          error: "Nothing to back up: this App uses no volume",
          status: "skipped_unsupported",
        },
      ]
    )
  })
})
