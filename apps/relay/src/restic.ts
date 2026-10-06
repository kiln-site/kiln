import { createHash } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { lstat, mkdir, opendir, rm } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import { Effect, Result, Schedule } from "effect"

import { RelayBackupError } from "./effect/errors.js"
import {
  applyResticDestinationEnvironment,
  resticDestinationEndpointPort,
  resticDriverLocation,
  resticGlobalArgs,
  resticRepositoryPath,
  resticRepositoryString,
  type ResticDriverLocation,
} from "./backups/destinations/index.js"
import {
  resticS3ProxyAllowedHosts,
  resticS3ProxyToken,
  withResticS3Proxy,
} from "./backups/destinations/s3/proxy.js"

const RESTIC_BINARY = "restic"
const MAX_JSON_LINE_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MAX_STAGING_ENTRIES = 100_000
const MAX_SKIPPED_ENTRY_WARNINGS = 25
const MAX_UNLIMITED_RESTORE_BYTES = 1024 ** 4
const RESTIC_TERMINATE_TIMEOUT_MS = 5_000
const RESTIC_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "RESTIC_CACERT",
  "TMPDIR",
] as const
const RESTIC_EXIT_REPOSITORY_MISSING = 10
const RESTIC_EXIT_WRONG_PASSWORD = 12

export type ResticProgress = {
  bytesCompleted: number
  bytesTotal: number | null
}

export type ResticSnapshotSummary = {
  snapshotId: string
  totalBytesProcessed: number
}

export type TranslatedExcludes = {
  excludes: Array<string>
  warnings: Array<string>
}

export type ResticSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    stdio: ["ignore", "pipe", "pipe"]
  }
) => ChildProcess

export { resticDriverLocation, resticRepositoryPath }
export type { ResticDriverLocation }

export type ResticDriver = {
  backup: (input: {
    cwd: string
    excludes: ReadonlyArray<string>
    location: ResticDriverLocation
    onProgress?: (progress: ResticProgress) => void
    password: string
    path: string
    signal: AbortSignal
    tags: ReadonlyArray<string>
  }) => Promise<ResticSnapshotSummary>
  cacheCleanup: (input: {
    location: ResticDriverLocation
    password: string
    signal: AbortSignal
  }) => Promise<void>
  catConfig: (input: {
    location: ResticDriverLocation
    password: string
    signal: AbortSignal
  }) => Promise<"exists" | "missing">
  dumpZip: (input: {
    destination: string
    location: ResticDriverLocation
    onProgress?: (bytes: number) => void
    password: string
    selector: string
    signal: AbortSignal
  }) => Promise<{ bytes: number; checksumSha256: string }>
  forget: (input: {
    location: ResticDriverLocation
    password: string
    signal: AbortSignal
    snapshotId: string
  }) => Promise<void>
  init: (input: {
    location: ResticDriverLocation
    password: string
    signal: AbortSignal
  }) => Promise<void>
  prune: (input: {
    location: ResticDriverLocation
    onProgress?: (progress: ResticProgress) => void
    password: string
    signal: AbortSignal
  }) => Promise<void>
  restore: (input: {
    location: ResticDriverLocation
    onProgress?: (progress: ResticProgress) => void
    password: string
    selector: string
    signal: AbortSignal
    target: string
  }) => Promise<void>
  snapshotsByTag: (input: {
    location: ResticDriverLocation
    password: string
    signal: AbortSignal
    tag: string
  }) => Promise<Array<{ id: string }>>
  stats: (input: {
    location: ResticDriverLocation
    password: string
    signal: AbortSignal
    snapshotId: string
  }) => Promise<{ totalSize: number }>
}

export function resticSnapshotSelector(
  snapshotId: string,
  instanceDirectory: string
): string {
  return `${snapshotId}:${instanceDirectory}`
}

