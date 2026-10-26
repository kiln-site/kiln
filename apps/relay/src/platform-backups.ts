import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip, createGzip } from "node:zlib"
import { Effect, Result } from "effect"

import {
  backupArtifactFilename,
  isKilnInstallationId,
  type BackupCreateTaskInput,
  type BackupArchiveCreateTaskResult,
} from "@workspace/contracts"

import type { RelayConfig } from "./config.js"
import { provenDatabaseContainer, provenHearthRunning } from "./platform.js"
import { relayOwnsLabels } from "./relay-resources.js"
import {
  DockerEngine,
  type DockerContainerInspect,
  type DockerContainerSummary,
  type DockerExecProcess,
  streamIntoProcess,
} from "./docker-engine.js"

const PLATFORM_MAGIC = Buffer.from("KILNPLATFORM0001", "ascii")
const PLATFORM_HEADER_BYTES = 64
const PLATFORM_TAG_OFFSET = 44
const PLATFORM_MANIFEST_LENGTH_OFFSET = 60
const PLATFORM_BACKUP_TIMEOUT_MS = 30 * 60_000
const MAX_PLATFORM_ERROR_BYTES = 64 * 1024
const MAX_PLATFORM_RESTORE_BYTES = 1024 ** 4

export interface PlatformBackupManifest {
  compression: "gzip"
  createdAt: string
  databaseEngine: "mysql"
  // The database dumped, which the dump drops and recreates by name. Older
  // backups don't say.
  databaseName?: string
  encryption: "aes-256-gcm+scrypt"
  formatVersion: 1
  installationId: string
  payload: "hearth.dmp"
}

export async function createEncryptedPlatformBackup(
  config: RelayConfig,
  input: BackupCreateTaskInput,
  destination: string,
  progress: { completed: number; total: number },
  signal: AbortSignal
): Promise<BackupArchiveCreateTaskResult> {
  signal.throwIfAborted()
  const installationId = requiredInstallationId(config, input.target.id)
  const recoveryKey = requiredRecoveryKey(config)
  const { container, databaseName } = await hearthDatabaseContainer(
    config,
    installationId
  )
  const manifest: PlatformBackupManifest = {
    compression: "gzip",
    createdAt: new Date().toISOString(),
    databaseEngine: "mysql",
    databaseName,
    encryption: "aes-256-gcm+scrypt",
    formatVersion: 1,
    installationId,
    payload: "hearth.dmp",
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8")
  const salt = randomBytes(16)
  const initializationVector = randomBytes(12)
  const encryptionKey = await derivePlatformKey(recoveryKey, salt)
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey,
    initializationVector
  )
  cipher.setAAD(manifestBytes)
  const header = platformHeader(salt, initializationVector, manifestBytes)
  await writeFile(destination, Buffer.concat([header, manifestBytes]), {
    flag: "wx",
    mode: 0o600,
  })

  const child = await startPlatformClient(config, container, PLATFORM_DUMP)
  const stderr = collectProcessErrors(child)
  const sourceMeter = byteMeter((bytes) => {
    progress.completed = bytes
  })
  const storedLimit = byteMeter(
    undefined,
    input.maxBytes,
    header.byteLength + manifestBytes.byteLength
  )
  const writing = pipeline(
    child.stdout,
    sourceMeter,
    createGzip({ level: 6 }),
    cipher,
    storedLimit,
    createWriteStream(destination, { flags: "a" }),
    { signal }
  )
  const exited = requireSuccessfulProcess(child, stderr, signal)
  const written = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => Promise.all([writing, exited]),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(written)) {
    child.kill()
    // Appending can recreate the file if cleanup runs before the stream opens.
    await Promise.allSettled([writing, exited])
    await rm(destination, { force: true })
    throw written.failure
  }

  const file = await open(destination, "r+")
  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.succeed(file),
      (handle) =>
        Effect.tryPromise(() =>
          handle.write(cipher.getAuthTag(), 0, 16, PLATFORM_TAG_OFFSET)
        ),
      (handle) => Effect.promise(() => handle.close())
    )
  )
  const metadata = await stat(destination)
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(destination, { signal })) {
    digest.update(chunk)
  }
  return {
    bytes: metadata.size,
    checksumSha256: digest.digest("hex"),
    filename: backupArtifactFilename(input.backupId, "platform_bundle"),
    warnings: [],
  }
}

