import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { constants as zlibConstants, createGunzip, createGzip } from "node:zlib"
import { Effect, Fiber, Predicate, Result, Schema } from "effect"
import { extract as tarExtract, type Header, pack as tarPack } from "tar-stream"

import {
  backupTarManifestSchema,
  type BackupTarget,
  type BackupTarManifest,
} from "@workspace/contracts"

import type { RelayConfig } from "../config.js"
import type { DockerEngine } from "../docker-engine.js"
import { writeFileAtomic } from "../effect/atomic-file.js"
import { RelayBackupError } from "../effect/errors.js"
import { relayOwnerLabels, relayOwnsLabels } from "../relay-resources.js"
import { backupPathIsExcluded } from "./exclude.js"
import {
  type TarRestoreRoot,
  type TarRestoreStep,
  tarRestoreStagingName,
} from "./tar-restore-steps.js"

/**
 * Backs up and restores what Docker mounts: a volume, or an App's folder as
 * a bind. Docker reads and writes the files, through its archive API, in a
 * short-lived helper container that mounts them at `/volume`, so each file
 * keeps its owner, mode, and extended attributes, and symlinks stay links.
 *
 * The helper runs the Relay's own image, which is on every Relay that runs
 * in Docker, as supported Relays do, and needs no pull or registry. It's
 * distroless, so the steps a restore runs in it are the Relay's own Node
 * code (`../tar-restore-helper.ts`). It has no network.
 *
 * An archive is `.kiln-backup/manifest.json`, then the files under `data/`,
 * gzipped. Creating one validates every path Docker sends; restoring one
 * validates every entry again before Docker sees it, so nothing lands
 * outside the staging folder or through a symlink the archive made.
 */

const MOUNT = "/volume"
const SOURCE_PREFIX = "volume"
const DATA_PREFIX = "data"
const MANIFEST_PATH = ".kiln-backup/manifest.json"
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ENTRIES = 1_000_000
const HELPER_LABEL = "kiln.backup.helper"
const HELPER_MEMORY_BYTES = 256 * 1024 * 1024
const STEP_TIMEOUT_MS = 30 * 60_000

/** What a helper mounts: a volume by its Docker name, or a host path. */
export type TarSource =
  | { readonly kind: "volume"; readonly name: string }
  | { readonly kind: "bind"; readonly path: string }

export interface TarProgress {
  completed: number
  currentPath: string | null
}

/**
 * Archives what a source holds into `partial`, gzipped, leaving out paths
 * the exclusions name. Fails past `maxBytes` of output.
 */
export async function createTarBackup(options: {
  readonly config: RelayConfig
  readonly engine: DockerEngine
  readonly exclude: ReadonlyArray<string>
  readonly manifest: BackupTarManifest
  readonly maxBytes: number | null
  readonly partial: string
  readonly progress: TarProgress
  readonly signal: AbortSignal
  readonly source: TarSource
}): Promise<{
  bytes: number
  checksumSha256: string
  warnings: Array<string>
}> {
  const { config, engine } = options
  return withHelper(
    config,
    engine,
    options.source,
    { readOnly: true },
    async (helper) => {
      const archive = await Effect.runPromise(
        engine.containerArchive(helper, MOUNT)
      )
      return repack(archive, options)
    }
  )
}

/**
 * Restores an archive over what a source holds. Docker extracts it into a
 * staging folder inside the source, so the old files stay until the copy is
 * whole; `beginInstall` then commits to swapping it in, clearing the old
 * files and moving the restored ones up. A journal records each phase, so a
 * Relay that stops midway finishes or undoes it when it starts again
 * (`recoverInterruptedTarRestores`).
 */
