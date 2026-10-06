import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { Effect } from "effect"
import { openPromise, type Entry, type ZipFile } from "yauzl"

import {
  backupArchiveManifestSchema,
  brickRecipeSchema,
  type BackupArchiveManifest,
  type BackupRestoreTaskInput,
} from "@workspace/contracts"

import { brickSnapshotDirectory, saveBrickSnapshot } from "./bricks.js"
import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { RelayBackupError } from "./effect/errors.js"
import { isPublicRemoteAddress, secureRemoteLookup } from "./source-policy.js"

const ARCHIVE_MANIFEST_PATH = ".kiln-backup/manifest.json"
const MAX_ARCHIVE_ENTRIES = 100_000
// V3 manifests embed the exact Brick recipe used to provision the server.
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024
const MAX_UNLIMITED_RESTORE_BYTES = 1024 ** 4
const RESTORE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024
const RESTORE_TRANSFER_IDLE_TIMEOUT_MS = 30_000

type RestorePhase = "extracting" | "installed" | "moved_original" | "prepared"

export interface RestoreJournal {
  instanceDirectory: string
  phase: RestorePhase
  taskId: string
  version: 1
}

export interface RestorePaths {
  archive: string
  instance: string
  journal: string
  rollback: string
  staging: string
}

export async function restorePortableInstanceBackup(
  config: RelayConfig,
  input: BackupRestoreTaskInput & { kind: "restore" },
  instance: RelayInstanceConfig
): Promise<{ warnings: Array<string> }> {
  const prepared = await prepareInstanceRestoreStaging(
    config,
    instance.directory,
    input.taskId
  )
  let warnings: Array<string> = []

  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const archive = await materializeBackupArtifact(
          config,
          input,
          prepared.paths.archive
        )
        warnings = await extractBackupArchive(
          config,
          archive,
          prepared.paths.staging,
          input,
          instance
        )
        await installPreparedInstanceRestore(prepared)
        return { warnings }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.tryPromise(() =>
          settleRestoreJournal(config, prepared.journal, false)
        ).pipe(
          Effect.flatMap((completed) =>
            completed ? Effect.succeed({ warnings }) : Effect.fail(cause)
          )
        )
      )
    )
  )
}

export async function prepareInstanceRestoreStaging(
  config: RelayConfig,
  instanceDirectory: string,
  taskId: string
): Promise<PreparedInstanceRestore> {
  const configuredRoot = await realpathRequired(config.rootDirectory)
  const instanceRoot = resolve(configuredRoot, instanceDirectory)
  requireContained(configuredRoot, instanceRoot, "restore.path")
  const paths = restorePaths(config, instanceDirectory, taskId)
  const journal: RestoreJournal = {
    instanceDirectory,
    phase: "extracting",
    taskId,
    version: 1,
  }
  await mkdir(dirname(paths.journal), { mode: 0o700, recursive: true })
  await rm(paths.staging, { force: true, recursive: true })
  await rm(paths.rollback, { force: true, recursive: true })
  await rm(paths.archive, { force: true })
  await writeRestoreJournal(paths.journal, journal)
  return { journal, paths }
}

export async function installPreparedInstanceRestore(
  prepared: PreparedInstanceRestore
): Promise<void> {
  prepared.journal = {
    ...prepared.journal,
    phase: "prepared",
  }
  await writeRestoreJournal(prepared.paths.journal, prepared.journal)
  await rename(prepared.paths.instance, prepared.paths.rollback)
  prepared.journal = {
    ...prepared.journal,
    phase: "moved_original",
  }
  await writeRestoreJournal(prepared.paths.journal, prepared.journal)
  await rename(prepared.paths.staging, prepared.paths.instance)
  prepared.journal = {
    ...prepared.journal,
    phase: "installed",
  }
  await writeRestoreJournal(prepared.paths.journal, prepared.journal)
  await rm(prepared.paths.rollback, { force: true, recursive: true })
  await rm(prepared.paths.archive, { force: true })
  await unlink(prepared.paths.journal)
}

export type PreparedInstanceRestore = {
  journal: RestoreJournal
  paths: RestorePaths
}

export async function recoverInterruptedRestores(
  config: RelayConfig
): Promise<Array<string>> {
  const directory = restoreDirectoryPath(config)
  await mkdir(directory, { mode: 0o700, recursive: true })
  const completed: Array<string> = []
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const journalPath = resolve(directory, entry.name)
    const journal = parseRestoreJournal(await readFile(journalPath, "utf8"))
    if (!journal || `${journal.taskId}.json` !== entry.name) {
      await rm(journalPath, { force: true })
      continue
    }
    if (await settleRestoreJournal(config, journal, true)) {
      completed.push(journal.taskId)
    }
  }
  return completed
}

