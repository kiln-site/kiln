import {
  defaultAppConfig,
  relayDeployAppSchema,
  type AppConfig,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const appId = "d".repeat(40)

afterEach(() => {
  vi.useRealTimers()
})

function appContainers() {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.app.id"] === appId
  )
}

async function deploy(harness: RelayHarness, config: Partial<AppConfig>) {
  vi.useFakeTimers({
    now: Date.now(),
    toFake: ["Date", "setTimeout", "clearTimeout"],
  })
  await harness.apps.deploy(
    relayDeployAppSchema.parse({
      appId,
      config: { ...defaultAppConfig, image: "nginx:alpine", ...config },
      name: "Website",
    })
  )
  for (let step = 0; step < 10_000; step += 1) {
    const app = await harness.apps.get(appId)
    if (app.deployment?.state !== "running") {
      vi.useRealTimers()
      return app
    }
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(100)
  }
  throw new Error("The deployment never finished")
}

describe("leftover containers", () => {
  it("removes a replaced App container Docker refused once, after a restart, and keeps the one serving", async () => {
    const harness = await relayHarness()
    await harness.apps.create({ id: appId, name: "Website" })
    fakeDocker.images.set("nginx:alpine", {})
    await deploy(harness, {})
    const [first] = appContainers()
    fakeDocker.failNext(
      { command: "rm", target: first!.id },
      "removal of container is already in progress"
    )

    const second = await deploy(harness, { command: "serve --v2" })

    expect(second.deployment?.state).toBe("succeeded")
    expect(appContainers()).toHaveLength(2)
    const serving = appContainers().find(
      (container) => container.id !== first!.id
    )
    expect(serving?.state.running).toBe(true)

    const restarted = await harness.restart()
    await Effect.runPromise(restarted.cleanup.pass({ kind: "timer" }))

    expect(appContainers().map((container) => container.id)).toEqual([
      serving!.id,
    ])
    expect(await Effect.runPromise(harness.state.listDockerCleanups())).toEqual(
      []
    )
  })
})

describe("update leftovers", () => {
  function seedUpdate(input: { readonly helperRunning: boolean }) {
    fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/relay:latest",
      labels: { "io.kiln.component": "relay" },
      name: "kiln-relay",
      running: true,
    })
    const backup = fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/relay:old",
      labels: { "io.kiln.component": "relay" },
      name: "kiln-relay-kiln-backup-1767225600000",
    })
    const helper = fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/relay:latest",
      labels: { "io.kiln.update-helper": "true" },
      name: "kiln-updater-batch",
      running: input.helperRunning,
    })
    return { backup, helper }
  }

  it("removes a finished update's helper and the container it set aside, and nothing else", async () => {
    const harness = await relayHarness()
    const { backup, helper } = seedUpdate({ helperRunning: false })
    // Named like a set-aside container, but not one: a person's own, one
    // whose replacement isn't running, and another installation's.
    fakeDocker.addContainer({ name: "web", running: true })
    const own = fakeDocker.addContainer({ name: "web-kiln-backup-1" })
    fakeDocker.addContainer({
      labels: { "io.kiln.component": "hearth" },
      name: "kiln-hearth",
    })
    const unreplaced = fakeDocker.addContainer({
      labels: { "io.kiln.component": "hearth" },
      name: "kiln-hearth-kiln-backup-1",
    })
    fakeDocker.addContainer({
      labels: { "io.kiln.component": "hearth" },
      name: "other-hearth",
      running: true,
    })
    const foreign = fakeDocker.addContainer({
      labels: {
        "io.kiln.component": "hearth",
        "io.kiln.installation": "another-installation",
      },
      name: "other-hearth-kiln-backup-1",
    })

    await Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))

    expect(fakeDocker.container(backup.id)).toBeUndefined()
    expect(fakeDocker.container(helper.id)).toBeUndefined()
    for (const kept of [own, unreplaced, foreign]) {
      expect(fakeDocker.container(kept.id)).toBeDefined()
    }
    expect(fakeDocker.container("kiln-relay")?.state.running).toBe(true)
  })

  it("leaves the set-aside container while an update's helper runs, since it may roll back to it", async () => {
    const harness = await relayHarness()
    const { backup, helper } = seedUpdate({ helperRunning: true })

    await Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))

    expect(fakeDocker.container(backup.id)).toBeDefined()
    expect(fakeDocker.container(helper.id)).toBeDefined()
  })
})