export async function restoreTarBackup(options: {
  readonly archive: string
  readonly backupId: string
  readonly beginInstall: () => void
  readonly config: RelayConfig
  readonly engine: DockerEngine
  readonly signal: AbortSignal
  readonly source: TarSource
  readonly target: BackupTarget
  readonly taskId: string
}): Promise<{ warnings: Array<string> }> {
  const { config, engine, source, taskId } = options
  const manifest = await readTarManifest(options.archive)
  if (
    manifest.backupId !== options.backupId ||
    manifest.target.kind !== options.target.kind ||
    manifest.target.id !== options.target.id
  ) {
    throw tarError(
      "manifest_mismatch",
      "restore.validate",
      "The archive manifest does not match this backup and its target"
    )
  }
  const staging = tarRestoreStagingName(taskId)
  const journal: TarRestoreJournal = {
    phase: "staging",
    root: null,
    source,
    taskId,
    version: 1,
  }
  await writeJournal(config, journal)
  const root = await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        withHelper(config, engine, source, { readOnly: false }, (helper) =>
          stage(engine, helper, options.archive, staging, options.signal)
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.andThen((root) =>
        Effect.try({
          try: () => {
            options.beginInstall()
            return root
          },
          catch: (cause) => cause,
        })
      ),
      Effect.tapError(() =>
        Effect.tryPromise(async () => {
          await runStep(config, engine, source, "discard", staging, null)
          await removeJournal(config, taskId)
        }).pipe(Effect.ignore)
      )
    )
  )
  const installed = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise(() =>
        installRestore(config, engine, { ...journal, root })
      )
    )
  )
  if (Result.isFailure(installed)) {
    throw tarError(
      "restore_install_failed",
      "restore.install",
      `The restored files couldn't all be moved in, and some of the old ones may be gone; the Relay finishes the restore when it next starts. ${errorMessage(installed.failure)}`
    )
  }
  return { warnings: [] }
}

/**
 * Settles restores a stopped Relay left midway: one still staging is
 * undone, leaving the files as they were; one that had begun clearing or
 * installing is finished. Answers the tasks it finished. A restore that
 * can't be settled yet, as when Docker is down, keeps its journal for the
 * next start.
 */
export async function recoverInterruptedTarRestores(
  config: RelayConfig,
  engine: DockerEngine
): Promise<Array<string>> {
  const directory = journalDirectory(config)
  await mkdir(directory, { mode: 0o700, recursive: true })
  await removeLeftoverHelpers(config, engine)
  const completed: Array<string> = []
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue
    const path = join(directory, name)
    const journal = decodeJournal(await readFile(path, "utf8"))
    if (!journal || `${journal.taskId}.json` !== name) {
      await rm(path, { force: true })
      continue
    }
    const settled = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise(async () => {
          if (journal.phase === "staging") {
            await runStep(
              config,
              engine,
              journal.source,
              "discard",
              tarRestoreStagingName(journal.taskId),
              null
            )
            await removeJournal(config, journal.taskId)
            return false
          }
          await installRestore(config, engine, journal)
          return true
        })
      )
    )
    if (Result.isSuccess(settled) && settled.success) {
      completed.push(journal.taskId)
    }
  }
  return completed
}

// ------------------------------------------------------------- archiving

