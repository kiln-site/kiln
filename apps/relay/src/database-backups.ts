import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { rm, stat } from "node:fs/promises"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip, createGzip } from "node:zlib"
import { Effect, Result } from "effect"

import {
  backupArtifactFilename,
  type BackupCreateTaskInput,
  type BackupArchiveCreateTaskResult,
  type RelayManagedDatabase,
} from "@workspace/contracts"

import type { DatabaseDriver } from "./databases.js"
import {
  type DockerExecProcess,
  streamIntoProcess,
} from "./docker-engine.js"

const DATABASE_BACKUP_TIMEOUT_MS = 30 * 60_000
const MAX_DATABASE_ERROR_BYTES = 64 * 1024
const MAX_DATABASE_RESTORE_BYTES = 1024 ** 4

export interface DatabaseBackupProgress {
  completed: number
  total: number
}

export async function createCompressedDatabaseBackup(
  databases: DatabaseDriver,
  input: BackupCreateTaskInput,
  destination: string,
  progress: DatabaseBackupProgress,
  signal: AbortSignal = new AbortController().signal
): Promise<BackupArchiveCreateTaskResult> {
  signal.throwIfAborted()
  const database = await databases.backupTarget(input.target.id)
  const child = await startDatabaseClient(databases, database, "export")
  const stderr = collectProcessErrors(child)
  const sourceMeter = byteMeter((bytes) => {
    progress.completed = bytes
  })
  const storedLimit = byteMeter(undefined, input.maxBytes)
  const writing = pipeline(
    child.stdout,
    sourceMeter,
    createGzip({ level: 6 }),
    storedLimit,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
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
    // A failed client can exit before the write stream even opens the file.
    // Settle both branches before cleanup, keeping the original failure.
    await Promise.allSettled([writing, exited])
    await rm(destination, { force: true })
    throw written.failure
  }

  const metadata = await stat(destination)
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(destination, { signal })) {
    digest.update(chunk)
  }
  return {
    bytes: metadata.size,
    checksumSha256: digest.digest("hex"),
    filename: backupArtifactFilename(input.backupId, "database_dump"),
    warnings: [],
  }
}

export async function restoreCompressedDatabaseBackup(
  databases: DatabaseDriver,
  databaseId: string,
  source: string
): Promise<{ warnings: Array<string> }> {
  const database = await databases.backupTarget(databaseId)
  const child = await startDatabaseClient(databases, database, "import")
  const stderr = collectProcessErrors(child)
  // The client's progress output isn't kept, but it must be read for the
  // client to keep going.
  child.stdout.resume()
  const restored = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          streamIntoProcess(
            child,
            () =>
              pipeline(
                createReadStream(source),
                createGunzip(),
                byteMeter(undefined, MAX_DATABASE_RESTORE_BYTES),
                child.stdin
              ),
            () => requireSuccessfulProcess(child, stderr)
          ),
        catch: (cause) => cause,
      })
    )
  )
  if (Result.isFailure(restored)) {
    child.kill()
    throw restored.failure
  }
  return { warnings: [] }
}

function startDatabaseClient(
  databases: DatabaseDriver,
  database: RelayManagedDatabase,
  mode: "export" | "import"
): Promise<DockerExecProcess> {
  return databases.process(
    database,
    ["sh", "-ec", databaseBackupShell(database, mode)],
    {
      stdin: mode === "import",
      ...(database.engine === "postgres" ? { user: "postgres" } : {}),
    }
  )
}

function databaseBackupShell(
  database: RelayManagedDatabase,
  mode: "export" | "import"
): string {
  if (database.engine === "mysql") {
    return mode === "export"
      ? 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --user=root --single-transaction --skip-lock-tables --no-tablespaces "$MYSQL_DATABASE"'
      : 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root "$MYSQL_DATABASE"'
  }
  if (database.engine === "mariadb") {
    return mode === "export"
      ? 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump --user=root --single-transaction --skip-lock-tables "$MARIADB_DATABASE"'
      : 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb --user=root "$MARIADB_DATABASE"'
  }
  if (database.engine === "postgres") {
    return mode === "export"
      ? 'exec pg_dump --clean --if-exists --no-owner --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'
      : 'exec psql --set ON_ERROR_STOP=on --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'
  }
  throw new Error(`${database.engine} logical backups are not supported yet`)
}

export function collectProcessErrors(child: DockerExecProcess) {
  const chunks: Array<Buffer> = []
  let bytes = 0
  child.stderr.on("data", (chunk: Buffer) => {
    if (bytes >= MAX_DATABASE_ERROR_BYTES) return
    const remaining = MAX_DATABASE_ERROR_BYTES - bytes
    const retained = chunk.subarray(0, remaining)
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
    timedOut: "Database backup command timed out",
    timeout: DATABASE_BACKUP_TIMEOUT_MS,
  })
  if (code !== 0) {
    throw new Error(stderr() || `Database command exited with code ${code}`)
  }
}

function byteMeter(
  update?: (bytes: number) => void,
  maximumBytes?: number | null
): Transform {
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (
        maximumBytes !== undefined &&
        maximumBytes !== null &&
        bytes > maximumBytes
      ) {
        callback(new Error("Database backup exceeded its size limit"))
        return
      }
      update?.(bytes)
      callback(null, chunk)
    },
  })
}