function parsePlatformHeader(header: Buffer): {
  initializationVector: Buffer
  manifestLength: number
  salt: Buffer
  tag: Buffer
} {
  if (
    header.byteLength !== PLATFORM_HEADER_BYTES ||
    !header.subarray(0, PLATFORM_MAGIC.byteLength).equals(PLATFORM_MAGIC)
  ) {
    throw new Error("The file is not a Kiln platform backup")
  }
  const manifestLength = header.readUInt32BE(PLATFORM_MANIFEST_LENGTH_OFFSET)
  if (manifestLength <= 0 || manifestLength > 64 * 1024) {
    throw new Error("The Kiln platform backup manifest is invalid")
  }
  return {
    initializationVector: header.subarray(32, 44),
    manifestLength,
    salt: header.subarray(16, 32),
    tag: header.subarray(PLATFORM_TAG_OFFSET, PLATFORM_TAG_OFFSET + 16),
  }
}

function derivePlatformKey(recoveryKey: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, rejectKey) => {
    scrypt(recoveryKey, salt, 32, (error, key) => {
      if (error) rejectKey(error)
      else resolveKey(key)
    })
  })
}

export async function inspectEncryptedPlatformBackup(
  recoveryKey: string,
  source: string
): Promise<PlatformBackupManifest> {
  const opened = await openPlatformBackup(source)
  const key = await derivePlatformKey(recoveryKey, opened.salt)
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    opened.initializationVector
  )
  decipher.setAAD(opened.manifestBytes)
  decipher.setAuthTag(opened.tag)
  for await (const _chunk of createReadStream(source, {
    start: opened.payloadOffset,
  }).pipe(decipher)) {
    // Consume the authenticated stream to validate its key and contents.
  }
  return opened.manifest
}

export async function restoreEncryptedPlatformBackup(
  config: RelayConfig,
  source: string,
  confirmedInstallationId: string
): Promise<PlatformBackupManifest> {
  const installationId = requiredInstallationId(config, confirmedInstallationId)
  const recoveryKey = requiredRecoveryKey(config)
  if (await hearthApplicationIsRunning(config, installationId)) {
    throw new Error("Stop Hearth before restoring a Kiln platform backup")
  }
  const opened = await openPlatformBackup(source)
  if (opened.manifest.installationId !== installationId) {
    throw new Error("The platform backup belongs to another Kiln installation")
  }
  const key = await derivePlatformKey(recoveryKey, opened.salt)
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    opened.initializationVector
  )
  decipher.setAAD(opened.manifestBytes)
  decipher.setAuthTag(opened.tag)
  const { container, databaseName, labeled } = await hearthDatabaseContainer(
    config,
    installationId
  )
  // The dump recreates the database it came from by name, whatever the
  // client connects to. Backups older than the name restore as before
  // onto Kiln's labeled containers only.
  if (
    opened.manifest.databaseName === undefined
      ? !labeled
      : opened.manifest.databaseName !== databaseName
  ) {
    throw new Error(
      opened.manifest.databaseName === undefined
        ? "This backup predates Kiln recording which database it holds, so it restores only onto Kiln's labeled MySQL"
        : `This backup holds the database ${opened.manifest.databaseName}, but Hearth's MySQL container was created for ${databaseName}`
    )
  }
  const restoreDirectory = resolve(config.dataDirectory, "restores")
  const stagedDump = resolve(
    restoreDirectory,
    `.platform-${randomUUID()}.dmp.gz`
  )
  await mkdir(restoreDirectory, { mode: 0o700, recursive: true })
  const decrypted = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          pipeline(
            createReadStream(source, { start: opened.payloadOffset }),
            decipher,
            byteMeter(undefined, MAX_PLATFORM_RESTORE_BYTES),
            createWriteStream(stagedDump, { flags: "wx", mode: 0o600 })
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(decrypted)) {
    await rm(stagedDump, { force: true })
    throw decrypted.failure
  }
  // The decrypted dump is removed however the import ends, including when
  // the database client can't start.
  const restored = await Effect.runPromise(
    Effect.result(
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => startPlatformClient(config, container, PLATFORM_IMPORT),
          catch: (cause) => cause,
        }),
        (child) => {
          const stderr = collectProcessErrors(child)
          // mysql's output isn't kept, but it must be read for it to keep
          // going.
          child.stdout.resume()
          return Effect.tryPromise({
            try: () =>
              streamIntoProcess(
                child,
                () =>
                  pipeline(
                    createReadStream(stagedDump),
                    createGunzip(),
                    byteMeter(undefined, MAX_PLATFORM_RESTORE_BYTES),
                    child.stdin
                  ),
                () => requireSuccessfulProcess(child, stderr)
              ),
            catch: (cause) => cause,
          })
        },
        (child, exit) =>
          Effect.sync(() => {
            if (exit._tag === "Failure") child.kill()
          })
      ).pipe(
        Effect.ensuring(Effect.promise(() => rm(stagedDump, { force: true })))
      )
    )
  )
  if (Result.isFailure(restored)) throw restored.failure
  return opened.manifest
}

