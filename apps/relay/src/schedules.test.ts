import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import type {
  BackupTaskInput,
  RelayBackupTask,
  RelayScheduleProjection,
} from "@workspace/contracts"
import {
  nextScheduleOccurrence,
  resolveScheduleBackupName,
  scheduleActionAppliesToTarget,
  scheduleActionSchema,
  scheduleActionSupportsTarget,
} from "@workspace/contracts"

import { ScheduleManager } from "./schedules.js"

const directories: Array<string> = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function manager(
  overrides: Partial<{
    backupPollIntervalMs: number
    backupWaitTimeoutMs: number
    enqueueBackup: (input: BackupTaskInput) => Promise<RelayBackupTask>
    findInstance: (instanceId: string) => Promise<object | null>
    getBackup: (taskId: string) => Promise<RelayBackupTask | null>
    reportError: (message: string, cause: unknown) => void
    sendConsoleCommand: (instanceId: string, command: string) => Promise<void>
    tickIntervalMs: number
    tickRetryBaseMs: number
  }> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-schedules-"))
  directories.push(directory)
  return ScheduleManager.make({
    backupPollIntervalMs: overrides.backupPollIntervalMs,
    backupWaitTimeoutMs: overrides.backupWaitTimeoutMs,
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
    tickIntervalMs: overrides.tickIntervalMs,
    tickRetryBaseMs: overrides.tickRetryBaseMs,
  })
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

describe("Relay schedule persistence", () => {
  it("does not clone retained state during idle ticks", async () => {
    const schedules = await manager({ tickIntervalMs: 5 })
    const clone = vi.spyOn(globalThis, "structuredClone")

    const fiber = Effect.runFork(schedules.run())
    await Effect.runPromise(Effect.sleep("30 millis"))
    fiber.interruptUnsafe()

    expect(clone).not.toHaveBeenCalled()
  })

  it("keeps the scheduler fiber alive when a tick fails", async () => {
    const reportError = vi.fn()
    const schedules = await manager({
      reportError,
      tickIntervalMs: 5,
      tickRetryBaseMs: 1,
    })
    const directory = directories.at(-1)
    if (!directory) throw new Error("Missing schedule test directory")
    const statePath = join(directory, "schedules.json")
    await rm(statePath, { force: true })
    await mkdir(statePath)

    const fiber = Effect.runFork(schedules.run())
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled(), {
      timeout: 500,
    })

    expect(fiber.pollUnsafe()).toBeUndefined()
    fiber.interruptUnsafe()
  })

  it("applies a revision and reports its Relay-owned next run", async () => {
    const schedules = await manager()
    const applied = await schedules.apply(projection)

    expect(applied.acknowledgedRevision).toBe(1)
    expect(applied.nextRunAt).toBeTypeOf("number")
    expect(schedules.overview([projection.id]).deployments).toEqual([applied])
  })

  it("evaluates cron in the Relay timezone", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z")
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const schedules = await manager()
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
    const schedules = await manager()
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
    const schedules = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push(command)
      },
    })
    const applied = await schedules.apply(projection)

    const started = await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    expect(started.status).toBe("running")
    expect(schedules.overview([projection.id]).deployments[0]?.nextRunAt).toBe(
      applied.nextRunAt
    )
    await vi.waitFor(() => {
      expect(commands).toEqual(["say hello"])
      expect(schedules.overview([projection.id]).runs[0]?.status).toBe(
        "succeeded"
      )
    })
  })

  it("runs live targets when another target no longer exists", async () => {
    const commands: Array<string> = []
    const schedules = await manager({
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

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(commands).toEqual(["server-a:say hello"])
      expect(schedules.overview([projection.id]).runs[0]).toMatchObject({
        status: "partial",
        targetRuns: [
          { status: "succeeded", target: { id: "server-a" } },
          {
            error: "Target no longer exists",
            status: "failed",
            target: { id: "deleted-server" },
          },
        ],
      })
    })
  })

  it("waits between actions without delaying the server", async () => {
    const commands: Array<{ command: string; timestamp: number }> = []
    const schedules = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (_instanceId, command) => {
        commands.push({ command, timestamp: Date.now() })
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        projection.actions[0],
        {
          duration: 20,
          id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
          type: "wait",
          unit: "milliseconds",
        },
        {
          command: "say after wait",
          id: "3c99d222-3d12-4fb6-a5f7-9d18078d7e90",
          type: "console_command",
        },
      ],
    })

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(commands).toHaveLength(2)
      expect(schedules.overview([projection.id]).runs[0]?.status).toBe(
        "succeeded"
      )
    })
    expect(commands.map(({ command }) => command)).toEqual([
      "say hello",
      "say after wait",
    ])
    expect(
      (commands[1]?.timestamp ?? 0) - (commands[0]?.timestamp ?? 0)
    ).toBeGreaterThanOrEqual(15)
    const run = schedules.overview([projection.id]).runs[0]
    expect(run?.sequenceAttempts).toMatchObject([
      { actionType: "wait", status: "succeeded" },
    ])
    expect(
      run?.targetRuns[0]?.attempts.map((attempt) => attempt.actionType)
    ).toEqual(["console_command", "console_command"])
  })

  it("finishes each action phase across targets before waiting", async () => {
    const commands: Array<{ command: string; instanceId: string }> = []
    const schedules = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async (instanceId, command) => {
        commands.push({ command, instanceId })
      },
    })
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
        {
          duration: 20,
          id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
          type: "wait",
          unit: "milliseconds",
        },
        {
          command: "say after wait",
          id: "3c99d222-3d12-4fb6-a5f7-9d18078d7e90",
          type: "console_command",
        },
      ],
      targets,
    })

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(commands).toHaveLength(18)
      expect(schedules.overview([projection.id]).runs[0]?.status).toBe(
        "succeeded"
      )
    })
    expect(commands.slice(0, 9).map(({ command }) => command)).toEqual(
      Array(9).fill("say hello")
    )
    expect(commands.slice(9).map(({ command }) => command)).toEqual(
      Array(9).fill("say after wait")
    )
    const run = schedules.overview([projection.id]).runs[0]
    expect(run?.sequenceAttempts).toHaveLength(1)
    expect(run?.targetRuns).toHaveLength(9)
    expect(
      run?.targetRuns.every(
        (targetRun) =>
          targetRun.attempts.length === 2 &&
          targetRun.attempts.every(
            (attempt) => attempt.actionType === "console_command"
          )
      )
    ).toBe(true)
  })

  it("skips a wait when every target overlaps another occurrence", async () => {
    let releaseCommand: () => void = () => undefined
    const commandBlocked = new Promise<void>((resolve) => {
      releaseCommand = resolve
    })
    let markCommandStarted: () => void = () => undefined
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve
    })
    const schedules = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async () => {
        markCommandStarted()
        await commandBlocked
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        projection.actions[0],
        {
          duration: 20,
          id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
          type: "wait",
          unit: "milliseconds",
        },
      ],
    })

    const first = await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })
    await commandStarted
    const overlapping = await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(
        schedules
          .overview([projection.id])
          .runs.find((run) => run.id === overlapping.id)?.status
      ).toBe("noop")
    })
    const overlappingRun = schedules
      .overview([projection.id])
      .runs.find((run) => run.id === overlapping.id)
    expect(overlappingRun?.targetRuns[0]?.status).toBe("skipped_overlap")
    expect(overlappingRun?.sequenceAttempts).toMatchObject([
      {
        actionType: "wait",
        error: "No targets can continue",
        status: "not_run",
      },
    ])

    releaseCommand()
    await vi.waitFor(() => {
      expect(
        schedules
          .overview([projection.id])
          .runs.find((run) => run.id === first.id)?.status
      ).toBe("succeeded")
    })
  })

  it("skips waits after every target has failed", async () => {
    const schedules = await manager({
      findInstance: async () => ({}),
      sendConsoleCommand: async () => {
        throw new Error("Command failed")
      },
    })
    await schedules.apply({
      ...projection,
      actions: [
        projection.actions[0],
        {
          duration: 20,
          id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
          type: "wait",
          unit: "milliseconds",
        },
      ],
    })

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(schedules.overview([projection.id]).runs[0]?.status).toBe("failed")
    })
    const run = schedules.overview([projection.id]).runs[0]
    expect(run?.targetRuns[0]?.status).toBe("failed")
    expect(run?.sequenceAttempts).toMatchObject([
      {
        actionType: "wait",
        error: "No targets can continue",
        status: "not_run",
      },
    ])
  })

  it("keeps a successful wait-only run as a noop", async () => {
    const schedules = await manager({ findInstance: async () => ({}) })
    await schedules.apply({
      ...projection,
      actions: [
        {
          duration: 1,
          id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
          type: "wait",
          unit: "milliseconds",
        },
      ],
    })

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(schedules.overview([projection.id]).runs[0]?.status).toBe("noop")
    })
    const run = schedules.overview([projection.id]).runs[0]
    expect(run?.targetRuns[0]?.status).toBe("noop")
    expect(run?.sequenceAttempts).toMatchObject([
      { actionType: "wait", status: "succeeded" },
    ])
  })

  it("does not run an action on targets disabled by its override", async () => {
    const commands: Array<string> = []
    const schedules = await manager({
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

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      expect(commands).toEqual([])
      expect(schedules.overview([projection.id]).runs[0]?.status).toBe("noop")
      expect(
        schedules.overview([projection.id]).runs[0]?.targetRuns[0]?.attempts[0]
          ?.status
      ).toBe("skipped_policy")
    })
  })

  it("runs a deployed incremental backup with its prepared destination", async () => {
    const inputs: Array<BackupTaskInput> = []
    const schedules = await manager({
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

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
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
  })

  it("runs a deployed full backup with stored S3 credentials", async () => {
    const inputs: Array<BackupTaskInput> = []
    const schedules = await manager({
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

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
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
  })

  it("fails a wedged scheduled backup after the configured timeout", async () => {
    const schedules = await manager({
      backupPollIntervalMs: 5,
      backupWaitTimeoutMs: 20,
      enqueueBackup: async (input) =>
        ({ status: "queued", taskId: input.taskId }) as RelayBackupTask,
      findInstance: async () => ({}),
      getBackup: async (taskId) =>
        ({ status: "running", taskId }) as RelayBackupTask,
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

    await schedules.runNow({
      revision: projection.revision,
      scheduleId: projection.id,
    })

    await vi.waitFor(() => {
      const run = schedules.overview([projection.id]).runs[0]
      expect(run?.status).toBe("failed")
      expect(run?.targetRuns[0]?.attempts[0]?.error).toBe(
        "Scheduled backup timed out"
      )
    })
  })
})

describe("schedule action schema", () => {
  it("normalizes a blank legacy backup name", () => {
    expect(
      scheduleActionSchema.parse({
        destination: { kind: "local" },
        id: "6cc00681-a2cd-40c7-a036-7c9bd09b269b",
        mode: "full",
        name: "   ",
        type: "backup",
      })
    ).toMatchObject({ name: "Scheduled backup" })
  })

  it("defaults wait actions to seconds", () => {
    expect(
      scheduleActionSchema.parse({
        duration: 4,
        id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
        type: "wait",
      })
    ).toEqual({
      duration: 4,
      id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
      type: "wait",
      unit: "seconds",
    })
  })
})

describe("scheduled action target support", () => {
  it("uses backup mode and power action when checking compatibility", () => {
    expect(
      scheduleActionSupportsTarget(
        { mode: "incremental", type: "backup" },
        { kind: "database" }
      )
    ).toBe(false)
    expect(
      scheduleActionSupportsTarget(
        { mode: "full", type: "backup" },
        { kind: "database" }
      )
    ).toBe(true)
    expect(
      scheduleActionSupportsTarget(
        { action: "kill", type: "power" },
        { kind: "database" }
      )
    ).toBe(false)
  })

  it("honors explicit target overrides after compatibility checks", () => {
    const target = projection.targets[0]
    expect(
      scheduleActionAppliesToTarget(
        { targetKeys: [], type: "console_command" },
        target
      )
    ).toBe(false)
    expect(
      scheduleActionAppliesToTarget(
        {
          targetKeys: [`${target.relayId}:${target.kind}:${target.id}`],
          type: "console_command",
        },
        target
      )
    ).toBe(true)
  })

  it("expands scheduled backup name tags", () => {
    expect(
      resolveScheduleBackupName(
        "scheduled-<schedule>-<timestamp>-<backup_id>-<instance_id>-<run_id>-<schedule_id>",
        {
          backupId: "backup-1",
          instanceId: "instance-1",
          runId: "run-1",
          scheduleId: "schedule-1",
          scheduleName: "Nightly",
          timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
        }
      )
    ).toBe(
      "scheduled-Nightly-2026.01.02-03.04.05Z-backup-1-instance-1-run-1-schedule-1"
    )
  })
})
