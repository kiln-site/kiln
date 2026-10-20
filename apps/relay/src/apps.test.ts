import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  appTailscaleMemberId,
  defaultAppConfig,
  relayTailscaleStackConfigSchema,
  relayDeployAppSchema,
  type AppConfig,
  type RelayApp,
  type RelayConsoleLine,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { exclusive } from "./operation-lanes.js"
import { appLifecycleLocks, appReplaceLocks } from "./operation-plans.js"
import { appRouteOwner } from "./relay-resources.js"
import { fakeDocker } from "./test/docker.js"
import {
  provisioningWorker,
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const appId = "c".repeat(40)
const MIB = 1024 ** 2

it("returns only requested App views, with table summaries separated from container details", async () => {
  const harness = await createdApp()
  await harness.apps.create({ id: "d".repeat(40), name: "Other app" })
  const items = await harness.apps.inventory(
    [
      { id: appId, view: "status" },
      { id: appId, view: "table" },
      { id: appId, view: "detail" },
      { id: "f".repeat(40), view: "detail" },
    ],
    new AbortController().signal
  )
  expect(items).toEqual([
    { id: appId, view: "status", observedState: "stopped" },
    {
      id: appId,
      view: "table",
      observedState: "stopped",
      table: {
        containerSearchText: "",
        containerCount: 0,
        runningContainerCount: 0,
        deploying: false,
      },
    },
    {
      id: appId,
      view: "detail",
      observedState: "stopped",
      app: expect.objectContaining({ id: appId, containers: [] }),
    },
  ])
})

it("shows a provisioning app at once, then creates it once Hearth claims it", async () => {
  const harness = await relayHarness()
  const manager = await provisioningWorker(harness)
  const input = { id: appId, name: "Website" }

  await Effect.runPromise(
    manager.prepare({
      idempotencyKey: randomUUID(),
      input,
      instanceId: appId,
      kind: "app",
      placeholder: harness.apps.placeholder(input),
    })
  )
  expect(
    await harness.apps.inventory(
      [{ id: appId, view: "detail" }],
      new AbortController().signal
    )
  ).toEqual([
    expect.objectContaining({
      app: expect.objectContaining({
        provisioning: expect.objectContaining({ phase: "awaiting_claim" }),
      }),
      observedState: "provisioning",
    }),
  ])
  // Until it exists, nothing can change it.
  await expect(harness.apps.get(appId)).rejects.toThrow("App not found")

  await Effect.runPromise(manager.claim("app", appId))
  for (let tries = 0; tries < 10_000; tries += 1) {
    const [app] = await harness.apps.list()
    if (app && !app.provisioning) break
    await new Promise((resolve) => setImmediate(resolve))
  }

  expect(await harness.apps.list()).toEqual([
    expect.objectContaining({ id: appId, observedState: "stopped" }),
  ])
  expect((await harness.apps.list())[0]?.provisioning).toBeUndefined()
  expect(fakeDocker.networks.has(harness.resources.appNetwork(appId))).toBe(
    true
  )
})

it("removes the data directory of an app whose create failed before its network", async () => {
  const harness = await relayHarness()
  const manager = await provisioningWorker(harness)
  const input = { id: appId, name: "Website" }
  fakeDocker.failNext({ command: "network create" }, "address pools exhausted")
  await Effect.runPromise(
    manager.prepare({
      idempotencyKey: randomUUID(),
      input,
      instanceId: appId,
      kind: "app",
      placeholder: harness.apps.placeholder(input),
    })
  )
  await Effect.runPromise(manager.claim("app", appId))
  for (let tries = 0; tries < 10_000; tries += 1) {
    const [app] = await harness.apps.list()
    if (app?.observedState === "failed") break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const directory = join(harness.config.dataDirectory, "apps", appId)
  await access(directory)

  await Effect.runPromise(
    manager.discard("app", appId, () => harness.apps.discard(appId))
  )

  await expect(access(directory)).rejects.toThrow()
  expect(await harness.apps.list()).toEqual([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function createdApp() {
  const harness = await relayHarness()
  await harness.apps.create({ id: appId, name: "Website" })
  fakeDocker.images.set("nginx:alpine", {})
  return harness
}

// Where the last deployment left the fake clock, so the next one starts
// later and gets its own time.
let clock = 0

// Deploys and lets the new container settle, under fake timers, until the
// deployment finishes.
async function deploy(
  harness: RelayHarness,
  config: Partial<AppConfig>,
  id = appId
): Promise<RelayApp> {
  useDeploymentClock()
  await harness.apps.deploy(deployment(config, id))
  return settledDeployment(harness, id)
}

function deployment(config: Partial<AppConfig>, id = appId) {
  return relayDeployAppSchema.parse({
    appId: id,
    config: { ...defaultAppConfig, image: "nginx:alpine", ...config },
    name: "Website",
  })
}

function useDeploymentClock() {
  vi.useFakeTimers({
    now: Math.max(Date.now(), clock),
    toFake: ["Date", "setTimeout", "clearTimeout"],
  })
}

async function settledDeployment(
  harness: RelayHarness,
  id = appId
): Promise<RelayApp> {
  const [app] = await settledDeployments(harness, [id])
  return app!
}

async function settledDeployments(
  harness: RelayHarness,
  ids: ReadonlyArray<string>
): Promise<Array<RelayApp>> {
  // Docker and the filesystem are real I/O; each step lets them progress
  // before the clock moves on.
  for (let step = 0; step < 10_000; step += 1) {
    const apps = await Promise.all(ids.map((id) => harness.apps.get(id)))
    if (apps.every((app) => app.deployment?.state !== "running")) {
      clock = Date.now()
      vi.useRealTimers()
      return apps
    }
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(100)
  }
  throw new Error("The deployment never finished")
}

// `docker-compose config`, which Relay runs to read a Compose file: the file
// on stdin as JSON. Compose's `up` and buildx's `build` go through the fake
// daemon's `command()` boundary, which refuses the docker CLI.
async function composeConfigCommand(): Promise<() => Promise<void>> {
  const bin = await mkdtemp(join(tmpdir(), "kiln-compose-bin-"))
  const relay = fileURLToPath(new URL("../package.json", import.meta.url))
  await writeFile(
    join(bin, "docker-compose"),
    [
      "#!/usr/bin/env node",
      `const { parse } = require("module").createRequire(${JSON.stringify(relay)})("yaml")`,
      "const args = process.argv.slice(2)",
      'if (args.at(-3) !== "config") process.exit(1)',
      'let input = ""',
      'process.stdin.on("data", (chunk) => (input += chunk))',
      'process.stdin.on("end", () => process.stdout.write(JSON.stringify({ name: args[args.indexOf("-p") + 1], ...parse(input) })))',
    ].join("\n")
  )
  await chmod(join(bin, "docker-compose"), 0o755)
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`)
  return () => rm(bin, { force: true, recursive: true })
}

function appContainers(id = appId) {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.app.id"] === id
  )
}

describe("apps", () => {
  it("deploys an image as one container named for the app and the time", async () => {
    const harness = await createdApp()

    const app = await deploy(harness, {
      environment: "GREETING=hello\n# comment\n",
      ports: [{ containerPort: 80, hostPort: 8080, protocol: "tcp" }],
    })

    expect(app).toMatchObject({
      deployment: { state: "succeeded" },
      observedState: "running",
    })
    const [container] = appContainers()
    expect(appContainers()).toHaveLength(1)
    expect(container!.name).toMatch(
      new RegExp(`^${TEST_NAMESPACE}-kiln-${appId.slice(0, 8)}-\\d{14}$`, "u")
    )
    expect(container!.state.running).toBe(true)
    expect(container!.env).toMatchObject({ GREETING: "hello" })
    expect(container!.labels).toMatchObject({
      "kiln.app.service": "app",
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "app",
    })
    expect(container!.mounts).toContainEqual(
      expect.objectContaining({
        destination: "/data",
        source: join(harness.config.dataDirectory, "apps", appId),
      })
    )
  })

  it("refuses a second deployment sent while the first is starting", async () => {
    const harness = await createdApp()
    const request = relayDeployAppSchema.parse({
      appId,
      config: { ...defaultAppConfig, image: "nginx:alpine" },
      name: "Website",
    })

    useDeploymentClock()
    const results = await Promise.allSettled([
      harness.apps.deploy(request),
      harness.apps.deploy(request),
    ])

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ])
    expect(results.find((result) => result.status === "rejected")).toMatchObject(
      { reason: new Error("A deployment is already running") }
    )
    expect((await settledDeployment(harness)).deployment?.state).toBe(
      "succeeded"
    )
  })

  it("keeps the running container when its replacement fails to start", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    const [previous] = appContainers()

    fakeDocker.failNext({ command: "start" }, "port is already allocated")
    const app = await deploy(harness, { command: "nginx -g 'daemon off;'" })

    expect(app.deployment).toMatchObject({ state: "failed" })
    expect(app.observedState).toBe("running")
    expect(appContainers().map((container) => container.id)).toEqual([
      previous!.id,
    ])
    expect(previous!.state.running).toBe(true)
  })

  // Docker reports a container it keeps restarting as running.
  it("keeps the running container when its replacement keeps crashing", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    const [previous] = appContainers()
    fakeDocker.images.set("crashes:latest", {})
    fakeDocker.crashingImages.add("crashes:latest")

    const app = await deploy(harness, { image: "crashes:latest" })

    expect(app.deployment).toMatchObject({ state: "failed" })
    expect(appContainers().map((container) => container.id)).toEqual([
      previous!.id,
    ])
    expect(previous!.state.running).toBe(true)
  })

  it("keeps the latest deployment's log across a Relay restart", async () => {
    const harness = await createdApp()
    const deployed = await deploy(harness, {})

    const { apps } = await harness.restart()
    const app = await apps.get(appId)
    const session = await apps.consoleSession(appId, "deployment", () =>
      Promise.reject(new Error("Not a container stream"))
    )
    const history = await session.history()

    expect(app.deployment).toMatchObject({
      id: deployed.deployment!.id,
      state: "succeeded",
    })
    expect(history.lines.map((line) => line.text)).toContain(
      "Pulling nginx:alpine"
    )
  })

  it("follows a deployment's log while its oldest lines are dropped", async () => {
    const harness = await createdApp()
    // A pull that prints more than a deployment log keeps.
    const image = "verbose:latest"
    fakeDocker.pullOutput.set(
      image,
      Array.from(
        { length: 20 },
        (_, index) => `layer ${index} ${"x".repeat(900 * 1024)}\n`
      ).join("")
    )
    const pull = fakeDocker.hold({ command: "pull" })
    const deploying = deploy(harness, { image })
    await pull.reached
    const session = await harness.apps.consoleSession(appId, "deployment", () =>
      Promise.reject(new Error("Not a container stream"))
    )
    const controller = new AbortController()
    const lines = session.stream(controller.signal)[Symbol.asyncIterator]()
    // Reading its first line when the pull prints the rest at once.
    const first = await lines.next()
    pull.release()
    await deploying
    const rest: Array<RelayConsoleLine | undefined> = []
    for (;;) {
      const { value } = await lines.next()
      rest.push(value)
      if (!value || value.text.startsWith("Deployment ")) break
    }
    controller.abort()

    const index = (line: RelayConsoleLine | undefined) =>
      Number(line?.id.split("-").at(-1))
    const history = await session.history(5_000)
    expect(index(first.value)).toBe(0)
    expect(rest.every((line) => line !== undefined)).toBe(true)
    expect(rest.map(index)).toEqual(history.lines.map(index))
    // The oldest lines were dropped from the log.
    expect(index(history.lines[0])).toBeGreaterThan(0)
    // About 18 MB of pull output goes through the fake Docker's API.
  }, 15_000)

  it("labels a deployed container for its web routes on an external Traefik", async () => {
    const harness = await relayHarness({ KILN_RELAY_PROXY: "none" })
    await harness.apps.create({ id: appId, name: "Website" })
    fakeDocker.images.set("nginx:alpine", {})
    await Effect.runPromise(
      harness.state.replaceInstanceRoutes(appRouteOwner(appId), [
        {
          hostname: "site.example.com",
          id: "0a1b2c3d",
          name: "Site",
          path: null,
          service: "app",
          stripPrefix: true,
          targetPort: 80,
        },
      ])
    )

    await deploy(harness, {})

    const [container] = appContainers()
    expect(container!.labels).toMatchObject({
      "traefik.enable": "true",
      "traefik.http.routers.kiln-route-0a1b2c3d-https.rule":
        "Host(`site.example.com`)",
      "traefik.http.services.kiln-route-0a1b2c3d.loadbalancer.server.port":
        "80",
    })
    expect([...container!.networks.keys()]).toContain(
      harness.resources.edgeNetwork
    )
  })

  it("puts a service at its Tailscale address when the app deploys", async () => {
    const harness = await createdApp()
    const stackId = "e".repeat(40)
    const address = "10.165.57.12"
    const network = harness.resources.tailscaleStackNetwork(stackId)
    fakeDocker.addNetwork({
      labels: { "kiln.relay.owner": TEST_NAMESPACE },
      name: network,
      subnet: "10.165.57.0/24",
    })
    await mkdir(join(harness.config.rootDirectory, stackId), {
      recursive: true,
    })
    await writeFile(
      join(harness.config.rootDirectory, stackId, "stack.json"),
      JSON.stringify(
        relayTailscaleStackConfigSchema.parse({
          bindings: [
            {
              address,
              enabled: true,
              hostname: "website",
              instanceId: appTailscaleMemberId(appId, "app"),
            },
          ],
          domain: "test",
          hostname: "private-network",
          id: stackId,
          name: "Private Network",
          subnet: "10.165.57.0/24",
        })
      )
    )

    await deploy(harness, {})

    const [container] = appContainers()
    expect(container!.networks.get(network)).toMatchObject({
      ipAddress: address,
    })
  })

  it("keeps bundled Traefik on a routed app's network when Traefik is recreated", async () => {
    const harness = await relayHarness({ KILN_RELAY_PROXY: "traefik" })
    await harness.apps.create({ id: appId, name: "Website" })
    fakeDocker.addContainer({ name: "kiln-relay", running: true })
    vi.stubEnv("HOSTNAME", "kiln-relay")
    const route = {
      hostname: "site.example.com",
      id: "0a1b2c3d",
      instanceId: appRouteOwner(appId),
      name: "Site",
      path: null,
      service: "app",
      stripPrefix: true,
      targetPort: 80,
    }

    await harness.lifecycle.configureProxy(
      {
        acmeEmail: "admin@example.com",
        mode: "traefik",
        traefikImage: "traefik:v3.7.13",
      },
      [route]
    )

    expect([
      ...fakeDocker
        .container(harness.resources.traefikContainer)!
        .networks.keys(),
    ]).toContain(harness.resources.appNetwork(appId))
  })

  it("removes a routed app's network that bundled Traefik joined", async () => {
    const harness = await createdApp()
    const network = harness.resources.appNetwork(appId)
    fakeDocker.addContainer({
      name: harness.resources.traefikContainer,
      networks: [network],
      running: true,
    })

    await harness.apps.delete({ appId, deleteData: false })

    expect(fakeDocker.networks.has(network)).toBe(false)
    await expect(harness.apps.list()).resolves.toEqual([])
  })

  it("builds a Dockerfile with buildx and runs a Compose file with the standalone Compose binary", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()

    const built = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })
    expect(built.deployment).toMatchObject({ state: "succeeded" })
    expect(
      fakeDocker.images.get(`kiln-app-${appId}:${built.deployment?.id}`)
    ).toEqual({ "kiln.app.id": appId })
    expect(appContainers()[0]?.image).toBe(
      `kiln-app-${appId}:${built.deployment?.id}`
    )

    const composed = await deploy(harness, {
      compose: "services:\n  web:\n    image: nginx:alpine\n",
      serviceLimits: { web: { cpuMillis: 250, memoryBytes: 256 * MIB } },
      sourceType: "compose",
    })
    expect(composed.deployment).toMatchObject({ state: "succeeded" })
    expect(
      appContainers().map((container) => [
        container.labels["com.docker.compose.service"],
        container.state.running,
        container.memoryBytes,
        container.nanoCpus,
      ])
    ).toEqual([["web", true, 256 * MIB, 2.5e8]])
    await removeCompose()
  })

  it("applies each service's limits when it deploys and changes them in place", async () => {
    const harness = await createdApp()
    await deploy(harness, {
      serviceLimits: { app: { cpuMillis: 500, memoryBytes: 256 * MIB } },
    })
    const [deployed] = appContainers()
    expect(deployed).toMatchObject({ memoryBytes: 256 * MIB, nanoCpus: 5e8 })

    const limited = await harness.apps.setLimits({
      appId,
      diskLimitBytes: 1024 * MIB,
      serviceLimits: { app: { cpuMillis: 500, memoryBytes: 512 * MIB } },
    })

    expect(appContainers()).toEqual([
      expect.objectContaining({ id: deployed!.id, memoryBytes: 512 * MIB }),
    ])
    expect(limited).toMatchObject({
      containers: [
        {
          limits: { cpuMillis: 500, diskBytes: null, memoryBytes: 512 * MIB },
        },
      ],
      diskLimitBytes: 1024 * MIB,
    })
  })

  it("stops an app whose data outgrows its disk limit", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    await harness.apps.setLimits({
      appId,
      diskLimitBytes: 128 * MIB,
      serviceLimits: {},
    })
    const data = join(harness.config.dataDirectory, "apps", appId, "big.bin")

    await harness.apps.enforceDiskLimits()
    expect(appContainers()[0]?.state.running).toBe(true)

    // A sparse file: its apparent size counts, without filling the disk.
    await writeFile(data, "")
    await truncate(data, 200 * MIB)
    await harness.apps.enforceDiskLimits()

    expect(appContainers()[0]?.state.running).toBe(false)
    expect(await harness.apps.get(appId)).toMatchObject({
      diskLimitBytes: 128 * MIB,
      diskUsedBytes: 200 * MIB,
      observedState: "stopped",
    })
  })

  it("counts every service a Compose deployment starts, and limits Docker keeps until it redeploys", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    // Over half the node, so two such limits can't both fit.
    const most = Math.ceil((totalmem() * 0.6) / MIB) * MIB
    const compose = [
      "services:",
      "  web:",
      "    image: nginx:alpine",
      "  worker:",
      "    image: nginx:alpine",
      `    mem_limit: ${most}`,
    ].join("\n")

    // The worker's own limit, from its Compose file, counts with the web
    // service's.
    const refused = await deploy(harness, {
      compose,
      serviceLimits: { web: { cpuMillis: null, memoryBytes: most } },
      sourceType: "compose",
    })
    expect(refused.deployment?.error).toMatch(/Memory limit exceeds/u)
    expect(appContainers()).toHaveLength(0)

    // A limit saved for a service the file no longer has doesn't count.
    const deployed = await deploy(harness, {
      compose,
      serviceLimits: {
        gone: { cpuMillis: null, memoryBytes: most },
        web: { cpuMillis: null, memoryBytes: 64 * MIB },
      },
      sourceType: "compose",
    })
    expect(deployed.deployment).toMatchObject({ state: "succeeded" })

    // Removing the worker's limit waits for a redeploy, so it still holds
    // its memory, and the web service can't take as much again.
    await expect(
      harness.apps.setLimits({
        appId,
        diskLimitBytes: null,
        serviceLimits: {
          web: { cpuMillis: null, memoryBytes: most },
          worker: { cpuMillis: null, memoryBytes: null },
        },
      })
    ).rejects.toThrow(/Memory limit exceeds/u)
    expect(
      appContainers().map((container) => container.memoryBytes)
    ).toContain(64 * MIB)
    await removeCompose()
  })

  it("frees one service's memory before another takes it", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const most = Math.ceil((totalmem() * 0.6) / MIB) * MIB
    await deploy(harness, {
      compose: [
        "services:",
        "  web:",
        "    image: nginx:alpine",
        "  worker:",
        "    image: nginx:alpine",
      ].join("\n"),
      serviceLimits: {
        web: { cpuMillis: null, memoryBytes: most },
        worker: { cpuMillis: null, memoryBytes: 64 * MIB },
      },
      sourceType: "compose",
    })
    const service = (name: string) =>
      appContainers().find(
        (container) => container.labels["com.docker.compose.service"] === name
      )!
    // Docker refuses the web service's decrease.
    fakeDocker.failNext(
      { command: "update", target: service("web").id },
      "Docker unavailable"
    )

    await expect(
      harness.apps.setLimits({
        appId,
        diskLimitBytes: null,
        serviceLimits: {
          web: { cpuMillis: null, memoryBytes: 64 * MIB },
          worker: { cpuMillis: null, memoryBytes: most },
        },
      })
    ).rejects.toThrow("Docker unavailable")

    // The worker never took the memory the web service still holds.
    expect(service("web").memoryBytes).toBe(most)
    expect(service("worker").memoryBytes).toBe(64 * MIB)
    await removeCompose()
  })

  it("lets only one of two deployments that each fit alone take the node's memory", async () => {
    const harness = await createdApp()
    const otherId = "e".repeat(40)
    await harness.apps.create({ id: otherId, name: "Other" })
    const most = Math.ceil((totalmem() * 0.6) / MIB) * MIB
    const limits = { app: { cpuMillis: null, memoryBytes: most } }

    useDeploymentClock()
    await harness.apps.deploy(deployment({ serviceLimits: limits }))
    await harness.apps.deploy(deployment({ serviceLimits: limits }, otherId))
    const outcomes = (await settledDeployments(harness, [appId, otherId])).map(
      (app) => app.deployment?.state
    )

    expect(new Set(outcomes)).toEqual(new Set(["failed", "succeeded"]))
    expect(
      [...appContainers(), ...appContainers(otherId)].filter(
        (container) => container.memoryBytes === most
      )
    ).toHaveLength(1)
  })

  it("finishes a deployment the Relay was paused during", async () => {
    const harness = await createdApp()
    const pull = fakeDocker.hold({ command: "pull" })
    const deploying = deploy(harness, {
      image: "fresh:latest",
      serviceLimits: { app: { cpuMillis: null, memoryBytes: 256 * MIB } },
    })
    await pull.reached
    // A pause lets running work finish; the deployment still reserves its
    // memory once its image is ready.
    harness.lanes.setPaused(true)
    pull.release()

    expect((await deploying).deployment).toMatchObject({ state: "succeeded" })
    expect(appContainers()).toEqual([
      expect.objectContaining({ memoryBytes: 256 * MIB }),
    ])
    harness.lanes.setPaused(false)
  })

  it("keeps checking disk limits after a limited app is deleted", async () => {
    const harness = await createdApp()
    const otherId = "e".repeat(40)
    await harness.apps.create({ id: otherId, name: "Other" })
    await deploy(harness, {})
    await deploy(harness, {}, otherId)
    for (const id of [appId, otherId]) {
      await harness.apps.setLimits({
        appId: id,
        diskLimitBytes: 128 * MIB,
        serviceLimits: {},
      })
    }
    await harness.apps.delete({ appId, deleteData: true })
    const data = join(harness.config.dataDirectory, "apps", otherId, "big.bin")
    await writeFile(data, "")
    await truncate(data, 200 * MIB)

    await harness.apps.enforceDiskLimits()

    expect(appContainers(otherId)[0]?.state.running).toBe(false)
  })

  it("doesn't stop an app whose disk limit was raised while its stop waited", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    await harness.apps.setLimits({
      appId,
      diskLimitBytes: 128 * MIB,
      serviceLimits: {},
    })
    const data = join(harness.config.dataDirectory, "apps", appId, "big.bin")
    await writeFile(data, "")
    await truncate(data, 200 * MIB)
    let release: () => void = () => undefined
    const held = Effect.runPromise(
      harness.lanes.run(
        { label: "app.action", locks: appLifecycleLocks(appId) },
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              release = resolve
            })
        )
      )
    )

    const enforcing = harness.apps.enforceDiskLimits()
    await harness.apps.setLimits({
      appId,
      diskLimitBytes: 1024 * MIB,
      serviceLimits: {},
    })
    release()
    await held
    await enforcing

    expect(appContainers()[0]?.state.running).toBe(true)
  })

  it("doesn't recreate an App deleted while its deployment waited", async () => {
    const harness = await createdApp()
    // The deploy request holds the App's lane while it records the
    // deployment, and a delete arrives behind it.
    let releaseDeploy: () => void = () => undefined
    const deployRequest = Effect.runPromise(
      harness.lanes.run(
        { label: "app.deploy", locks: appLifecycleLocks(appId) },
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              releaseDeploy = resolve
            })
        )
      )
    )
    const deletion = Effect.runPromise(
      harness.lanes.run(
        { label: "app.delete", locks: appReplaceLocks(appId) },
        Effect.promise(() =>
          harness.apps.delete({ appId, deleteData: true })
        )
      )
    )
    await harness.apps.deploy(
      relayDeployAppSchema.parse({
        appId,
        config: { ...defaultAppConfig, image: "nginx:alpine" },
        name: "Website",
      })
    )
    // As the control socket does before the delete waits its turn.
    harness.apps.abortDeployment(appId)
    releaseDeploy()
    await deployRequest
    await expect(deletion).resolves.toMatchObject({ deleted: true })
    await fakeDocker.idle()

    expect((await harness.apps.list()).map((app) => app.id)).not.toContain(
      appId
    )
    expect(appContainers()).toHaveLength(0)
  })

  it("finishes a deployment a withdrawn delete aborted, so the next one can run", async () => {
    const harness = await createdApp()
    let releaseDeploy: () => void = () => undefined
    const deployRequest = Effect.runPromise(
      harness.lanes.run(
        { label: "app.deploy", locks: appLifecycleLocks(appId) },
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              releaseDeploy = resolve
            })
        )
      )
    )
    await harness.apps.deploy(
      relayDeployAppSchema.parse({
        appId,
        config: { ...defaultAppConfig, image: "nginx:alpine" },
        name: "Website",
      })
    )
    // A delete stops the deployment, then is withdrawn before it runs.
    harness.apps.abortDeployment(appId)
    releaseDeploy()
    await deployRequest
    await vi.waitFor(async () =>
      expect((await harness.apps.get(appId)).deployment).toMatchObject({
        error: "The deployment was cancelled",
        state: "failed",
      })
    )

    const app = await deploy(harness, {})
    expect(app.deployment).toMatchObject({ state: "succeeded" })
  })

  it("finishes a deployment the Relay was too busy to start", async () => {
    const harness = await createdApp()
    // Fill the lanes' queue behind something that holds its lock.
    const holder = harness.lanes.admit({
      label: "holder",
      locks: [exclusive("busy")],
    })
    const queued = Array.from({ length: 512 }, (_, index) =>
      harness.lanes.admit({ label: `queued-${index}`, locks: [exclusive("busy")] })
    )
    await harness.apps.deploy(
      relayDeployAppSchema.parse({
        appId,
        config: { ...defaultAppConfig, image: "nginx:alpine" },
        name: "Website",
      })
    )
    await vi.waitFor(async () =>
      expect((await harness.apps.get(appId)).deployment).toMatchObject({
        state: "failed",
      })
    )
    for (const ticket of [holder, ...queued]) ticket.cancel()

    expect((await deploy(harness, {})).deployment).toMatchObject({
      state: "succeeded",
    })
  })

  it("removes an app's containers, network, and data when deleted", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    const data = join(harness.config.dataDirectory, "apps", appId)
    await writeFile(join(data, "notes.txt"), "keep me?")

    await harness.apps.delete({ appId, deleteData: true })

    expect(appContainers()).toEqual([])
    expect(
      [...fakeDocker.networks.values()].some(
        (network) => network.labels["kiln.app.id"] === appId
      )
    ).toBe(false)
    await expect(access(data)).rejects.toThrow()
    await expect(harness.apps.get(appId)).rejects.toThrow("App not found")
  })
})
