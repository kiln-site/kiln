import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  appVolumeId,
  defaultAppConfig,
  relayDeployAppSchema,
  type AppConfig,
  type RelayApp,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DockerEngine } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"
import { RelayVolumes } from "./volumes.js"
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

function relayVolumes(harness: RelayHarness) {
  return new RelayVolumes(
    harness.config,
    new DockerEngine(harness.config.dockerSocket),
    harness.state,
    () => harness.lifecycle.hostDataDirectory()
  )
}

function appContainers(id = appId) {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.app.id"] === id
  )
}

describe("rolling deployments", () => {
  it("stops the running container first when it writes to a mounted path, but not when it only reads one", async () => {
    const harness = await createdApp()
    const mounts = (readOnly: boolean) => [
      {
        id: "nodepath1",
        readOnly,
        service: null,
        source: { path: "/srv/shared", type: "host" as const },
        target: "/shared",
      },
    ]
    await deploy(harness, { mounts: mounts(false) })

    const writing = await deploy(harness, {
      command: "serve --v2",
      mounts: mounts(false),
    })
    expect(writing.deployment).toMatchObject({
      rolling: false,
      state: "succeeded",
    })

    const reading = await deploy(harness, {
      command: "serve --v3",
      mounts: mounts(true),
    })
    expect(reading.deployment).toMatchObject({
      rolling: true,
      state: "succeeded",
    })
    expect(appContainers()).toHaveLength(1)
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

describe("App volumes", () => {
  const declaresVolume = [
    "services:",
    "  db:",
    "    image: nginx:alpine",
    "    volumes:",
    "      - type: volume",
    "        source: data",
    "        target: /data",
    "volumes:",
    "  data: {}",
    "",
  ].join("\n")

  it("keeps a Compose volume's ID and data through redeploys and a rolled deployment", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const volumes = relayVolumes(harness)
    const owned = async () =>
      (await Effect.runPromise(volumes.list())).volumes.filter(
        (volume) => volume.kind === "app"
      )

    await deploy(harness, { compose: declaresVolume, sourceType: "compose" })
    const [made] = await owned()
    expect(made).toMatchObject({
      id: `${appId}/data`,
      owner: { appId, volume: "data" },
    })
    fakeDocker.volumes.get(made!.dockerName)!.files.set("/rows", "kept")

    // Running, so a deployment would roll over, but two copies can't share
    // the volume.
    const again = await deploy(harness, {
      compose: declaresVolume,
      sourceType: "compose",
    })
    expect(again.deployment).toMatchObject({
      rolling: false,
      state: "succeeded",
    })
    // Without the volume it rolls over to a project of its own.
    const rolled = await deploy(harness, {
      compose: "services:\n  db:\n    image: nginx:alpine\n",
      sourceType: "compose",
    })
    expect(rolled.deployment).toMatchObject({
      rolling: true,
      state: "succeeded",
    })
    const back = await deploy(harness, {
      compose: declaresVolume,
      sourceType: "compose",
    })
    expect(back.deployment).toMatchObject({ state: "succeeded" })

    expect(await owned()).toEqual([
      expect.objectContaining({
        dockerName: made!.dockerName,
        id: `${appId}/data`,
        users: [{ appId, configured: false, mounted: true }],
      }),
    ])
    expect(fakeDocker.volumes.get(made!.dockerName)?.files.get("/rows")).toBe(
      "kept"
    )
    await removeCompose()
  })

  it("deletes only the volumes its own Compose project made that its deletion names, never one another App mounts", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const otherId = "d".repeat(40)
    await harness.apps.create({ id: otherId, name: "Other app" })
    const kilnId = "3f9a21c4".padEnd(40, "0")
    const kilnVolume = `${TEST_NAMESPACE}-kiln-3f9a21c4-media`
    fakeDocker.addVolume({
      labels: {
        "kiln.relay.owner": TEST_NAMESPACE,
        "kiln.resource.kind": "volume",
        "kiln.volume.id": kilnId,
      },
      name: kilnVolume,
    })
    const project = `${TEST_NAMESPACE}-kiln-app-${appId}`
    await deploy(harness, {
      compose: [
        "services:",
        "  web:",
        "    image: nginx:alpine",
        "    volumes:",
        "      - type: volume",
        "        source: data",
        "        target: /data",
        "      - type: volume",
        "        source: shared",
        "        target: /shared",
        "volumes:",
        "  data: {}",
        "  shared: {}",
        "",
      ].join("\n"),
      mounts: [
        {
          id: "media0001",
          readOnly: false,
          service: null,
          source: { type: "volume", volumeId: kilnId },
          target: "/media",
        },
      ],
      sourceType: "compose",
    })
    // The other App mounts one of this App's volumes by its Docker name.
    await deploy(
      harness,
      {
        compose: [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    volumes:",
          "      - type: volume",
          "        source: cache",
          "        target: /cache",
          "      - type: volume",
          "        source: shared",
          "        target: /shared",
          "volumes:",
          "  cache: {}",
          "  shared:",
          "    external: true",
          `    name: ${project}_shared`,
          "",
        ].join("\n"),
        sourceType: "compose",
      },
      otherId
    )
    expect(fakeDocker.volumes.has(`${project}_data`)).toBe(true)

    // Its deletion planned to take only `data`; `cache` came since.
    fakeDocker.addVolume({
      labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.volume": "cache",
      },
      name: `${project}_cache`,
    })
    await harness.apps.delete({
      appId,
      deleteData: true,
      volumeIds: [appVolumeId(appId, "data"), appVolumeId(appId, "shared")],
    })

    expect(fakeDocker.volumes.has(`${project}_data`)).toBe(false)
    // On the list, but another App mounts it.
    expect(fakeDocker.volumes.has(`${project}_shared`)).toBe(true)
    // Its own and unmounted, but not on the list.
    expect(fakeDocker.volumes.has(`${project}_cache`)).toBe(true)
    expect(fakeDocker.volumes.has(kilnVolume)).toBe(true)
    expect(
      fakeDocker.volumes.has(`${TEST_NAMESPACE}-kiln-app-${otherId}_cache`)
    ).toBe(true)
    await removeCompose()
  })
})