async function extractBackupArchive(
  config: RelayConfig,
  archivePath: string,
  stagingRoot: string,
  input: BackupRestoreTaskInput,
  instance: RelayInstanceConfig
): Promise<Array<string>> {
  const zip = await openPromise(archivePath, {
    autoClose: false,
    decodeStrings: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  })
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const entries: Array<Entry> = []
        const names = new Set<string>()
        let logicalBytes = 0
        for await (const entry of zip.eachEntry()) {
          if (entries.length >= MAX_ARCHIVE_ENTRIES) {
            throw restoreError(
              "too_many_entries",
              "restore.validate",
              `Backups cannot contain more than ${MAX_ARCHIVE_ENTRIES.toLocaleString("en-US")} entries`
            )
          }
          validateArchiveEntry(entry, names)
          if (entry.fileName !== ARCHIVE_MANIFEST_PATH) {
            logicalBytes = safeByteSum(logicalBytes, entry.uncompressedSize)
          }
          entries.push(entry)
        }
        const maximumBytes =
          instance.limits.diskBytes > 0
            ? instance.limits.diskBytes
            : MAX_UNLIMITED_RESTORE_BYTES
        if (logicalBytes > maximumBytes) {
          throw restoreError(
            "restore_too_large",
            "restore.validate",
            "The backup expands beyond this server's disk limit"
          )
        }
        await requireRestoreSpace(dirname(stagingRoot), logicalBytes)
        await mkdir(stagingRoot, { mode: 0o700, recursive: false })

        let manifest: BackupArchiveManifest | null = null
        for (const entry of entries) {
          if (entry.fileName === ARCHIVE_MANIFEST_PATH) {
            manifest = await readManifest(zip, entry)
            if (
              manifest.backupId !== input.backupId ||
              manifest.target.kind !== "instance" ||
              manifest.target.id !== input.target.id
            ) {
              throw restoreError(
                "manifest_mismatch",
                "restore.validate",
                "The archive manifest does not match this backup and server"
              )
            }
            continue
          }
          await extractEntry(zip, entry, stagingRoot)
        }
        if (
          manifest?.formatVersion === 3 &&
          manifest.server.brick.recipe !== null
        ) {
          const snapshotSha256 = await saveBrickSnapshot(
            brickSnapshotDirectory(config.dataDirectory),
            brickRecipeSchema.parse(manifest.server.brick.recipe)
          )
          if (
            manifest.server.brick.snapshotSha256 &&
            manifest.server.brick.snapshotSha256 !== snapshotSha256
          ) {
            throw restoreError(
              "manifest_mismatch",
              "restore.validate",
              "The embedded Brick recipe does not match its snapshot checksum"
            )
          }
        }
        return manifest
          ? []
          : ["Restored a legacy archive without an embedded Kiln manifest"]
      },
      catch: (cause) => cause,
    }).pipe(Effect.ensuring(Effect.sync(() => zip.close())))
  )
}

function validateArchiveEntry(entry: Entry, names: Set<string>): void {
  const name = entry.fileName
  const directory = name.endsWith("/")
  const path = directory ? name.slice(0, -1) : name
  const segments = path.split("/")
  if (
    !path ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw restoreError(
      "unsafe_archive_path",
      "restore.validate",
      "The backup contains an unsafe path"
    )
  }
  if (names.has(path)) {
    throw restoreError(
      "duplicate_archive_path",
      "restore.validate",
      "The backup contains duplicate paths"
    )
  }
  names.add(path)
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    !Number.isSafeInteger(entry.compressedSize) ||
    entry.compressedSize < 0
  ) {
    throw restoreError(
      "invalid_archive_size",
      "restore.validate",
      "The backup contains an invalid entry size"
    )
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  const fileType = unixMode & 0o170000
  if (
    fileType !== 0 &&
    fileType !== 0o100000 &&
    !(directory && fileType === 0o040000)
  ) {
    throw restoreError(
      "unsupported_archive_entry",
      "restore.validate",
      "The backup contains a symbolic link or special file"
    )
  }
}

async function extractEntry(
  zip: ZipFile,
  entry: Entry,
  stagingRoot: string
): Promise<void> {
  const directory = entry.fileName.endsWith("/")
  const name = directory ? entry.fileName.slice(0, -1) : entry.fileName
  const destination = resolve(stagingRoot, name)
  requireContained(stagingRoot, destination, "restore.extract")
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  if (directory) {
    await mkdir(destination, { mode: 0o700, recursive: true })
    return
  }
  await mkdir(dirname(destination), { mode: 0o700, recursive: true })
  const source = await zip.openReadStreamPromise(entry)
  const mode = 0o600 | (unixMode & 0o111)
  await pipeline(source, createWriteStream(destination, { flags: "wx", mode }))
  await chmod(destination, mode)
}