export function requiredRepositoryPassword(
  password: string | undefined,
  operation: string
): string {
  if (!password) {
    throw RelayBackupError.make({
      code: "repository_password_missing",
      operation,
      reason: "The restic repository password was not provided to Relay",
    })
  }
  return password
}

export function translateExcludePatterns(
  patterns: ReadonlyArray<string>
): TranslatedExcludes {
  const excludes: Array<string> = []
  const warnings: Array<string> = []
  const seen = new Set<string>()
  const add = (pattern: string) => {
    if (seen.has(pattern)) return
    seen.add(pattern)
    excludes.push(pattern)
  }
  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("!")) {
      warnings.push(`Skipped unsupported restic exclude negation: ${trimmed}`)
      continue
    }
    if (isUnsupportedExcludePattern(trimmed)) {
      warnings.push(`Skipped unsupported restic exclude pattern: ${trimmed}`)
      continue
    }
    add(trimmed)
    if (!trimmed.includes("/")) add(`**/${trimmed}`)
  }
  return { excludes, warnings }
}

function isUnsupportedExcludePattern(pattern: string): boolean {
  if (pattern.includes("[") || pattern.includes("{")) return true
  return /\?\(|\*\(|\+\(|@\(|!\(/u.test(pattern)
}

function parseResticJsonLine(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed) return null
  return Result.getOrElse(
    Result.try(() => JSON.parse(trimmed) as unknown),
    () => null
  )
}

function progressFromResticStatus(value: unknown): ResticProgress | null {
  if (!isRecord(value) || value.message_type !== "status") return null
  const bytesDone = integerField(value, "bytes_done")
  const totalBytes = integerField(value, "total_bytes")
  if (bytesDone === null && totalBytes === null) return null
  return {
    bytesCompleted: bytesDone ?? 0,
    bytesTotal: totalBytes,
  }
}

function summaryFromResticJson(value: unknown): ResticSnapshotSummary | null {
  if (!isRecord(value) || value.message_type !== "summary") return null
  const snapshotId = stringField(value, "snapshot_id")
  const totalBytesProcessed = integerField(value, "total_bytes_processed")
  if (!snapshotId || totalBytesProcessed === null) return null
  return { snapshotId, totalBytesProcessed }
}

export function createResticDriver(options?: {
  cacheDirectory?: string
  spawn?: ResticSpawn
}): ResticDriver {
  const spawnRestic = options?.spawn ?? defaultSpawn
  const cacheDirectory = options?.cacheDirectory
  const run = (
    args: ReadonlyArray<string>,
    input: {
      cwd?: string
      location: ResticDriverLocation
      mutating?: boolean
      onJson?: (value: unknown) => void
      password: string
      retryable?: boolean
      signal: AbortSignal
      stdoutPipe?: (stdout: NodeJS.ReadableStream) => Promise<void>
    }
  ) => {
    const execute = async () => {
      if (input.mutating && input.location.kind === "s3") {
        await retryResticOperation(() =>
          spawnResticCommand(spawnRestic, ["unlock"], {
            cacheDirectory,
            location: input.location,
            password: input.password,
            signal: input.signal,
          })
        )
      }
      return spawnResticCommand(spawnRestic, args, {
        cacheDirectory,
        cwd: input.cwd,
        location: input.location,
        onJson: input.onJson,
        password: input.password,
        signal: input.signal,
        stdoutPipe: input.stdoutPipe,
      })
    }
    return input.retryable ? retryResticOperation(execute) : execute()
  }

  return {
    backup: async (input) => {
      let summary: ResticSnapshotSummary | null = null
      const result = await run(
        [
          "backup",
          "--json",
          ...input.tags.flatMap((tag) => ["--tag", tag]),
          ...input.excludes.flatMap((pattern) => ["--exclude", pattern]),
          input.path,
        ],
        {
          cwd: input.cwd,
          location: input.location,
          mutating: true,
          password: input.password,
          signal: input.signal,
          onJson: (value) => {
            const progress = progressFromResticStatus(value)
            if (progress) input.onProgress?.(progress)
            const next = summaryFromResticJson(value)
            if (next) summary = next
          },
        }
      )
      if (!summary) {
        throw resticError(
          "restic_backup_summary_missing",
          "create.restic",
          result.stderr || "restic backup did not report a snapshot"
        )
      }
      return summary
    },
    cacheCleanup: async (input) => {
      if (input.location.kind !== "s3") return
      await run(["cache", "--cleanup"], {
        location: input.location,
        password: input.password,
        signal: input.signal,
      })
    },
    catConfig: async (input) => {
      const result = await resultOf(() =>
        run(["cat", "config"], {
          location: input.location,
          password: input.password,
          retryable: true,
          signal: input.signal,
        })
      )
      if (Result.isSuccess(result)) return "exists"
      const failure = result.failure
      if (
        failure instanceof RelayBackupError &&
        failure.exitCode === RESTIC_EXIT_REPOSITORY_MISSING
      ) {
        return "missing"
      }
      if (
        failure instanceof RelayBackupError &&
        failure.exitCode === RESTIC_EXIT_WRONG_PASSWORD
      ) {
        throw resticError(
          "restic_wrong_password",
          "cat.config",
          failure.reason,
          failure.exitCode
        )
      }
      throw failure
    },
    dumpZip: async (input) => {
      await mkdir(dirname(input.destination), { recursive: true, mode: 0o700 })
      await rm(input.destination, { force: true })
      const digest = createHash("sha256")
      let bytes = 0
      const output = createWriteStream(input.destination, {
        flags: "wx",
        mode: 0o600,
      })
      const hasher = new Transform({
        transform(chunk, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.byteLength
          digest.update(buffer)
          input.onProgress?.(bytes)
          callback(null, buffer)
        },
      })
      const dumped = await resultOf(async () => {
        await run(["dump", "-a", "zip", input.selector, "/"], {
          location: input.location,
          password: input.password,
          signal: input.signal,
          stdoutPipe: (stdout) => pipeline(stdout, hasher, output),
        })
        return { bytes, checksumSha256: digest.digest("hex") }
      })
      if (Result.isFailure(dumped)) {
        output.destroy()
        hasher.destroy()
        await rm(input.destination, { force: true })
        throw dumped.failure
      }
      return dumped.success
    },
    forget: async (input) => {
      const result = await resultOf(() =>
        run(["forget", input.snapshotId], {
          location: input.location,
          mutating: true,
          password: input.password,
          retryable: true,
          signal: input.signal,
        })
      )
      if (Result.isSuccess(result)) return
      if (isMissingSnapshotError(result.failure)) return
      throw result.failure
    },
    init: async (input) => {
      if (input.location.kind === "local") {
        await mkdir(input.location.path, { recursive: true, mode: 0o700 })
      }
      await run(["init"], {
        location: input.location,
        password: input.password,
        signal: input.signal,
      })
    },
    prune: async (input) => {
      await run(["prune", "--json"], {
        location: input.location,
        mutating: true,
        password: input.password,
        signal: input.signal,
        onJson: (value) => {
          const progress = progressFromResticStatus(value)
          if (progress) input.onProgress?.(progress)
        },
      })
    },
    restore: async (input) => {
      await mkdir(input.target, { recursive: true, mode: 0o700 })
      await run(
        ["restore", "--json", input.selector, "--target", input.target],
        {
          location: input.location,
          mutating: true,
          password: input.password,
          signal: input.signal,
          onJson: (value) => {
            const progress = progressFromResticStatus(value)
            if (progress) input.onProgress?.(progress)
          },
        }
      )
    },
    snapshotsByTag: async (input) => {
      const result = await run(["snapshots", "--json", "--tag", input.tag], {
        location: input.location,
        password: input.password,
        retryable: true,
        signal: input.signal,
      })
      const parsed = parseResticJsonLine(result.stdoutText)
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((entry) => {
        const id = isRecord(entry) ? stringField(entry, "id") : null
        return id ? [{ id }] : []
      })
    },
    stats: async (input) => {
      const result = await run(
        ["stats", "--mode", "restore-size", "--json", input.snapshotId],
        {
          location: input.location,
          password: input.password,
          retryable: true,
          signal: input.signal,
        }
      )
      const parsed = parseResticJsonLine(result.stdoutText)
      const totalSize = isRecord(parsed)
        ? integerField(parsed, "total_size")
        : null
      if (totalSize === null) {
        throw resticError(
          "restic_stats_missing",
          "create.restic",
          "restic stats did not report restore size"
        )
      }
      return { totalSize }
    },
  }
}

export async function validateStagingTree(
  stagingRoot: string,
  limits: { diskBytes: number }
): Promise<{ entries: number; logicalBytes: number; warnings: Array<string> }> {
  const root = resolve(stagingRoot)
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw resticError(
      "invalid_staging_tree",
      "restore.validate",
      "The restored staging tree is not a directory"
    )
  }
  let entries = 0
  let logicalBytes = 0
  let skipped = 0
  const warnings: Array<string> = []
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of await opendir(directory)) {
      entries += 1
      if (entries > MAX_STAGING_ENTRIES) {
        throw resticError(
          "too_many_entries",
          "restore.validate",
          `Backups cannot contain more than ${MAX_STAGING_ENTRIES.toLocaleString("en-US")} entries`
        )
      }
      const absolute = resolve(directory, entry.name)
      requireContained(root, absolute, "restore.validate")
      const child = await lstat(absolute)
      if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) {
        // Full archives never contain non-regular files (the walker skips
        // them with a warning), so drop them here for identical semantics
        // instead of failing an otherwise valid snapshot restore.
        await rm(absolute, { force: true, recursive: false })
        skipped += 1
        if (warnings.length < MAX_SKIPPED_ENTRY_WARNINGS) {
          warnings.push(
            `Skipped non-regular file ${relative(root, absolute) || entry.name}`
          )
        }
        continue
      }
      if (child.isDirectory()) {
        await visit(absolute)
        continue
      }
      logicalBytes = safeByteSum(logicalBytes, child.size)
    }
  }
  await visit(root)
  if (skipped > warnings.length) {
    warnings.push(`Skipped ${skipped - warnings.length} more non-regular files`)
  }
  const maximumBytes =
    limits.diskBytes > 0 ? limits.diskBytes : MAX_UNLIMITED_RESTORE_BYTES
  if (logicalBytes > maximumBytes) {
    throw resticError(
      "restore_too_large",
      "restore.validate",
      "The backup expands beyond this server's disk limit"
    )
  }
  return { entries, logicalBytes, warnings }
}

