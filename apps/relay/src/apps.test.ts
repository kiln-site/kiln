import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

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
import { pack } from "tar-stream"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DockerEngine } from "./docker-engine.js"
import { exclusive } from "./operation-lanes.js"
import {
  appLifecycleLocks,
  appReplaceLocks,
  controlRequestLocks,
} from "./operation-plans.js"
import { appRouteOwner } from "./relay-resources.js"
import { fakeDocker } from "./test/docker.js"
import { RelayVolumes } from "./volumes.js"
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
  vi.unstubAllGlobals()
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

  it("reports what each container mounts", async () => {
    const harness = await createdApp()
    const image = await deploy(harness, {})

    expect(image.containers[0]?.mounts).toEqual([
      {
        destination: "/data",
        readOnly: false,
        source: join(harness.config.dataDirectory, "apps", appId),
        type: "bind",
      },
    ])

    // A volume, by the name Docker gives it.
    const removeCompose = await composeConfigCommand()
    fakeDocker.images.set("redis:alpine", {})
    fakeDocker.imageConfigs.set("redis:alpine", { Volumes: { "/data": {} } })
    const compose = await deploy(harness, {
      compose: "services:\n  cache:\n    image: redis:alpine\n",
      sourceType: "compose",
    })

    expect(compose.containers[0]?.mounts).toEqual([
      {
        destination: "/data",
        readOnly: false,
        source: expect.stringMatching(/^[a-f0-9]{64}$/u),
        type: "volume",
      },
    ])
    await removeCompose()
  })

  it("mounts the config's volumes, node paths, and files, each in the services it names", async () => {
    const harness = await createdApp()
    const volumeId = "3f9a21c4".padEnd(40, "0")
    const volume = `${TEST_NAMESPACE}-kiln-3f9a21c4-media`
    fakeDocker.addVolume({
      labels: {
        "kiln.relay.owner": TEST_NAMESPACE,
        "kiln.resource.kind": "volume",
        "kiln.volume.id": volumeId,
      },
      name: volume,
    })
    const files = join(harness.config.dataDirectory, "app-mounts", appId)
    const mounts: AppConfig["mounts"] = [
      {
        id: "media0001",
        readOnly: false,
        service: null,
        source: { type: "volume", volumeId },
        target: "/media",
      },
      {
        id: "certs0001",
        readOnly: true,
        service: null,
        source: { path: "/etc/ssl/certs", type: "host" },
        target: "/certs",
      },
      {
        id: "config001",
        readOnly: true,
        service: "app",
        source: { content: "port = 80\n", type: "file" },
        target: "/etc/app.toml",
      },
    ]

    const app = await deploy(harness, { mounts })

    expect(app.deployment).toMatchObject({ state: "succeeded" })
    expect(appContainers()[0]?.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destination: "/media",
          source: volume,
          type: "volume",
        }),
        expect.objectContaining({
          destination: "/certs",
          readOnly: true,
          source: "/etc/ssl/certs",
        }),
        expect.objectContaining({
          destination: "/etc/app.toml",
          readOnly: true,
          source: join(files, app.deployment!.id, "config001"),
        }),
      ])
    )
    expect(
      await readFile(join(files, app.deployment!.id, "config001"), "utf8")
    ).toBe("port = 80\n")

    // A Compose app's mount goes only in the service it names, and the
    // files no container mounts any longer are removed.
    const removeCompose = await composeConfigCommand()
    const compose = await deploy(harness, {
      compose:
        "services:\n  web:\n    image: nginx:alpine\n  worker:\n    image: nginx:alpine\n",
      mounts: [{ ...mounts[1]!, service: "worker" }],
      sourceType: "compose",
    })

    expect(compose.deployment).toMatchObject({ state: "succeeded" })
    const mounted = (service: string) =>
      appContainers()
        .find((container) => container.labels["kiln.app.service"] === service)
        ?.mounts.map((mount) => mount.destination)
    expect(mounted("worker")).toContain("/certs")
    expect(mounted("web")).not.toContain("/certs")
    expect(await readdir(files)).toEqual([])
    await removeCompose()
  })

  it("leaves the running container's files as they are until a deployment replaces it", async () => {
    const harness = await createdApp()
    const files = join(harness.config.dataDirectory, "app-mounts", appId)
    const mount = (content: string) => ({
      id: "config001",
      readOnly: true,
      service: null,
      source: { content, type: "file" as const },
      target: "/etc/app.toml",
    })
    const first = await deploy(harness, { mounts: [mount("port = 80\n")] })
    const [running] = appContainers()
    const mounted = join(files, first.deployment!.id, "config001")

    // One that changes the file, and one that stops mounting it, each
    // failing before they replace the container.
    for (const mounts of [[mount("port = 81\n")], []]) {
      const pull = fakeDocker.hold({ command: "pull" })
      const deploying = deploy(harness, { mounts })
      await pull.reached
      expect(await readFile(mounted, "utf8")).toBe("port = 80\n")
      pull.fail("pull access denied")
      expect((await deploying).deployment).toMatchObject({ state: "failed" })
      expect(appContainers().map((container) => container.id)).toEqual([
        running!.id,
      ])
      expect(await readFile(mounted, "utf8")).toBe("port = 80\n")
    }

    const replaced = await deploy(harness, { mounts: [mount("port = 81\n")] })
    expect(await readdir(files)).toEqual([replaced.deployment!.id])
  })

  it("gives a deployment within a second of the last its own name and files", async () => {
    const harness = await createdApp()
    const files = join(harness.config.dataDirectory, "app-mounts", appId)
    const mount = (content: string) => ({
      id: "config001",
      readOnly: true,
      service: null,
      source: { content, type: "file" as const },
      target: "/etc/app.toml",
    })
    const first = await deploy(harness, { mounts: [mount("port = 80\n")] })
    const mounted = join(files, first.deployment!.id, "config001")

    // The same second the first started in.
    vi.useFakeTimers({
      now: Date.parse(first.deployment!.startedAt),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    })
    const pull = fakeDocker.hold({ command: "pull" })
    await harness.apps.deploy(deployment({ mounts: [mount("port = 81\n")] }))
    await pull.reached
    expect(await readFile(mounted, "utf8")).toBe("port = 80\n")
    pull.fail("pull access denied")
    const retried = await settledDeployment(harness)

    expect(retried.deployment!.id > first.deployment!.id).toBe(true)
    expect(await readFile(mounted, "utf8")).toBe("port = 80\n")
  })

  it("removes the volumes an image declares with the containers that had them", async () => {
    const harness = await createdApp()
    fakeDocker.images.set("redis:alpine", {})
    fakeDocker.imageConfigs.set("redis:alpine", { Volumes: { "/data": {} } })

    await deploy(harness, { image: "redis:alpine" })
    await deploy(harness, {
      command: "redis-server --save 60 1",
      image: "redis:alpine",
    })
    expect(fakeDocker.danglingVolumes.size).toBe(0)

    await harness.apps.delete({ appId, deleteData: true })
    expect(fakeDocker.danglingVolumes.size).toBe(0)
  })

  it("keeps a volume from being deleted while a deployment that mounts it starts", async () => {
    const harness = await createdApp()
    const volumeId = "3f9a21c4".padEnd(40, "0")
    const volume = `${TEST_NAMESPACE}-kiln-3f9a21c4-media`
    fakeDocker.addVolume({
      labels: {
        "kiln.relay.owner": TEST_NAMESPACE,
        "kiln.resource.kind": "volume",
        "kiln.volume.id": volumeId,
      },
      name: volume,
    })
    const volumes = new RelayVolumes(
      harness.config,
      new DockerEngine(harness.config.dockerSocket),
      harness.state
    )
    const pull = fakeDocker.hold({ command: "pull" })
    const deploying = deploy(harness, {
      mounts: [
        {
          id: "media0001",
          readOnly: false,
          service: null,
          source: { type: "volume", volumeId },
          target: "/media",
        },
      ],
    })
    await pull.reached

    // As the control socket deletes one, in the volume's lane.
    const locks = await controlRequestLocks(
      "relay.volumes.delete",
      { id: volumeId },
      (reference) => reference
    )
    const deleting = Effect.runPromise(
      harness.lanes.run(
        { label: "relay.volumes.delete", locks: locks ?? [] },
        volumes.delete(volumeId)
      )
    ).then(
      () => null,
      (error: unknown) => error
    )
    pull.release()

    expect((await deploying).deployment).toMatchObject({ state: "succeeded" })
    expect(await deleting).toBeInstanceOf(Error)
    expect(fakeDocker.volumes.has(volume)).toBe(true)
    expect(appContainers()[0]?.mounts).toContainEqual(
      expect.objectContaining({ destination: "/media", source: volume })
    )
  })

  it("fails a deployment that mounts a volume no longer on the Relay", async () => {
    const harness = await createdApp()

    const app = await deploy(harness, {
      mounts: [
        {
          id: "media0001",
          readOnly: false,
          service: null,
          source: { type: "volume", volumeId: "a".repeat(40) },
          target: "/media",
        },
      ],
    })

    expect(app.deployment).toMatchObject({
      error: expect.stringContaining("no longer exists"),
      state: "failed",
    })
    expect(appContainers()).toEqual([])
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

  it("keeps an app's current memory reserved until a smaller limit applies", async () => {
    const harness = await createdApp()
    const otherId = "e".repeat(40)
    await harness.apps.create({ id: otherId, name: "Other" })
    const most = Math.ceil((totalmem() * 0.6) / MIB) * MIB
    await deploy(harness, {
      serviceLimits: { app: { cpuMillis: null, memoryBytes: most } },
    })
    const [container] = appContainers()
    const update = fakeDocker.hold({ command: "update", target: container!.id })

    const shrinking = harness.apps.setLimits({
      appId,
      diskLimitBytes: null,
      serviceLimits: { app: { cpuMillis: null, memoryBytes: 64 * MIB } },
    })
    await update.reached
    const other = await deploy(
      harness,
      { serviceLimits: { app: { cpuMillis: null, memoryBytes: most } } },
      otherId
    )
    update.fail("cannot update a running container")

    expect(other.deployment).toMatchObject({
      error: expect.stringContaining("Memory limit exceeds"),
      state: "failed",
    })
    await expect(shrinking).rejects.toThrow()
    expect(container!.memoryBytes).toBe(most)
  })

  it("lets another app deploy while one waits for its health check", async () => {
    const harness = await createdApp()
    const otherId = "e".repeat(40)
    await harness.apps.create({ id: otherId, name: "Other" })
    fakeDocker.images.set("slow:latest", {})
    fakeDocker.imageConfigs.set("slow:latest", {
      Healthcheck: { Test: ["CMD", "true"] },
    })
    fakeDocker.healthTimelines.set("slow:latest", [
      { afterMs: 0, health: "starting" },
      { afterMs: 60_000, health: "healthy" },
    ])

    useDeploymentClock()
    await harness.apps.deploy(deployment({ image: "slow:latest" }))
    await harness.apps.deploy(deployment({}, otherId))
    // On one clock, until the other app's deployment ends.
    let other = await harness.apps.get(otherId)
    while (other.deployment?.state === "running") {
      await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(100)
      other = await harness.apps.get(otherId)
    }

    expect(other.deployment).toMatchObject({ state: "succeeded" })
    expect((await harness.apps.get(appId)).deployment).toMatchObject({
      state: "running",
    })
    expect((await settledDeployment(harness)).deployment).toMatchObject({
      state: "succeeded",
    })
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

describe("rolling deployments", () => {
  const healthChecked = "site:healthy"

  function containerAliases(name: string, network: string) {
    return fakeDocker.container(name)?.networks.get(network)?.aliases ?? []
  }

  it("starts the replacement beside the running container and moves the app's name to it once healthy", async () => {
    const harness = await createdApp()
    fakeDocker.images.set(healthChecked, {})
    fakeDocker.imageConfigs.set(healthChecked, {
      Healthcheck: { Test: ["CMD", "true"] },
    })
    await deploy(harness, { image: healthChecked })
    const [previous] = appContainers()
    const stops = fakeDocker.hold({ command: "stop", target: previous!.id })

    useDeploymentClock()
    await harness.apps.deploy(
      deployment({ command: "serve --v2", image: healthChecked })
    )
    // The old container is still serving when the new one has its name.
    let reached = false
    void stops.reached.then(() => {
      reached = true
    })
    while (!reached) await vi.advanceTimersByTimeAsync(100)
    const network = harness.resources.appNetwork(appId)
    const next = appContainers().find(
      (container) => container.id !== previous!.id
    )
    expect(previous!.state.running).toBe(true)
    expect(containerAliases(next!.name, network)).toContain(
      `app-${appId.slice(0, 8)}`
    )
    stops.release()
    const app = await settledDeployment(harness)

    expect(app.deployment).toMatchObject({ rolling: true, state: "succeeded" })
    expect(appContainers().map((container) => container.id)).toEqual([
      next!.id,
    ])
  })

  it("keeps the running container, and its name, when the replacement fails its health check", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    const [previous] = appContainers()
    fakeDocker.images.set("broken:latest", {})
    fakeDocker.imageConfigs.set("broken:latest", {
      Healthcheck: { Test: ["CMD", "false"] },
    })
    fakeDocker.unhealthyImages.add("broken:latest")

    const app = await deploy(harness, { image: "broken:latest" })

    expect(app.deployment).toMatchObject({
      error: expect.stringContaining("failed its health check"),
      rolling: true,
      state: "failed",
    })
    expect(appContainers().map((container) => container.id)).toEqual([
      previous!.id,
    ])
    expect(previous!.state.running).toBe(true)
    expect(
      containerAliases(previous!.name, harness.resources.appNetwork(appId))
    ).toContain(`app-${appId.slice(0, 8)}`)
  })

  it("stops the running container first when the node can't hold both copies' memory", async () => {
    const harness = await createdApp()
    const most = Math.ceil((totalmem() * 0.6) / MIB) * MIB
    const serviceLimits = { app: { cpuMillis: null, memoryBytes: most } }
    await deploy(harness, { serviceLimits })

    const app = await deploy(harness, { command: "serve --v2", serviceLimits })

    expect(app.deployment).toMatchObject({ rolling: false, state: "succeeded" })
    expect(appContainers()).toHaveLength(1)
  })

  it("stops the running container first when the app publishes host ports", async () => {
    const harness = await createdApp()
    const ports = [
      { containerPort: 80, hostPort: 8080, protocol: "tcp" as const },
    ]
    await deploy(harness, { ports })

    const app = await deploy(harness, { command: "serve --v2", ports })

    expect(app.deployment).toMatchObject({ rolling: false, state: "succeeded" })
    expect(appContainers()).toHaveLength(1)
  })

  it("rolls a Compose project over in a project of its own, and removes the old one", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const compose =
      "services:\n  web:\n    image: nginx:alpine\n  worker:\n    image: nginx:alpine\n"
    const first = await deploy(harness, { compose, sourceType: "compose" })
    expect(first.deployment).toMatchObject({ rolling: false })
    const before = appContainers().map((container) => container.id)

    const second = await deploy(harness, { compose, sourceType: "compose" })

    expect(second.deployment).toMatchObject({
      rolling: true,
      state: "succeeded",
    })
    const after = appContainers()
    expect(after).toHaveLength(2)
    expect(after.some((container) => before.includes(container.id))).toBe(
      false
    )
    expect(
      new Set(
        after.map((container) => container.labels["com.docker.compose.project"])
      )
    ).toEqual(
      new Set([
        `${TEST_NAMESPACE}-kiln-app-${appId}-${second.deployment!.id}`,
      ])
    )
    expect(
      containerAliases(
        after.find(
          (container) =>
            container.labels["com.docker.compose.service"] === "web"
        )!.name,
        harness.resources.appNetwork(appId)
      )
    ).toContain(`web.app-${appId.slice(0, 8)}`)
    await removeCompose()
  })

  it("keeps the running project when one new service fails its health check while another is still starting", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const first =
      "services:\n  web:\n    image: nginx:alpine\n  worker:\n    image: nginx:alpine\n"
    await deploy(harness, { compose: first, sourceType: "compose" })
    const before = appContainers().map((container) => container.id)
    for (const image of ["site:web", "site:worker"]) {
      fakeDocker.images.set(image, {})
      fakeDocker.imageConfigs.set(image, {
        Healthcheck: { Test: ["CMD", "true"] },
      })
    }
    // The web service passes, then fails while the worker is still starting.
    fakeDocker.healthTimelines.set("site:web", [
      { afterMs: 0, health: "healthy" },
      { afterMs: 8_000, health: "unhealthy" },
    ])
    fakeDocker.healthTimelines.set("site:worker", [
      { afterMs: 0, health: "starting" },
      { afterMs: 30_000, health: "healthy" },
    ])

    const app = await deploy(harness, {
      compose:
        "services:\n  web:\n    image: site:web\n  worker:\n    image: site:worker\n",
      sourceType: "compose",
    })

    expect(app.deployment).toMatchObject({
      error: expect.stringContaining("failed its health check"),
      state: "failed",
    })
    expect(appContainers().map((container) => container.id).sort()).toEqual(
      [...before].sort()
    )
    await removeCompose()
  })

  it("removes the old project's own networks after rolling over, and leaves networks the file names", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const compose = "services:\n  web:\n    image: nginx:alpine\n"
    await deploy(harness, { compose, sourceType: "compose" })
    const base = `${TEST_NAMESPACE}-kiln-app-${appId}`
    // As Compose made them for the first project: its default network, and
    // one the file names itself, which the next project joins.
    fakeDocker.addNetwork({
      labels: { "com.docker.compose.project": base },
      name: `${base}_default`,
    })
    fakeDocker.addNetwork({
      labels: { "com.docker.compose.project": base },
      name: "acme-backend",
    })

    const rolled = await deploy(harness, { compose, sourceType: "compose" })

    expect(rolled.deployment).toMatchObject({
      rolling: true,
      state: "succeeded",
    })
    expect(fakeDocker.networks.has(`${base}_default`)).toBe(false)
    expect(fakeDocker.networks.has("acme-backend")).toBe(true)
    await removeCompose()
  })

  it("keeps a staged Compose service off the app's network, under any name, until it takes over", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    await deploy(harness, {
      compose: "services:\n  api:\n    image: nginx:alpine\n",
      sourceType: "compose",
    })
    const network = harness.resources.appNetwork(appId)
    const [previous] = appContainers()
    fakeDocker.images.set("site:api", {})
    fakeDocker.imageConfigs.set("site:api", {
      Healthcheck: { Test: ["CMD", "true"] },
    })
    fakeDocker.healthTimelines.set("site:api", [
      { afterMs: 0, health: "starting" },
      { afterMs: 20_000, health: "healthy" },
    ])

    useDeploymentClock()
    await harness.apps.deploy(
      deployment({
        compose: "services:\n  api:\n    image: site:api\n",
        sourceType: "compose",
      })
    )
    // While the new service waits for its health check.
    const staged = () =>
      appContainers().find(
        (container) => container.id !== previous!.id && container.state.running
      )
    while (!staged()) await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(staged()!.networks.has(network)).toBe(false)
    expect(containerAliases(previous!.name, network)).toContain("api")
    const app = await settledDeployment(harness)
    expect(app.deployment).toMatchObject({ rolling: true, state: "succeeded" })
    expect(containerAliases(appContainers()[0]!.name, network)).toContain(
      `api.app-${appId.slice(0, 8)}`
    )
    await removeCompose()
  })

  it("binds a Compose file's configs and secrets from the host path of the app's files", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await relayHarness()
    // The Relay's data directory, as the host mounted it, at another path.
    const host = "/srv/kiln/relay-data"
    fakeDocker.addContainer({
      mounts: [
        {
          destination: harness.config.dataDirectory,
          source: host,
          type: "bind",
        },
      ],
      name: "kiln-relay-self",
      running: true,
    })
    vi.stubEnv("HOSTNAME", "kiln-relay-self")
    await harness.apps.create({ id: appId, name: "Website" })
    fakeDocker.images.set("nginx:alpine", {})
    const data = join(harness.config.dataDirectory, "apps", appId)
    const compose = [
      "services:",
      "  web:",
      "    image: nginx:alpine",
      "    configs:",
      "      - source: site",
      "        target: /etc/nginx/conf.d/site.conf",
      "      - source: app",
      "        target: app.conf",
      "    secrets:",
      "      - source: key",
      "      - source: password",
      "        target: db_password",
      "configs:",
      "  site:",
      `    file: ${data}/site.conf`,
      "  app:",
      `    file: ${data}/app.conf`,
      "secrets:",
      "  key:",
      `    file: ${data}/key.pem`,
      "  password:",
      `    file: ${data}/password.txt`,
      "",
    ].join("\n")

    const app = await deploy(harness, { compose, sourceType: "compose" })

    expect(app.deployment).toMatchObject({ state: "succeeded" })
    expect(appContainers()[0]?.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destination: "/etc/nginx/conf.d/site.conf",
          readOnly: true,
          source: join(host, "apps", appId, "site.conf"),
        }),
        expect.objectContaining({
          destination: "/run/secrets/key",
          readOnly: true,
          source: join(host, "apps", appId, "key.pem"),
        }),
        // Relative targets land where Compose puts them.
        expect.objectContaining({
          destination: "/app.conf",
          source: join(host, "apps", appId, "app.conf"),
        }),
        expect.objectContaining({
          destination: "/run/secrets/db_password",
          source: join(host, "apps", appId, "password.txt"),
        }),
      ])
    )
    await removeCompose()
  })

  it("replaces a Compose project that keeps data in a volume instead of running two copies", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    fakeDocker.images.set("postgres:17", {})
    fakeDocker.imageConfigs.set("postgres:17", {
      Volumes: { "/var/lib/postgresql/data": {} },
    })
    const declared =
      "services:\n  web:\n    image: nginx:alpine\n  db:\n    image: postgres:17\n"
    const named =
      "services:\n  db:\n    image: nginx:alpine\n    volumes:\n      - type: volume\n        source: data\n        target: /data\nvolumes:\n  data: {}\n"

    for (const compose of [declared, named]) {
      await deploy(harness, { compose, sourceType: "compose" })
      const app = await deploy(harness, { compose, sourceType: "compose" })

      expect(app.deployment).toMatchObject({
        rolling: false,
        state: "succeeded",
      })
      expect(
        new Set(
          appContainers().map(
            (container) => container.labels["com.docker.compose.project"]
          )
        )
      ).toEqual(new Set([`${TEST_NAMESPACE}-kiln-app-${appId}`]))
    }
    await removeCompose()
  })
})