async function readManifest(zip: ZipFile, entry: Entry) {
  if (entry.uncompressedSize > MAX_MANIFEST_BYTES) {
    throw restoreError(
      "manifest_too_large",
      "restore.validate",
      "The archive manifest is too large"
    )
  }
  const chunks: Array<Buffer> = []
  let bytes = 0
  const source = await zip.openReadStreamPromise(entry)
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_MANIFEST_BYTES) {
      throw restoreError(
        "manifest_too_large",
        "restore.validate",
        "The archive manifest is too large"
      )
    }
    chunks.push(buffer)
  }
  return backupArchiveManifestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  )
}

export async function materializeBackupArtifact(
  config: RelayConfig,
  input: BackupRestoreTaskInput,
  destination: string
): Promise<string> {
  await mkdir(restoreDirectoryPath(config), { mode: 0o700, recursive: true })
  if (input.source.kind === "restic") {
    throw restoreError(
      "unsupported_restore_source",
      "restore.materialize",
      "Restic snapshots cannot be materialized as archive files"
    )
  }
  const artifact =
    input.source.kind === "local"
      ? backupArchivePath(config, input.backupId)
      : await downloadRestoreArtifact(destination, input)
  await verifyBackupArtifact(
    artifact,
    input.source.bytes,
    input.source.checksumSha256
  )
  return artifact
}

async function downloadRestoreArtifact(
  destination: string,
  input: BackupRestoreTaskInput
): Promise<string> {
  const source = input.source
  if (source.kind !== "remote") return destination
  const url = new URL(source.downloadUrl)
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Signed backup URLs must use HTTPS")
  }
  const literal = url.hostname.replace(/^\[|\]$/gu, "")
  if (
    !source.allowPrivateNetwork &&
    isIP(literal) !== 0 &&
    !isPublicRemoteAddress(literal)
  ) {
    throw new Error(
      "Signed backup URL resolves to a private or reserved address"
    )
  }
  await new Promise<void>((resolveDownload, rejectDownload) => {
    const request = httpsRequest(
      url,
      {
        headers: source.headers,
        lookup: source.allowPrivateNetwork ? undefined : secureRemoteLookup,
        method: "GET",
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          rejectDownload(
            new Error(
              `Backup storage returned HTTP ${response.statusCode ?? 0}`
            )
          )
          return
        }
        let bytes = 0
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > source.bytes) {
            response.destroy(
              new Error("Backup storage returned more data than expected")
            )
          }
        })
        void Effect.runPromise(
          Effect.tryPromise({
            try: () =>
              pipeline(
                response,
                createWriteStream(destination, { flags: "wx", mode: 0o600 })
              ),
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: rejectDownload,
              onSuccess: () => {
                if (bytes !== source.bytes) {
                  rejectDownload(
                    new Error("Backup storage returned an incomplete archive")
                  )
                } else resolveDownload()
              },
            })
          )
        )
      }
    )
    request.setTimeout(RESTORE_TRANSFER_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error("Backup download timed out"))
    })
    request.once("error", rejectDownload)
    request.end()
  })
  return destination
}

async function verifyBackupArtifact(
  path: string,
  expectedBytes: number,
  expectedChecksum: string
): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw restoreError(
      "invalid_archive",
      "restore.verify",
      "The backup archive is not a regular file"
    )
  }
  if (metadata.size !== expectedBytes) {
    throw restoreError(
      "archive_size_mismatch",
      "restore.verify",
      "The backup archive size does not match the catalog"
    )
  }
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  if (digest.digest("hex") !== expectedChecksum) {
    throw restoreError(
      "archive_checksum_mismatch",
      "restore.verify",
      "The backup archive checksum does not match the catalog"
    )
  }
}

export async function requireRestoreSpace(
  directory: string,
  logicalBytes: number
): Promise<void> {
  const filesystem = await statfs(directory)
  const available = BigInt(filesystem.bavail) * BigInt(filesystem.bsize)
  const required = BigInt(logicalBytes + RESTORE_SPACE_RESERVE_BYTES)
  if (available < required) {
    throw restoreError(
      "insufficient_space",
      "restore.preflight",
      "The Relay does not have enough free space to stage this restore"
    )
  }
}

