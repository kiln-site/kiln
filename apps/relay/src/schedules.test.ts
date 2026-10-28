import { symlinkSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import { Effect, Fiber, ManagedRuntime } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import type { BackupTaskInput, RelayBackupTask } from "@workspace/contracts"
import type { RelayScheduleProjection } from "@workspace/contracts/schedules"
import {
  nextScheduleOccurrence,
  scheduleStableId,
} from "@workspace/contracts/schedules"

import { RelayStateError } from "./effect/errors.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"

import { ScheduleManager, type ScheduleManagerOptions } from "./schedules.js"
import { LaneRejectedError } from "./operation-lanes.js"

const directories: Array<string> = []
const managers: Array<ScheduleManager> = []
const runtimes: Array<
  ReturnType<typeof ManagedRuntime.make<RelayStateStore, unknown>>
> = []
const minuteMs = 60_000
const hourMs = 60 * minuteMs

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
    directory: string
    legacy: unknown
    beforeMake: (filename: string) => void
    enqueueBackup: (input: BackupTaskInput) => Promise<RelayBackupTask>
    findInstance: (instanceId: string) => Promise<object | null>
    getBackup: (taskId: string) => Promise<RelayBackupTask | null>
    reportError: (message: string, cause: unknown) => void
    sendConsoleCommand: (instanceId: string, command: string) => Promise<void>
    powerIntent: ScheduleManagerOptions["powerIntent"]
    isPaused: () => boolean
    listDatabaseIds: ScheduleManagerOptions["listDatabaseIds"]
    runContainerCommand: ScheduleManagerOptions["runContainerCommand"]
    runPower: ScheduleManagerOptions["runPower"]
    // Stands in for the Relay's storage, as a failing disk would.
    state: (
      state: ScheduleManagerOptions["state"]
    ) => ScheduleManagerOptions["state"]
  }> = {}
) {
  const directory =
    overrides.directory ?? (await mkdtemp(join(tmpdir(), "kiln-schedules-")))
  directories.push(directory)
  const options: Omit<ScheduleManagerOptions, "state"> = {
    enqueueBackup:
      overrides.enqueueBackup ??
      (async () => {
        throw new Error("not used")
      }),
    findInstance: overrides.findInstance ?? (async () => null),
    getBackup: overrides.getBackup ?? (async () => null),
    listDatabaseIds: overrides.listDatabaseIds ?? (async () => new Set()),
    platformTargetId: () => "platform",
    relayId: "relay-a",
    reportError: overrides.reportError,
    powerIntent: overrides.powerIntent ?? (() => "0"),
    isPaused: overrides.isPaused ?? (() => false),
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
  if (overrides.legacy)
    await writeFile(
      join(directory, "schedules.json"),
      JSON.stringify(overrides.legacy)
    )
  const start = async () => {
    const runtime = ManagedRuntime.make(makeRelayStateLayer(filename))
    runtimes.push(runtime)
    const store = await runtime.runPromise(RelayStateStore)
    overrides.beforeMake?.(filename)
    const schedules = await ScheduleManager.make({
      ...options,
      state: overrides.state?.(store.schedules) ?? store.schedules,
    })
    managers.push(schedules)
    return schedules
  }
  const schedules = await start()
  return { directory, filename, restart: start, schedules }
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

function waitAction(duration: number, unit: "milliseconds" | "minutes") {
  return {
    duration,
    id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
    type: "wait" as const,
    unit,
  }
}

const afterWaitCommand = {
  command: "say after wait",
  id: "3c99d222-3d12-4fb6-a5f7-9d18078d7e90",
  type: "console_command" as const,
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
  it("keeps manual and due occurrences distinct at the same wall-clock time", async () => {
    const { schedules } = await manager({ findInstance: async () => ({}) })
    const applied = await schedules.apply({ ...projection, cron: "hourly" })
    vi.setSystemTime(applied.nextRunAt!)
    const manual = await runNow(schedules)
    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    )
    const worker = Effect.runFork(schedules.run())
    try {
      await advanceUntil(async () => {
        const { runs } = await schedules.overview()
        expect(runs).toHaveLength(2)
        expect(runs.every((run) => run.status === "succeeded")).toBe(true)
        expect(
          runs.map((run) => run.scheduledAt).sort((left, right) => left - right)
        ).toEqual(
          [applied.nextRunAt!, manual.scheduledAt].sort(
            (left, right) => left - right
          )
        )
        expect(manual.scheduledAt).not.toBe(applied.nextRunAt)
      })
    } finally {
      await Effect.runPromise(Fiber.interrupt(worker))
    }
  })

  it.each(["same Relay", "legacy Relay"])(
    "preserves existing %s history at a due timestamp and advances the queue",
    async (origin) => {
      const dueAt = Date.now() + minuteMs
      const healthyId = randomUUID()
      const existing = {
        id:
          origin === "same Relay"
            ? scheduleStableId(projection.id, dueAt, "relay-a")
            : "legacy-manual-run",
        scheduleId: projection.id,
        revision: 1,
        scheduledAt: dueAt,
        startedAt: dueAt,
        finishedAt: dueAt,
        status: "succeeded",
        targetRuns: [],
      }
      const { schedules } = await manager({
        legacy: {
          version: 1,
          lastHeartbeatAt: Date.now(),
          tombstones: {},
          runs: [existing],
          schedules: [
            { ...projection, nextRunAt: dueAt },
            { ...projection, id: healthyId, nextRunAt: dueAt },
          ],
        },
      })
      vi.setSystemTime(dueAt)
      const worker = Effect.runFork(schedules.run())
      try {
        await advanceUntil(async () => {
          const overview = await schedules.overview()
          expect(overview.deployments.every((d) => d.nextRunAt! > dueAt)).toBe(
            true
          )
          expect(overview.runs.find((r) => r.id === existing.id)).toMatchObject(
            existing
          )
          expect(
            overview.runs.find((r) => r.scheduleId === healthyId)?.status
          ).toBe("failed")
          expect(overview.runs).toHaveLength(2)
        })
      } finally {
        await Effect.runPromise(Fiber.interrupt(worker))
      }
    }
  )

  it.each(["live", "restart"])(
    "drops an unreadable definition for redeployment without blocking healthy schedules during %s claims",
    async (mode) => {
      const { filename, schedules, restart } = await manager()
      const ids = Array.from({ length: 34 }, () => randomUUID()).sort()
      const applied = await Promise.all(
        ids.map((id, index) =>
          schedules.apply({
            ...projection,
            id,
            cron: "hourly",
            targets: [{ ...projection.targets[0]!, id: `server-${index}` }],
          })
        )
      )
      const database = new DatabaseSync(filename)
      database
        .prepare(
          "UPDATE relay_schedules SET definition_json = '{' WHERE schedule_id = ?"
        )
        .run(ids[0]!)
      database.close()
      vi.setSystemTime(applied[0]!.nextRunAt!)
      let recovered = schedules
      if (mode === "restart") {
        schedules.close()
        recovered = await restart()
      }
      const worker = Effect.runFork(recovered.run())
      try {
        await advanceUntil(async () => {
          const overview = await recovered.overview()
          expect(overview.runs).toHaveLength(ids.length - 1)
          expect(
            overview.runs.every(
              (r) => r.status === (mode === "restart" ? "missed" : "failed")
            )
          ).toBe(true)
          // Hearth redeploys a schedule whose revision the Relay no longer reports.
          expect(overview.deployments.map((d) => d.scheduleId)).not.toContain(
            ids[0]
          )
        }, 1_000)
        const repaired = await recovered.apply({
          ...projection,
          id: ids[0]!,
          cron: "hourly",
          revision: 1,
        })
        expect(repaired.nextRunAt).toBeGreaterThan(Date.now())
      } finally {
        await Effect.runPromise(Fiber.interrupt(worker))
      }
    }
  )

  it("records overdue occurrences as missed after a restart even when storage fails first", async () => {
    const commands: Array<string> = []
    const { filename, schedules, restart } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_id, command) => {
        commands.push(command)
      },
    })
    const ids = Array.from({ length: 34 }, () => randomUUID()).sort()
    const applied = await Promise.all(
      ids.map((id) => schedules.apply({ ...projection, id, cron: "hourly" }))
    )
    const database = new DatabaseSync(filename)
    database.exec(`CREATE TRIGGER fail_recovery BEFORE UPDATE ON relay_schedules
      WHEN OLD.schedule_id = '${ids[1]}' BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END`)
    vi.setSystemTime(applied[0]!.nextRunAt!)
    schedules.close()
    const recovered = await restart()
    const worker = Effect.runFork(recovered.run())
    try {
      await advanceUntil(async () => {
        const { runs } = await recovered.overview(ids)
        expect(runs).toHaveLength(ids.length - 1)
      }, 1_000)
      database.exec("DROP TRIGGER fail_recovery")
      await advanceUntil(async () => {
        const { runs } = await recovered.overview(ids)
        expect(runs).toHaveLength(ids.length)
        expect(runs.every((run) => run.status === "missed")).toBe(true)
      }, 1_000)
      expect(commands).toEqual([])
    } finally {
      database.close()
      await Effect.runPromise(Fiber.interrupt(worker))
    }
  })

  it("executes durable claims around a failing row and retries that row after storage recovers", async () => {
    const commands: Array<string> = []
    const failures: Array<unknown> = []
    const { filename, schedules } = await manager({
      findInstance: async () => ({}),
      reportError: (_message, cause) => failures.push(cause),
      sendConsoleCommand: async (_id, command) => {
        commands.push(command)
      },
    })
    const ids = Array.from({ length: 3 }, () => randomUUID()).sort()
    const applied = await Promise.all(
      ids.map((id, index) =>
        schedules.apply({
          ...projection,
          id,
          cron: "hourly",
          targets: [{ ...projection.targets[0]!, id: `server-${index}` }],
          actions: [
            {
              ...projection.actions[0]!,
              type: "console_command",
              command: `say ${index}`,
            },
          ],
        })
      )
    )
    const database = new DatabaseSync(filename)
    database.exec(`CREATE TRIGGER fail_one_claim BEFORE UPDATE ON relay_schedules
      WHEN OLD.schedule_id = '${ids[1]}' BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END`)
    vi.setSystemTime(applied[0]!.nextRunAt!)
    const worker = Effect.runFork(schedules.run())
    try {
      await advanceUntil(async () => {
        expect([...commands].sort()).toEqual(["say 0", "say 2"])
        const overview = await schedules.overview()
        expect(overview.runs).toHaveLength(2)
        expect(overview.runs.every((r) => r.status === "succeeded")).toBe(true)
      })
      expect(failures).toHaveLength(1)
      database.exec("DROP TRIGGER fail_one_claim")
      await advanceUntil(async () => {
        expect([...commands].sort()).toEqual(["say 0", "say 1", "say 2"])
        expect(
          (await schedules.overview()).runs.every(
            (r) => r.status === "succeeded"
          )
        ).toBe(true)
      }, 1000)
    } finally {
      database.close()
      await Effect.runPromise(Fiber.interrupt(worker))
    }
  })

  it("still executes claimed occurrences when a later write in the batch fails", async () => {
    const commands: Array<string> = []
    const errors: Array<string> = []
    const { filename, schedules } = await manager({
      findInstance: async () => ({}),
      reportError: (message) => errors.push(message),
      sendConsoleCommand: async (_id, command) => {
        commands.push(command)
      },
    })
    const [healthyId, unreadableId] = [randomUUID(), randomUUID()].sort()
    const applied = await schedules.apply({
      ...projection,
      id: healthyId!,
      cron: "hourly",
    })
    await schedules.apply({ ...projection, id: unreadableId!, cron: "hourly" })
    const database = new DatabaseSync(filename)
    database
      .prepare(
        "UPDATE relay_schedules SET definition_json = '{' WHERE schedule_id = ?"
      )
      .run(unreadableId!)
    database.exec(`CREATE TRIGGER fail_drop BEFORE DELETE ON relay_schedules
      BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END`)
    vi.setSystemTime(applied.nextRunAt!)
    const worker = Effect.runFork(schedules.run())
    try {
      await advanceUntil(async () => {
        expect(commands).toEqual(["say hello"])
        expect((await schedules.overview()).runs[0]?.status).toBe("succeeded")
      })
      expect(errors).toEqual(["Relay schedule claim failed"])
      database.exec("DROP TRIGGER fail_drop")
      await advanceUntil(async () => {
        const { deployments } = await schedules.overview()
        expect(deployments.map((d) => d.scheduleId)).toEqual([healthyId])
      }, 1_000)
      expect(commands).toEqual(["say hello"])
    } finally {
      database.close()
      await Effect.runPromise(Fiber.interrupt(worker))
    }
  })

  it("reports a long run and keeps its result after newer runs fill the history", async () => {
    const { filename, schedules } = await manager({
      findInstance: async () => ({}),
    })
    await schedules.apply({
      ...projection,
      enabled: false,
      actions: [waitAction(30, "minutes"), projection.actions[0]!],
    })
    const long = await runNow(schedules)
    const database = new DatabaseSync(filename)
    const insert = database.prepare(`INSERT INTO relay_schedule_runs
      (run_id, schedule_id, revision, scheduled_at, started_at, finished_at,
       status, sequence_attempts_json, target_runs_json)
      VALUES (?, ?, 1, ?, ?, ?, 'succeeded', '[]', '[]')`)
    for (let index = 0; index < 1_000; index++) {
      const at = Date.now() + 1 + index
      insert.run(randomUUID(), projection.id, at, at, at)
    }
    database.close()
    expect(
      (await schedules.overview()).runs.find((run) => run.id === long.id)
        ?.status
    ).toBe("running")
    await advanceUntil(async () => {
      const { runs } = await schedules.overview()
      expect(runs).toHaveLength(1_000)
      expect(runs[0]).toMatchObject({ id: long.id, status: "succeeded" })
    }, minuteMs)
  })

  it("drains due work in batches without losing occurrences behind executing runs", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const commands: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
        await blocked
      },
    })
    const definitions = Array.from({ length: 50 }, (_, index) => ({
      ...projection,
      id: randomUUID(),
      cron: "hourly",
      targets: [{ ...projection.targets[0]!, id: `server-${index}` }],
      actions: [
        {
          ...projection.actions[0]!,
          type: "console_command" as const,
          command: `say ${index}`,
        },
      ],
    }))
    const deployments = await Promise.all(
      definitions.map((definition) => schedules.apply(definition))
    )
    vi.setSystemTime(deployments[0]!.nextRunAt!)
    const fiber = Effect.runFork(schedules.run())
    try {
      await advanceUntil(() => expect(commands.length).toBeGreaterThan(0))
      await vi.advanceTimersByTimeAsync(1_000)
      release()
      await advanceUntil(async () => {
        const overview = await schedules.overview()
        expect([...commands].sort()).toEqual(
          definitions.map((_, index) => `say ${index}`).sort()
        )
        expect(overview.runs).toHaveLength(definitions.length)
        expect(overview.runs.every((run) => run.status === "succeeded")).toBe(
          true
        )
      }, 1_000)
    } finally {
      release()
      await Effect.runPromise(Fiber.interrupt(fiber))
      schedules.close()
    }
  })

  it("marks unfinished runs interrupted after a restart", async () => {
    const { schedules, restart } = await manager({
      findInstance: async () => ({}),
    })
    await schedules.apply({
      ...projection,
      actions: [waitAction(30, "minutes")],
    })
    await runNow(schedules)
    expect((await latestRun(schedules))?.status).toBe("running")
    schedules.close()
    const recovered = await restart()
    expect((await latestRun(recovered))?.status).toBe("interrupted")
  })

  it("imports legacy state and merges files an older Relay writes after a downgrade by revision", async () => {
    const removedId = "32483f84-1709-4546-85b7-7eebc19a6b1f"
    const otherId = "6f0d9a55-4be1-4a3e-9d4f-0f6c1f2b8a11"
    const legacy = {
      version: 1,
      lastHeartbeatAt: Date.now(),
      schedules: [
        { ...projection, nextRunAt: Date.now() + hourMs },
        { ...projection, id: otherId, nextRunAt: Date.now() + hourMs },
      ],
      tombstones: { [removedId]: 3 },
      runs: [
        {
          id: "legacy-run",
          scheduleId: projection.id,
          revision: 1,
          scheduledAt: Date.now() - minuteMs,
          startedAt: Date.now() - minuteMs,
          finishedAt: Date.now(),
          status: "succeeded",
          targetRuns: [],
        },
      ],
    }
    const { directory, schedules, restart } = await manager({ legacy })
    expect((await latestRun(schedules))?.id).toBe("legacy-run")
    expect(
      await schedules.apply({ ...projection, id: removedId, revision: 2 })
    ).toMatchObject({ acknowledgedRevision: 3, nextRunAt: null })
    await schedules.apply({ ...projection, revision: 2 })
    schedules.close()

    // A stale copy of the original file never moves a revision backward.
    await writeFile(join(directory, "schedules.json"), JSON.stringify(legacy))
    const stale = await restart()
    expect(
      (await stale.overview([projection.id])).deployments[0]
    ).toMatchObject({ acknowledgedRevision: 2 })
    stale.close()

    // After a downgrade the older Relay deletes one schedule and redeploys
    // the other at the same revision, as Hearth does to refresh credentials.
    // Its file is newer, so both changes survive the re-upgrade.
    const redeployedNextRunAt = Date.now() + 2 * hourMs
    await writeFile(
      join(directory, "schedules.json"),
      JSON.stringify({
        ...legacy,
        schedules: [
          {
            ...projection,
            id: otherId,
            nextRunAt: redeployedNextRunAt,
          },
        ],
        tombstones: { [projection.id]: 3 },
        runs: [],
      })
    )
    const recovered = await restart()
    const { deployments } = await recovered.overview()
    expect(deployments).toEqual([
      {
        scheduleId: otherId,
        acknowledgedRevision: 1,
        nextRunAt: redeployedNextRunAt,
      },
    ])
    expect(await recovered.apply({ ...projection, revision: 2 })).toMatchObject(
      { acknowledgedRevision: 3, nextRunAt: null }
    )
    expect((await latestRun(recovered))?.id).toBe("legacy-run")
    await expect(
      readFile(join(directory, "schedules.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      JSON.parse(
        await readFile(join(directory, "schedules.json.migrated"), "utf8")
      )
    ).toEqual(legacy)
  })

  it("rolls back a failed legacy import and retries it without losing the source", async () => {
    let filename = ""
    const legacy = {
      version: 1,
      lastHeartbeatAt: Date.now(),
      tombstones: {},
      schedules: [{ ...projection, nextRunAt: Date.now() + hourMs }],
      runs: [
        {
          id: "legacy-run",
          scheduleId: projection.id,
          revision: 1,
          scheduledAt: Date.now(),
          startedAt: Date.now(),
          finishedAt: Date.now(),
          status: "succeeded",
          targetRuns: [],
        },
      ],
    }
    await expect(
      manager({
        legacy,
        beforeMake: (path) => {
          filename = path
          const database = new DatabaseSync(path)
          database.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON relay_schedule_runs
        BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END`)
          database.close()
        },
      })
    ).rejects.toBeDefined()
    const database = new DatabaseSync(filename)
    expect(
      database.prepare("SELECT schedule_id FROM relay_schedules").all()
    ).toEqual([])
    expect(
      JSON.parse(
        await readFile(join(dirname(filename), "schedules.json"), "utf8")
      )
    ).toEqual(legacy)
    database.exec("DROP TRIGGER fail_import")
    database.close()
    const recovered = await manager({ directory: dirname(filename) })
    expect((await latestRun(recovered.schedules))?.status).toBe("succeeded")
    expect((await recovered.schedules.overview()).deployments).toHaveLength(1)
  })

  it("refuses to start while an imported legacy file cannot be retired", async () => {
    let archive = ""
    const legacy = {
      version: 1,
      lastHeartbeatAt: Date.now(),
      tombstones: {},
      schedules: [{ ...projection, nextRunAt: Date.now() + hourMs }],
      runs: [],
    }
    await expect(
      manager({
        legacy,
        beforeMake: (filename) => {
          archive = join(dirname(filename), "schedules.json.migrated")
          symlinkSync(archive, archive)
        },
      })
    ).rejects.toMatchObject({ code: "ELOOP" })
    const directory = dirname(archive)
    expect(
      JSON.parse(await readFile(join(directory, "schedules.json"), "utf8"))
    ).toEqual(legacy)
    await rm(archive)
    const recovered = await manager({ directory })
    expect((await recovered.schedules.overview()).deployments).toHaveLength(1)
    await expect(
      readFile(join(directory, "schedules.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("accepts a same-revision redeploy with refreshed backup credentials", async () => {
    const credentials = (key: string) => ({
      accessKeyId: key,
      allowPrivateNetwork: false,
      secretAccessKey: `secret-${key}`,
      bucket: "backups",
      region: "us-east-1",
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      kind: "s3" as const,
      objectKeyPrefix: "scheduled",
    })
    const definition: RelayScheduleProjection = {
      ...projection,
      cron: "hourly",
      targets: [
        projection.targets[0]!,
        { ...projection.targets[0]!, id: "server-b", name: "Server B" },
      ],
      actions: [
        {
          type: "backup",
          id: projection.actions[0]!.id,
          destination: { kind: "storage", storageId: randomUUID() },
          mode: "full",
          name: "Backups",
          executions: ["server-a", "server-b"].map((id) => ({
            targetId: id,
            targetKind: "instance",
            mode: "full",
            destination: credentials("old"),
          })),
        },
      ],
    }
    const { schedules } = await manager()
    const applied = await schedules.apply(definition)
    await vi.advanceTimersByTimeAsync(5_000)
    const refreshed: RelayScheduleProjection = {
      ...definition,
      targets: [...definition.targets].reverse(),
      actions: definition.actions.map((action) =>
        action.type !== "backup"
          ? action
          : {
              ...action,
              executions: [...action.executions].reverse().map((execution) => ({
                ...execution,
                destination: credentials("rotated"),
              })),
            }
      ),
    }
    expect(await schedules.apply(refreshed)).toEqual(applied)
    // Assert the caller-visible execution gets the new credential, not just an ACK.
    let usedKey: string | undefined
    const running = await manager({
      enqueueBackup: async (input) => {
        if (input.kind !== "create") throw new Error("unexpected backup")
        if (
          input.destination.kind === "s3" &&
          "accessKeyId" in input.destination
        )
          usedKey = input.destination.accessKeyId
        throw new Error("test boundary")
      },
      findInstance: async () => ({}),
    })
    await running.schedules.apply(definition)
    await running.schedules.apply(refreshed)
    await runNow(running.schedules)
    await advanceUntil(() => expect(usedKey).toBe("rotated"))
  })

  it("keeps valid history and definitions available when one history row is unreadable", async () => {
    const { filename, schedules } = await manager({
      findInstance: async () => ({}),
    })
    await schedules.apply(projection)
    const first = await runNow(schedules)
    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    )
    const second = await runNow(schedules)
    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    )
    const database = new DatabaseSync(filename)
    database
      .prepare(
        "UPDATE relay_schedule_runs SET target_runs_json = '{' WHERE run_id = ?"
      )
      .run(first.id)
    database.close()
    const overview = await schedules.overview()
    expect(overview.deployments[0]?.acknowledgedRevision).toBe(1)
    expect(overview.runs.map((run) => run.id)).toEqual([second.id])
  })

  it("ignores a stale apply or removal that arrives after a newer revision", async () => {
    const { schedules, restart } = await manager()
    const applied = await schedules.apply({ ...projection, revision: 3 })
    expect(await schedules.apply({ ...projection, revision: 2 })).toEqual(
      applied
    )
    expect(
      await schedules.remove({ scheduleId: projection.id, revision: 2 })
    ).toEqual(applied)
    schedules.close()
    const recovered = await restart()
    expect((await recovered.overview()).deployments).toEqual([applied])
    expect(
      await recovered.remove({ scheduleId: projection.id, revision: 3 })
    ).toEqual({ ...applied, nextRunAt: null })
    expect((await recovered.overview()).deployments).toEqual([])
  })

  it("retries a failed completion without re-executing actions and retains it after restart", async () => {
    const errors: Array<string> = []
    const commands: Array<string> = []
    const { filename, restart, schedules } = await manager({
      findInstance: async () => ({}),
      reportError: (message) => errors.push(message),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
        const database = new DatabaseSync(filename)
        database.exec(`CREATE TRIGGER fail_completion BEFORE INSERT ON relay_schedule_runs
          WHEN NEW.status <> 'running' BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END`)
        database.close()
      },
    })
    await schedules.apply({ ...projection, enabled: false })
    await runNow(schedules)
    await advanceUntil(async () =>
      expect(errors).toContain("Relay schedule completion write failed")
    )
    await vi.advanceTimersByTimeAsync(2 * minuteMs)
    const database = new DatabaseSync(filename)
    database.exec("DROP TRIGGER fail_completion")
    database.close()
    await advanceUntil(
      async () =>
        expect((await latestRun(schedules))?.status).toBe("succeeded"),
      1_000
    )
    schedules.close()
    const recovered = await restart()
    expect((await latestRun(recovered))?.status).toBe("succeeded")
    expect(commands).toEqual(["say hello"])
    expect(errors).toEqual(["Relay schedule completion write failed"])
    recovered.close()
  })

  it("bounds pending completions during a storage outage and releases capacity when storage recovers", async () => {
    const { filename, schedules } = await manager({
      findInstance: async () => ({}),
    })
    await schedules.apply({ ...projection, enabled: false })
    const database = new DatabaseSync(filename)
    database.exec(
      "CREATE TRIGGER pending_completions BEFORE INSERT ON relay_schedule_runs WHEN NEW.status <> 'running' BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END"
    )
    try {
      const runs = await Promise.all(
        Array.from({ length: 32 }, () => runNow(schedules))
      )
      await expect(runNow(schedules)).rejects.toThrow("capacity")
      await vi.advanceTimersByTimeAsync(5 * minuteMs)
      await expect(runNow(schedules)).rejects.toThrow("capacity")
      database.exec("DROP TRIGGER pending_completions")
      await advanceUntil(async () => {
        const overview = await schedules.overview()
        expect(overview.runs).toHaveLength(runs.length)
        expect(overview.runs.every((run) => run.status !== "running")).toBe(
          true
        )
      }, 1_000)
      await expect(runNow(schedules)).resolves.toMatchObject({
        status: "running",
      })
    } finally {
      database.close()
    }
  })

  it("persists due runs before execution and preserves completed history on restart", async () => {
    const commands: Array<string> = []
    const { restart, schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        expect((await latestRun(schedules))?.status).toBe("running")
        commands.push(command)
      },
    })
    const applied = await schedules.apply({ ...projection, cron: "* * * * *" })
    vi.setSystemTime(applied.nextRunAt!)
    const fiber = Effect.runFork(schedules.run())
    try {
      await advanceUntil(async () => {
        expect(commands).toEqual(["say hello"])
        expect((await latestRun(schedules))?.status).toBe("succeeded")
      })
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
      schedules.close()
    }

    const recovered = await restart()
    expect(await latestRun(recovered)).toMatchObject({
      scheduledAt: applied.nextRunAt,
      status: "succeeded",
    })
    expect((await recovered.overview()).deployments).toEqual(
      (await schedules.overview()).deployments
    )
    recovered.close()
  })

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

  it("backs off an ongoing claim failure and resumes after recovery", async () => {
    const errors: Array<string> = []
    const { filename, schedules } = await manager({
      reportError: (message) => errors.push(message),
    })
    const applied = await schedules.apply({ ...projection, cron: "* * * * *" })
    const database = new DatabaseSync(filename)
    database.exec(
      "CREATE TRIGGER persistent_claim_failure BEFORE UPDATE ON relay_schedules BEGIN SELECT RAISE(FAIL, 'busy'); END"
    )
    vi.setSystemTime(applied.nextRunAt!)
    const worker = Effect.runFork(schedules.run())
    try {
      await advanceUntil(() =>
        expect(errors).toEqual(["Relay schedule claim failed"])
      )
      await vi.advanceTimersByTimeAsync(5 * minuteMs)
      expect(errors).toEqual(["Relay schedule claim failed"])
      database.exec("DROP TRIGGER persistent_claim_failure")
      await advanceUntil(
        async () => expect((await latestRun(schedules))?.status).toBe("failed"),
        1_000
      )
    } finally {
      database.close()
      await Effect.runPromise(Fiber.interrupt(worker))
    }
  })

  it("evaluates cron in the Relay timezone", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z")
    vi.setSystemTime(now)
    const { schedules } = await manager()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    // Keep the persisted zone different from the host Relay zone so the
    // negative assertion cannot collapse into the Relay-timezone assertion.
    const storedTimezone =
      timezone === "Pacific/Honolulu" ? "UTC" : "Pacific/Honolulu"

    const applied = await schedules.apply({
      ...projection,
      cron: "0 0 * * *",
      timezone: storedTimezone,
    })

    expect(applied.nextRunAt).toBe(
      nextScheduleOccurrence("0 0 * * *", timezone, now).getTime()
    )
    expect(applied.nextRunAt).not.toBe(
      nextScheduleOccurrence("0 0 * * *", storedTimezone, now).getTime()
    )
  })

  it("keeps a tombstone from being replaced by an older revision", async () => {
    const { schedules } = await manager()
    await schedules.apply(projection)
    await schedules.remove({ revision: 3, scheduleId: projection.id })

    const stale = await schedules.apply({ ...projection, revision: 2 })

    expect(stale).toEqual({
      acknowledgedRevision: 3,
      nextRunAt: null,
      scheduleId: projection.id,
    })
    expect((await schedules.overview([projection.id])).deployments).toEqual([])
  })

  it("starts a deployed schedule immediately without changing its next run", async () => {
    const commands: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    const applied = await schedules.apply(projection)

    const started = await runNow(schedules)

    expect(started.status).toBe("running")
    expect(
      (await schedules.overview([projection.id])).deployments[0]?.nextRunAt
    ).toBe(applied.nextRunAt)
    await advanceUntil(async () => {
      expect(commands).toEqual(["say hello"])
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    })
  })

  it("runs live targets when another target no longer exists", async () => {
    const commands: Array<string> = []
    const { schedules } = await manager({
      findInstance: async (instanceId) =>
        instanceId === "server-a" ? {} : null,
      sendConsoleCommand: async (instanceId, command) => {
        commands.push(`${instanceId}:${command}`)
      },
    })
    await schedules.apply({
      ...projection,
      targets: [
        ...projection.targets,
        {
          id: "deleted-server",
          kind: "instance",
          name: "Deleted server",
          relayId: "relay-a",
        },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () => {
      expect(commands).toEqual(["server-a:say hello"])
      expect(await latestRun(schedules)).toMatchObject({
        status: "partial",
        targetRuns: [
          { status: "succeeded", target: { id: "server-a" } },
          { status: "failed", target: { id: "deleted-server" } },
        ],
      })
    })
  })

  it("holds later actions until the wait has elapsed", async () => {
    const commands: Array<{ command: string; sentAt: number }> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push({ command, sentAt: Date.now() })
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        projection.actions[0],
        waitAction(5, "minutes"),
        afterWaitCommand,
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () => expect(commands).toHaveLength(1))
    expect((await latestRun(schedules))?.status).toBe("running")

    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    }, minuteMs)
    expect(commands.map(({ command }) => command)).toEqual([
      "say hello",
      "say after wait",
    ])
    expect(
      (commands[1]?.sentAt ?? 0) - (commands[0]?.sentAt ?? 0)
    ).toBeGreaterThanOrEqual(5 * minuteMs)
    expect((await latestRun(schedules))?.sequenceAttempts).toMatchObject([
      { actionType: "wait", status: "succeeded" },
    ])
  })

  it("runs no actions while the Relay is paused", async () => {
    const commands: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      isPaused: () => true,
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    await schedules.apply(projection)

    await runNow(schedules)
    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).not.toBe("running")
    })
    expect(commands).toEqual([])
    expect((await latestRun(schedules))?.targetRuns[0]?.attempts).toMatchObject(
      [{ error: "Not run: the Relay is paused", status: "not_run" }]
    )
  })

  it("records a step a pause withdrew while it waited its turn as not run", async () => {
    const { schedules } = await manager({
      findInstance: async () => ({}),
      // Paused after the step checked, while it waited for its lane.
      runPower: async () => {
        throw new LaneRejectedError({
          message: "paused",
          reason: "paused",
        })
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          action: "restart",
          id: "0e9a7f5c-77e8-4b39-8c1a-6d5bb9c0b3a1",
          type: "power",
        },
      ],
    })

    await runNow(schedules)
    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).not.toBe("running")
    })
    const run = await latestRun(schedules)
    // Nothing ran, and nothing failed.
    expect(run?.status).toBe("noop")
    expect(run?.targetRuns[0]?.attempts).toMatchObject([
      { error: "Not run: the Relay is paused", status: "not_run" },
    ])
  })

  it("gives way to a power change someone makes during its wait", async () => {
    let intent = "manual-0"
    const ran: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      powerIntent: () => intent,
      // As the Relay does: a step runs only while the intent it was given
      // is still current.
      runPower: async (_kind, _id, action, powerIntent) => {
        if (powerIntent !== intent) {
          throw new LaneRejectedError({
            message: "superseded",
            reason: "superseded",
          })
        }
        ran.push(action)
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          action: "stop",
          id: "0e9a7f5c-77e8-4b39-8c1a-6d5bb9c0b3a1",
          type: "power",
        },
        waitAction(5, "minutes"),
        {
          action: "start",
          id: "6c1d2a9e-5f6b-4b0e-9d57-2a7c4f1e8b33",
          type: "power",
        },
      ],
    })

    await runNow(schedules)
    await advanceUntil(async () => expect(ran).toEqual(["stop"]))
    // Someone stops the server by hand while the schedule waits.
    intent = "manual-1"

    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).not.toBe("running")
    }, minuteMs)
    expect(ran).toEqual(["stop"])
    const run = await latestRun(schedules)
    expect(run?.status).toBe("succeeded")
    expect(run?.targetRuns[0]?.attempts).toMatchObject([
      { status: "succeeded" },
      { status: "not_run" },
    ])
  })

  it("finishes each action phase across targets before waiting", async () => {
    const commands: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    // More targets than the per-phase concurrency limit.
    const targets = Array.from({ length: 9 }, (_, index) => ({
      id: `server-${index + 1}`,
      kind: "instance" as const,
      name: `Server ${index + 1}`,
      relayId: "relay-a",
    }))
    await schedules.apply({
      ...projection,
      actions: [
        projection.actions[0],
        waitAction(1, "minutes"),
        afterWaitCommand,
      ],
      targets,
    })

    await runNow(schedules)

    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    }, minuteMs)
    expect(commands).toEqual([
      ...Array(9).fill("say hello"),
      ...Array(9).fill("say after wait"),
    ])
    expect((await latestRun(schedules))?.targetRuns).toHaveLength(9)
  })

  it("skips a wait when every target overlaps another occurrence", async () => {
    let releaseCommand: () => void = () => undefined
    const commandBlocked = new Promise<void>((resolve) => {
      releaseCommand = resolve
    })
    let commandStarted = false
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async () => {
        commandStarted = true
        await commandBlocked
      },
    })
    await schedules.apply({
      ...projection,
      actions: [projection.actions[0], waitAction(20, "milliseconds")],
    })

    const first = await runNow(schedules)
    await advanceUntil(async () => expect(commandStarted).toBe(true))
    const overlapping = await runNow(schedules)
    const findRun = async (id: string) =>
      (await schedules.overview([projection.id])).runs.find(
        (run) => run.id === id
      )

    await advanceUntil(async () =>
      expect((await findRun(overlapping.id))?.status).toBe("noop")
    )
    expect(await findRun(overlapping.id)).toMatchObject({
      sequenceAttempts: [{ actionType: "wait", status: "not_run" }],
      targetRuns: [{ status: "skipped_overlap" }],
    })

    releaseCommand()
    await advanceUntil(
      async () => expect((await findRun(first.id))?.status).toBe("succeeded"),
      1_000
    )
  })

  it("skips waits after every target has failed", async () => {
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async () => {
        throw new Error("Command failed")
      },
    })
    await schedules.apply({
      ...projection,
      actions: [projection.actions[0], waitAction(20, "milliseconds")],
    })

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("failed")
    )
    expect(await latestRun(schedules)).toMatchObject({
      sequenceAttempts: [{ actionType: "wait", status: "not_run" }],
      targetRuns: [{ status: "failed" }],
    })
  })

  it("runs later actions after a failure when the schedule continues on failure", async () => {
    const commands: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
        if (command === "say hello") throw new Error("Command failed")
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        projection.actions[0],
        waitAction(20, "milliseconds"),
        afterWaitCommand,
      ],
      continueOnFailure: true,
    })

    await runNow(schedules)

    await advanceUntil(
      async () => expect((await latestRun(schedules))?.status).toBe("failed"),
      20
    )
    expect(commands).toEqual(["say hello", "say after wait"])
    expect(await latestRun(schedules)).toMatchObject({
      sequenceAttempts: [{ actionType: "wait", status: "succeeded" }],
      targetRuns: [
        {
          attempts: [
            { error: "Command failed", status: "failed" },
            { error: null, status: "succeeded" },
          ],
          error: "Command failed",
          status: "failed",
        },
      ],
    })
  })

  it("keeps a successful wait-only run as a noop", async () => {
    const { schedules } = await manager({ findInstance: async () => ({}) })
    await schedules.apply({
      ...projection,
      actions: [waitAction(1, "milliseconds")],
    })

    await runNow(schedules)

    await advanceUntil(
      async () => expect((await latestRun(schedules))?.status).toBe("noop"),
      1_000
    )
    expect(await latestRun(schedules)).toMatchObject({
      sequenceAttempts: [{ actionType: "wait", status: "succeeded" }],
      targetRuns: [{ status: "noop" }],
    })
  })

  it("does not run an action on targets disabled by its override", async () => {
    const commands: Array<string> = []
    const { schedules } = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          command: "say hello",
          id: "8ff172c1-dc22-45fa-8457-b899ca25a8f8",
          targetKeys: [],
          type: "console_command",
        },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).toBe("noop")
    })
    expect(commands).toEqual([])
    expect(
      (await latestRun(schedules))?.targetRuns[0]?.attempts[0]?.status
    ).toBe("skipped_policy")
  })

  it("runs a deployed incremental backup with its prepared destination", async () => {
    const inputs: Array<BackupTaskInput> = []
    const { schedules } = await manager({
      enqueueBackup: async (input) => {
        inputs.push(input)
        return {
          status: "succeeded",
          taskId: input.taskId,
        } as RelayBackupTask
      },
      findInstance: async () => ({}),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: {
            kind: "storage",
            storageId: "87949dc0-3b2a-4b57-999c-f9bfaf487880",
          },
          executions: [
            {
              destination: {
                kind: "restic",
                repository: { kind: "local" },
                repositoryPassword: "repository-secret",
              },
              mode: "incremental",
              targetId: "server-a",
              targetKind: "instance",
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "incremental",
          name: "scheduled-<schedule>-<timestamp>",
          type: "backup",
        },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      artifactKind: "restic_snapshot",
      catalog: {
        name: expect.stringMatching(
          /^scheduled-Daily greeting-\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}Z$/u
        ),
        storageId: "87949dc0-3b2a-4b57-999c-f9bfaf487880",
      },
      destination: {
        artifactId: expect.any(String),
        kind: "restic",
        repositoryPassword: "repository-secret",
      },
      mode: "incremental",
    })
  })

  it("runs a deployed full backup with stored S3 credentials", async () => {
    const inputs: Array<BackupTaskInput> = []
    const { schedules } = await manager({
      enqueueBackup: async (input) => {
        inputs.push(input)
        return {
          status: "succeeded",
          taskId: input.taskId,
        } as RelayBackupTask
      },
      findInstance: async () => ({}),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: {
            kind: "storage",
            storageId: "87949dc0-3b2a-4b57-999c-f9bfaf487880",
          },
          executions: [
            {
              destination: {
                accessKeyId: "AKIDEXAMPLE",
                allowPrivateNetwork: false,
                bucket: "kiln-backups",
                endpoint: "https://s3.example.com",
                forcePathStyle: false,
                kind: "s3",
                objectKeyPrefix: "team/kiln/test/relay/instance/server-a",
                region: "us-east-1",
                secretAccessKey: "storage-secret",
              },
              mode: "full",
              targetId: "server-a",
              targetKind: "instance",
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "full",
          name: "scheduled-<schedule>-<timestamp>",
          type: "backup",
        },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).toBe("succeeded")
    })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      artifactKind: "archive",
      catalog: {
        storageId: "87949dc0-3b2a-4b57-999c-f9bfaf487880",
      },
      destination: {
        accessKeyId: "AKIDEXAMPLE",
        artifactId: expect.any(String),
        bucket: "kiln-backups",
        kind: "s3",
        objectKey: expect.stringMatching(
          /^team\/kiln\/test\/relay\/instance\/server-a\/[a-f0-9-]{36}\/backup-[a-f0-9]{8}\.zip$/u
        ),
        secretAccessKey: "storage-secret",
      },
      mode: "full",
    })
  })

  it("doesn't run a backup step Hearth refused, and says why", async () => {
    const enqueued: Array<unknown> = []
    const { schedules } = await manager({
      enqueueBackup: async (input) => {
        enqueued.push(input)
        return { status: "succeeded", taskId: input.taskId } as RelayBackupTask
      },
      findInstance: async () => ({}),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: { kind: "local" },
          executions: [
            {
              destination: null,
              mode: "full",
              refusal: "backups are turned off for it",
              targetId: "server-a",
              targetKind: "instance",
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "full",
          name: "Scheduled archive",
          type: "backup",
        },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () => {
      expect(
        (await latestRun(schedules))?.targetRuns[0]?.attempts[0]
      ).toMatchObject({
        error: "Not run: backups are turned off for it",
        status: "not_run",
      })
    })
    expect(enqueued).toEqual([])
  })

  it("keeps the newest generation Hearth sent when an older one arrives late", async () => {
    const enqueued: Array<unknown> = []
    const { schedules } = await manager({
      enqueueBackup: async (input) => {
        enqueued.push(input)
        return { status: "succeeded", taskId: input.taskId } as RelayBackupTask
      },
      findInstance: async () => ({}),
    })
    const backup = (execution: Record<string, unknown>) => ({
      ...projection,
      actions: [
        {
          destination: { kind: "local" as const },
          executions: [
            {
              destination: { kind: "local" as const },
              mode: "full" as const,
              targetId: "server-a",
              targetKind: "instance" as const,
              ...execution,
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "full" as const,
          name: "Scheduled archive",
          type: "backup" as const,
        },
      ],
    })

    // Backups were turned off (generation 2) after Hearth had started
    // sending the schedule that allowed them (generation 1), which arrives
    // second.
    await schedules.apply({
      ...backup({
        destination: null,
        refusal: "backups are turned off for it",
      }),
      generation: 2,
    })
    const late = await schedules.apply({ ...backup({}), generation: 1 })
    await runNow(schedules)

    expect(late.acknowledgedGeneration).toBe(2)
    // Its overview, which Hearth imports, says so too.
    expect(
      (await schedules.overview()).deployments[0]?.acknowledgedGeneration
    ).toBe(2)
    await advanceUntil(async () => {
      expect(
        (await latestRun(schedules))?.targetRuns[0]?.attempts[0]?.status
      ).toBe("not_run")
    })
    expect(enqueued).toEqual([])
  })

  it("queues a scheduled backup with the size ceiling and repository Hearth admitted", async () => {
    const enqueued: Array<BackupTaskInput> = []
    const { schedules } = await manager({
      enqueueBackup: async (input) => {
        enqueued.push(input)
        return { status: "succeeded", taskId: input.taskId } as RelayBackupTask
      },
      findInstance: async () => ({}),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: { kind: "local" },
          executions: [
            {
              destination: {
                kind: "restic",
                repository: { kind: "local" },
                repositoryPassword: "repository-password",
              },
              maxBytes: 4_096,
              mode: "incremental",
              repositoryId: "44444444-4444-4444-8444-444444444444",
              targetId: "server-a",
              targetKind: "instance",
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "incremental",
          name: "Scheduled snapshot",
          type: "backup",
        },
      ],
    })

    await runNow(schedules)

    await advanceUntil(() => {
      expect(enqueued).toHaveLength(1)
    })
    expect(enqueued[0]).toMatchObject({
      catalog: { repositoryId: "44444444-4444-4444-8444-444444444444" },
      maxBytes: 4_096,
      mode: "incremental",
    })
  })

  it("fails a scheduled backup that never finishes", async () => {
    const { schedules } = await manager({
      enqueueBackup: async (input) =>
        ({ status: "queued", taskId: input.taskId }) as RelayBackupTask,
      findInstance: async () => ({}),
      // A wedged queue: the status lookup never settles.
      getBackup: () => new Promise<RelayBackupTask | null>(() => undefined),
    })
    await schedules.apply({
      ...projection,
      actions: [
        {
          destination: { kind: "local" },
          executions: [
            {
              destination: { kind: "local" },
              mode: "full",
              targetId: "server-a",
              targetKind: "instance",
            },
          ],
          id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
          mode: "full",
          name: "Scheduled archive",
          type: "backup",
        },
      ],
    })

    await runNow(schedules)

    await advanceUntil(async () => {
      expect((await latestRun(schedules))?.status).toBe("failed")
    }, hourMs)
    expect(
      (await latestRun(schedules))?.targetRuns[0]?.attempts[0]?.status
    ).toBe("failed")
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
    // Saved before commands and kills reached databases: no step names its
    // targets, so each meant the game server alone.
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

  it("runs a step naming a database there only once Hearth has checked it", async () => {
    const containerCommands: Array<string> = []
    const power: Array<string> = []
    const { schedules } = await manager({
      listDatabaseIds: async () => new Set([databaseId]),
      runContainerCommand: async (_target, command) => {
        containerCommands.push(command)
        return { exitCode: 0, output: "", truncated: false, unknown: null }
      },
      runPower: async (kind, id, action) => {
        power.push(`${kind}:${id}:${action}`)
      },
    })
    // Saved before commands and kills reached databases: the old schema
    // took the database's key, and nothing checked it because it was
    // skipped.
    const legacy = [
      {
        command: "./legacy",
        id: "5d8f43a2-6a0e-4d36-9c11-3b1f4f5e2a10",
        targetKeys: [databaseKey],
        type: "console_command" as const,
      },
      {
        action: "kill" as const,
        id: "0e9a7f5c-77e8-4b39-8c1a-6d5bb9c0b3a1",
        targetKeys: [databaseKey],
        type: "power" as const,
      },
    ]
    await schedules.apply({ ...databaseCommands, actions: legacy })
    await runNow(schedules)
    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("noop")
    )
    expect(containerCommands).toEqual([])
    expect(power).toEqual([])

    // The same steps, saved by Hearth now.
    await schedules.apply({
      ...databaseCommands,
      actions: legacy.map((action) => ({ ...action, authorizedTargets: 2 })),
      revision: 2,
    })
    await schedules.runNow({ revision: 2, scheduleId: projection.id })
    await advanceUntil(() => expect(power).toHaveLength(1))
    expect(containerCommands).toEqual(["./legacy"])
    expect(power).toEqual([`database:${databaseId}:kill`])
  })

  it("records each command's exit code and output, and stops at one whose outcome is unknown", async () => {
    const commands: Array<string> = []
    const { schedules } = await manager({
      listDatabaseIds: async () => new Set([databaseId]),
      runContainerCommand: async (target, command) => {
        expect(target).toEqual({ id: databaseId, kind: "database" })
        commands.push(command)
        return command === "./migrate"
          ? { exitCode: 0, output: "migrated\n", truncated: false, unknown: null }
          : {
              exitCode: null,
              output: "vacuuming",
              truncated: false,
              unknown: "The command didn't finish within 10 minutes",
            }
      },
    })
    await schedules.apply(databaseCommands)

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("failed")
    )
    expect(commands).toEqual(["./migrate", "./vacuum"])
    expect((await latestRun(schedules))?.targetRuns[0]).toMatchObject({
      attempts: [
        {
          result: { exitCode: 0, output: "migrated\n", truncated: false },
          status: "succeeded",
        },
        {
          error: "The command didn't finish within 10 minutes",
          result: { exitCode: null, output: "vacuuming" },
          status: "unknown",
        },
        { error: "A previous action failed", status: "not_run" },
      ],
      status: "failed",
    })
  })

  it("refuses to send a command it couldn't record first", async () => {
    const commands: Array<string> = []
    const reported: Array<string> = []
    const { schedules } = await manager({
      listDatabaseIds: async () => new Set([databaseId]),
      reportError: (message) => reported.push(message),
      runContainerCommand: async (_target, command) => {
        commands.push(command)
        return { exitCode: 0, output: "", truncated: false, unknown: null }
      },
      state: (state) => ({
        ...state,
        recordProgress: () =>
          Effect.fail(
            RelayStateError.make({
              cause: new Error("disk I/O error"),
              operation: "schedules.record_progress",
            })
          ),
      }),
    })
    await schedules.apply(databaseCommands)

    await runNow(schedules)

    await advanceUntil(async () =>
      expect((await latestRun(schedules))?.status).toBe("failed")
    , 1_000)
    expect(commands).toEqual([])
    expect(reported).toContain("Relay schedule progress write failed")
    expect((await latestRun(schedules))?.targetRuns[0]?.attempts).toMatchObject(
      [
        {
          error:
            "Not run: the Relay couldn't record the command before sending it",
          status: "failed",
        },
        { status: "not_run" },
        { status: "not_run" },
      ]
    )
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
