import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  defaultAppConfig,
  relayCreateDatabaseSchema,
  relayDeployAppSchema,
} from "@workspace/contracts"
import type { RelayScheduleProjection } from "@workspace/contracts/schedules"
import { Effect } from "effect"
import {
  afterEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { controlRequestLocks } from "./operation-plans.js"
import { ScheduleManager } from "./schedules.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const scheduleId = "14bb1e12-fab9-45f3-8f85-ae22d2f074e5"

afterEach(() => {
  vi.useRealTimers()
})

// The Relay's schedule worker, wired to the harness as index.ts wires it.
async function scheduleManager(harness: RelayHarness) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-power-schedules-"))
  const manager = await ScheduleManager.make({
    enqueueBackup: async () => {
      throw new Error("not used")
    },
    findInstance: (instanceId) => harness.docker.findInstance(instanceId),
    getBackup: async () => null,
    isPaused: () => harness.lanes.paused,
    listDatabaseIds: async () =>
      new Set((await harness.databases.list()).map(({ id }) => id)),
    platformTargetId: () => "platform",
    powerIntent: (kind, id) => harness.power.intent(kind, id),
    relayId: "relay-a",
    runContainerCommand: (target, command) =>
      harness.commands.run(target, command),
    runPower: (kind, id, action, powerIntent) =>
      harness.power.scheduled(kind, id, action, powerIntent),
    sendConsoleCommand: async () => {
      throw new Error("not used")
    },
    state: harness.state.schedules,
    stateDirectory: directory,
  })
  onTestFinished(async () => {
    manager.close()
    await rm(directory, { force: true, recursive: true })
  })
  return manager
}