async function repack(
  archive: Readable,
  options: Parameters<typeof createTarBackup>[0]
): Promise<{ bytes: number; checksumSha256: string; warnings: Array<string> }> {
  const { maxBytes, progress } = options
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  const warnings: Array<string> = []
  const digest = createHash("sha256")
  let bytes = 0
  const pack = tarPack()
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (maxBytes !== null && bytes > maxBytes) {
        callback(
          tarError(
            "size_limit_exceeded",
            "create.write",
            "The compressed backup exceeds the configured size limit"
          )
        )
        return
      }
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  const writing = pipeline(
    Readable.from(pack),
    createGzip({ level: zlibConstants.Z_BEST_SPEED }),
    meter,
    createWriteStream(options.partial, { flags: "wx", mode: 0o600 }),
    { signal }
  )
  const reading = async () => {
    await addEntry(
      pack,
      { mode: 0o600, mtime: new Date(), name: MANIFEST_PATH, type: "file" },
      Buffer.from(`${JSON.stringify(options.manifest)}\n`)
    )
    const extract = tarExtract()
    // Settled once every entry is read; a failure before then is the
    // loop's, which this mustn't report again.
    const feeding = settle(() => pipeline(archive, extract, { signal }))
    const excluded: Array<string> = []
    let entries = 0
    for await (const entry of extract) {
      const header = entry.header
      const path = sourcePath(header.name)
      entries += 1
      if (entries > MAX_ENTRIES) {
        throw tarError(
          "too_many_entries",
          "create.collect",
          `Backups cannot contain more than ${MAX_ENTRIES.toLocaleString("en-US")} entries`
        )
      }
      const directory = header.type === "directory"
      const skipped =
        path !== "" &&
        (excluded.some((prefix) => path.startsWith(`${prefix}/`)) ||
          // A restore's staging folder, if one was left behind.
          (!path.includes("/") && path.startsWith(".kiln-restore-")) ||
          backupPathIsExcluded(path, directory, options.exclude))
      if (skipped) {
        if (directory) excluded.push(path)
        entry.resume()
        continue
      }
      if (!ARCHIVED_TYPES.has(header.type ?? "file")) {
        warnings.push(`Skipped ${header.type} ${path}`.slice(0, 1_024))
        entry.resume()
        continue
      }
      progress.currentPath = path || null
      if (header.type === "file") {
        entry.on("data", (chunk) => {
          progress.completed += (chunk as Buffer).byteLength
        })
      }
      await addEntry(
        pack,
        {
          ...header,
          linkname:
            header.type === "link"
              ? dataName(sourcePath(header.linkname ?? ""))
              : header.linkname,
          name: dataName(path, directory),
          pax: entryPax(header.pax),
        },
        entry
      )
    }
    await requireSettled(feeding)
    pack.finalize()
  }
  // Each side stops the other when it fails.
  const settled = await Promise.all([
    settle(reading, controller),
    settle(() => writing, controller),
  ])
  const failure = settled.find(Result.isFailure)
  if (failure) {
    archive.destroy()
    // The first failure, not the abort it caused in the other side.
    throw signal.reason instanceof Error ? signal.reason : failure.failure
  }
  progress.currentPath = null
  return { bytes, checksumSha256: digest.digest("hex"), warnings }
}

const ARCHIVED_TYPES = new Set(["directory", "file", "link", "symlink"])

// A path Docker archived under the mount, relative to it: "" for the mount
// itself. Anything else, or a path that climbs out, isn't the source's.
function sourcePath(name: string): string {
  const trimmed = name.replace(/\/+$/u, "")
  if (trimmed === SOURCE_PREFIX) return ""
  if (!trimmed.startsWith(`${SOURCE_PREFIX}/`)) {
    throw tarError(
      "unsafe_archive_path",
      "create.collect",
      "Docker archived a path outside the source"
    )
  }
  const path = trimmed.slice(SOURCE_PREFIX.length + 1)
  requireSafePath(path, "create.collect")
  return path
}

function dataName(path: string, directory = false): string {
  if (!path) return `${DATA_PREFIX}/`
  return `${DATA_PREFIX}/${path}${directory ? "/" : ""}`
}

// The entry's own PAX records, such as its extended attributes and large
// sizes or IDs, without its path, which the new name replaces.
function entryPax(pax: Header["pax"]): Record<string, string> | undefined {
  if (!Predicate.isObject(pax)) return undefined
  const {
    linkpath: _linkpath,
    path: _path,
    ...rest
  } = pax as Record<string, string>
  return Object.keys(rest).length > 0 ? rest : undefined
}

// ------------------------------------------------------------- restoring