type SpawnedRestic = {
  exitCode: number
  stderr: string
  stdout: NodeJS.ReadableStream
  stdoutText: string
}

async function spawnResticCommand(
  spawnRestic: ResticSpawn,
  args: ReadonlyArray<string>,
  input: {
    cacheDirectory?: string
    cwd?: string
    location: ResticDriverLocation
    onJson?: (value: unknown) => void
    password: string
    signal: AbortSignal
    stdoutPipe?: (stdout: NodeJS.ReadableStream) => Promise<void>
  }
): Promise<SpawnedRestic> {
  if (input.location.kind !== "s3") {
    return spawnResticOnce(spawnRestic, args, input)
  }
  const token = resticS3ProxyToken()
  return withResticS3Proxy(
    {
      allowPrivateNetwork: input.location.allowPrivateNetwork,
      allowedHosts: resticS3ProxyAllowedHosts(input.location),
      endpointPort: resticDestinationEndpointPort(input.location) ?? 443,
      token,
    },
    (proxyUrl) => spawnResticOnce(spawnRestic, args, { ...input, proxyUrl })
  )
}

async function spawnResticOnce(
  spawnRestic: ResticSpawn,
  args: ReadonlyArray<string>,
  input: {
    cacheDirectory?: string
    cwd?: string
    location: ResticDriverLocation
    onJson?: (value: unknown) => void
    password: string
    proxyUrl?: string
    signal: AbortSignal
    stdoutPipe?: (stdout: NodeJS.ReadableStream) => Promise<void>
  }
): Promise<SpawnedRestic> {
  input.signal.throwIfAborted()
  if (input.location.kind === "s3" && input.cacheDirectory) {
    await mkdir(input.cacheDirectory, { recursive: true, mode: 0o700 })
  }
  const env = resticSpawnEnv(input)
  const child = spawnRestic(
    RESTIC_BINARY,
    [...resticGlobalArgs(input.location), ...args],
    {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  if (!child.stdout || !child.stderr) {
    throw resticError(
      "restic_stdio_missing",
      args[0] ?? "restic",
      "restic did not provide stdio pipes"
    )
  }
  const stdout = child.stdout
  const stderrStream = child.stderr
  let stdoutText = ""
  let stderr = ""
  let stdoutBuffer = ""
  let exited = false
  const waitForExit = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      exited = true
      rejectExit(error)
    })
    child.once("close", (code) => {
      exited = true
      resolveExit(code ?? 1)
    })
  })
  let termination: Promise<void> | null = null
  const terminate = () => {
    termination ??= terminateResticChild(child, waitForExit, () => exited)
    return termination
  }
  let resolveAborted: (cause: unknown) => void = () => undefined
  const aborted = new Promise<{ readonly cause: unknown }>((resolve) => {
    resolveAborted = (cause) => resolve({ cause })
  })
  const onAbort = () => {
    Effect.runFork(
      Effect.tryPromise({
        try: terminate,
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: resolveAborted,
          onSuccess: () =>
            resolveAborted(
              resticError(
                "restic_command_aborted",
                args[0] ?? "restic",
                input.signal.reason instanceof Error
                  ? input.signal.reason.message
                  : "The restic command was cancelled"
              )
            ),
        })
      )
    )
  }
  if (input.signal.aborted) {
    onAbort()
  } else {
    input.signal.addEventListener("abort", onAbort, { once: true })
  }
  const completed = await resultOf(async () => {
    const outcome = await Promise.race([
      Promise.all([
        waitForExit,
        input.stdoutPipe
          ? input.stdoutPipe(stdout)
          : readStream(stdout, (chunk) => {
              if (!input.onJson) {
                stdoutText = appendBounded(stdoutText, chunk.toString("utf8"))
                return
              }
              stdoutBuffer += chunk.toString("utf8")
              stdoutText = appendBounded(stdoutText, chunk.toString("utf8"))
              const lines = stdoutBuffer.split("\n")
              stdoutBuffer = lines.pop() ?? ""
              for (const line of lines) {
                const parsed = parseResticJsonLine(line)
                if (parsed !== null) input.onJson(parsed)
              }
            }),
        readStream(stderrStream, (chunk) => {
          stderr = appendBounded(
            stderr,
            chunk.toString("utf8"),
            MAX_STDERR_BYTES
          )
        }),
      ]),
      aborted,
    ])
    if (!Array.isArray(outcome)) throw outcome.cause
    const [exitCode] = outcome
    if (stdoutBuffer.trim()) {
      const parsed = parseResticJsonLine(stdoutBuffer)
      if (parsed !== null) input.onJson?.(parsed)
    }
    if (exitCode !== 0) {
      throw resticError(
        "restic_command_failed",
        args[0] ?? "restic",
        redactResticStderr(
          stderr.trim() || `restic exited with code ${exitCode}`,
          input
        ),
        exitCode
      )
    }
    return {
      exitCode,
      stderr: redactResticStderr(stderr, input),
      stdout,
      stdoutText,
    }
  })
  input.signal.removeEventListener("abort", onAbort)
  if (Result.isFailure(completed)) {
    await terminate()
    throw completed.failure
  }
  return completed.success
}

