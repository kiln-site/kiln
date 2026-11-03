import {
  defaultAppConfig,
  relayDeployAppSchema,
  type AppConfig,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DockerCleanup } from "./docker-cleanup.js"
import { DockerEngine } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const appId = "d".repeat(40)

// Where the last deployment left the fake clock, so the next one starts
// a second later with its own deployment ID.
let clock = 0

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
    now: Math.max(Date.now(), clock + 1_000),
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
      clock = Date.now()
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

describe("image retention", () => {
  const builds = () =>
    [...fakeDocker.images.keys()].filter((image) =>
      image.startsWith(`kiln-app-${appId}:`)
    )

  it("records the build a successful deployment runs", async () => {
    const harness = await relayHarness()
    await harness.apps.create({ id: appId, name: "Website" })
    const app = await deploy(harness, {
      dockerfile: "FROM nginx:alpine\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment?.state).toBe("succeeded")
    expect(
      (await Effect.runPromise(harness.state.listAppDeploymentImages())).map(
        (record) => record.imageId
      )
    ).toEqual([`sha256:kiln-app-${appId}:${app.deployment!.id}`])
  })

  it("keeps the builds of an App's five newest successful deployments and any build's first day", async () => {
    const harness = await relayHarness()
    await harness.apps.create({ id: appId, name: "Website" })
    // Six successful deployments, a minute apart, each running its own
    // build, and none of their containers left.
    const deployed: Array<string> = []
    const start = Date.now()
    for (let index = 1; index <= 6; index += 1) {
      const build = `kiln-app-${appId}:2026010100000${index}`
      vi.useFakeTimers({ now: start + index * 60_000, toFake: ["Date"] })
      await Effect.runPromise(
        harness.cleanup.recordDeployment({
          appId,
          deploymentId: `2026010100000${index}`,
          imageIds: [`sha256:${build}`],
        })
      )
      vi.useRealTimers()
      fakeDocker.images.set(build, { "kiln.app.id": appId })
      fakeDocker.imageCreated.set(build, 0)
      deployed.push(build)
    }
    // A day on, two deployments failed after building, one an hour ago. A
    // person's own untagged image isn't Kiln's to remove.
    const dayOn = start + 25 * 60 * 60_000
    const now = Math.floor(dayOn / 1000)
    for (const [name, created] of [
      ["recent-failure", now - 3_600],
      ["old-failure", 0],
    ] as const) {
      fakeDocker.images.set(`kiln-app-${appId}:${name}`, {
        "kiln.app.id": appId,
      })
      fakeDocker.imageCreated.set(`kiln-app-${appId}:${name}`, created)
    }
    fakeDocker.images.set("someone/else:1", {})
    fakeDocker.untaggedImages.add("someone/else:1")

    vi.useFakeTimers({ now: dayOn, toFake: ["Date"] })
    await Effect.runPromise(harness.cleanup.pruneAppImages(appId))

    expect(builds().sort()).toEqual(
      [...deployed.slice(1), `kiln-app-${appId}:recent-failure`].sort()
    )
    expect(fakeDocker.images.has("someone/else:1")).toBe(true)
  })

  it("keeps the image Hearth and the Relay ran before their latest update, and no older untagged one", async () => {
    const harness = await relayHarness()
    const image = (name: string, component: string, created: number) => {
      fakeDocker.images.set(name, { "io.kiln.component": component })
      fakeDocker.imageCreated.set(name, created)
      fakeDocker.untaggedImages.add(name)
    }
    fakeDocker.images.set("ghcr.io/kiln-site/hearth:latest", {
      "io.kiln.component": "hearth",
    })
    fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/hearth:latest",
      name: "kiln-hearth",
      running: true,
    })
    image("hearth-before", "hearth", 100)
    image("hearth-older", "hearth", 200)
    image("relay-older", "relay", 100)
    image("relay-before", "relay", 200)
    // A version someone pinned by its tag.
    fakeDocker.images.set("ghcr.io/kiln-site/hearth:0.1.0", {
      "io.kiln.component": "hearth",
    })
    const cleanup = new DockerCleanup({
      config: harness.config,
      engine: new DockerEngine(harness.config.dockerSocket),
      lanes: harness.lanes,
      // The Relay's own update predates records of the image it replaced.
      previousKilnImages: () =>
        Effect.succeed(new Map([["hearth", "sha256:hearth-before"]])),
      state: harness.state,
      updating: () => Effect.succeed(false),
    })

    await Effect.runPromise(cleanup.pass({ kind: "timer" }))

    expect([...fakeDocker.images.keys()].sort()).toEqual(
      [
        "ghcr.io/kiln-site/hearth:0.1.0",
        "ghcr.io/kiln-site/hearth:latest",
        "hearth-before",
        "relay-before",
      ].sort()
    )
  })
})