// Extracts the archive into the staging folder, checking every entry, and
// answers the owner and mode the source's root had.
async function stage(
  engine: DockerEngine,
  helper: string,
  archivePath: string,
  staging: string,
  outerSignal: AbortSignal
): Promise<TarRestoreRoot | null> {
  const controller = new AbortController()
  const signal = AbortSignal.any([outerSignal, controller.signal])
  const pack = tarPack()
  const putting = () =>
    Effect.runPromise(
      engine.putContainerArchive(helper, MOUNT, Readable.from(pack))
    )
  let root: TarRestoreRoot | null = null
  const feeding = async () => {
    const extract = tarExtract()
    const reading = settle(() =>
      pipeline(createReadStream(archivePath), createGunzip(), extract, {
        signal,
      })
    )
    const seen = new Map<string, Header["type"]>()
    const links = new Set<string>()
    let first = true
    for await (const entry of extract) {
      const header = entry.header
      if (first) {
        first = false
        if (header.name !== MANIFEST_PATH) {
          throw tarError(
            "invalid_archive",
            "restore.validate",
            "The archive doesn't begin with its manifest"
          )
        }
        entry.resume()
        continue
      }
      const path = archivedDataPath(header.name)
      if (seen.has(path) || seen.size >= MAX_ENTRIES) {
        throw tarError(
          "duplicate_archive_path",
          "restore.validate",
          "The backup contains duplicate paths"
        )
      }
      // Nothing may be written through a link the archive made.
      const parents = path.split("/").slice(0, -1)
      for (let index = 1; index <= parents.length; index += 1) {
        if (links.has(parents.slice(0, index).join("/"))) {
          throw tarError(
            "unsafe_archive_path",
            "restore.validate",
            "The backup writes through a symbolic link"
          )
        }
      }
      if (!ARCHIVED_TYPES.has(header.type ?? "file")) {
        throw tarError(
          "unsupported_archive_entry",
          "restore.validate",
          "The backup contains a special file"
        )
      }
      let linkname = header.linkname
      if (header.type === "link") {
        const target = archivedDataPath(header.linkname ?? "")
        if (seen.get(target) !== "file") {
          throw tarError(
            "unsafe_archive_path",
            "restore.validate",
            "The backup links to a file it doesn't hold"
          )
        }
        linkname = `${staging}/${target}`
      }
      seen.set(path, header.type)
      if (header.type === "symlink") links.add(path)
      if (path === "") {
        if (header.type !== "directory") {
          throw tarError(
            "invalid_archive",
            "restore.validate",
            "The backup's root isn't a folder"
          )
        }
        root = {
          gid: header.gid ?? 0,
          mode: header.mode ?? 0o755,
          uid: header.uid ?? 0,
        }
      }
      await addEntry(
        pack,
        {
          ...header,
          linkname,
          // The staging folder stays private until it's swapped in.
          ...(path === "" ? { gid: 0, mode: 0o700, uid: 0 } : {}),
          name:
            path === ""
              ? `${staging}/`
              : `${staging}/${path}${header.type === "directory" ? "/" : ""}`,
          pax: entryPax(header.pax),
        },
        entry
      )
    }
    await requireSettled(reading)
    if (root === null) {
      throw tarError(
        "invalid_archive",
        "restore.validate",
        "The backup holds no files"
      )
    }
    pack.finalize()
  }
  const settled = await Promise.all([
    settle(feeding, controller, () => pack.destroy()),
    settle(putting, controller),
  ])
  const failure = settled.find(Result.isFailure)
  if (failure) {
    throw signal.reason instanceof Error ? signal.reason : failure.failure
  }
  return root
}

// An entry's path under `data/`, relative to it: "" for the root.
function archivedDataPath(name: string): string {
  const trimmed = name.replace(/\/+$/u, "")
  if (trimmed === DATA_PREFIX) return ""
  if (!trimmed.startsWith(`${DATA_PREFIX}/`)) {
    throw tarError(
      "unsafe_archive_path",
      "restore.validate",
      "The backup contains a path outside its data"
    )
  }
  const path = trimmed.slice(DATA_PREFIX.length + 1)
  requireSafePath(path, "restore.validate")
  return path
}

