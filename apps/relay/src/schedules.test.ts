import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import { Effect, Fiber, ManagedRuntime } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

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
    enqueueBackup: async () => {
      throw new Error("not used")
    },
    findInstance: overrides.findInstance ?? (async () => null),
    getBackup: async () => null,
    listAppOwnedVolumeIds: async () => [],
    listAppIds: async () => new Set(),
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
  return { restart: start, schedules }
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
  timezone: "UTC",
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

describe("Relay schedule commands in containers", () => {
  const databaseId = "d".repeat(40)
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