import { access, mkdir, symlink, writeFile } from "node:fs/promises"
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
import { Effect, Result } from "effect"
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

  it("applies a .dockerignore of as many patterns as Docker can send back", async () => {
    const harness = await createdApp()
    const data = join(harness.config.dataDirectory, "apps", appId)
    await writeFile(join(data, "kept.txt"), "kept")
    await writeFile(join(data, "xxxxxx150"), "excluded")
    // 10,000 patterns, nearly 128 KiB of them as headers: both limits.
    await writeFile(
      join(data, ".dockerignore"),
      Array.from({ length: 10_000 }, (_, index) => `${index}`.padStart(9, "x")).join("\n")
    )

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment).toMatchObject({ state: "succeeded" })
    expect(fakeDocker.builds[0]?.files).toContain("kept.txt")
    expect(fakeDocker.builds[0]?.files).not.toContain("xxxxxx150")
  })

  it.each([
    [
      "patterns",
      Array.from({ length: 60_000 }, (_, index) => `${index}`).join("\n"),
      "The build's .dockerignore has 60000 patterns; Kiln builds with up to 10000",
    ],
    [
      "bytes of patterns",
      Array.from({ length: 1_100 }, (_, index) => `${index}`.padStart(127, "x")).join("\n"),
      "The build's .dockerignore has 145200 bytes of patterns as Docker sends them; Kiln builds with up to 131072, which is what Docker can send back",
    ],
  ])("refuses a .dockerignore of more %s than Docker can send back, before the build", async (_, ignore, error) => {
    const harness = await createdApp()
    const data = join(harness.config.dataDirectory, "apps", appId)
    await writeFile(join(data, ".dockerignore"), ignore)

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment).toMatchObject({ error, state: "failed" })
    expect(fakeDocker.builds).toEqual([])
  })

  it.each([
    [
      "a link to a device",
      (path: string) => symlink("/dev/zero", path),
      "The build's .dockerignore is a symbolic link; Kiln builds with a regular file there",
    ],
    [
      "a directory",
      (path: string) => mkdir(path),
      "The build's .dockerignore is not a regular file",
    ],
    [
      "over the size it reads",
      (path: string) => writeFile(path, "x".repeat(1024 * 1024 + 1)),
      "The build's .dockerignore is over 1048576 bytes; Kiln builds with ignore files of up to that",
    ],
  ])("refuses a .dockerignore that's %s, without reading past its limit", async (_, create, error) => {
    const harness = await createdApp()
    const data = join(harness.config.dataDirectory, "apps", appId)
    await create(join(data, ".dockerignore"))

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment).toMatchObject({ error, state: "failed" })
    expect(fakeDocker.builds).toEqual([])
  })

  it("counts every pattern escaped, as BuildKit sends them, when any isn't ASCII", async () => {
    const harness = await createdApp()
    const data = join(harness.config.dataDirectory, "apps", appId)
    // 111 patterns, about 88 KB as written, which BuildKit escapes to
    // twice that, past what the session takes.
    await writeFile(
      join(data, ".dockerignore"),
      [
        ...Array.from({ length: 110 }, (_, index) => `${index}${"a/".repeat(400)}`),
        "é",
      ].join("\n")
    )

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment?.state).toBe("failed")
    expect(app.deployment?.error).toMatch(
      /^The build's \.dockerignore has \d+ bytes of patterns as Docker sends them; Kiln builds with up to 131072/u
    )
    expect(fakeDocker.builds).toEqual([])
  })

  it("fails a build with a file name that isn't UTF-8, as the CLI does", async (context) => {
    const harness = await createdApp()
    const data = join(harness.config.dataDirectory, "apps", appId)
    await mkdir(join(data, "assets"))
    const created = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise(() =>
          writeFile(
            Buffer.concat([
              Buffer.from(`${join(data, "assets")}/`),
              Buffer.from([0x66, 0xff, 0x6f]),
            ]),
            "x"
          )
        )
      )
    )
    // macOS's file systems refuse such names.
    if (Result.isFailure(created)) context.skip()

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment?.state).toBe("failed")
    expect(app.deployment?.error).toContain(
      'a file name in "assets" isn\'t valid UTF-8: string field contains invalid UTF-8'
    )
  })

  it("fails a build whose session breaks with what broke it", async () => {
    const harness = await createdApp()
    // More than an HTTP/2 header block can hold.
    fakeDocker.excludePatterns = Array.from({ length: 16_000 }, (_, index) =>
      `${index}`.padStart(10, "x")
    )

    const app = await deploy(harness, {
      dockerfile: "FROM alpine\nCOPY . .\n",
      sourceType: "dockerfile",
    })

    expect(app.deployment).toMatchObject({
      error:
        "The build's session with Docker failed: Too many CONTINUATION frames following a HEADER frame",
      state: "failed",
    })
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

  describe("Compose projects", () => {
    const project = `${TEST_NAMESPACE}-kiln-app-${appId}`
    const composeFile = [
      "services:",
      "  web:",
      "    image: nginx:alpine",
      "    environment:",
      "      DATA: ${KILN_DATA}",
      "    volumes: ['./uploads:/uploads', 'cache:/cache']",
      "    depends_on:",
      "      db: { condition: service_healthy }",
      "  db:",
      "    image: postgres:17",
      "    healthcheck: { test: pg_isready, interval: 1s }",
      "volumes:",
      "  cache:",
    ].join("\n")

    const service = (name: string) =>
      appContainers().find(
        (container) => container.labels["com.docker.compose.service"] === name
      )

    it("runs one container per service, labeled as Compose labels them", async () => {
      const harness = await createdApp()
      const data = join(harness.config.dataDirectory, "apps", appId)

      const app = await deploy(harness, {
        compose: composeFile,
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      const web = service("web")!
      const db = service("db")!
      for (const container of [web, db]) {
        expect(container.state.running).toBe(true)
        expect(container.labels).toMatchObject({
          "com.docker.compose.oneoff": "False",
          "com.docker.compose.project": project,
          "kiln.app.id": appId,
          "kiln.resource.kind": "app",
        })
        expect([...container.networks.keys()]).toEqual(
          expect.arrayContaining([
            `${project}_default`,
            `${TEST_NAMESPACE}-kiln-app-${appId}-network`,
          ])
        )
      }
      expect(web.labels["com.docker.compose.depends_on"]).toBe(
        "db:service_healthy:false"
      )
      expect(fakeDocker.networks.get(`${project}_default`)?.labels).toMatchObject(
        {
          "com.docker.compose.network": "default",
          "com.docker.compose.project": project,
        }
      )
      expect(fakeDocker.volumes.get(`${project}_cache`)?.labels).toMatchObject({
        "com.docker.compose.project": project,
        "com.docker.compose.volume": "cache",
      })
      // Paths in the app's directory are bound from where the host has it.
      expect(web.env.DATA).toBe(data)
      expect(web.mounts).toContainEqual(
        expect.objectContaining({
          destination: "/uploads",
          source: join(data, "uploads"),
        })
      )
    })

    it("fails when a dependency doesn't become healthy, leaving its dependents stopped", async () => {
      const harness = await createdApp()
      fakeDocker.unhealthyImages.add("postgres:17")

      const app = await deploy(harness, {
        compose: composeFile,
        sourceType: "compose",
      })

      expect(app.deployment?.state).toBe("failed")
      expect(app.deployment?.error).toMatch(
        /dependency failed to start: container .*-db-\d+ is unhealthy/u
      )
      expect(service("web")?.state.running).toBe(false)
    })

    it("keeps a service's anonymous volumes, declared or from its image, read-only ones read-only, across redeploys", async () => {
      const harness = await createdApp()
      fakeDocker.imageConfigs.set("postgres:17", {
        Volumes: { "/var/lib/postgresql/data": {} },
      })
      const file = [
        "services:",
        "  web:",
        "    image: nginx:alpine",
        "    volumes:",
        "      - /data",
        "      - { type: volume, target: /readonly, read_only: true }",
        "      - { type: tmpfs, target: /scratch, read_only: true }",
        "  db:",
        "    image: postgres:17",
      ].join("\n")
      const mount = (name: string, destination: string) =>
        service(name)?.mounts.find((entry) => entry.destination === destination)

      const first = await deploy(harness, { compose: file, sourceType: "compose" })
      expect(first.deployment).toMatchObject({ state: "succeeded" })
      const before = {
        data: mount("web", "/data")?.source,
        db: mount("db", "/var/lib/postgresql/data")?.source,
        readonly: mount("web", "/readonly")?.source,
      }
      const firstDb = service("db")!.id

      const second = await deploy(harness, { compose: file, sourceType: "compose" })

      expect(second.deployment).toMatchObject({ state: "succeeded" })
      expect(service("db")!.id).not.toBe(firstDb)
      expect(mount("web", "/data")).toMatchObject({ source: before.data, type: "volume" })
      expect(mount("web", "/readonly")).toMatchObject({
        readOnly: true,
        source: before.readonly,
      })
      expect(mount("web", "/scratch")).toMatchObject({ readOnly: true, type: "tmpfs" })
      expect(mount("db", "/var/lib/postgresql/data")?.source).toBe(before.db)
      expect(appContainers()).toHaveLength(2)
    })

    it("replaces the previous containers and removes dropped services", async () => {
      const harness = await createdApp()
      const first = await deploy(harness, {
        compose: composeFile.replace(
          "volumes:\n",
          "  worker:\n    image: busybox\nvolumes:\n"
        ),
        sourceType: "compose",
      })
      expect(first.deployment).toMatchObject({ state: "succeeded" })
      const firstDb = service("db")!.id

      const app = await deploy(harness, {
        compose: composeFile,
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      expect(appContainers().map((container) => container.labels["com.docker.compose.service"]).sort()).toEqual(["db", "web"])
      expect(service("db")!.id).not.toBe(firstDb)
    })

    // What docker compose v5.5.1 leaves when a redeploy fails, which the
    // next deploy replaces.
    describe("when a redeploy fails, as Compose leaves it", () => {
      // Each container: its service, whether it's the first deployment's,
      // a replacement still under its temporary name, and its state.
      const containers = (first: ReadonlyArray<string>) =>
        appContainers()
          .map((container) => ({
            first: first.includes(container.id),
            service: container.labels["com.docker.compose.service"],
            state: container.state.running
              ? "running"
              : container.starts === 0
                ? "created"
                : "exited",
            temporary: /^[0-9a-f]{12}_/u.test(container.name),
          }))
          .sort((left, right) =>
            `${left.service}${left.first}`.localeCompare(
              `${right.service}${right.first}`
            )
          )

      it.each([
        [
          "Docker refuses a replacement (a missing bind source), after the database's",
          (file: string) =>
            file.replace(
              "'./uploads:/uploads'",
              "{ type: bind, source: ./missing, target: /missing, bind: { create_host_path: false } }"
            ),
          () => undefined,
          /bind source path does not exist/u,
          [
            { first: false, service: "db", state: "created", temporary: false },
            { first: true, service: "web", state: "running", temporary: false },
          ],
        ],
        [
          "a replacement fails to start",
          (file: string) => file,
          () =>
            fakeDocker.failNext({ command: "start" }, "port is already allocated"),
          /port is already allocated/u,
          [
            { first: false, service: "db", state: "created", temporary: false },
            { first: false, service: "web", state: "created", temporary: false },
          ],
        ],
        [
          "stopping a replaced container fails after Docker applied it",
          (file: string) => file,
          () => fakeDocker.failAfterNext({ command: "stop" }, "stop timed out"),
          /stop timed out/u,
          [
            { first: false, service: "db", state: "created", temporary: true },
            { first: true, service: "db", state: "exited", temporary: false },
            { first: true, service: "web", state: "running", temporary: false },
          ],
        ],
      ])("leaves what Compose leaves when %s, and the next deploy replaces it", async (_, change, fail, error, left) => {
        const harness = await createdApp()
        const first = await deploy(harness, {
          compose: composeFile,
          sourceType: "compose",
        })
        expect(first.deployment).toMatchObject({ state: "succeeded" })
        const firstIds = appContainers().map((container) => container.id)
        const cache = fakeDocker.volumes.get(`${project}_cache`)
        fail()

        const failed = await deploy(harness, {
          compose: change(composeFile),
          sourceType: "compose",
        })

        expect(failed.deployment?.state).toBe("failed")
        expect(failed.deployment?.error).toMatch(error)
        expect(containers(firstIds)).toEqual(left)

        const next = await deploy(harness, {
          compose: composeFile,
          sourceType: "compose",
        })

        expect(next.deployment).toMatchObject({ state: "succeeded" })
        expect(containers(firstIds)).toEqual([
          { first: false, service: "db", state: "running", temporary: false },
          { first: false, service: "web", state: "running", temporary: false },
        ])
        expect(fakeDocker.volumes.get(`${project}_cache`)).toBe(cache)
      })
    })

    it("pulls, builds, and creates for the platform a service pins", async () => {
      const harness = await createdApp()
      // Present, but for another platform.
      fakeDocker.images.set("busybox:1", {})
      fakeDocker.imagePlatforms.set("busybox:1", "linux/amd64")
      const data = join(harness.config.dataDirectory, "apps", appId)
      await writeFile(join(data, "Dockerfile"), "FROM busybox\n")

      const app = await deploy(harness, {
        compose: [
          "services:",
          "  pinned:",
          "    image: busybox:1",
          "    platform: linux/arm64",
          "  built:",
          "    build: .",
          "    platform: linux/arm64",
        ].join("\n"),
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      expect(fakeDocker.pullPlatforms.get("docker.io/library/busybox:1")).toBe("linux/arm64")
      expect(fakeDocker.builds[0]?.platform).toBe("linux/arm64")
      expect(service("pinned")?.platform).toBe("linux/arm64")
      expect(service("built")?.platform).toBe("linux/arm64")
    })

    it("builds an image services share once, and doesn't pull it for the services that use it", async () => {
      const harness = await createdApp()
      const data = join(harness.config.dataDirectory, "apps", appId)
      await writeFile(join(data, "Dockerfile"), "FROM busybox\n")

      const app = await deploy(harness, {
        compose: [
          "services:",
          "  api:",
          "    image: example/shared:1",
          "    build: .",
          "  worker:",
          "    image: example/shared:1",
          "    build: .",
          "  cron:",
          "    image: example/shared:1",
          "    pull_policy: always",
        ].join("\n"),
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      expect(fakeDocker.builds.map((build) => build.tag)).toEqual([
        "example/shared:1",
      ])
      expect([...fakeDocker.pulls.keys()]).not.toContain(
        "docker.io/example/shared:1"
      )
      expect(
        ["api", "worker", "cron"].map((name) => service(name)?.image)
      ).toEqual(["example/shared:1", "example/shared:1", "example/shared:1"])
    })

    it("recreates a network whose configuration changed, and keeps one that didn't", async () => {
      const harness = await createdApp()
      const file = (internal: boolean) =>
        [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    networks: [back]",
          "networks:",
          "  back:",
          `    internal: ${internal}`,
        ].join("\n")
      const network = () => fakeDocker.networks.get(`${project}_back`)

      await deploy(harness, { compose: file(false), sourceType: "compose" })
      const first = network()!
      await deploy(harness, { compose: file(false), sourceType: "compose" })
      expect(network()!.id).toBe(first.id)

      const changed = await deploy(harness, { compose: file(true), sourceType: "compose" })

      expect(changed.deployment).toMatchObject({ state: "succeeded" })
      expect(network()).toMatchObject({ internal: true })
      expect(network()!.id).not.toBe(first.id)
      expect([...service("web")!.networks.keys()]).toContain(`${project}_back`)
    })

    it("shares the IPC and PID namespaces of a service it names, after creating it", async () => {
      const harness = await createdApp()

      const app = await deploy(harness, {
        compose: [
          "services:",
          "  sidecar:",
          "    image: busybox",
          "    ipc: service:main",
          "    pid: service:main",
          "  main:",
          "    image: busybox",
          "    ipc: shareable",
        ].join("\n"),
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      const main = service("main")!
      expect(service("sidecar")).toMatchObject({
        ipcMode: `container:${main.id}`,
        pidMode: `container:${main.id}`,
      })
    })

    it("starts a service whose optional dependency fails, with a warning", async () => {
      const harness = await createdApp()
      fakeDocker.unhealthyImages.add("postgres:17")

      const app = await deploy(harness, {
        compose: composeFile.replace(
          "db: { condition: service_healthy }",
          "db: { condition: service_healthy, required: false }"
        ),
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      expect(service("web")?.state.running).toBe(true)
      const session = await harness.apps.consoleSession(appId, "deployment", () =>
        Promise.reject(new Error("Not a container stream"))
      )
      const history = await session.history(5_000)
      expect(history.lines.map((line) => line.text)).toContainEqual(
        expect.stringMatching(/optional dependency "db" failed to start: container .* is unhealthy/u)
      )
    })

    it("fails a bind that mustn't create its missing host path", async () => {
      const harness = await createdApp()
      const file = [
        "services:",
        "  web:",
        "    image: nginx:alpine",
        "    volumes:",
        "      - type: bind",
        "        source: ./missing",
        "        target: /missing",
        "        bind: { create_host_path: false }",
      ].join("\n")

      const app = await deploy(harness, { compose: file, sourceType: "compose" })

      expect(app.deployment?.error).toMatch(/bind source path does not exist/u)
      expect(appContainers()).toEqual([])
    })

    it("mounts file secrets and configs read-only, and writes others into the container", async () => {
      const harness = await createdApp()
      const data = join(harness.config.dataDirectory, "apps", appId)
      await writeFile(join(data, "token.txt"), "s3cret")

      const app = await deploy(harness, {
        compose: [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    secrets:",
          "      - token",
          "      - { source: api, target: api.key, uid: '101', mode: 0400 }",
          "    configs:",
          "      - { source: settings, target: /etc/app.conf }",
          "secrets:",
          "  token: { file: ./token.txt }",
          "  api: { environment: API_KEY }",
          "configs:",
          "  settings: { content: 'mode=${MODE}' }",
        ].join("\n"),
        environment: "API_KEY=from-env\nMODE=fast\n",
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      const web = service("web")!
      expect(web.mounts).toContainEqual(
        expect.objectContaining({
          destination: "/run/secrets/token",
          readOnly: true,
          source: join(data, "token.txt"),
          type: "bind",
        })
      )
      expect(web.copiedFiles).toEqual(
        expect.arrayContaining([
          { content: "from-env", gid: 0, mode: 0o400, path: "/run/secrets/api.key", uid: 101 },
          { content: "mode=fast", gid: 0, mode: 0o444, path: "/etc/app.conf", uid: 0 },
        ])
      )
    })

    it("builds with the Dockerfile's own ignore file over the context's", async () => {
      const harness = await createdApp()
      const data = join(harness.config.dataDirectory, "apps", appId)
      await mkdir(join(data, "docker"), { recursive: true })
      await mkdir(join(data, "secrets"), { recursive: true })
      await writeFile(join(data, "secrets", "credentials"), "do not ship")
      await writeFile(join(data, "app.txt"), "ship")
      await writeFile(join(data, ".dockerignore"), "nothing-matches\n")
      await writeFile(join(data, "docker", "web.Dockerfile"), "FROM busybox\nCOPY . /app\n")
      await writeFile(join(data, "docker", "web.Dockerfile.dockerignore"), "secrets\n")

      const app = await deploy(harness, {
        compose: [
          "services:",
          "  web:",
          "    build: { context: ., dockerfile: docker/web.Dockerfile }",
        ].join("\n"),
        sourceType: "compose",
      })

      expect(app.deployment).toMatchObject({ state: "succeeded" })
      const [build] = fakeDocker.builds
      expect(build!.dockerfile).toBe("FROM busybox\nCOPY . /app\n")
      expect(build!.files).toContain("app.txt")
      expect(build!.files).not.toContain("secrets/credentials")
    })

    it("fails before running anything when the file uses what Kiln can't run", async () => {
      const harness = await createdApp()

      const app = await deploy(harness, {
        compose: "services:\n  web:\n    image: nginx\n    links: [db]\n  db:\n    image: postgres\n",
        sourceType: "compose",
      })

      expect(app.deployment?.error).toMatch(/`links`.*doesn't support/u)
      expect(appContainers()).toEqual([])
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
