import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"

import type {
  BackupCreateTaskInput,
  BackupTaskInput,
  RelayBackupTask,
} from "@workspace/contracts"
import { Effect } from "effect"
import { pack as tarPack } from "tar-stream"
import { expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { BackupManager } from "./backups.js"
import type { DatabaseDriver } from "./databases.js"
import { backupArchivePath } from "./backups/destinations/index.js"
import { TarRestoreFences } from "./backups/tar-restore-journal.js"
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

// A database driver whose dump is a few bytes, in place of a database's
// own client run in its container. `asked` is told as each dump starts.
function dumping(asked: () => void = () => undefined) {
  return {
    backupTarget: async (id: string) => {
      asked()
      return { engine: "mysql", id }
    },
    process: async () => ({
      kill: () => undefined,
      stderr: Readable.from([]),
      stdout: Readable.from(["-- MySQL dump\n"]),
      waitFor: async () => 0,
    }),
  } as unknown as DatabaseDriver
}

function backups(
  harness: RelayHarness,
  volumes: RelayVolumes,
  // In place of the Relay's own: Apps whose power a test watches, and a
  // database driver.
  instead: {
    apps?: {
      isRunning: (id: string) => Promise<boolean>
      start: (id: string) => Promise<void>
      stop: (id: string) => Promise<void>
    }
    databases?: DatabaseDriver
  } = {}
) {
  return Effect.runPromise(
    BackupManager.make({
      ...(instead.databases ? { databases: instead.databases } : {}),
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
        ...instead.apps,
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

// Stopped together, a volume and the database beside it are of one quiet
// moment: the database is dumped only once the Apps that use the volume
// are stopped, and they start again only when both have left. A dump taken
// as the App runs would not match the files archived while it was stopped.
it("dumps a database of a stopped batch while the Apps of its volumes are stopped", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  fakeDocker.addContainer({
    labels: {
      "kiln.app.id": "a".repeat(12),
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "app",
    },
    mounts: [{ destination: "/data", source: volume.name, type: "volume" }],
    name: "site",
  })
  let running = true
  const seen: Array<string> = []
  const manager = await backups(harness, volumes, {
    apps: {
      isRunning: async () => running,
      start: async () => {
        running = true
        seen.push("started")
      },
      stop: async () => {
        running = false
        seen.push("stopped")
      },
    },
    databases: dumping(() =>
      seen.push(running ? "dump, running" : "dump, stopped")
    ),
  })
  const batch = { id: randomUUID(), size: 2 }
  const archive = createInput(
    { id: volumeId, kind: "volume" },
    { batch, consistency: "stopped" }
  )
  const dump = createInput(
    { id: "d".repeat(12), kind: "database" },
    { artifactKind: "database_dump", batch, consistency: "stopped" }
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* manager.enqueue(archive)
      yield* manager.enqueue(dump)
      yield* manager.runPending()
    })
  )

  expect(seen).toEqual(["stopped", "dump, stopped", "started"])
  expect(
    await Effect.runPromise(manager.get(archive.taskId))
  ).toMatchObject({ result: { consistency: "stopped" }, status: "succeeded" })
  expect(await Effect.runPromise(manager.get(dump.taskId))).toMatchObject({
    status: "succeeded",
  })
})

// A database is "stopped" only as one of a batch whose volumes are. Left
// without them, as when the rest never reached the Relay, a dump would be
// taken with nothing stopped and still say it was, so none is taken.
it("takes no dump for a stopped batch that arrives without its volumes", async () => {
  const { harness, volumes } = await relay()
  let dumps = 0
  const manager = await backups(harness, volumes, {
    databases: dumping(() => (dumps += 1)),
  })
  const dump = createInput(
    { id: "d".repeat(12), kind: "database" },
    {
      artifactKind: "database_dump",
      batch: { id: randomUUID(), size: 2 },
      consistency: "stopped",
    }
  )

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const ran = Effect.runPromise(
    Effect.gen(function* () {
      yield* manager.enqueue(dump)
      yield* manager.runPending()
      return yield* manager.get(dump.taskId)
    })
  )
  // The Relay waits a few moments for the rest of a batch to arrive.
  let done = false
  void ran.finally(() => {
    done = true
  })
  while (!done) await vi.advanceTimersByTimeAsync(250)
  vi.useRealTimers()

  expect(await ran).toMatchObject({
    error: "This backup's batch is incomplete; no backups were started",
    status: "failed",
  })
  expect(dumps).toBe(0)
})

// A Relay that stops after the dump is finished and before the volume's
// archive is runs the archive again when it starts. Alone, it would stop
// the App a second time: a later moment than the dump's, in a run that
// would read as one. So what is left of the batch is failed instead.
it("fails the rest of a stopped batch whose database was already dumped", async () => {
  const { harness, volumes } = await relay()
  const volume = kilnVolume()
  fakeDocker.addContainer({
    labels: {
      "kiln.app.id": "a".repeat(12),
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "app",
    },
    mounts: [{ destination: "/data", source: volume.name, type: "volume" }],
    name: "site",
  })
  const stops: Array<string> = []
  const manager = await backups(harness, volumes, {
    apps: {
      isRunning: async () => true,
      start: async () => undefined,
      stop: async (id) => {
        stops.push(id)
      },
    },
    databases: dumping(),
  })
  const batch = { id: randomUUID(), size: 2 }
  // The dump, taken and finished before the Relay stopped.
  const dump = createInput(
    { id: "d".repeat(12), kind: "database" },
    { artifactKind: "database_dump", batch, consistency: "stopped" }
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* manager.enqueue(dump)
      yield* harness.state.claimBatchBackupTasks(batch.id, Date.now())
      yield* harness.state.completeBackupTask(
        dump.taskId,
        {
          bytes: 1,
          checksumSha256: "0".repeat(64),
          filename: "dump.sql.gz",
          warnings: [],
        },
        Date.now()
      )
    })
  )
  // The volume's archive, back in line as the Relay starts again.
  const archive = createInput(
    { id: volumeId, kind: "volume" },
    { batch, consistency: "stopped" }
  )

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const ran = Effect.runPromise(
    Effect.gen(function* () {
      yield* manager.enqueue(archive)
      yield* manager.runPending()
      return yield* manager.get(archive.taskId)
    })
  )
  let done = false
  void ran.finally(() => {
    done = true
  })
  while (!done) await vi.advanceTimersByTimeAsync(250)
  vi.useRealTimers()

  expect(await ran).toMatchObject({
    error: "This backup's batch is incomplete; no backups were started",
    status: "failed",
  })
  expect(stops).toEqual([])
})