async function openPlatformBackup(source: string): Promise<{
  initializationVector: Buffer
  manifest: PlatformBackupManifest
  manifestBytes: Buffer
  payloadOffset: number
  salt: Buffer
  tag: Buffer
}> {
  const file = await open(source, "r")
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.succeed(file),
      (handle) =>
        Effect.tryPromise(async () => {
          const header = Buffer.alloc(PLATFORM_HEADER_BYTES)
          const headerRead = await handle.read(header, 0, header.byteLength, 0)
          if (headerRead.bytesRead !== header.byteLength) {
            throw new Error("The Kiln platform backup header is incomplete")
          }
          const parsed = parsePlatformHeader(header)
          const manifestBytes = Buffer.alloc(parsed.manifestLength)
          const manifestRead = await handle.read(
            manifestBytes,
            0,
            manifestBytes.byteLength,
            PLATFORM_HEADER_BYTES
          )
          if (manifestRead.bytesRead !== manifestBytes.byteLength) {
            throw new Error("The Kiln platform backup manifest is incomplete")
          }
          return {
            ...parsed,
            manifest: parsePlatformManifest(manifestBytes),
            manifestBytes,
            payloadOffset: PLATFORM_HEADER_BYTES + manifestBytes.byteLength,
          }
        }),
      (handle) => Effect.promise(() => handle.close())
    )
  )
}

// Running Hearth containers of this installation with the given resource label.
function runningHearthContainers(
  config: RelayConfig,
  installationId: string,
  resource: "hearth" | "hearth-database"
): Promise<ReadonlyArray<DockerContainerSummary>> {
  return Effect.runPromise(
    new DockerEngine(config.dockerSocket).listContainers({
      filters: {
        label: [
          `io.kiln.installation=${installationId}`,
          `io.kiln.resource=${resource}`,
        ],
      },
    })
  )
}

/**
 * Kiln's MySQL container, the database it was created for, which Kiln's
 * backups dump and restore, and whether Kiln's labels found it.
 */
async function hearthDatabaseContainer(
  config: RelayConfig,
  installationId: string
): Promise<{ container: string; databaseName: string; labeled: boolean }> {
  const matching = await runningHearthContainers(
    config,
    installationId,
    "hearth-database"
  )
  // A Relay in platform mode labels the database it installed with its
  // resource namespace; prefer it over another deployment's.
  const owned = matching.filter((candidate) =>
    relayOwnsLabels(config, candidate.Labels)
  )
  const containers =
    config.resourceNamespace && owned.length > 0 ? owned : matching
  const engine = new DockerEngine(config.dockerSocket)
  if (containers.length === 0) {
    const unlabeled = await Effect.runPromise(
      provenDatabaseContainer(engine, config)
    )
    if (unlabeled) {
      return {
        container: unlabeled.Id,
        databaseName: createdDatabase(unlabeled),
        labeled: false,
      }
    }
  }
  const [container] = containers
  if (!container || containers.length > 1) {
    throw new Error(
      containers.length === 0
        ? "The colocated Hearth database container was not found"
        : "Multiple Hearth database containers matched this installation"
    )
  }
  const inspected = await Effect.runPromise(
    engine.inspectContainer(container.Id)
  )
  return {
    container: container.Id,
    databaseName: createdDatabase(inspected),
    labeled: true,
  }
}

