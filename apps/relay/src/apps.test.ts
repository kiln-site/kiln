import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
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
import { databaseBrick } from "./test/database-bricks.js"
import { composeVolumeId, RelayVolumes } from "./volumes.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const appId = "c".repeat(12)

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
      // The project it is run as names it, whatever name the file gives.
      'process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ...parse(input), name: args[args.indexOf("-p") + 1] })))',
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

describe("an App created with a database", () => {
  const databaseId = "d".repeat(12)
  const addDatabaseNetwork = (name: string) =>
    fakeDocker.addNetwork({
      internal: true,
      labels: {
        "kiln.database.id": databaseId,
        "kiln.database.network": name,
        "kiln.relay.owner": TEST_NAMESPACE,
        "kiln.resource.kind": "database",
      },
      name,
    })

  it("keeps the connection to one still provisioning", async () => {
    const harness = await relayHarness()
    const database = {
      databaseName: "kiln_main",
      ...databaseBrick("postgres"),
      id: databaseId,
      name: "Main",
      password: "p".repeat(24),
      username: "kiln_main",
      variables: {},
    } as const
    await Effect.runPromise(
      harness.state.enqueueProvisioningJob(
        {
          idempotencyKey: randomUUID(),
          input: database,
          instanceId: databaseId,
          kind: "database",
          placeholder: harness.databases.placeholder(database),
        },
        Date.now()
      )
    )

    await harness.apps.create({
      databaseIds: [databaseId],
      id: appId,
      name: "Website",
    })

    expect((await harness.apps.get(appId)).savedDatabaseIds).toEqual([
      databaseId,
    ])
  })

  it("keeps the connection to one whose container is being replaced", async () => {
    const harness = await relayHarness()
    // Between containers, as when a limit comes off, only its network shows.
    addDatabaseNetwork("database-network")

    await harness.apps.create({
      databaseIds: [databaseId],
      id: appId,
      name: "Website",
    })

    expect((await harness.apps.get(appId)).savedDatabaseIds).toEqual([
      databaseId,
    ])
  })
})

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

// The label a deployment leaves outlives the Relay's memory of it, so a
// check after a restart still says which revision runs.
describe("an App that follows a Brick", () => {
  it("says which revision of its Brick it runs, as its last deployment left it", async () => {
    const harness = await createdApp()
    const source = "https://bricks.test/blog.yml"
    const revision = async (number: number | null) => {
      useDeploymentClock()
      await harness.apps.deploy({
        ...deployment({}),
        ...(number === null ? {} : { brick: { revision: number, source } }),
      })
      await settledDeployment(harness)
      const [answer] = await harness.apps.checkImages(
        [{ appId, image: "nginx:alpine" }],
        new AbortController().signal
      )
      return answer?.brick
    }

    expect(await revision(1)).toEqual({ revision: 1, source })
    expect(await revision(2)).toEqual({ revision: 2, source })
    // Detached: deployed since as its own, it says nothing of a Brick.
    expect(await revision(null)).toBeUndefined()
  })
})

