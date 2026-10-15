import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

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

import { appRouteOwner } from "./relay-resources.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const appId = "c".repeat(40)

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
  vi.useFakeTimers({
    now: Math.max(Date.now(), clock),
    toFake: ["Date", "setTimeout", "clearTimeout"],
  })
  await harness.apps.deploy(
    relayDeployAppSchema.parse({
      appId,
      config: { ...defaultAppConfig, image: "nginx:alpine", ...config },
      name: "Website",
    })
  )
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

  it("builds a Dockerfile from the app's files, leaving out what .dockerignore excludes", async () => {
    const harness = await createdApp()
    const data = join(harness.config.dataDirectory, "apps", appId)
    await mkdir(join(data, "src"), { recursive: true })
    await mkdir(join(data, "secrets"), { recursive: true })
    await mkdir(join(data, "cache", "keep"), { recursive: true })
    await writeFile(join(data, "src", "server.js"), "console.log(1)\n")
    await writeFile(join(data, "secrets", "token.txt"), "do not ship")
    await writeFile(join(data, "debug.log"), "noise")
    await writeFile(join(data, "cache", "blob"), "noise")
    await writeFile(join(data, "cache", "keep", "keep.txt"), "kept")
    // A file of the app's own named like the Dockerfile Relay used to add.
    await writeFile(join(data, ".kiln.Dockerfile"), "the app's file")
    await writeFile(
      join(data, ".dockerignore"),
      // A negated class (`[^a]` excludes `secrets` but not `api`), and a
      // wildcard exception under an excluded directory.
      "[^a]*\n!src\n!.kiln.Dockerfile\n!api.txt\n*.log\ncache\n!**/keep.txt\n"
    )
    await writeFile(join(data, "api.txt"), "kept")
    const dockerfile = 'FROM node:24-alpine\nCOPY . .\nCMD ["node", "src/server.js"]\n'

    const app = await deploy(harness, { dockerfile, sourceType: "dockerfile" })

    expect(app.deployment).toMatchObject({ state: "succeeded" })
    const [build] = fakeDocker.builds
    expect(build!.dockerfile).toBe(dockerfile)
    // The Dockerfile isn't part of the context, so `COPY . .` doesn't copy
    // it, and the app's own files are sent as they are.
    expect(build!.files).toEqual([
      ".kiln.Dockerfile",
      "api.txt",
      "cache/keep/keep.txt",
      "src/server.js",
    ])
    expect(build!.labels).toEqual({ "kiln.app.id": appId })
    const [container] = appContainers()
    expect(container!.image).toBe(build!.tag)
    expect(container!.state.running).toBe(true)
  })

  it("refuses oversized and truncated session messages without buffering them, and still builds", async () => {
    const harness = await createdApp()
    const frame = (length: number, bytes: number) => {
      const prefix = Buffer.alloc(5)
      prefix.writeUInt32BE(length, 1)
      return Buffer.concat([prefix, Buffer.alloc(bytes)])
    }
    // One advertising 2 GiB, one ending partway through, one compressed.
    fakeDocker.sessionProbes.push(
      frame(2 ** 31, 64 * 1024),
      frame(10, 3),
      Buffer.concat([Buffer.from([1]), frame(2, 2).subarray(1)])
    )

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(fakeDocker.sessionProbeStatuses).toEqual(["8", "13", "12"])
    expect(app.deployment).toMatchObject({ state: "succeeded" })
  })

  it("applies a .dockerignore of more patterns than an HTTP/2 header list holds by default", async () => {
    const harness = await createdApp()
    const data = join(harness.config.dataDirectory, "apps", appId)
    await writeFile(join(data, "kept.txt"), "kept")
    await writeFile(join(data, "excluded-150.txt"), "excluded")
    await writeFile(
      join(data, ".dockerignore"),
      Array.from({ length: 200 }, (_, index) => `excluded-${index}.txt`).join("\n")
    )

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment).toMatchObject({ state: "succeeded" })
    expect(fakeDocker.builds[0]?.files).toContain("kept.txt")
    expect(fakeDocker.builds[0]?.files).not.toContain("excluded-150.txt")
  })

  it("closes the build's session when Docker rejects the build", async () => {
    const harness = await createdApp()
    fakeDocker.buildRejection = "unsupported builder version"

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment).toMatchObject({
      error: "Error response from daemon: unsupported builder version",
      state: "failed",
    })
    await vi.waitFor(() => expect(fakeDocker.sessionCount()).toBe(0))
  })

  it("closes a build's session when its deployment is cancelled", async () => {
    const harness = await createdApp()
    const build = fakeDocker.hold({ command: "build" })
    const deploying = harness.apps.deploy(
      relayDeployAppSchema.parse({
        appId,
        config: {
          ...defaultAppConfig,
          dockerfile: "FROM alpine\nCOPY . .\n",
          sourceType: "dockerfile",
        },
        name: "Website",
      })
    )
    await build.reached
    expect(fakeDocker.sessionCount()).toBe(1)

    // Deleting the app cancels its deployment.
    const deleting = harness.apps.delete({ appId, deleteData: false })
    await vi.waitFor(() => expect(fakeDocker.sessionCount()).toBe(0))
    build.release()
    await deploying
    await deleting
    expect(appContainers()).toEqual([])
  })

  it("fails a deployment whose build fails, with the build's error", async () => {
    const harness = await createdApp()
    fakeDocker.buildFailure =
      'process "/bin/sh -c npm ci" did not complete successfully: exit code: 1'

    const app = await deploy(harness, {
      dockerfile: "FROM node:24-alpine\nRUN npm ci\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment).toMatchObject({
      error: 'process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
      state: "failed",
    })
    expect(appContainers()).toEqual([])
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