export async function settleRestoreJournal(
  config: RelayConfig,
  journal: RestoreJournal,
  preferComplete: boolean
): Promise<boolean> {
  const paths = restorePaths(config, journal.instanceDirectory, journal.taskId)
  const [instanceExists, rollbackExists, stagingExists] = await Promise.all([
    pathExists(paths.instance),
    pathExists(paths.rollback),
    pathExists(paths.staging),
  ])
  let completed = false
  if (journal.phase === "installed" && instanceExists) {
    await rm(paths.rollback, { force: true, recursive: true })
    await rm(paths.staging, { force: true, recursive: true })
    completed = true
  } else if (journal.phase === "installed" && stagingExists) {
    await rename(paths.staging, paths.instance)
    await rm(paths.rollback, { force: true, recursive: true })
    completed = true
  } else if (journal.phase === "installed" && rollbackExists) {
    await rename(paths.rollback, paths.instance)
  } else if (
    preferComplete &&
    !instanceExists &&
    rollbackExists &&
    stagingExists
  ) {
    await rename(paths.staging, paths.instance)
    await rm(paths.rollback, { force: true, recursive: true })
    completed = true
  } else if (preferComplete && instanceExists && rollbackExists) {
    await rm(paths.rollback, { force: true, recursive: true })
    await rm(paths.staging, { force: true, recursive: true })
    completed = true
  } else if (!preferComplete && rollbackExists) {
    if (instanceExists) {
      await rm(paths.instance, { force: true, recursive: true })
    }
    await rename(paths.rollback, paths.instance)
    await rm(paths.staging, { force: true, recursive: true })
  } else {
    await rm(paths.staging, { force: true, recursive: true })
  }
  await rm(paths.archive, { force: true })
  await rm(paths.journal, { force: true })
  return completed
}

function restorePaths(
  config: RelayConfig,
  instanceDirectory: string,
  taskId: string
): RestorePaths {
  const instance = resolve(config.rootDirectory, instanceDirectory)
  requireContained(config.rootDirectory, instance, "restore.journal")
  const parent = dirname(instance)
  const base = basename(instance)
  return {
    archive: resolve(restoreDirectoryPath(config), `${taskId}.zip`),
    instance,
    journal: resolve(restoreDirectoryPath(config), `${taskId}.json`),
    rollback: resolve(parent, `.${base}.kiln-rollback-${taskId}`),
    staging: resolve(parent, `.${base}.kiln-restore-${taskId}`),
  }
}

function parseRestoreJournal(value: string): RestoreJournal | null {
  const parsed = Effect.runSync(
    Effect.try({
      try: () => JSON.parse(value) as Partial<RestoreJournal>,
      catch: () => null,
    })
  )
  if (parsed === null) return null
  if (
    parsed.version !== 1 ||
    typeof parsed.instanceDirectory !== "string" ||
    !parsed.instanceDirectory ||
    typeof parsed.taskId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      parsed.taskId
    ) ||
    !["extracting", "prepared", "moved_original", "installed"].includes(
      parsed.phase ?? ""
    )
  ) {
    return null
  }
  return parsed as RestoreJournal
}

async function writeRestoreJournal(
  path: string,
  journal: RestoreJournal
): Promise<void> {
  await Effect.runPromise(
    writeFileAtomic(path, `${JSON.stringify(journal)}\n`, 0o600)
  )
}

function safeByteSum(total: number, value: number): number {
  const sum = total + value
  if (!Number.isSafeInteger(sum) || sum > MAX_UNLIMITED_RESTORE_BYTES) {
    throw restoreError(
      "restore_too_large",
      "restore.validate",
      "The backup expands beyond the maximum supported restore size"
    )
  }
  return sum
}

function requireContained(root: string, candidate: string, operation: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw restoreError(
      "path_outside_instance",
      operation,
      "The restore path resolves outside the instance directory"
    )
  }
}

async function realpathRequired(path: string): Promise<string> {
  return (await stat(path)).isDirectory()
    ? await import("node:fs/promises").then(({ realpath }) => realpath(path))
    : Promise.reject(new Error("Relay instance root is not a directory"))
}

async function pathExists(path: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (cause) =>
          cause instanceof Error && "code" in cause && cause.code === "ENOENT",
        () => Effect.succeed(false)
      )
    )
  )
}

function backupArchivePath(config: RelayConfig, backupId: string): string {
  return resolve(config.dataDirectory, "backups", `${backupId}.zip`)
}

function restoreDirectoryPath(config: RelayConfig): string {
  return resolve(config.dataDirectory, "restores")
}

function restoreError(code: string, operation: string, reason: string) {
  return RelayBackupError.make({ code, operation, reason })
}
