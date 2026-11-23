import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import {
  mkdir,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { resolve } from "node:path"
import { Transform, Writable } from "node:stream"
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
import {
  decodePlatformRecovery,
  type PlatformRecovery,
} from "./platform-recovery.js"
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
const MAX_PLATFORM_RECOVERY_BYTES = 1024 ** 2
const PLATFORM_RECOVERY_LENGTH_BYTES = 4

/**
 * A platform backup's manifest, unencrypted but authenticated. Format 1
 * encrypts Hearth's dump, gzipped. Format 2 encrypts the length of its
 * recovery section (4 bytes, big-endian), that section as JSON (see
 * `platform-recovery.ts`), then the same gzipped dump, so the backup and its
 * recovery code alone restore Kiln on a new machine.
 */
export interface PlatformBackupManifest {
  compression: "gzip"
  createdAt: string
  databaseEngine: "mysql"
  // The database dumped, which the dump drops and recreates by name. Older
  // backups don't say.
  databaseName?: string
  encryption: "aes-256-gcm+scrypt"
  formatVersion: 1 | 2
  installationId: string
  payload: "hearth.dmp"
}

export async function createEncryptedPlatformBackup(
  config: RelayConfig,
  input: Pick<BackupCreateTaskInput, "backupId" | "maxBytes" | "target">,
  destination: string,
  progress: { completed: number; total: number },
  signal: AbortSignal,
  recovery: PlatformRecovery | null
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
    formatVersion: recovery ? 2 : 1,
    installationId,
    payload: "hearth.dmp",
  }
  const recoverySection = recovery ? encodeRecoverySection(recovery) : null
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

  const child = await startPlatformClient(
    config,
    container,
    PLATFORM_DUMP,
    databaseName
  )
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
    startingWith(recoverySection),
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
    ...(recovery && { recoverable: true as const }),
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

/**
 * A platform backup's manifest and recovery section, once the whole backup
 * has been authenticated with `recoveryKey`; the section is null in format 1.
 * Nothing decrypted is written anywhere.
 */
export async function readPlatformBackupRecovery(
  recoveryKey: string,
  source: string
): Promise<{
  manifest: PlatformBackupManifest
  recovery: PlatformRecovery | null
}> {
  const opened = await openPlatformBackup(source)
  const key = await derivePlatformKey(recoveryKey, opened.salt)
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    opened.initializationVector
  )
  decipher.setAAD(opened.manifestBytes)
  decipher.setAuthTag(opened.tag)
  const section = sectionReader(opened.manifest.formatVersion === 2)
  await pipeline(
    createReadStream(source, { start: opened.payloadOffset }),
    decipher,
    section.writable
  )
  const text = section.text()
  if (text === null) return { manifest: opened.manifest, recovery: null }
  return {
    manifest: opened.manifest,
    recovery: await Effect.runPromise(decodePlatformRecovery(text)),
  }
}

/**
 * Keeps the recovery section from the start of a decrypted payload and lets
 * the rest pass to nowhere, so the whole payload is still authenticated.
 */
function sectionReader(present: boolean) {
  let header = Buffer.alloc(0)
  let body: Buffer | null = null
  let expected = 0
  const writable = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!present || (body && body.byteLength >= expected)) return done()
      if (!body) {
        header = Buffer.concat([header, chunk])
        if (header.byteLength < PLATFORM_RECOVERY_LENGTH_BYTES) return done()
        expected = header.readUInt32BE(0)
        if (expected <= 0 || expected > MAX_PLATFORM_RECOVERY_BYTES) {
          return done(
            new Error("The Kiln platform backup's recovery section is invalid")
          )
        }
        body = header.subarray(PLATFORM_RECOVERY_LENGTH_BYTES)
      } else {
        body = Buffer.concat([body, chunk])
      }
      done()
    },
  })
  return {
    text: () => {
      if (!present) return null
      if (!body || body.byteLength < expected) {
        throw new Error(
          "The Kiln platform backup's recovery section is cut short"
        )
      }
      return body.subarray(0, expected).toString("utf8")
    },
    writable,
  }
}