// What an App's containers listen on is said whether or not they publish
// it on the Relay, for whoever routes a domain to it.
describe("an App's containers", () => {
  it("say the TCP ports they listen on, published or not", async () => {
    const harness = await createdApp()
    fakeDocker.imageConfigs.set("nginx:alpine", {
      ExposedPorts: { "8080/tcp": {}, "9090/tcp": {}, "53/udp": {} },
    })
    const app = await deploy(harness, {})
    expect(
      app.containers.find((container) => container.running)?.exposedPorts
    ).toEqual([8080, 9090])
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

  it("runs a Compose App's services in the node's workload slice", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const slice = "kilnworkloads.slice"
    harness.docker.allocations.setWorkloadLimit(slice, 1024 ** 3)

    await deploy(harness, {
      compose:
        "services:\n  web:\n    image: nginx:alpine\n    cgroup_parent: elsewhere\n",
      sourceType: "compose",
    })

    const [container] = [...fakeDocker.containers.values()].filter(
      (candidate) => candidate.labels["kiln.app.id"] === appId
    )
    expect(container?.cgroupParent).toBe(slice)
    expect(container?.labels["kiln.relay.workload-slice"]).toBe(slice)
    await removeCompose()
  })

  // What a Compose file declares is kept on a Kiln volume like any other:
  // found again by its ID however often it deploys, never made twice, and
  // never started empty beside its data.
  it("keeps what a Compose file declares on a Kiln volume, through redeploys", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const volumes = relayVolumes(harness)
    const listed = async () => (await Effect.runPromise(volumes.list())).volumes

    await deploy(harness, { compose: declaresVolume, sourceType: "compose" })
    const [made] = await listed()
    const id = composeVolumeId(appId, "data")
    expect(made).toMatchObject({
      id,
      kind: "kiln",
      name: "Website data",
      // Its file names it, whether or not a container mounts it.
      users: [{ appId, configured: true, mounted: true }],
    })
    expect(fakeDocker.volumes.get(made!.dockerName)?.labels).toMatchObject({
      "kiln.resource.kind": "volume",
      "kiln.volume.id": id,
    })
    // Compose made none of its own.
    expect([...fakeDocker.volumes.keys()]).toEqual([made!.dockerName])
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
    expect(await listed()).toEqual([
      expect.objectContaining({ dockerName: made!.dockerName, id }),
    ])
    expect(fakeDocker.volumes.get(made!.dockerName)?.files.get("/rows")).toBe(
      "kept"
    )
    // Named by its file, it can't be deleted from under the App.
    await expect(Effect.runPromise(volumes.delete(id))).rejects.toThrow(
      "configuration mounts this volume"
    )

    // A file that no longer declares it lets go of it, and it stays.
    await deploy(harness, {
      compose: "services:\n  db:\n    image: nginx:alpine\n",
      sourceType: "compose",
    })
    expect(await listed()).toEqual([
      expect.objectContaining({ id, users: [] }),
    ])
    await removeCompose()
  })

  // Whatever key Compose takes is kept: one left to Compose would be a
  // volume no backup takes, beside others that say the App is backed up.
  it("keeps a volume under any key Compose takes, beside the others", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const volumes = relayVolumes(harness)
    const long = "k".repeat(129)

    await deploy(harness, {
      compose: [
        "services:",
        "  db:",
        "    image: nginx:alpine",
        "    volumes:",
        ...["data", "_data", long].flatMap((key, index) => [
          "      - type: volume",
          `        source: ${key}`,
          `        target: /keep${index}`,
        ]),
        "volumes:",
        "  data: {}",
        "  _data: {}",
        `  ${long}: {}`,
        "",
      ].join("\n"),
      sourceType: "compose",
    })

    const listed = (await Effect.runPromise(volumes.list())).volumes
    expect(new Set(listed.map((volume) => volume.id))).toEqual(
      new Set(["data", "_data", long].map((key) => composeVolumeId(appId, key)))
    )
    for (const volume of listed) {
      expect(volume).toMatchObject({
        kind: "kiln",
        users: [{ appId, configured: true }],
      })
    }
    // Compose made none of its own.
    expect(new Set(fakeDocker.volumes.keys())).toEqual(
      new Set(listed.map((volume) => volume.dockerName))
    )
    await removeCompose()
  })

  it("refuses to deploy onto an empty volume when the one it kept is gone", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    await deploy(harness, { compose: declaresVolume, sourceType: "compose" })
    const [dockerName] = [...fakeDocker.volumes.keys()]
    // Removed behind Kiln's back.
    fakeDocker.volumes.delete(dockerName!)
    // The App still names it: its backup must take it, and can't, where
    // one of what is left would pass for all the App keeps.
    const volumes = relayVolumes(harness)
    const gone = composeVolumeId(appId, "data")
    expect((await Effect.runPromise(volumes.list())).missing).toEqual([
      { appId, volumeId: gone },
    ])
    expect(await Effect.runPromise(volumes.appBackupVolumeIds(appId))).toEqual(
      [gone]
    )

    const refused = await deploy(harness, {
      compose: declaresVolume,
      sourceType: "compose",
    })

    expect(refused.deployment).toMatchObject({ state: "failed" })
    expect(refused.deployment?.error).toContain("is gone from its Relay")
    expect(fakeDocker.volumes.size).toBe(0)
    await removeCompose()
  })

  it("refuses to deploy beside a volume Compose made for the same key before", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const old = `${TEST_NAMESPACE}-kiln-app-${appId}_data`
    fakeDocker.addVolume({
      labels: {
        "com.docker.compose.project": `${TEST_NAMESPACE}-kiln-app-${appId}`,
        "com.docker.compose.volume": "data",
      },
      name: old,
    })

    const refused = await deploy(harness, {
      compose: declaresVolume,
      sourceType: "compose",
    })

    expect(refused.deployment).toMatchObject({ state: "failed" })
    expect(refused.deployment?.error).toContain(old)
    // Nothing runs, and its data is where it was.
    expect(appContainers()).toEqual([])
    expect(fakeDocker.volumes.has(old)).toBe(true)
    // The volume made to move it to is no App's yet: a backup of the App
    // would take it, empty, for the data still in the old one.
    const made = (await Effect.runPromise(relayVolumes(harness).list()))
      .volumes
    expect(made).toEqual([
      expect.objectContaining({
        id: composeVolumeId(appId, "data"),
        users: [],
      }),
    ])
    expect(refused.deployment?.error).toContain(made[0]!.dockerName)

    // With the old one gone, it deploys onto that volume, the App's now.
    fakeDocker.volumes.delete(old)
    const deployed = await deploy(harness, {
      compose: declaresVolume,
      sourceType: "compose",
    })
    expect(deployed.deployment).toMatchObject({ state: "succeeded" })
    expect(
      (await Effect.runPromise(relayVolumes(harness).list())).volumes
    ).toEqual([
      expect.objectContaining({
        dockerName: made[0]!.dockerName,
        users: [expect.objectContaining({ appId })],
      }),
    ])
    await removeCompose()
  })

  it("deletes an App without any volume it used", async () => {
    const removeCompose = await composeConfigCommand()
    const harness = await createdApp()
    const volumes = relayVolumes(harness)
    await deploy(harness, { compose: declaresVolume, sourceType: "compose" })
    const [dockerName] = [...fakeDocker.volumes.keys()]
    const id = composeVolumeId(appId, "data")

    await harness.apps.delete({ appId, deleteData: true })
    await Effect.runPromise(volumes.forgetApp("hearth-a", appId))

    expect(fakeDocker.volumes.has(dockerName!)).toBe(true)
    // No App's now, it can be deleted by whoever decides to.
    await Effect.runPromise(volumes.delete(id))
    expect(fakeDocker.volumes.has(dockerName!)).toBe(false)
    await removeCompose()
  })
})
