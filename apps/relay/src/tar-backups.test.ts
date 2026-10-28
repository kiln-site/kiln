import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import {
  access,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"

import {
  defaultAppConfig,
  relayDeployAppSchema,
  type AppConfig,
  type BackupCreateTaskInput,
  type BackupTaskInput,
  type RelayBackupTask,
} from "@workspace/contracts"
import { Effect } from "effect"
import { pack as tarPack } from "tar-stream"
import { afterEach, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { BackupManager } from "./backups.js"
import { backupArchivePath } from "./backups/destinations/index.js"
import { DockerEngine } from "./docker-engine.js"
import { RelayStateStore } from "./effect/state.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"
import { RelayVolumes } from "./volumes.js"

const volumeId = "3f9a21c4".padEnd(40, "0")
const appId = "c".repeat(40)
const otherAppId = "d".repeat(40)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function relay() {
  const harness = await relayHarness()
  // The helpers run the Relay's own image, found through its container.
  harness.config.selfContainer = "kiln-relay"
  fakeDocker.images.set("kiln-relay:test", {})
  fakeDocker.addContainer({ image: "kiln-relay:test", name: "kiln-relay" })
  fakeDocker.images.set("nginx:alpine", {})
  const volumes = new RelayVolumes(
    harness.config,
    new DockerEngine(harness.config.dockerSocket),
    harness.state,
    () => harness.lifecycle.hostDataDirectory()
  )
  return { harness, volumes }
}

function backups(harness: RelayHarness, volumes: RelayVolumes) {
  return Effect.runPromise(
    BackupManager.make({
      apps: {
        hostFolder: async (id) =>
          (await harness.apps.list()).some((app) => app.id === id)
            ? join(await harness.lifecycle.hostDataDirectory(), "apps", id)
            : null,
        isRunning: async (id) =>
          (await harness.apps.get(id)).containers.some(
            (container) => container.running
          ),
        start: async (id) => {
          await harness.apps.action({ action: "start", appId: id })
        },
        stop: async (id) => {
          await harness.apps.action({ action: "stop", appId: id })
        },
      },
      config: harness.config,
      findInstance: async () => null,
      isInstanceStopped: async () => true,
      lanes: harness.lanes,
      volumes,
    }).pipe(Effect.provideService(RelayStateStore, harness.state))
  )
}

function runTask(manager: BackupManager, input: BackupTaskInput) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* manager.enqueue(input)
      yield* manager.runPending()
      return (yield* manager.get(input.taskId))!
    })
  )
}

function createInput(
  target: BackupCreateTaskInput["target"],
  options: Partial<BackupCreateTaskInput> = {}
): BackupTaskInput {
  return {
    artifactKind: "tar_archive",
    backupId: randomUUID(),
    destination: { kind: "local" },
    exclude: [],
    kind: "create",
    maxBytes: null,
    mode: "full",
    reason: "manual",
    target,
    taskId: randomUUID(),
    ...options,
  }
}

function restoreInput(created: RelayBackupTask): BackupTaskInput {
  const result = created.result as { bytes: number; checksumSha256: string }
  return {
    backupId: created.backupId,
    kind: "restore",
    source: {
      bytes: result.bytes,
      checksumSha256: result.checksumSha256,
      kind: "local",
    },
    target: created.input.target,
    taskId: randomUUID(),
  }
}

function kilnVolume() {
  const volume = fakeDocker.addVolume({
    labels: {
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "volume",
      "kiln.volume.id": volumeId,
    },
    name: `${TEST_NAMESPACE}-kiln-3f9a21c4-db`,
  })
  volume.files.set("pgdata/PG_VERSION", "16")
  volume.files.set("pgdata/base/1", "rows")
  volume.directories.add("empty")
  volume.symlinks.set("current", "pgdata")
  volume.owners.set("", { gid: 999, mode: 0o700, uid: 999 })
  volume.owners.set("pgdata", { gid: 999, mode: 0o700, uid: 999 })
  volume.owners.set("pgdata/base/1", { gid: 999, mode: 0o600, uid: 999 })
  return volume
}

// What a volume holds, its folders whether named or implied by paths.
function snapshot(volume: ReturnType<typeof kilnVolume>) {
  const directories = new Set(volume.directories)
  for (const path of [...volume.files.keys(), ...volume.symlinks.keys()]) {
    const parts = path.split("/")
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"))
    }
  }
  return {
    directories: [...directories].sort((left, right) =>
      left.localeCompare(right)
    ),
    files: Object.fromEntries(volume.files),
    owners: Object.fromEntries(
      [...volume.owners].filter(([path]) =>
        ["", "pgdata", "pgdata/base/1"].includes(path)
      )
    ),
    symlinks: Object.fromEntries(volume.symlinks),
  }
}

