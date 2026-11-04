import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

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
import { SystemUpdateManager, type UpdateOperation } from "./system-updates.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const appId = "d".repeat(40)

// Where the last deployment left the fake clock, so the next one starts
// a second later with its own deployment ID.
let clock = 0

afterEach(() => {
  vi.useRealTimers()
})

/**
 * A cleanup reading update records on disk, written as the update helper
 * writes them, through the Relay's own update manager.
 */
async function cleanupWithUpdates(
  harness: RelayHarness,
  operations: ReadonlyArray<UpdateOperation>
) {
  const directory = join(harness.config.dataDirectory, "updates")
  await mkdir(directory, { recursive: true })
  for (const operation of operations) {
    await writeFile(
      join(directory, `${operation.id}.json`),
      JSON.stringify(operation)
    )
  }
  const updates = new SystemUpdateManager(harness.config)
  return new DockerCleanup({
    config: harness.config,
    engine: new DockerEngine(harness.config.dockerSocket),
    lanes: harness.lanes,
    state: harness.state,
    updates: () => updates.cleanupState(),
  })
}

function update(
  fields: Pick<
    UpdateOperation,
    "component" | "requestedImage" | "startedAt" | "status"
  > &
    Partial<UpdateOperation>
): UpdateOperation {
  return {
    error: null,
    finishedAt: fields.status === "running" ? null : fields.startedAt,
    id: randomUUID(),
    previousImage: `ghcr.io/kiln-site/${fields.component}:latest`,
    targetContainer: `kiln-${fields.component}`,
    version: "0.1.0-nightly.2",
    ...fields,
  }
}

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
  const finished = update({
    batchId: "batch",
    component: "relay",
    requestedImage: "sha256:relay-new",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "succeeded",
  })

  function seedUpdate(helper: {
    readonly state: "created" | "exited" | "running"
  }) {
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
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    const container = fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/relay:latest",
      labels: { "io.kiln.update-helper": "true" },
      name: "kiln-updater-batch",
      running: helper.state === "running",
      ...(helper.state === "exited" && {
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    })
    return { backup, helper: container }
  }

  it("removes a finished update's helper and the container it set aside, and nothing else", async () => {
    const harness = await relayHarness()
    const cleanup = await cleanupWithUpdates(harness, [finished])
    const { backup, helper } = seedUpdate({ state: "exited" })
    // Named like a set-aside container, but not one: a person's own, one
    // whose replacement isn't running, and another installation's; and a
    // helper of an update this Relay has no record of.
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
    // From before installation labels, by an update this Relay didn't make.
    fakeDocker.addContainer({
      labels: { "io.kiln.component": "hearth" },
      name: "unlabeled-hearth",
      running: true,
    })
    const unlabeled = fakeDocker.addContainer({
      labels: { "io.kiln.component": "hearth" },
      name: "unlabeled-hearth-kiln-backup-1",
    })
    const unknownHelper = fakeDocker.addContainer({
      labels: { "io.kiln.update-helper": "true" },
      name: "kiln-updater-someone-elses",
      startedAt: "2026-01-01T00:00:00.000Z",
    })

    await Effect.runPromise(cleanup.pass({ kind: "timer" }))

    expect(fakeDocker.container(backup.id)).toBeUndefined()
    expect(fakeDocker.container(helper.id)).toBeUndefined()
    for (const kept of [own, unreplaced, foreign, unlabeled, unknownHelper]) {
      expect(fakeDocker.container(kept.id)).toBeDefined()
    }
    expect(fakeDocker.container("kiln-relay")?.state.running).toBe(true)
  })

  it("leaves the set-aside container while an update's helper is made or runs, since it may roll back to it", async () => {
    for (const state of ["created", "running"] as const) {
      const harness = await relayHarness()
      const cleanup = await cleanupWithUpdates(harness, [finished])
      const { backup, helper } = seedUpdate({ state })

      await Effect.runPromise(cleanup.pass({ kind: "timer" }))

      expect(fakeDocker.container(backup.id)).toBeDefined()
      expect(fakeDocker.container(helper.id)).toBeDefined()
      fakeDocker.reset()
    }
  })

  it("leaves updates' leftovers and images alone while an update record can't be read", async () => {
    const harness = await relayHarness()
    const cleanup = await cleanupWithUpdates(harness, [finished])
    await writeFile(
      join(harness.config.dataDirectory, "updates", `${randomUUID()}.json`),
      "{ half-written"
    )
    const { backup, helper } = seedUpdate({ state: "exited" })
    fakeDocker.images.set("relay-new", { "io.kiln.component": "relay" })
    fakeDocker.untaggedImages.add("relay-new")

    await Effect.runPromise(cleanup.pass({ kind: "timer" }))

    expect(fakeDocker.container(backup.id)).toBeDefined()
    expect(fakeDocker.container(helper.id)).toBeDefined()
    expect(fakeDocker.images.has("relay-new")).toBe(true)
  })

  it("leaves everything while an update's record says it runs, before its helper exists", async () => {
    const harness = await relayHarness()
    const cleanup = await cleanupWithUpdates(harness, [
      update({
        component: "relay",
        requestedImage: "sha256:relay-next",
        startedAt: "2026-01-02T00:00:00.000Z",
        status: "running",
      }),
    ])
    const { backup } = seedUpdate({ state: "exited" })
    fakeDocker.container("kiln-updater-batch")!.name = "kiln-updater-old"
    // The image it's pulled, which nothing uses yet.
    fakeDocker.images.set("relay-next", { "io.kiln.component": "relay" })
    fakeDocker.untaggedImages.add("relay-next")

    await Effect.runPromise(cleanup.pass({ kind: "timer" }))

    expect(fakeDocker.container(backup.id)).toBeDefined()
    expect(fakeDocker.images.has("relay-next")).toBe(true)
  })
})