function createdDatabase(container: DockerContainerInspect): string {
  const entry = container.Config.Env?.find((value) =>
    value.startsWith("MYSQL_DATABASE=")
  )
  const name = entry?.slice("MYSQL_DATABASE=".length)
  if (!name) {
    throw new Error("Kiln's MySQL container doesn't name its database")
  }
  return name
}

async function hearthApplicationIsRunning(
  config: RelayConfig,
  installationId: string
): Promise<boolean> {
  return (
    (await runningHearthContainers(config, installationId, "hearth")).length >
      0 ||
    // A Docker error fails the restore rather than read as none running.
    (await Effect.runPromise(
      provenHearthRunning(new DockerEngine(config.dockerSocket), config)
    ))
  )
}

function requiredInstallationId(config: RelayConfig, targetId: string): string {
  if (!config.installationId || config.installationId !== targetId) {
    throw new Error("The platform backup target does not match this Relay")
  }
  return config.installationId
}

function requiredRecoveryKey(config: RelayConfig): string {
  if (!config.platformBackupKey) {
    throw new Error(
      "Configure KILN_PLATFORM_BACKUP_KEY before creating a platform backup"
    )
  }
  return config.platformBackupKey
}

function platformHeader(
  salt: Buffer,
  initializationVector: Buffer,
  manifest: Buffer
): Buffer {
  const header = Buffer.alloc(PLATFORM_HEADER_BYTES)
  PLATFORM_MAGIC.copy(header, 0)
  salt.copy(header, 16)
  initializationVector.copy(header, 32)
  header.writeUInt32BE(manifest.byteLength, PLATFORM_MANIFEST_LENGTH_OFFSET)
  return header
}

const PLATFORM_DUMP =
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --user=root --single-transaction --skip-lock-tables --no-tablespaces --routines --events --triggers --add-drop-database --databases "$MYSQL_DATABASE"'
const PLATFORM_IMPORT =
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root "$MYSQL_DATABASE"'

function startPlatformClient(
  config: RelayConfig,
  container: string,
  script: string
): Promise<DockerExecProcess> {
  return Effect.runPromise(
    new DockerEngine(config.dockerSocket).execProcess(
      container,
      ["sh", "-ec", script],
      { stdin: script === PLATFORM_IMPORT }
    )
  )
}

function parsePlatformManifest(value: Buffer): PlatformBackupManifest {
  const parsed = JSON.parse(
    value.toString("utf8")
  ) as Partial<PlatformBackupManifest>
  if (
    parsed.compression !== "gzip" ||
    parsed.databaseEngine !== "mysql" ||
    parsed.encryption !== "aes-256-gcm+scrypt" ||
    parsed.formatVersion !== 1 ||
    parsed.payload !== "hearth.dmp" ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    !isKilnInstallationId(parsed.installationId) ||
    (parsed.databaseName !== undefined &&
      (typeof parsed.databaseName !== "string" || !parsed.databaseName))
  ) {
    throw new Error("The Kiln platform backup manifest is invalid")
  }
  return parsed as PlatformBackupManifest
}

function collectProcessErrors(child: DockerExecProcess) {
  const chunks: Array<Buffer> = []
  let bytes = 0
  child.stderr.on("data", (chunk: Buffer) => {
    if (bytes >= MAX_PLATFORM_ERROR_BYTES) return
    const retained = chunk.subarray(0, MAX_PLATFORM_ERROR_BYTES - bytes)
    bytes += retained.byteLength
    chunks.push(retained)
  })
  return () => Buffer.concat(chunks).toString("utf8").trim()
}

async function requireSuccessfulProcess(
  child: DockerExecProcess,
  stderr: () => string,
  signal?: AbortSignal
): Promise<void> {
  const code = await child.waitFor({
    signal,
    timedOut: "Platform backup command timed out",
    timeout: PLATFORM_BACKUP_TIMEOUT_MS,
  })
  if (code !== 0) {
    throw new Error(
      stderr() || `Platform backup command exited with code ${code}`
    )
  }
}

function byteMeter(
  update?: (bytes: number) => void,
  maximumBytes?: number | null,
  initialBytes = 0
): Transform {
  let bytes = initialBytes
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (
        maximumBytes !== undefined &&
        maximumBytes !== null &&
        bytes > maximumBytes
      ) {
        callback(new Error("Platform backup exceeded its size limit"))
        return
      }
      update?.(bytes - initialBytes)
      callback(null, chunk)
    },
  })
}
