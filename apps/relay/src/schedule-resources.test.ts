import {
  defaultAppConfig,
  relayCreateDatabaseSchema,
  relayDeployAppSchema,
} from "@workspace/contracts"
import {
  scheduleTargetKey,
  type RelayScheduleProjection,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { controlRequestLocks } from "./operation-plans.js"
import type { ScheduleManager } from "./schedules.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  scheduleWorker,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const scheduleId = "14bb1e12-fab9-45f3-8f85-ae22d2f074e5"

type ScheduleWorker = ScheduleManager

afterEach(() => {
  vi.useRealTimers()
})

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

    const schedules = await scheduleWorker(harness)
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

    const run = await finishedRun(schedules)
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
    const schedules = await scheduleWorker(harness)
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
    const appId = await deployedApp(harness)
    const schedules = await scheduleWorker(harness)
    await schedules.apply(stopWaitStart(appTarget(appId)))
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    await schedules.runNow({ revision: 1, scheduleId })
    await until(() => appContainers(appId).every(({ state }) => !state.running))

    // Someone stops it during the wait, as a Hearth request does.
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

    const run = await finishedRun(schedules)
    expect(run.targetRuns[0]?.attempts).toMatchObject([
      { status: "succeeded" },
      {
        error: "Not run: the App's power was changed during the schedule",
        status: "not_run",
      },
    ])
    expect(appContainers(appId).every(({ state }) => !state.running)).toBe(
      true
    )
  })
})

describe("App replacement", () => {
  it("lets a deployment during a schedule stand", async () => {
    const harness = await relayHarness()
    const appId = await deployedApp(harness)
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

describe("App commands", () => {
  it("runs in the service its step names, and fails a step naming a service the App doesn't have", async () => {
    const harness = await relayHarness()
    const appId = await deployedApp(harness)
    const target = appTarget(appId)
    const key = scheduleTargetKey(target)
    fakeDocker.shellScripts.set("./migrate", { output: "migrated\n" })
    const schedules = await scheduleWorker(harness)
    await schedules.apply({
      ...stopWaitStart(target),
      actions: [
        {
          command: "./migrate",
          id: "5d8f43a2-6a0e-4d36-9c11-3b1f4f5e2a10",
          services: { [key]: "app" },
          authorizedTargets: 2,
          targetKeys: [key],
          type: "console_command",
        },
        // A deployment renamed the service since the schedule was saved.
        {
          command: "./seed",
          id: "a4c1e6b9-2f7d-4c0a-8e35-7b9d2c6f1e44",
          services: { [key]: "worker" },
          authorizedTargets: 2,
          targetKeys: [key],
          type: "console_command",
        },
      ],
      continueOnFailure: true,
    })
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })

    await schedules.runNow({ revision: 1, scheduleId })

    const run = await finishedRun(schedules, 10)
    expect(run.targetRuns[0]?.attempts).toMatchObject([
      {
        result: { exitCode: 0, output: "migrated\n", truncated: false },
        status: "succeeded",
      },
      { error: "The App has no service named worker", status: "failed" },
    ])
    const [container] = appContainers(appId)
    expect(container?.labels["kiln.app.service"]).toBe("app")
    expect(container?.processes.map(({ argv }) => argv)).toContainEqual([
      "sh",
      "-c",
      "./migrate",
    ])
    expect(
      container?.processes.some(({ argv }) => argv.includes("./seed"))
    ).toBe(false)
  })
})

function appTarget(appId: string): RelayScheduleProjection["targets"][number] {
  return { id: appId, kind: "app", name: "Website", relayId: "relay-a" }
}

function appContainers(appId: string) {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.app.id"] === appId
  )
}

// An image App, deployed and settled, with its one service `app` running.
async function deployedApp(harness: RelayHarness) {
  const appId = "a".repeat(40)
  await harness.apps.create({ id: appId, name: "Website" })
  await deploy(harness, appId)
  expect(appContainers(appId).some(({ state }) => state.running)).toBe(true)
  return appId
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

// Steps of `stepMs`, long enough to pass a Wait but no Docker timeout.
async function finishedRun(schedules: ScheduleWorker, stepMs = 60_000) {
  let run: Awaited<ReturnType<ScheduleWorker["overview"]>>["runs"][number]
  await until(async () => {
    run = (await schedules.overview([scheduleId])).runs[0]!
    return run.status !== "running"
  }, stepMs)
  return run!
}