describe("leftovers from before updates were recorded", () => {
  it("removes a helper and set-aside container stopped over a day, and none that stopped since", async () => {
    const harness = await relayHarness()
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000).toISOString()
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/relay:latest",
      labels: { "io.kiln.component": "relay" },
      name: "kiln-relay",
      running: true,
    })
    const stopped = (
      name: string,
      labels: Record<string, string>,
      at: string
    ) =>
      fakeDocker.addContainer({
        finishedAt: at,
        image: "ghcr.io/kiln-site/relay:old",
        labels,
        name,
        startedAt: at,
      })
    const relay = { "io.kiln.component": "relay" }
    const helper = { "io.kiln.update-helper": "true" }
    const oldBackup = stopped(
      "kiln-relay-kiln-backup-1700000000000",
      relay,
      dayAgo
    )
    const newBackup = stopped(
      "kiln-relay-kiln-backup-1767225600000",
      relay,
      hourAgo
    )
    const oldHelper = stopped("kiln-updater-legacy", helper, dayAgo)
    const newHelper = stopped("kiln-updater-recent", helper, hourAgo)
    // Kiln's game servers share the prefix, and a stopped one stays; so
    // does a container labelled as a helper that isn't named like one.
    const server = stopped("kiln-e1534cce", {}, dayAgo)
    const odd = stopped("not-an-updater", helper, dayAgo)

    await Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))

    expect(fakeDocker.container(oldBackup.id)).toBeUndefined()
    expect(fakeDocker.container(oldHelper.id)).toBeUndefined()
    for (const kept of [newBackup, newHelper, server, odd]) {
      expect(fakeDocker.container(kept.id)).toBeDefined()
    }
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

  it("keeps a build a day after the App's first deployment failed, even when asked to remove images Kiln didn't run", async () => {
    const harness = await relayHarness()
    await harness.apps.create({ id: appId, name: "Website" })
    fakeDocker.failNext({ command: "create" }, "no space left on device")
    const app = await deploy(harness, {
      dockerfile: "FROM nginx:alpine\n",
      sourceType: "dockerfile",
    })
    expect(app.deployment?.state).toBe("failed")
    expect(builds()).toHaveLength(1)

    await Effect.runPromise(
      harness.cleanup.cleanNow({ buildCache: false, unknownImages: true })
    )
    expect(builds()).toHaveLength(1)

    vi.useFakeTimers({ now: clock + 25 * 60 * 60_000, toFake: ["Date"] })
    await Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))
    expect(builds()).toEqual([])
  })

  it("keeps Hearth's image from before its latest successful update, through a failed attempt since, and never another installation's", async () => {
    const harness = await relayHarness()
    const cleanup = await cleanupWithUpdates(harness, [
      update({
        component: "hearth",
        previousImageId: "sha256:hearth-oldest",
        requestedImage: "sha256:hearth-before",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "succeeded",
      }),
      update({
        component: "hearth",
        previousImageId: "sha256:hearth-before",
        requestedImage: "sha256:hearth-current",
        startedAt: "2026-01-02T00:00:00.000Z",
        status: "succeeded",
      }),
      // Pulled, then failed before replacing anything.
      update({
        component: "hearth",
        previousImageId: "sha256:hearth-current",
        requestedImage: "sha256:hearth-failed",
        startedAt: "2026-01-03T00:00:00.000Z",
        status: "failed",
      }),
    ])
    const image = (name: string, created: number) => {
      fakeDocker.images.set(name, { "io.kiln.component": "hearth" })
      fakeDocker.imageCreated.set(name, created)
      fakeDocker.untaggedImages.add(name)
    }
    image("hearth-current", 300)
    fakeDocker.addContainer({
      image: "hearth-current",
      name: "kiln-hearth",
      running: true,
    })
    image("hearth-oldest", 100)
    image("hearth-before", 200)
    image("hearth-failed", 400)
    // Another installation's on the same host, which no update here named.
    image("hearth-elsewhere", 50)
    // A version someone pinned by its tag.
    fakeDocker.images.set("ghcr.io/kiln-site/hearth:0.1.0", {
      "io.kiln.component": "hearth",
    })

    await Effect.runPromise(cleanup.pass({ kind: "timer" }))

    expect([...fakeDocker.images.keys()].sort()).toEqual(
      [
        "ghcr.io/kiln-site/hearth:0.1.0",
        "hearth-before",
        "hearth-current",
        "hearth-elsewhere",
      ].sort()
    )
  })
})