let clock = 0

async function deploy(
  harness: RelayHarness,
  config: Partial<AppConfig>,
  id = appId
) {
  vi.useFakeTimers({
    now: Math.max(Date.now(), clock),
    toFake: ["Date", "setTimeout", "clearTimeout"],
  })
  await harness.apps.deploy(
    relayDeployAppSchema.parse({
      appId: id,
      config: { ...defaultAppConfig, image: "nginx:alpine", ...config },
      name: "Website",
    })
  )
  for (let step = 0; step < 10_000; step += 1) {
    const app = await harness.apps.get(id)
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

const mountsVolume: Partial<AppConfig> = {
  mounts: [
    {
      id: "pgdata001",
      readOnly: false,
      service: null,
      source: { type: "volume", volumeId },
      target: "/var/lib/postgresql/data",
    },
  ],
}

function helpersLeft() {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.backup.helper"]
  )
}

it("backs up a volume through Docker and restores it with its owners, modes, and links", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  const before = snapshot(volume)
  const manager = await backups(harness, volumes)

  const created = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" })
  )
  expect(created).toMatchObject({
    result: {
      consistency: "live",
      filename: `backup-${created.backupId.slice(0, 8)}.tar.gz`,
    },
    status: "succeeded",
  })

  volume.files.set("pgdata/base/1", "changed")
  volume.files.set("stray", "written since")
  volume.symlinks.delete("current")
  const restored = await runTask(manager, restoreInput(created))

  expect(restored.status).toBe("succeeded")
  expect(snapshot(volume)).toEqual(before)
  expect(helpersLeft()).toEqual([])
  expect(
    await readdir(join(harness.config.dataDirectory, "restores", "tar"))
  ).toEqual([])
})

it("backs up an App's folder through a bind, leaving out what it excludes, and restores it once the App is stopped", async () => {
  const { harness, volumes } = await relay()
  await harness.apps.create({ id: appId, name: "Website" })
  const folder = join(harness.config.dataDirectory, "apps", appId)
  await mkdir(join(folder, "data", "cache"), { recursive: true })
  await writeFile(join(folder, "data", "notes.txt"), "keep")
  await writeFile(join(folder, "data", "cache", "blob"), "skip")
  await symlink("notes.txt", join(folder, "data", "latest"))
  const manager = await backups(harness, volumes)

  const created = await runTask(
    manager,
    createInput({ id: appId, kind: "app" }, { exclude: ["data/cache/"] })
  )
  expect(created.status).toBe("succeeded")

  await writeFile(join(folder, "data", "notes.txt"), "changed")
  await writeFile(join(folder, "stray"), "written since")
  await deploy(harness, {})
  const refused = await runTask(manager, restoreInput(created))
  expect(refused).toMatchObject({
    error: "Stop the App before restoring its folder",
    status: "failed",
  })

  await harness.apps.action({ action: "stop", appId })
  const restored = await runTask(manager, restoreInput(created))

  expect(restored.status).toBe("succeeded")
  expect(await readFile(join(folder, "data", "notes.txt"), "utf8")).toBe("keep")
  expect(await readlink(join(folder, "data", "latest"))).toBe("notes.txt")
  await expect(access(join(folder, "stray"))).rejects.toThrow()
  await expect(access(join(folder, "data", "cache"))).rejects.toThrow()
})

it("refuses to restore a volume while a container that mounts it runs", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  const manager = await backups(harness, volumes)
  const created = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" })
  )
  await harness.apps.create({ id: appId, name: "Website" })
  await deploy(harness, mountsVolume)
  volume.files.set("stray", "written since")

  const refused = await runTask(manager, restoreInput(created))

  expect(refused).toMatchObject({
    error: expect.stringContaining(
      "which mounts this volume, before restoring it"
    ),
    status: "failed",
  })
  expect(volume.files.get("stray")).toBe("written since")
})