async function installRestore(
  config: RelayConfig,
  engine: DockerEngine,
  journal: TarRestoreJournal
): Promise<void> {
  const staging = tarRestoreStagingName(journal.taskId)
  if (journal.phase !== "installing") {
    await writeJournal(config, { ...journal, phase: "clearing" })
    await runStep(config, engine, journal.source, "clear", staging, null)
  }
  await writeJournal(config, { ...journal, phase: "installing" })
  await runStep(
    config,
    engine,
    journal.source,
    "install",
    staging,
    journal.root
  )
  await removeJournal(config, journal.taskId)
}

/** Reads and checks the manifest an archive begins with. */
export async function readTarManifest(
  path: string
): Promise<BackupTarManifest> {
  const source = createReadStream(path)
  const gunzip = createGunzip()
  const extract = tarExtract()
  const first = new Promise<Buffer | null>((resolveFirst) => {
    const fail = () => resolveFirst(null)
    source.once("error", fail)
    gunzip.once("error", fail)
    extract.once("error", fail)
    extract.once("finish", fail)
    extract.once("entry", (header, stream) => {
      if (header.name !== MANIFEST_PATH || header.type !== "file") {
        fail()
        return
      }
      const chunks: Array<Buffer> = []
      let size = 0
      stream.on("data", (chunk) => {
        size += (chunk as Buffer).byteLength
        if (size > MAX_MANIFEST_BYTES) fail()
        else chunks.push(chunk as Buffer)
      })
      stream.once("end", () => resolveFirst(Buffer.concat(chunks)))
    })
  })
  source.pipe(gunzip).pipe(extract as unknown as NodeJS.WritableStream)
  const manifest = await first
  source.destroy()
  gunzip.destroy()
  extract.destroy()
  const parsed =
    manifest === null
      ? null
      : backupTarManifestSchema.safeParse(safeJson(manifest.toString("utf8")))
  if (!parsed?.success) {
    throw tarError(
      "invalid_archive",
      "restore.validate",
      "The archive doesn't begin with a valid manifest"
    )
  }
  return parsed.data
}

// ------------------------------------------------------------- helpers

// Runs `use` with a helper that mounts the source and is only created, so
// Docker sets up its mounts for the archive API without running anything.
async function withHelper<A>(
  config: RelayConfig,
  engine: DockerEngine,
  source: TarSource,
  options: { readonly readOnly: boolean },
  use: (helper: string) => Promise<A>
): Promise<A> {
  const relay = await relayContainer(config, engine)
  const name = helperName(config)
  await Effect.runPromise(
    engine.createContainer(
      name,
      helperBody(config, relay, source, {
        cmd: ["-e", ""],
        readOnly: options.readOnly,
      })
    )
  )
  return Effect.runPromise(
    Effect.tryPromise({ try: () => use(name), catch: (cause) => cause }).pipe(
      Effect.ensuring(
        engine.removeContainer(name, { force: true }).pipe(Effect.ignore)
      )
    )
  )
}