describe("Hearth and Relay images", () => {
  const image = (name: string, component: string, created: number) => {
    fakeDocker.images.set(name, { "io.kiln.component": component })
    fakeDocker.imageCreated.set(name, created)
    fakeDocker.untaggedImages.add(name)
  }

  it("removes the helper images of failed Hearth updates but the newest", async () => {
    const harness = await relayHarness()
    const cleanup = await cleanupWithUpdates(harness, [
      update({
        component: "hearth",
        helperImage: "sha256:relay-helper-1",
        requestedImage: "sha256:hearth-next-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "failed",
      }),
      update({
        component: "hearth",
        helperImage: "sha256:relay-helper-2",
        requestedImage: "sha256:hearth-next-2",
        startedAt: "2026-01-02T00:00:00.000Z",
        status: "failed",
      }),
    ])
    image("relay-helper-1", "relay", 100)
    image("relay-helper-2", "relay", 200)

    await Effect.runPromise(cleanup.pass({ kind: "timer" }))

    expect(fakeDocker.images.has("relay-helper-1")).toBe(false)
    expect(fakeDocker.images.has("relay-helper-2")).toBe(true)
  })

  it("keeps no other old image when the one before the latest update is kept anyway", async () => {
    const harness = await relayHarness()
    // The image before the latest update is pinned by a tag.
    fakeDocker.images.set("ghcr.io/kiln-site/hearth:0.1.0", {
      "io.kiln.component": "hearth",
    })
    const cleanup = await cleanupWithUpdates(harness, [
      update({
        component: "hearth",
        requestedImage: "sha256:ghcr.io/kiln-site/hearth:0.1.0",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "succeeded",
        previousImageId: "sha256:hearth-oldest",
      }),
      update({
        component: "hearth",
        previousImageId: "sha256:ghcr.io/kiln-site/hearth:0.1.0",
        requestedImage: "sha256:hearth-current",
        startedAt: "2026-01-02T00:00:00.000Z",
        status: "succeeded",
      }),
    ])
    image("hearth-current", "hearth", 300)
    fakeDocker.addContainer({
      image: "hearth-current",
      name: "kiln-hearth",
      running: true,
    })
    image("hearth-oldest", "hearth", 100)

    await Effect.runPromise(cleanup.pass({ kind: "timer" }))

    expect([...fakeDocker.images.keys()].sort()).toEqual(
      ["ghcr.io/kiln-site/hearth:0.1.0", "hearth-current"].sort()
    )
  })
})