describe("GitHub deployments", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567"

  // A tarball shaped like GitHub's, served for the commit.
  async function serveRepository(files: Record<string, string>) {
    const packer = pack()
    const chunks: Array<Buffer> = []
    packer.on("data", (chunk: unknown) => {
      chunks.push(Buffer.from(chunk as Uint8Array))
    })
    const done = new Promise<void>((resolve) =>
      packer.on("end", () => resolve())
    )
    for (const [name, body] of Object.entries(files)) {
      packer.entry({ name: `acme-site-${commit.slice(0, 7)}/${name}` }, body)
    }
    packer.finalize()
    await done
    const tarball = gzipSync(Buffer.concat(chunks))
    const requests: Array<{ authorization: string | null; url: string }> = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({
        authorization: new Headers(init.headers).get("authorization"),
        url,
      })
      return new Response(tarball, { status: 200 })
    })
    return requests
  }

  function githubDeployment(
    build: "compose" | "dockerfile",
    path: string,
    config: Partial<AppConfig> = {}
  ) {
    return relayDeployAppSchema.parse({
      appId,
      config: { ...defaultAppConfig, ...config, sourceType: "github" },
      github: {
        build,
        commit,
        path,
        repository: "acme/site",
        token: "ghs_short_lived",
      },
      name: "Website",
    })
  }

  async function deployGitHub(
    harness: RelayHarness,
    input: ReturnType<typeof githubDeployment>
  ) {
    useDeploymentClock()
    await harness.apps.deploy(input)
    return settledDeployment(harness)
  }

  it("builds the commit's Dockerfile with the repository as its context, and keeps no checkout", async () => {
    const harness = await createdApp()
    const requests = await serveRepository({
      "docker/web.Dockerfile": "FROM alpine\nCOPY . .\n",
      "index.html": "<h1>hi</h1>",
    })

    const app = await deployGitHub(
      harness,
      githubDeployment("dockerfile", "docker/web.Dockerfile")
    )

    expect(app.deployment).toMatchObject({ commit, state: "succeeded" })
    expect(requests).toEqual([
      {
        authorization: "Bearer ghs_short_lived",
        url: `https://api.github.com/repos/acme/site/tarball/${commit}`,
      },
    ])
    const [container] = appContainers()
    expect(container!.image).toBe(`kiln-app-${appId}:${app.deployment!.id}`)
    expect(container!.labels["kiln.app.commit"]).toBe(commit)
    await expect(
      readdir(join(harness.config.dataDirectory, "app-sources", appId))
    ).resolves.toEqual([])
  })

  it("runs the commit's Compose file, binding its relative paths to the checkout it keeps", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    await serveRepository({
      "deploy/compose.yaml":
        "services:\n  web:\n    image: nginx:alpine\n    volumes:\n      - type: bind\n        source: ./nginx.conf\n        target: /etc/nginx/nginx.conf\n",
      "deploy/nginx.conf": "events {}",
    })

    const app = await deployGitHub(
      harness,
      githubDeployment("compose", "deploy/compose.yaml")
    )

    expect(app.deployment).toMatchObject({ commit, state: "succeeded" })
    const checkout = join(
      harness.config.dataDirectory,
      "app-sources",
      appId,
      app.deployment!.id
    )
    expect(appContainers()[0]?.labels["kiln.app.commit"]).toBe(commit)
    await expect(access(join(checkout, "deploy/nginx.conf"))).resolves.toBe(
      undefined
    )
    await removeCompose()
  })

  it("keeps the checkout that the containers a failed deployment left running bind files from", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    // A volume makes Compose replace its containers rather than roll, so a
    // failed deployment leaves its own running.
    const compose = (image: string) =>
      `services:\n  web:\n    image: ${image}\n    volumes:\n      - type: volume\n        source: data\n        target: /data\n      - type: bind\n        source: ./public\n        target: /usr/share/nginx/html\nvolumes:\n  data: {}\n`
    await serveRepository({ "compose.yaml": compose("nginx:alpine") })
    await deployGitHub(harness, githubDeployment("compose", "compose.yaml"))
    fakeDocker.images.set("site:broken", {})
    fakeDocker.imageConfigs.set("site:broken", {
      Healthcheck: { Test: ["CMD", "false"] },
    })
    fakeDocker.unhealthyImages.add("site:broken")
    await serveRepository({ "compose.yaml": compose("site:broken") })

    const failed = await deployGitHub(
      harness,
      githubDeployment("compose", "compose.yaml")
    )

    expect(failed.deployment).toMatchObject({ state: "failed" })
    const [running] = appContainers()
    expect(running?.labels["kiln.app.deployment"]).toBe(failed.deployment!.id)
    expect(
      await readdir(join(harness.config.dataDirectory, "app-sources", appId))
    ).toEqual([failed.deployment!.id])
    await removeCompose()
  })

  it("fails before deploying when the repository has no file at the path", async () => {
    const harness = await createdApp()
    await serveRepository({ "README.md": "hi" })

    const app = await deployGitHub(
      harness,
      githubDeployment("dockerfile", "Dockerfile")
    )

    expect(app.deployment).toMatchObject({
      error: "The repository has no file at Dockerfile",
      state: "failed",
    })
    expect(appContainers()).toEqual([])
  })
})

describe("deployment logs", () => {
  it("reads the latest deployment's log and those the Relay kept, and nothing outside them", async () => {
    const harness = await createdApp()
    const first = await deploy(harness, {})
    const second = await deploy(harness, { command: "serve --v2" })

    const latest = await harness.apps.readDeployment({
      appId,
      deploymentId: second.deployment!.id,
    })
    const earlier = await harness.apps.readDeployment({
      appId,
      deploymentId: first.deployment!.id,
    })

    expect(latest?.deployment).toMatchObject({ state: "succeeded" })
    expect(earlier?.lines.map((line) => line.text)).toContain(
      "Pulling nginx:alpine"
    )
    expect(
      await harness.apps.readDeployment({
        appId,
        deploymentId: "../../relay",
      })
    ).toBeNull()
  })
})