// Docker and SQLite are real I/O; each step lets them progress before the
// clock moves on.
async function until(condition: () => boolean | Promise<boolean>, stepMs = 0) {
  for (let step = 0; step < 10_000; step += 1) {
    if (await condition()) return
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  throw new Error("The condition never held")
}

function stopWaitStart(
  target: RelayScheduleProjection["targets"][number]
): RelayScheduleProjection {
  return {
    actions: [
      {
        action: "stop",
        id: "0e9a7f5c-77e8-4b39-8c1a-6d5bb9c0b3a1",
        type: "power",
      },
      {
        duration: 5,
        id: "1e68e6ac-7381-494d-82bb-d50c4a63f575",
        type: "wait",
        unit: "minutes",
      },
      {
        action: "start",
        id: "6c1d2a9e-5f6b-4b0e-9d57-2a7c4f1e8b33",
        type: "power",
      },
    ],
    cron: "daily",
    enabled: true,
    id: scheduleId,
    name: "Nightly maintenance",
    revision: 1,
    targets: [target],
    timezone: "UTC",
  }
}

describe("one power path", () => {
  it("lets a person's database stop during a schedule stand", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        engine: "postgres",
        id,
        name: "Main database",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    const container = fakeDocker.container(
      `${TEST_NAMESPACE}-kiln-db-${id}-database`
    )!

    const schedules = await scheduleManager(harness)
    await schedules.apply(
      stopWaitStart({
        id,
        kind: "database",
        name: "Main database",
        relayId: "relay-a",
      })
    )
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    await schedules.runNow({ revision: 1, scheduleId })
    await until(() => !container.state.running)

    // Someone stops it during the wait, as a Hearth request does.
    const locks = await controlRequestLocks(
      "database.action",
      { action: "stop", databaseId: id },
      (reference) => reference,
      () => []
    )
    await Effect.runPromise(
      harness.lanes.run(
        { label: "database.action", locks: locks ?? [] },
        Effect.promise(() => harness.power.requested("database", id, "stop"))
      )
    )

    let run: Awaited<ReturnType<typeof schedules.overview>>["runs"][number]
    await until(async () => {
      run = (await schedules.overview([scheduleId])).runs[0]!
      return run.status !== "running"
    }, 60_000)
    run = run!
    expect(run.targetRuns[0]?.attempts).toMatchObject([
      { status: "succeeded" },
      { status: "not_run" },
    ])
    expect(run.targetRuns[0]?.attempts[1]?.error).toBe(
      "Not run: the database's power was changed during the schedule"
    )
    expect(container.state.running).toBe(false)
  })

  it("leaves a database being deleted alone, recording each step as not run", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        engine: "postgres",
        id,
        name: "Main database",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    const container = fakeDocker.container(
      `${TEST_NAMESPACE}-kiln-db-${id}-database`
    )!
    // As a freeze for its deletion does: the lanes refuse every change to it.
    harness.lanes.addRefusal((_label, locks) =>
      locks.some((lock) => lock.key.split("/", 1)[0] === `database:${id}`)
        ? "This database is being deleted"
        : null
    )
    const key = `relay-a:database:${id}`
    const schedules = await scheduleManager(harness)
    await schedules.apply({
      ...stopWaitStart({
        id,
        kind: "database",
        name: "Main database",
        relayId: "relay-a",
      }),
      actions: [
        {
          action: "stop",
          id: "0e9a7f5c-77e8-4b39-8c1a-6d5bb9c0b3a1",
          type: "power",
        },
        {
          authorizedTargets: 2,
          command: "./vacuum",
          id: "6c1d2a9e-5f6b-4b0e-9d57-2a7c4f1e8b33",
          targetKeys: [key],
          type: "console_command",
        },
      ],
      continueOnFailure: true,
    })
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })

    await schedules.runNow({ revision: 1, scheduleId })

    let run: Awaited<ReturnType<typeof schedules.overview>>["runs"][number]
    await until(async () => {
      run = (await schedules.overview([scheduleId])).runs[0]!
      return run.status !== "running"
    }, 10)
    expect(run!.targetRuns[0]?.attempts).toMatchObject([
      { error: "Not run: This database is being deleted", status: "not_run" },
      { error: "Not run: This database is being deleted", status: "not_run" },
    ])
    expect(container.state.running).toBe(true)
    expect(container.processes.some(({ argv }) => argv.includes("./vacuum")))
      .toBe(false)
  })

  it("lets a person's App stop during a schedule stand", async () => {
    const harness = await relayHarness()
    const appId = "a".repeat(40)
    await harness.apps.create({ id: appId, name: "Website" })
    await deploy(harness, appId)
    const containers = () => appContainers(appId)
    expect(containers().some((container) => container.state.running)).toBe(
      true
    )

    // Schedules can't name Apps until they're schedule targets; drive the
    // power path directly, as the schedule worker does.
    const intent = harness.power.intent("app", appId)
    await harness.power.scheduled("app", appId, "stop", intent)
    expect(containers().every((container) => !container.state.running)).toBe(
      true
    )
    const locks = await controlRequestLocks(
      "app.action",
      { action: "stop", appId },
      (reference) => reference,
      () => []
    )
    await Effect.runPromise(
      harness.lanes.run(
        { label: "app.action", locks: locks ?? [] },
        Effect.promise(() => harness.power.requested("app", appId, "stop"))
      )
    )

    await expect(
      harness.power.scheduled("app", appId, "start", intent)
    ).rejects.toMatchObject({ reason: "superseded" })
    expect(containers().every((container) => !container.state.running)).toBe(
      true
    )
  })

  it("lets a deployment during a schedule stand", async () => {
    const harness = await relayHarness()
    const appId = "a".repeat(40)
    await harness.apps.create({ id: appId, name: "Website" })
    await deploy(harness, appId)
    const intent = harness.power.intent("app", appId)
    // The schedule's own steps keep its later ones current.
    await harness.power.scheduled("app", appId, "stop", intent)
    await harness.power.scheduled("app", appId, "start", intent)

    // Someone deploys during the schedule's wait.
    await deploy(harness, appId)

    await expect(
      harness.power.scheduled("app", appId, "stop", intent)
    ).rejects.toMatchObject({ reason: "superseded" })
    expect(appContainers(appId).some(({ state }) => state.running)).toBe(true)
  })
})

function appContainers(appId: string) {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.app.id"] === appId
  )
}

// Deploys an image App and waits, under fake timers, for it to settle.
async function deploy(harness: RelayHarness, appId: string) {
  fakeDocker.images.set("nginx:alpine", {})
  vi.useFakeTimers({
    now: Date.now() + 60_000,
    toFake: ["Date", "setTimeout", "clearTimeout"],
  })
  await harness.apps.deploy(
    relayDeployAppSchema.parse({
      appId,
      config: { ...defaultAppConfig, image: "nginx:alpine" },
      name: "Website",
    })
  )
  await until(
    async () => (await harness.apps.get(appId)).deployment?.state !== "running",
    100
  )
  vi.useRealTimers()
}