/** Removes what a restore that was killed left: secrets, and room one needs. */
export async function clearPlatformStaging(
  config: Pick<RelayConfig, "dataDirectory">
): Promise<void> {
  const directory = resolve(config.dataDirectory, "restores")
  await mkdir(directory, { mode: 0o700, recursive: true })
  for (const left of await readdir(directory)) {
    if (left.startsWith(".platform-")) {
      await rm(resolve(directory, left), { force: true })
    }
  }
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
  await clearPlatformStaging(config)
  const decrypted = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: async () => {
          await pipeline(
            createReadStream(source, { start: opened.payloadOffset }),
            decipher,
            byteMeter(undefined, MAX_PLATFORM_RESTORE_BYTES),
            createWriteStream(stagedDump, { flags: "wx", mode: 0o600 })
          )
          // On the same installation, its recovery section has nothing to
          // add.
          return stagedDumpOffset(stagedDump, opened.manifest)
        },
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(decrypted)) {
    await rm(stagedDump, { force: true })
    throw decrypted.failure
  }
  const dumpOffset = decrypted.success
  // The decrypted dump is removed however the import ends, including when
  // the database client can't start.
  const restored = await Effect.runPromise(
    Effect.result(
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () =>
            startPlatformClient(
              config,
              container,
              PLATFORM_IMPORT,
              databaseName
            ),
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
                    createReadStream(stagedDump, { start: dumpOffset }),
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
  // Not labeled for this installation, so a backup that doesn't name its
  // database can't restore here: it could recreate another Hearth's.
  if (config.platformDatabase) {
    return {
      container: config.platformDatabase.container,
      databaseName: config.platformDatabase.name,
      labeled: false,
    }
  }
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
  const labeled = await runningHearthContainers(
    config,
    installationId,
    "hearth"
  )
  // Other Hearths on a shared MySQL use their own databases, so only this
  // installation's label says this one is running.
  if (config.platformDatabase) return labeled.length > 0
  return (
    labeled.length > 0 ||
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
// The database is created first if it's missing, as after an import that
// stopped between the dump's DROP DATABASE and CREATE DATABASE: the client
// can't connect to it otherwise, and the dump recreates it anyway.
const PLATFORM_IMPORT =
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql --user=root -e "CREATE DATABASE IF NOT EXISTS \\`$MYSQL_DATABASE\\`"; exec mysql --user=root "$MYSQL_DATABASE"'

function startPlatformClient(
  config: RelayConfig,
  container: string,
  script: string,
  databaseName: string
): Promise<DockerExecProcess> {
  return Effect.runPromise(
    new DockerEngine(config.dockerSocket).execProcess(
      container,
      ["sh", "-ec", script],
      {
        // A shared MySQL wasn't created for this database.
        ...(config.platformDatabase && {
          env: [`MYSQL_DATABASE=${databaseName}`],
        }),
        stdin: script === PLATFORM_IMPORT,
      }
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
    (parsed.formatVersion !== 1 && parsed.formatVersion !== 2) ||
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

/** Passes its stream through, after `first` when there is one. */
function startingWith(first: Buffer | null): Transform {
  let pending = first
  const release = (stream: Transform) => {
    if (pending) stream.push(pending)
    pending = null
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      release(this)
      done(null, chunk)
    },
    flush(done) {
      release(this)
      done()
    },
  })
}

function encodeRecoverySection(recovery: PlatformRecovery): Buffer {
  const json = Buffer.from(JSON.stringify(recovery), "utf8")
  if (json.byteLength > MAX_PLATFORM_RECOVERY_BYTES) {
    throw new Error("The platform backup's recovery section is too large")
  }
  const length = Buffer.alloc(PLATFORM_RECOVERY_LENGTH_BYTES)
  length.writeUInt32BE(json.byteLength)
  return Buffer.concat([length, json])
}

/**
 * Where the gzipped dump starts in a decrypted platform backup: after the
 * recovery section in format 2, at the start in format 1.
 */
async function stagedDumpOffset(
  staged: string,
  manifest: PlatformBackupManifest
): Promise<number> {
  if (manifest.formatVersion === 1) return 0
  const file = await open(staged, "r")
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.succeed(file),
      (handle) =>
        Effect.tryPromise(async () => {
          const length = Buffer.alloc(PLATFORM_RECOVERY_LENGTH_BYTES)
          const { bytesRead } = await handle.read(
            length,
            0,
            length.byteLength,
            0
          )
          const recoveryBytes = length.readUInt32BE(0)
          if (
            bytesRead !== length.byteLength ||
            recoveryBytes <= 0 ||
            recoveryBytes > MAX_PLATFORM_RECOVERY_BYTES
          ) {
            throw new Error(
              "The Kiln platform backup's recovery section is invalid"
            )
          }
          return PLATFORM_RECOVERY_LENGTH_BYTES + recoveryBytes
        }),
      (handle) => Effect.promise(() => handle.close())
    )
  )
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