it("stops the Apps that use a volume for a stopped backup, and starts again only those that ran", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  await harness.apps.create({ id: appId, name: "Website" })
  await harness.apps.create({ id: otherAppId, name: "Worker" })
  await deploy(harness, mountsVolume)
  await deploy(harness, mountsVolume, otherAppId)
  await harness.apps.action({ action: "stop", appId: otherAppId })
  const running = async (id: string) =>
    (await harness.apps.get(id)).containers.some(
      (container) => container.running
    )
  const manager = await backups(harness, volumes)
  const reading = fakeDocker.hold({ command: "archive get" })

  const backingUp = runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" }, { consistency: "stopped" })
  )
  await reading.reached
  // Nothing writes to it while Docker reads it.
  expect(await running(appId)).toBe(false)
  reading.release()
  const created = await backingUp

  expect(created).toMatchObject({
    result: { consistency: "stopped", warnings: [] },
    status: "succeeded",
  })
  expect(await running(appId)).toBe(true)
  expect(await running(otherAppId)).toBe(false)
  expect(volume.files.get("pgdata/PG_VERSION")).toBe("16")
})

it("refuses a restore whose archive writes through a link it made or climbs out", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  const before = snapshot(volume)
  const manager = await backups(harness, volumes)

  for (const entries of [
    [
      { linkname: "/etc", name: "data/escape", type: "symlink" as const },
      { body: "owned", name: "data/escape/passwd", type: "file" as const },
    ],
    [{ body: "owned", name: "data/../outside", type: "file" as const }],
  ]) {
    const backupId = randomUUID()
    const input = await writeArchive(harness, backupId, entries)
    const restored = await runTask(manager, input)

    expect(restored).toMatchObject({
      error: expect.stringMatching(/symbolic link|unsafe path/u),
      status: "failed",
    })
    expect(snapshot(volume)).toEqual(before)
  }
  expect(helpersLeft()).toEqual([])
})

it("leaves a volume as it was when a restore fails before swapping, and finishes one cut off while swapping when the Relay starts", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  const before = snapshot(volume)
  const manager = await backups(harness, volumes)
  const created = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" })
  )
  volume.files.set("stray", "written since")
  const changed = snapshot(volume)

  fakeDocker.failNext({ command: "archive put" }, "no space left on device")
  const staged = await runTask(manager, restoreInput(created))
  expect(staged.status).toBe("failed")
  expect(snapshot(volume)).toEqual(changed)

  // The old files are cleared, and moving the restored ones in stops.
  fakeDocker.failNext({ command: "restore install" }, "killed")
  const cut = await runTask(manager, restoreInput(created))
  expect(cut).toMatchObject({
    error: expect.stringContaining("finishes the restore when it next starts"),
    status: "failed",
  })
  expect(volume.files.has("stray")).toBe(false)

  const restarted = await backups(harness, volumes)

  expect(snapshot(volume)).toEqual(before)
  expect(await Effect.runPromise(restarted.get(cut.taskId))).toMatchObject({
    error: null,
    result: { warnings: ["Finished after the Relay restarted"] },
    status: "succeeded",
  })
  expect(
    await readdir(join(harness.config.dataDirectory, "restores", "tar"))
  ).toEqual([])
})

// An archive as a tampered backup might hold, stored as the Relay keeps
// its backups, and the restore that names it.
async function writeArchive(
  harness: RelayHarness,
  backupId: string,
  entries: ReadonlyArray<{
    body?: string
    linkname?: string
    name: string
    type: "file" | "symlink"
  }>
): Promise<BackupTaskInput> {
  const path = backupArchivePath(harness.config, backupId)
  await mkdir(join(path, ".."), { recursive: true })
  const pack = tarPack()
  const writing = pipeline(pack, createGzip(), createWriteStream(path))
  const manifest = {
    artifactKind: "tar_archive",
    backupId,
    consistency: "live",
    createdAt: new Date().toISOString(),
    formatVersion: 1,
    mode: "full",
    target: { id: volumeId, kind: "volume" },
    volume: null,
  }
  pack.entry({ name: ".kiln-backup/manifest.json" }, JSON.stringify(manifest))
  pack.entry({ name: "data/", type: "directory" })
  for (const entry of entries) {
    if (entry.type === "symlink") {
      pack.entry({
        linkname: entry.linkname,
        name: entry.name,
        type: "symlink",
      })
    } else pack.entry({ name: entry.name }, entry.body ?? "")
  }
  pack.finalize()
  await writing
  const bytes = (await stat(path)).size
  const checksumSha256 = createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
  return {
    backupId,
    kind: "restore",
    source: { bytes, checksumSha256, kind: "local" },
    target: { id: volumeId, kind: "volume" },
    taskId: randomUUID(),
  }
}
