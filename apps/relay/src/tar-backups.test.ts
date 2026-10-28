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
import { TarRestoreFences } from "./backups/tar-restore-journal.js"
import { DockerEngine } from "./docker-engine.js"
import { RelayStateStore } from "./effect/state.js"
import { exclusive, laneKeys } from "./operation-lanes.js"
import { appLifecycleLocks } from "./operation-plans.js"
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
  // As the Relay does, read before any work and kept across the managers a
  // test starts, which stand for the Relay starting again.
  const fences = await TarRestoreFences.load(harness.config)
  harness.lanes.addRefusal((label, locks) => fences.refusal(label, locks))
  fencesOf.set(harness, fences)
  return { harness, volumes }
}

const fencesOf = new WeakMap<RelayHarness, TarRestoreFences>()

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
        volumes: (id) => Effect.runPromise(volumes.appVolumeIds(id)),
      },
      config: harness.config,
      fences: fencesOf.get(harness)!,
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
  await startDeployment(harness, config, id)
  return deployed(harness, id)
}

function startDeployment(
  harness: RelayHarness,
  config: Partial<AppConfig>,
  id: string
) {
  return harness.apps.deploy(
    relayDeployAppSchema.parse({
      appId: id,
      config: { ...defaultAppConfig, image: "nginx:alpine", ...config },
      name: "Website",
    })
  )
}

// Runs a deployment to its end on fake timers, as its health checks wait.
async function deployed(harness: RelayHarness, id: string) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({
      now: Math.max(Date.now(), clock),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    })
  }
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

it("holds a volume alone through a stopped backup, so an App that begins using it deploys only after", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  await harness.apps.create({ id: otherAppId, name: "Worker" })
  const manager = await backups(harness, volumes)
  const mounted = () =>
    [...fakeDocker.containers.values()].some(
      (container) =>
        container.labels["kiln.app.id"] === otherAppId &&
        container.mounts.some((mount) => mount.source === volume.name)
    )
  const reading = fakeDocker.hold({ command: "archive get" })

  const backingUp = runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" }, { consistency: "stopped" })
  )
  await reading.reached
  // Not one of the Apps the backup stopped: it starts using the volume now,
  // and its deployment waits in the lanes behind the backup.
  await startDeployment(harness, mountsVolume, otherAppId)
  for (
    let tick = 0;
    tick < 1_000 &&
    !harness.lanes
      .describe()
      .waiting.some((waiter) => waiter.label === "app.deployment");
    tick += 1
  ) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(
    harness.lanes
      .describe()
      .waiting.some((waiter) => waiter.label === "app.deployment")
  ).toBe(true)
  expect(mounted()).toBe(false)

  reading.release()
  expect(await backingUp).toMatchObject({
    result: { consistency: "stopped" },
    status: "succeeded",
  })
  await deployed(harness, otherAppId)
  expect(mounted()).toBe(true)
})

it("stops an App once for a stopped batch of its folder and volume, and starts it again once", async () => {
  const { harness, volumes } = await relay()
  kilnVolume()
  await harness.apps.create({ id: appId, name: "Website" })
  const app = await deploy(harness, mountsVolume)
  const container = () => fakeDocker.containers.get(app.containers[0]!.id)!
  const startsBefore = container().starts
  const manager = await backups(harness, volumes)
  const batch = { id: randomUUID(), size: 2 }
  const folder = createInput(
    { id: appId, kind: "app" },
    { batch, consistency: "stopped" }
  )
  const volume = createInput(
    { id: volumeId, kind: "volume" },
    { batch, consistency: "stopped" }
  )
  const reading = fakeDocker.hold({ command: "archive get" })

  const running = Effect.runPromise(
    Effect.gen(function* () {
      yield* manager.enqueue(folder)
      yield* manager.enqueue(volume)
      yield* manager.runPending()
    })
  )
  await reading.reached
  expect(container().state.running).toBe(false)
  reading.release()
  await running

  for (const input of [folder, volume]) {
    expect(await Effect.runPromise(manager.get(input.taskId))).toMatchObject({
      result: { consistency: "stopped", warnings: [] },
      status: "succeeded",
    })
  }
  expect(container().state.running).toBe(true)
  expect(container().starts - startsBefore).toBe(1)
})

