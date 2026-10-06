import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import type {
  BackupTaskInput,
  RelayBackupTask,
  RelayScheduleProjection,
} from "@workspace/contracts"
import { nextScheduleOccurrence } from "@workspace/contracts"

import { ScheduleManager } from "./schedules.js"

const directories: Array<string> = []
const minuteMs = 60_000
const hourMs = 60 * minuteMs

beforeEach(() => {
  // Only virtual time is faked; immediates and file I/O stay real so the
  // Effect scheduler and schedule persistence keep running.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
  vi.setSystemTime(new Date("2026-01-15T12:00:30.000Z"))
})

afterEach(async () => {
  vi.useRealTimers()
  // A finished run is visible before its final atomic write lands, so retry
  // cleanup if that write races the removal.
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
async function advanceUntil(assertion: () => void, stepMs = 0) {
  const startedAt = performance.now()
  while (true) {
    try {
      assertion()
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
    enqueueBackup: (input: BackupTaskInput) => Promise<RelayBackupTask>
    findInstance: (instanceId: string) => Promise<object | null>
    getBackup: (taskId: string) => Promise<RelayBackupTask | null>
    reportError: (message: string, cause: unknown) => void
    sendConsoleCommand: (instanceId: string, command: string) => Promise<void>
  }> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-schedules-"))
  directories.push(directory)
  const schedules = await ScheduleManager.make({
    enqueueBackup:
      overrides.enqueueBackup ??
      (async () => {
        throw new Error("not used")
      }),
    findInstance: overrides.findInstance ?? (async () => null),
    getBackup: overrides.getBackup ?? (async () => null),
    listDatabaseIds: async () => new Set(),
    platformTargetId: "platform",
    relayId: "relay-a",
    reportError: overrides.reportError,
    runDatabasePower: async () => undefined,
    runInstancePower: async () => undefined,
    sendConsoleCommand: overrides.sendConsoleCommand ?? (async () => undefined),
    stateDirectory: directory,
  })
  return { directory, schedules }
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

function latestRun(schedules: ScheduleManager) {
  return schedules.overview([projection.id]).runs[0]
}

function runNow(schedules: ScheduleManager) {
  return schedules.runNow({
    revision: projection.revision,
    scheduleId: projection.id,
  })
}

describe("Relay schedule persistence", () => {
  it("keeps running due schedules after a failed tick", async () => {
    const commands: Array<string> = []
    const reportError = vi.fn()
    const { directory, schedules } = await manager({
      findInstance: async () => ({}),
      reportError,
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    await schedules.apply({ ...projection, cron: "* * * * *" })
    const statePath = join(directory, "schedules.json")
    await rm(statePath, { force: true })
    await mkdir(statePath)

    const fiber = Effect.runFork(schedules.run())
    try {
      await advanceUntil(() => expect(reportError).toHaveBeenCalled(), 1_000)
      expect(commands).toEqual([])

      await rm(statePath, { force: true, recursive: true })
      await advanceUntil(() => expect(commands).toEqual(["say hello"]), 1_000)
    } finally {
      fiber.interruptUnsafe()
      schedules.close()
    }
  })

  it("applies a revision and reports its Relay-owned next run", async () => {
    const { schedules } = await manager()
    const applied = await schedules.apply(projection)

    expect(applied.acknowledgedRevision).toBe(1)
    expect(applied.nextRunAt).toBeTypeOf("number")
    expect(schedules.overview([projection.id]).deployments).toEqual([applied])
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
    expect(schedules.overview([projection.id]).deployments).toEqual([])
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
    expect(schedules.overview([projection.id]).deployments[0]?.nextRunAt).toBe(
      applied.nextRunAt
    )
    await advanceUntil(() => {
      expect(commands).toEqual(["say hello"])
      expect(latestRun(schedules)?.status).toBe("succeeded")
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

    await advanceUntil(() => {
      expect(commands).toEqual(["server-a:say hello"])
      expect(latestRun(schedules)).toMatchObject({
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

    await advanceUntil(() => expect(commands).toHaveLength(1))
    expect(latestRun(schedules)?.status).toBe("running")

    await advanceUntil(() => {
      expect(latestRun(schedules)?.status).toBe("succeeded")
    }, minuteMs)
    expect(commands.map(({ command }) => command)).toEqual([
      "say hello",
      "say after wait",
    ])
    expect(
      (commands[1]?.sentAt ?? 0) - (commands[0]?.sentAt ?? 0)
    ).toBeGreaterThanOrEqual(5 * minuteMs)
    expect(latestRun(schedules)?.sequenceAttempts).toMatchObject([
      { actionType: "wait", status: "succeeded" },
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

    await advanceUntil(() => {
      expect(latestRun(schedules)?.status).toBe("succeeded")
    }, minuteMs)
    expect(commands).toEqual([
      ...Array(9).fill("say hello"),
      ...Array(9).fill("say after wait"),
    ])
    expect(latestRun(schedules)?.targetRuns).toHaveLength(9)
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
    await advanceUntil(() => expect(commandStarted).toBe(true))
    const overlapping = await runNow(schedules)
    const findRun = (id: string) =>
      schedules.overview([projection.id]).runs.find((run) => run.id === id)

    await advanceUntil(() =>
      expect(findRun(overlapping.id)?.status).toBe("noop")
    )
    expect(findRun(overlapping.id)).toMatchObject({
      sequenceAttempts: [{ actionType: "wait", status: "not_run" }],
      targetRuns: [{ status: "skipped_overlap" }],
    })

    releaseCommand()
    await advanceUntil(
      () => expect(findRun(first.id)?.status).toBe("succeeded"),
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

    await advanceUntil(() =>
      expect(latestRun(schedules)?.status).toBe("failed")
    )
    expect(latestRun(schedules)).toMatchObject({
      sequenceAttempts: [{ actionType: "wait", status: "not_run" }],
      targetRuns: [{ status: "failed" }],
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
      () => expect(latestRun(schedules)?.status).toBe("noop"),
      1_000
    )
    expect(latestRun(schedules)).toMatchObject({
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

    await advanceUntil(() => {
      expect(latestRun(schedules)?.status).toBe("noop")
    })
    expect(commands).toEqual([])
    expect(latestRun(schedules)?.targetRuns[0]?.attempts[0]?.status).toBe(
      "skipped_policy"
    )
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

    await advanceUntil(() => {
      expect(latestRun(schedules)?.status).toBe("succeeded")
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

    await advanceUntil(() => {
      expect(latestRun(schedules)?.status).toBe("succeeded")
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

    await advanceUntil(() => {
      expect(latestRun(schedules)?.status).toBe("failed")
    }, hourMs)
    expect(latestRun(schedules)?.targetRuns[0]?.attempts[0]?.status).toBe(
      "failed"
    )
  })
})