// Runs one step of swapping a restore in, in a helper of its own.
async function runStep(
  config: RelayConfig,
  engine: DockerEngine,
  source: TarSource,
  step: TarRestoreStep,
  staging: string,
  root: TarRestoreRoot | null
): Promise<void> {
  const relay = await relayContainer(config, engine)
  const name = helperName(config)
  const main = process.argv[1] ?? ""
  const development = extname(main) === ".ts"
  const entry = join(dirname(main), `tar-restore-helper${extname(main)}`)
  const cmd = [
    ...(development ? ["--import", "tsx"] : []),
    entry,
    step,
    staging,
    ...(root ? [String(root.uid), String(root.gid), String(root.mode)] : []),
  ]
  const run = Effect.gen(function* () {
    const helper = yield* engine.createContainer(
      name,
      helperBody(config, relay, source, { cmd, development, readOnly: false })
    )
    const exited = yield* Effect.forkChild(
      engine.waitContainer(helper.Id, "next-exit")
    )
    yield* engine.startContainer(helper.Id)
    const code = yield* Fiber.join(exited).pipe(
      Effect.timeoutOrElse({
        duration: STEP_TIMEOUT_MS,
        orElse: () => Effect.succeed(null),
      })
    )
    if (code === 0) return
    const output = yield* engine
      .containerLogs(helper.Id, { tail: 20, tty: false })
      .pipe(Effect.orElseSucceed(() => ({ stderr: "", stdout: "" })))
    return yield* Effect.fail(
      tarError(
        "restore_step_failed",
        `restore.${step}`,
        code === null
          ? `The restore's ${step} step took too long`
          : `The restore's ${step} step failed: ${(output.stderr || output.stdout).trim().split("\n").at(-1) ?? `exit ${code}`}`
      )
    )
  }).pipe(
    Effect.ensuring(
      engine.removeContainer(name, { force: true }).pipe(Effect.ignore)
    )
  )
  await Effect.runPromise(run)
}

function helperBody(
  config: RelayConfig,
  relay: { readonly Id: string; readonly Image: string },
  source: TarSource,
  options: {
    readonly cmd: ReadonlyArray<string>
    readonly development?: boolean
    readonly readOnly: boolean
  }
) {
  return {
    Image: relay.Image,
    Entrypoint: [process.execPath],
    Cmd: options.cmd,
    User: "0:0",
    WorkingDir: process.cwd(),
    Healthcheck: { Test: ["NONE"] },
    Labels: { [HELPER_LABEL]: "true", ...relayOwnerLabels(config) },
    HostConfig: {
      AutoRemove: false,
      Memory: HELPER_MEMORY_BYTES,
      MemorySwap: HELPER_MEMORY_BYTES,
      Mounts: [
        source.kind === "volume"
          ? {
              ReadOnly: options.readOnly,
              Source: source.name,
              Target: MOUNT,
              Type: "volume",
              // An empty volume stays empty: nothing of the helper's image
              // is copied into it.
              VolumeOptions: { NoCopy: true },
            }
          : {
              ReadOnly: options.readOnly,
              Source: source.path,
              Target: MOUNT,
              Type: "bind",
            },
      ],
      NetworkMode: "none",
      PidsLimit: 64,
      SecurityOpt: [
        "no-new-privileges",
        // SELinux would keep the helper from a bind's files.
        ...(source.kind === "bind" ? ["label=disable"] : []),
      ],
      // The Relay's source, which development mounts into its container.
      ...(options.development && { VolumesFrom: [relay.Id] }),
    },
  }
}

// The Relay's own container, whose image the helpers run.
async function relayContainer(
  config: RelayConfig,
  engine: DockerEngine
): Promise<{ Id: string; Image: string }> {
  const container = await Effect.runPromise(
    engine
      .inspectContainer<{ Id: string; Image: string }>(
        config.selfContainer ?? hostname()
      )
      .pipe(Effect.orElseSucceed(() => null))
  )
  if (!container?.Image) {
    throw tarError(
      "relay_container_unknown",
      "helper.image",
      "Backing up Apps and volumes needs the Relay to run in Docker"
    )
  }
  return container
}

function helperName(config: RelayConfig): string {
  const name = `kiln-backup-helper-${randomUUID().slice(0, 8)}`
  return config.resourceNamespace ? `${config.resourceNamespace}-${name}` : name
}

// Helpers a stopped Relay left, which nothing uses any more.
async function removeLeftoverHelpers(
  config: RelayConfig,
  engine: DockerEngine
): Promise<void> {
  await Effect.runPromise(
    engine
      .listContainers({ all: true, filters: { label: [HELPER_LABEL] } })
      .pipe(
        Effect.flatMap((containers) =>
          Effect.forEach(
            containers.filter((container) =>
              relayOwnsLabels(config, container.Labels)
            ),
            (container) =>
              engine
                .removeContainer(container.Id, { force: true })
                .pipe(Effect.ignore),
            { discard: true }
          )
        ),
        Effect.ignore
      )
  )
}