it("fails a stopped batch, stopping nothing, when an App begins using its volume while it waits its turn", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  await harness.apps.create({ id: appId, name: "Website" })
  const app = await deploy(harness, mountsVolume)
  const manager = await backups(harness, volumes)
  // Something holds the volume, so the batch waits for its turn.
  let release = () => undefined as void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const occupant = Effect.runPromise(
    harness.lanes.run(
      { label: "test.hold", locks: [exclusive(laneKeys.volume(volumeId))] },
      Effect.promise(() => held)
    )
  )
  const batch = { id: randomUUID(), size: 2 }
  const folder = createInput(
    { id: appId, kind: "app" },
    { batch, consistency: "stopped" }
  )
  const shared = createInput(
    { id: volumeId, kind: "volume" },
    { batch, consistency: "stopped" }
  )
  const running = Effect.runPromise(
    Effect.gen(function* () {
      yield* manager.enqueue(folder)
      yield* manager.enqueue(shared)
      yield* manager.runPending()
    })
  )
  const waiting = () =>
    harness.lanes
      .describe()
      .waiting.some((waiter) => waiter.label === "backup.batch")
  for (let tick = 0; tick < 1_000 && !waiting(); tick += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(waiting()).toBe(true)

  // Another App's container starts using it, as Docker might start one.
  const joiner = fakeDocker.addContainer({
    image: "nginx:alpine",
    labels: { "kiln.app.id": otherAppId, "kiln.resource.kind": "app" },
    mounts: [{ destination: "/data", source: volume.name, type: "volume" }],
    name: "worker-1",
    running: true,
  })
  release()
  await occupant
  await running

  for (const input of [folder, shared]) {
    expect(await Effect.runPromise(manager.get(input.taskId))).toMatchObject({
      error: expect.stringContaining("waited its turn"),
      status: "failed",
    })
  }
  expect(joiner.state.running).toBe(true)
  expect(fakeDocker.containers.get(app.containers[0]!.id)!.state.running).toBe(
    true
  )
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
    error: expect.stringContaining("tries again when it next starts"),
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

it("resumes the current install when concurrent resolutions waited on a clearing journal", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  volume.files.set("first", "already moved")
  volume.files.set("second", "still staged")
  const before = snapshot(volume)
  const manager = await backups(harness, volumes)
  const created = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" })
  )
  fakeDocker.failNext({ command: "restore clear" }, "interrupted")
  const cut = await runTask(manager, restoreInput(created))
  expect(cut.status).toBe("failed")

  const clearing = fakeDocker.hold({ command: "restore clear" })
  const installing = fakeDocker.hold({ command: "restore install" })
  const first = Effect.runPromise(
    Effect.result(manager.resolveTarRestore(cut.taskId, "finish"))
  )
  await clearing.reached
  const second = Effect.runPromise(
    Effect.result(manager.resolveTarRestore(cut.taskId, "finish"))
  )
  const third = Effect.runPromise(
    Effect.result(manager.resolveTarRestore(cut.taskId, "finish"))
  )
  // Both requests must have discovered the clearing journal before the
  // first recovery advances it. No clock or scheduling delay is assumed.
  while (harness.lanes.pending.waiting < 2) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  clearing.release()
  await installing.reached
  // Docker moved one entry before its install helper failed. The fake is
  // held at that external boundary, so model the partial filesystem change.
  const staged = `.kiln-restore-${cut.taskId}/first`
  volume.files.set("first", volume.files.get(staged)!)
  volume.files.delete(staged)
  installing.fail("interrupted after moving the first entry")
  expect((await first)._tag).toBe("Failure")
  expect((await second)._tag).toBe("Success")
  expect(snapshot(volume)).toEqual(before)
  expect((await third)._tag).toBe("Success")
  expect(await Effect.runPromise(manager.get(cut.taskId))).toMatchObject({
    status: "succeeded",
  })
  expect(
    await readdir(join(harness.config.dataDirectory, "restores", "tar"))
  ).toEqual([])
})