async function terminateResticChild(
  child: ChildProcess,
  waitForExit: Promise<number>,
  hasExited: () => boolean
): Promise<void> {
  if (hasExited()) return
  child.kill("SIGTERM")
  const first = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => waitForExit,
        catch: (cause) => cause,
      }).pipe(Effect.timeout(`${RESTIC_TERMINATE_TIMEOUT_MS} millis`))
    )
  )
  if (hasExited() || Result.isSuccess(first)) return
  child.kill("SIGKILL")
  await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => waitForExit,
        catch: (cause) => cause,
      }).pipe(Effect.timeout(`${RESTIC_TERMINATE_TIMEOUT_MS} millis`))
    )
  )
}

async function readStream(
  stream: NodeJS.ReadableStream,
  onChunk: (chunk: Buffer) => void
): Promise<void> {
  for await (const chunk of stream) {
    onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
}

function defaultSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    stdio: ["ignore", "pipe", "pipe"]
  }
): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: options.stdio,
  })
}

function isMissingSnapshotError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /no matching ID found/iu.test(message)
}

function resultOf<T>(run: () => Promise<T>) {
  return Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: run,
        catch: (cause) => cause,
      })
    )
  )
}

function resticError(
  code: string,
  operation: string,
  reason: string,
  exitCode?: number
) {
  return RelayBackupError.make({
    code,
    operation,
    reason,
    ...(exitCode === undefined ? {} : { exitCode }),
  })
}