// What an entry's body comes from: a buffer, or a stream of either kind,
// Node's or the archive reader's own.
type EntryBody =
  | Buffer
  | {
      once(event: "error", listener: (cause: Error) => void): unknown
      pipe(destination: NodeJS.WritableStream): unknown
      resume(): unknown
    }

function addEntry(
  pack: ReturnType<typeof tarPack>,
  header: Partial<Header> & Pick<Header, "name">,
  body: EntryBody
): Promise<void> {
  return new Promise((resolveEntry, rejectEntry) => {
    if (Buffer.isBuffer(body)) {
      pack.entry(header, body, (cause) =>
        cause ? rejectEntry(cause) : resolveEntry()
      )
      return
    }
    const sink = pack.entry(header, (cause) =>
      cause ? rejectEntry(cause) : resolveEntry()
    )
    if (header.type === "file" || header.type === "contiguous-file") {
      body.once("error", rejectEntry)
      body.pipe(sink as unknown as NodeJS.WritableStream)
    } else {
      body.resume()
    }
  })
}

function requireSafePath(path: string, operation: string): void {
  if (path === "") return
  const segments = path.split("/")
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw tarError(
      "unsafe_archive_path",
      operation,
      "The backup contains an unsafe path"
    )
  }
}

// ------------------------------------------------------------- journal

const TarSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("volume"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("bind"), path: Schema.String }),
])

const TarRestoreJournalSchema = Schema.Struct({
  phase: Schema.Literals(["staging", "clearing", "installing"]),
  root: Schema.NullOr(
    Schema.Struct({
      gid: Schema.Number,
      mode: Schema.Number,
      uid: Schema.Number,
    })
  ),
  source: TarSourceSchema,
  taskId: Schema.String.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    )
  ),
  version: Schema.Literal(1),
})

type TarRestoreJournal = typeof TarRestoreJournalSchema.Type

function decodeJournal(text: string): TarRestoreJournal | null {
  return Schema.decodeUnknownOption(TarRestoreJournalSchema)(
    safeJson(text)
  ).pipe((option) => (option._tag === "Some" ? option.value : null))
}

function journalDirectory(config: RelayConfig): string {
  return resolve(config.dataDirectory, "restores", "tar")
}

async function writeJournal(
  config: RelayConfig,
  journal: TarRestoreJournal
): Promise<void> {
  await mkdir(journalDirectory(config), { mode: 0o700, recursive: true })
  await Effect.runPromise(
    writeFileAtomic(
      join(journalDirectory(config), `${journal.taskId}.json`),
      `${JSON.stringify(journal)}\n`,
      0o600
    )
  )
}

async function removeJournal(config: RelayConfig, taskId: string) {
  await rm(join(journalDirectory(config), `${taskId}.json`), { force: true })
}

// Runs a side of a stream, settling instead of rejecting; a failure aborts
// the other side through `controller`.
function settle<A>(
  run: () => Promise<A>,
  controller?: AbortController,
  onFailure?: () => void
): Promise<Result.Result<A, unknown>> {
  return Effect.runPromise(
    Effect.result(
      Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            controller?.abort(cause)
            onFailure?.()
          })
        )
      )
    )
  )
}

async function requireSettled<A>(
  settled: Promise<Result.Result<A, unknown>>
): Promise<A> {
  const result = await settled
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

function safeJson(text: string): unknown {
  return Effect.runSync(
    Effect.try({ try: (): unknown => JSON.parse(text), catch: () => null })
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function tarError(code: string, operation: string, reason: string) {
  return RelayBackupError.make({ code, operation, reason })
}