it("keeps a volume whose swap failed fenced, even across a restart, and finishes its restore only with nothing running on it", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  const before = snapshot(volume)
  await harness.apps.create({ id: appId, name: "Website" })
  await deploy(harness, mountsVolume)
  const manager = await backups(harness, volumes)
  const created = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" })
  )
  await harness.apps.action({ action: "stop", appId })
  fakeDocker.failNext({ command: "restore install" }, "killed")
  const cut = await runTask(manager, restoreInput(created))
  expect(cut).toMatchObject({
    error: expect.stringContaining("until the restore finishes"),
    status: "failed",
  })

  // Nothing Kiln runs may change it or start what uses it meanwhile.
  expect(
    await runTask(manager, createInput({ id: volumeId, kind: "volume" }))
  ).toMatchObject({
    error: expect.stringContaining("the restore must finish first"),
    status: "failed",
  })
  await expect(
    Effect.runPromise(
      harness.lanes.run(
        { label: "app.action", locks: appLifecycleLocks(appId) },
        Effect.void
      )
    )
  ).rejects.toThrow("can't start until the restore finishes")
  expect(
    (await TarRestoreFences.load(harness.config)).find("volume", volumeId)
  ).not.toBeNull()

  // Docker starts the App anyway, as a restart policy would, and it writes.
  await harness.apps.action({ action: "start", appId })
  volume.files.set("pgdata/PG_VERSION", "17")
  const restarted = await backups(harness, volumes)
  expect(volume.files.get("pgdata/PG_VERSION")).toBe("17")
  expect(await Effect.runPromise(restarted.get(cut.taskId))).toMatchObject({
    status: "failed",
  })

  // Asked to finish, it stops the App and swaps the restore in.
  await Effect.runPromise(restarted.resolveTarRestore(cut.taskId, "finish"))
  expect(snapshot(volume)).toEqual(before)
  expect(await Effect.runPromise(restarted.get(cut.taskId))).toMatchObject({
    status: "succeeded",
  })
  expect(
    await readdir(join(harness.config.dataDirectory, "restores", "tar"))
  ).toEqual([])
  expect(
    await runTask(restarted, createInput({ id: volumeId, kind: "volume" }))
  ).toMatchObject({ status: "succeeded" })
})

it("refuses an archive that names a restore's staging folder, and never stages into a folder already there", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  const before = snapshot(volume)
  const manager = await backups(harness, volumes)

  const taskId = randomUUID()
  const crafted = await writeArchive(harness, randomUUID(), [
    { body: "x", name: `data/.kiln-restore-${taskId}/rows`, type: "file" },
  ])
  expect(await runTask(manager, { ...crafted, taskId })).toMatchObject({
    error: expect.stringContaining("restores keep for their staging folders"),
    status: "failed",
  })
  expect(snapshot(volume)).toEqual(before)

  // A folder with the staging folder's name, which the restore didn't make.
  const created = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" })
  )
  const restore = restoreInput(created)
  volume.files.set(`.kiln-restore-${restore.taskId}/keep`, "not the restore's")
  const blocked = snapshot(volume)
  expect(await runTask(manager, restore)).toMatchObject({
    error: expect.stringContaining("couldn't make its staging folder"),
    status: "failed",
  })
  expect(snapshot(volume)).toEqual(blocked)
})

it("keeps a hard link whose file was left out, so the backup restores", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  volume.files.set("cache/blob", "shared")
  volume.hardlinks.set("data/keep", "cache/blob")
  volume.hardlinks.set("data/keep-too", "cache/blob")
  const manager = await backups(harness, volumes)

  const created = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" }, { exclude: ["cache/"] })
  )
  expect(created.status).toBe("succeeded")
  volume.hardlinks.clear()
  volume.files.delete("cache/blob")
  const restored = await runTask(manager, restoreInput(created))

  expect(restored.status).toBe("succeeded")
  expect(volume.files.get("data/keep")).toBe("shared")
  expect(volume.files.get("data/keep-too")).toBe("shared")
  expect(volume.files.has("cache/blob")).toBe(false)
})