function resticSpawnEnv(input: {
  cacheDirectory?: string
  location: ResticDriverLocation
  password: string
  proxyUrl?: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of RESTIC_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  env.RESTIC_PASSWORD = input.password
  env.RESTIC_REPOSITORY = resticRepositoryString(input.location)
  applyResticDestinationEnvironment(env, input.location, {
    ...(input.cacheDirectory ? { cacheDirectory: input.cacheDirectory } : {}),
    ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
  })
  return env
}

function redactResticStderr(
  stderr: string,
  input: { location: ResticDriverLocation; password: string }
): string {
  let redacted = stderr.split(input.password).join("[redacted]")
  if (input.location.kind === "s3") {
    redacted = redacted
      .split(input.location.secretAccessKey)
      .join("[redacted]")
      .split(input.location.accessKeyId)
      .join("[redacted]")
  }
  return redacted
}

function retryResticOperation<T>(run: () => Promise<T>): Promise<T> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: run,
      catch: (cause) => cause,
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
        times: 2,
        while: isTransientResticFailure,
      })
    )
  )
}

function isTransientResticFailure(error: unknown): boolean {
  if (!(error instanceof RelayBackupError)) return false
  if (
    error.exitCode === RESTIC_EXIT_REPOSITORY_MISSING ||
    error.exitCode === RESTIC_EXIT_WRONG_PASSWORD
  ) {
    return false
  }
  return /timeout|temporar|connection reset|connection refused|network is unreachable|no such host|tls handshake|i\/o timeout|slow down|throttl|503|502|504/iu.test(
    error.reason
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string | null {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : null
}

function integerField(
  value: Record<string, unknown>,
  key: string
): number | null {
  const field = value[key]
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    ? field
    : null
}

function appendBounded(
  current: string,
  next: string,
  max = MAX_JSON_LINE_BYTES
) {
  const combined = current + next
  return combined.length > max
    ? combined.slice(combined.length - max)
    : combined
}

function requireContained(root: string, candidate: string, operation: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw resticError(
      "path_outside_instance",
      operation,
      "The restore path resolves outside the instance directory"
    )
  }
}

function safeByteSum(total: number, value: number): number {
  const sum = total + value
  if (!Number.isSafeInteger(sum) || sum > MAX_UNLIMITED_RESTORE_BYTES) {
    throw resticError(
      "restore_too_large",
      "restore.validate",
      "The backup expands beyond the maximum supported restore size"
    )
  }
  return sum
}
