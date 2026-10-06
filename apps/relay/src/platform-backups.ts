import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip, createGzip } from "node:zlib"
import { Effect, Result } from "effect"

import {
  backupArtifactFilename,
  type BackupCreateTaskInput,
  type BackupArchiveCreateTaskResult,
} from "@workspace/contracts"

import { command } from "./command.js"
import type { RelayConfig } from "./config.js"

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
  const container = await hearthDatabaseContainer(installationId)
  const manifest: PlatformBackupManifest = {
    compression: "gzip",
    createdAt: new Date().toISOString(),
    databaseEngine: "mysql",
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

  const child = spawnPlatformDump(container)
  const stderr = collectProcessErrors(child)
  const sourceMeter = byteMeter((bytes) => {
    progress.completed = bytes
  })
  const storedLimit = byteMeter(
    undefined,
    input.maxBytes,
    header.byteLength + manifestBytes.byteLength
  )
  const written = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          Promise.all([
            pipeline(
              child.stdout,
              sourceMeter,
              createGzip({ level: 6 }),
              cipher,
              storedLimit,
              createWriteStream(destination, { flags: "a" }),
              { signal }
            ),
            requireSuccessfulProcess(child, stderr, signal),
          ]),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(written)) {
    child.kill("SIGKILL")
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
  if (await hearthApplicationIsRunning(installationId)) {
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
  const container = await hearthDatabaseContainer(installationId)
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
  const child = spawnPlatformImport(container)
  const stderr = collectProcessErrors(child)
  const restored = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          Promise.all([
            pipeline(
              createReadStream(stagedDump),
              createGunzip(),
              byteMeter(undefined, MAX_PLATFORM_RESTORE_BYTES),
              child.stdin
            ),
            requireSuccessfulProcess(child, stderr),
          ]),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(restored)) {
    child.kill("SIGKILL")
    await rm(stagedDump, { force: true })
    throw restored.failure
  }
  await rm(stagedDump, { force: true })
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

async function hearthDatabaseContainer(
  installationId: string
): Promise<string> {
  const result = await command("docker", [
    "container",
    "ls",
    "--filter",
    `label=io.kiln.installation=${installationId}`,
    "--filter",
    "label=io.kiln.resource=hearth-database",
    "--format",
    "{{.ID}}",
  ])
  const containers = result.stdout.split("\n").filter(Boolean)
  if (containers.length !== 1) {
    throw new Error(
      containers.length === 0
        ? "The colocated Hearth database container was not found"
        : "Multiple Hearth database containers matched this installation"
    )
  }
  return containers[0]
}

async function hearthApplicationIsRunning(
  installationId: string
): Promise<boolean> {
  const result = await command("docker", [
    "container",
    "ls",
    "--filter",
    `label=io.kiln.installation=${installationId}`,
    "--filter",
    "label=io.kiln.resource=hearth",
    "--format",
    "{{.ID}}",
  ])
  return result.stdout.trim().length > 0
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

function spawnPlatformDump(container: string): ChildProcessWithoutNullStreams {
  return spawn(
    "docker",
    [
      "exec",
      "-i",
      container,
      "sh",
      "-ec",
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --user=root --single-transaction --skip-lock-tables --no-tablespaces --routines --events --triggers --add-drop-database --databases "$MYSQL_DATABASE"',
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  )
}

function spawnPlatformImport(
  container: string
): ChildProcessWithoutNullStreams {
  return spawn(
    "docker",
    [
      "exec",
      "-i",
      container,
      "sh",
      "-ec",
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root "$MYSQL_DATABASE"',
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
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
    typeof parsed.installationId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(parsed.installationId)
  ) {
    throw new Error("The Kiln platform backup manifest is invalid")
  }
  return parsed as PlatformBackupManifest
}

function collectProcessErrors(child: ChildProcessWithoutNullStreams) {
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

function requireSuccessfulProcess(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolveProcess, rejectProcess) => {
    const aborted = () => {
      clearTimeout(timeout)
      child.kill("SIGKILL")
      rejectProcess(signal?.reason ?? new Error("Platform backup cancelled"))
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      rejectProcess(new Error("Platform backup command timed out"))
    }, PLATFORM_BACKUP_TIMEOUT_MS)
    child.once("error", (cause) => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", aborted)
      rejectProcess(cause)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", aborted)
      if (code === 0) resolveProcess()
      else
        rejectProcess(
          new Error(
            stderr() || `Platform backup command exited with code ${code}`
          )
        )
    })
    signal?.addEventListener("abort", aborted, { once: true })
    if (signal?.aborted) aborted()
  })
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