it("starts again an App whose stop failed partway, and still owes the start when that fails too", async () => {
  const { harness, volumes } = await relay()
  kilnVolume()
  await harness.apps.create({ id: appId, name: "Website" })
  const app = await deploy(harness, mountsVolume)
  const container = app.containers[0]!.id
  const running = async () =>
    (await harness.apps.get(appId)).containers.some(
      (candidate) => candidate.running
    )
  const manager = await backups(harness, volumes)

  // Docker stops it but the answer is lost; starting it again fails.
  fakeDocker.failAfterNext({ command: "stop", target: container }, "timeout")
  fakeDocker.failNext({ command: "start", target: container }, "busy")
  const failed = await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" }, { consistency: "stopped" })
  )
  expect(failed).toMatchObject({
    error: expect.stringContaining("couldn't be stopped for the backup"),
    status: "failed",
  })
  expect(await running()).toBe(false)

  await backups(harness, volumes)
  expect(await running()).toBe(true)
  expect(
    await readdir(join(harness.config.dataDirectory, "backup-state", "stopped"))
  ).toEqual([])
})

it("leaves stopped an App whose power a person changed after a stopped backup owed it a start", async () => {
  const { harness, volumes } = await relay()
  kilnVolume()
  await harness.apps.create({ id: appId, name: "Website" })
  const app = await deploy(harness, mountsVolume)
  const container = app.containers[0]!.id
  const running = async () =>
    (await harness.apps.get(appId)).containers.some(
      (candidate) => candidate.running
    )
  const manager = await backups(harness, volumes)
  fakeDocker.failNext({ command: "start", target: container }, "busy")
  await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" }, { consistency: "stopped" })
  )
  expect(await running()).toBe(false)

  // A person stops it, as the control socket records.
  await Effect.runPromise(harness.state.bumpAppPowerRevision(appId, Date.now()))
  await backups(harness, volumes)

  expect(await running()).toBe(false)
  expect(
    await readdir(join(harness.config.dataDirectory, "backup-state", "stopped"))
  ).toEqual([])
})

it("keeps an App stopped after cancelling a deletion that superseded a backup restart", async () => {
  const { harness, volumes } = await relay()
  kilnVolume()
  await harness.apps.create({ id: appId, name: "Website" })
  const app = await deploy(harness, mountsVolume)
  const container = app.containers[0]!.id
  const manager = await backups(harness, volumes)
  fakeDocker.failNext({ command: "start", target: container }, "busy")
  await runTask(
    manager,
    createInput({ id: volumeId, kind: "volume" }, { consistency: "stopped" })
  )
  expect(fakeDocker.container(container)!.state.running).toBe(false)

  const deletionId = randomUUID()
  await Effect.runPromise(
    harness.lanes.run(
      { label: "resource.freeze", locks: [exclusive(laneKeys.app(appId))] },
      Effect.promise(() =>
        harness.freezes.freeze(
          { deletionId, id: appId, kind: "app" },
          (record) =>
            harness.apps.quietForDeletion(appId, (restartPolicies) =>
              record({ restartPolicies })
            )
        )
      )
    )
  )
  await harness.freezes.unfreeze(
    { deletionId, id: appId, kind: "app" },
    async (undo) => {
      if (undo.restartPolicies)
        await harness.apps.restoreRestartPolicies(undo.restartPolicies)
    }
  )
  Object.assign(harness, await harness.restart())
  await backups(harness, volumes)

  expect(fakeDocker.container(container)!.state.running).toBe(false)
  expect(
    await readdir(join(harness.config.dataDirectory, "backup-state", "stopped"))
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
