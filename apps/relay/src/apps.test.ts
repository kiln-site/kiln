import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
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
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const appId = "c".repeat(40)

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
  config: Partial<AppConfig>
): Promise<RelayApp> {
  useDeploymentClock()
  await harness.apps.deploy(
    relayDeployAppSchema.parse({
      appId,
      config: { ...defaultAppConfig, image: "nginx:alpine", ...config },
      name: "Website",
    })
  )
  return settledDeployment(harness)
}

function useDeploymentClock() {
  vi.useFakeTimers({
    now: Math.max(Date.now(), clock),
    toFake: ["Date", "setTimeout", "clearTimeout"],
  })
}

async function settledDeployment(harness: RelayHarness): Promise<RelayApp> {
  // Docker and the filesystem are real I/O; each step lets them progress
  // before the clock moves on.
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

function appContainers() {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.app.id"] === appId
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
    // `docker-compose config`, which Relay runs to read a Compose file: the
    // file on stdin as JSON. Compose's `up` and buildx's `build` go through
    // the fake daemon's `command()` boundary, which refuses the docker CLI.
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
      sourceType: "compose",
    })
    expect(composed.deployment).toMatchObject({ state: "succeeded" })
    expect(
      appContainers().map((container) => [
        container.labels["com.docker.compose.service"],
        container.state.running,
      ])
    ).toEqual([["web", true]])
    await rm(bin, { force: true, recursive: true })
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