describe("unused images", () => {
  it("removes an image none of Kiln's containers has used for a day, and never one Kiln didn't run", async () => {
    const harness = await relayHarness()
    const owned = { "kiln.relay.owner": TEST_NAMESPACE }
    const server = fakeDocker.addContainer({
      image: "ghcr.io/example/yolks:java_21",
      labels: {
        ...owned,
        [harness.config.serverIdLabel]: "e".repeat(32),
        "kiln.relay.managed": "true",
      },
      name: "kiln-test-kiln-eeeeeeee",
      running: true,
    })
    // A stopped database still uses its image.
    fakeDocker.addContainer({
      image: "postgres:17",
      labels: { ...owned, "kiln.database.id": "f".repeat(32) },
      name: "kiln-test-database",
    })
    // A person's own container, and an image they pulled.
    const theirs = fakeDocker.addContainer({
      image: "someone/app:1",
      name: "their-app",
    })
    fakeDocker.images.set("someone/tool:1", {})
    const pass = () =>
      Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))
    await pass()

    // The game server is deleted, and so is the person's container.
    fakeDocker.removeContainer(server.name)
    fakeDocker.removeContainer(theirs.name)
    await pass()
    expect(fakeDocker.images.has("ghcr.io/example/yolks:java_21")).toBe(true)

    vi.useFakeTimers({
      now: Date.now() + 25 * 60 * 60_000,
      toFake: ["Date"],
    })
    await pass()

    expect([...fakeDocker.images.keys()].sort()).toEqual(
      ["postgres:17", "someone/app:1", "someone/tool:1"].sort()
    )
  })
})

describe("the desktop image", () => {
  it("stays once a stream has used it, unlike one from an older version", async () => {
    const harness = await relayHarness()
    const owned = { "kiln.relay.owner": TEST_NAMESPACE }
    const current = harness.config.desktopImage
    const older = `${current}-older`
    for (const [name, image] of [
      ["kiln-test-kiln-desktop-encoder", current],
      ["kiln-test-kiln-desktop", older],
    ] as const) {
      fakeDocker.addContainer({
        image,
        labels: { ...owned, "kiln.relay.infrastructure": "desktop" },
        name,
        running: true,
      })
    }
    const pass = () =>
      Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))
    await pass()
    fakeDocker.removeContainer("kiln-test-kiln-desktop-encoder")
    fakeDocker.removeContainer("kiln-test-kiln-desktop")
    await pass()

    vi.useFakeTimers({
      now: Date.now() + 25 * 60 * 60_000,
      toFake: ["Date"],
    })
    await pass()

    expect(fakeDocker.images.has(current)).toBe(true)
    expect(fakeDocker.images.has(older)).toBe(false)
  })

  it("stays when it's named by digest, as a pinned Relay names it", async () => {
    const harness = await relayHarness()
    const owned = { "kiln.relay.owner": TEST_NAMESPACE }
    const pinned = `ghcr.io/example/desktop@sha256:${"a".repeat(64)}`
    harness.config.desktopImage = pinned
    await Effect.runPromise(
      new DockerEngine(harness.config.dockerSocket).pullImage(pinned, {
        timeout: 1_000,
      })
    )
    fakeDocker.addContainer({
      image: pinned,
      labels: { ...owned, "kiln.relay.infrastructure": "desktop" },
      name: "kiln-test-kiln-desktop-encoder",
      running: true,
    })
    const pass = () =>
      Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))
    await pass()
    fakeDocker.removeContainer("kiln-test-kiln-desktop-encoder")
    await pass()

    vi.useFakeTimers({
      now: Date.now() + 25 * 60 * 60_000,
      toFake: ["Date"],
    })
    await pass()

    expect(fakeDocker.images.has(pinned)).toBe(true)
  })
})

describe("cleanup a person asks for", () => {
  it("reports what it could remove, then removes Kiln's unused images at once and only what they chose besides", async () => {
    const harness = await relayHarness()
    const database = fakeDocker.addContainer({
      image: "postgres:16",
      labels: {
        "kiln.database.id": "f".repeat(32),
        "kiln.relay.owner": TEST_NAMESPACE,
      },
      name: "kiln-test-database",
    })
    await Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))
    // The database is deleted a moment ago; someone pulled their own image.
    fakeDocker.removeContainer(database.name)
    fakeDocker.images.set("someone/tool:1", {})
    fakeDocker.buildCache = [
      { InUse: false, Size: 5_000_000 },
      { InUse: true, Size: 2_000_000 },
    ]

    expect(await Effect.runPromise(harness.cleanup.storage())).toMatchObject({
      buildCache: { bytes: 7_000_000, reclaimableBytes: 5_000_000 },
      images: { count: 2 },
      reclaimable: { bytes: 1_000_000, images: 1 },
      unknown: { bytes: 1_000_000, images: 1 },
    })

    const kilnOnly = await Effect.runPromise(
      harness.cleanup.cleanNow({ buildCache: false, unknownImages: false })
    )
    expect(kilnOnly).toMatchObject({ buildCacheBytes: 0, images: 1 })
    expect([...fakeDocker.images.keys()]).toEqual(["someone/tool:1"])
    expect(fakeDocker.buildCache).toHaveLength(2)

    const everything = await Effect.runPromise(
      harness.cleanup.cleanNow({ buildCache: true, unknownImages: true })
    )
    expect(everything).toMatchObject({ buildCacheBytes: 5_000_000, images: 1 })
    expect(fakeDocker.images.size).toBe(0)
    expect(fakeDocker.buildCache).toEqual([{ InUse: true, Size: 2_000_000 }])
  })
})

describe("a cleanup someone asks for, in the background", () => {
  it("answers as it starts, runs one at a time, and shows it running until it's done", async () => {
    const harness = await relayHarness()
    const database = fakeDocker.addContainer({
      image: "postgres:16",
      labels: {
        "kiln.database.id": "f".repeat(32),
        "kiln.relay.owner": TEST_NAMESPACE,
      },
      name: "kiln-test-database",
    })
    await Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))
    fakeDocker.removeContainer(database.name)
    await Effect.runPromise(harness.cleanup.storage())
    const removal = fakeDocker.hold({ command: "image rm" })

    const started = await Effect.runPromise(
      harness.cleanup.startCleanup({ buildCache: false, unknownImages: false })
    )
    await removal.reached
    const again = await Effect.runPromise(
      harness.cleanup.startCleanup({ buildCache: false, unknownImages: true })
    )
    const running = await Effect.runPromise(harness.cleanup.storage())

    expect(started.alreadyRunning).toBe(false)
    expect(again).toEqual({
      alreadyRunning: true,
      startedAt: started.startedAt,
    })
    expect(running.cleaning).toEqual({ startedAt: started.startedAt })
    expect(fakeDocker.images.has("postgres:16")).toBe(true)

    removal.release()
    await vi.waitFor(async () => {
      const done = await Effect.runPromise(harness.cleanup.storage())
      expect(done.cleaning).toBeNull()
      expect(done.lastCleanup).toMatchObject({ images: 1, requested: true })
    })
    expect(fakeDocker.images.has("postgres:16")).toBe(false)
  })

  it("keeps how a cleanup that failed in the background ended", async () => {
    const harness = await relayHarness()
    // Read once, so reads while it runs answer from these figures.
    await Effect.runPromise(harness.cleanup.storage())
    // Docker fails it as it looks for update leftovers, then recovers
    // before it removes images.
    fakeDocker.failNext(
      { command: "ps" },
      "Cannot connect to the Docker daemon"
    )

    await Effect.runPromise(
      harness.cleanup.startCleanup({ buildCache: false, unknownImages: false })
    )

    await vi.waitFor(async () => {
      const done = await Effect.runPromise(harness.cleanup.storage())
      expect(done.cleaning).toBeNull()
      expect(done.lastCleanup?.error).toContain(
        "Cannot connect to the Docker daemon"
      )
    })
  })

  it("keeps the image and says it didn't finish when Docker fails to remove one", async () => {
    const harness = await relayHarness()
    const database = fakeDocker.addContainer({
      image: "postgres:16",
      labels: {
        "kiln.database.id": "f".repeat(32),
        "kiln.relay.owner": TEST_NAMESPACE,
      },
      name: "kiln-test-database",
    })
    await Effect.runPromise(harness.cleanup.pass({ kind: "timer" }))
    fakeDocker.removeContainer(database.name)
    await Effect.runPromise(harness.cleanup.storage())
    fakeDocker.failNext({ command: "image rm" }, "layer is locked")

    await Effect.runPromise(
      harness.cleanup.startCleanup({ buildCache: false, unknownImages: false })
    )

    await vi.waitFor(async () => {
      const done = await Effect.runPromise(harness.cleanup.storage())
      expect(done.cleaning).toBeNull()
      expect(done.lastCleanup).toMatchObject({ images: 0 })
      expect(done.lastCleanup?.error).toContain("layer is locked")
    })
    expect(fakeDocker.images.has("postgres:16")).toBe(true)
  })
})
