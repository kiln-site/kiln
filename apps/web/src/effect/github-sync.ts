import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import { CredentialError, ResourceNotFoundError } from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

const GITHUB_APP_CREDENTIALS_PURPOSE = "kiln-github-app-credentials"

const StoredCredentialsSchema = Schema.Struct({
  clientSecret: Schema.String,
  privateKey: Schema.String,
  webhookSecret: Schema.NullOr(Schema.String),
})
const decodeStoredCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredCredentialsSchema)
)
const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)
const decodeStringArray = Schema.decodeUnknownOption(
  Schema.Array(Schema.String)
)
// What Kiln last wrote at each destination path: the blob, and the file's
// modification time afterwards, so an edit since shows. Older records hold
// only the blob.
const decodeSyncedFiles = Schema.decodeUnknownOption(
  Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Struct({
        blob: Schema.NullOr(Schema.String),
        modifiedAt: Schema.NullOr(Schema.Number),
        pending: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ])
  )
)

export type GitHubSyncStatus =
  | "error"
  | "idle"
  | "queued"
  | "running"
  | "success"
export type GitHubSyncResourceKind = "app" | "instance" | "relay"

/** A file Kiln wrote, as it left it. */
export interface GitHubSyncedFile {
  /** The blob Kiln last wrote there; null before a write completed. */
  blob: string | null
  /** Null when the file was written before Kiln recorded it. */
  modifiedAt: number | null
  /** Blobs Kiln set out to write there, whose result it hasn't recorded. */
  pending?: ReadonlyArray<string>
}

export interface GitHubInstallationRecord {
  accountAvatarUrl: string | null
  accountLogin: string
  accountType: "Organization" | "User"
  id: number
  repositorySelection: "all" | "selected"
  suspended: boolean
}

/** A GitHub App someone connected, without its secrets. */
export interface GitHubConnection {
  appId: number
  appName: string
  appOwnerLogin: string
  appSlug: string
  appUrl: string
  createdAt: string
  id: string
  /** Null until the app is installed on an account. */
  installation: GitHubInstallationRecord | null
  ownerUserId: string
  /** GitHub delivers pushes; otherwise Kiln polls for new commits. */
  webhookActive: boolean
}

export interface GitHubConnectionCredential extends GitHubConnection {
  clientSecret: string
  privateKey: string
  webhookSecret: string | null
}

/** Files from one repository folder, copied into a game server or app. */
export interface GitHubSync {
  autoSync: boolean
  branch: string
  connectionId: string
  createdAt: string
  createdBy: string
  id: string
  /** Glob patterns relative to `sourcePath`; empty copies every file. */
  includePatterns: Array<string>
  lastChangedCount: number
  lastCommitMessage: string | null
  lastCommitSha: string | null
  lastError: string | null
  lastSyncedAt: string | null
  overwrite: boolean
  relayId: string
  repository: string
  repositoryId: number
  resourceId: string
  resourceKind: GitHubSyncResourceKind
  /** A folder in the repository, without slashes at either end; "" is its root. */
  sourcePath: string
  status: GitHubSyncStatus
  /** A folder in the game server or app, without slashes at either end. */
  targetPath: string
}

export interface GitHubSyncSettings {
  autoSync: boolean
  /** Replaces files that exist but Kiln didn't write, or that changed since. */
  overwrite: boolean
  branch: string
  includePatterns: Array<string>
  repository: string
  repositoryId: number
  sourcePath: string
  targetPath: string
}

interface ConnectionRow extends RowDataPacket {
  account_avatar_url: string | null
  account_login: string | null
  account_type: "Organization" | "User" | null
  app_id: number | string
  app_name: string
  app_owner_login: string
  app_slug: string
  app_url: string
  created_at: number | string
  credentials_ciphertext: string
  id: string
  installation_id: number | string | null
  owner_user_id: string
  repository_selection: "all" | "selected" | null
  suspended: boolean | number
  webhook_active: boolean | number
}

interface SyncRow extends RowDataPacket {
  auto_sync: boolean | number
  branch: string
  connection_id: string
  created_at: number | string
  created_by: string
  id: string
  include_patterns: unknown
  last_changed_count: number
  last_commit_message: string | null
  last_commit_sha: string | null
  last_error: string | null
  last_synced_at: number | string | null
  overwrite: boolean | number
  relay_id: string
  repository: string
  repository_id: number | string
  resource_id: string
  resource_kind: GitHubSyncResourceKind
  source_path: string
  status: GitHubSyncStatus
  target_path: string
}

const connectionColumns = `id, owner_user_id, app_id, app_slug, app_name, app_url,
  app_owner_login, credentials_ciphertext, webhook_active, installation_id,
  account_login, account_type, account_avatar_url, repository_selection,
  suspended, created_at`

const syncColumns = `id, connection_id, relay_id, resource_kind, resource_id,
  repository_id, repository, branch, source_path, target_path,
  include_patterns, auto_sync, overwrite, status, last_error,
  last_commit_sha, last_commit_message, last_synced_at, last_changed_count,
  created_by, created_at`

export const insertGitHubConnectionEffect = Effect.fn(
  "github.connection.insert"
)(function* (input: {
  appId: number
  appName: string
  appOwnerLogin: string
  appSlug: string
  appUrl: string
  clientId: string
  clientSecret: string
  id: string
  ownerUserId: string
  privateKey: string
  webhookActive: boolean
  webhookSecret: string | null
}) {
  const database = yield* Database
  const ciphertext = yield* encryptCredentials({
    clientSecret: input.clientSecret,
    privateKey: input.privateKey,
    webhookSecret: input.webhookSecret,
  })
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "github.connection.insert",
    `INSERT INTO ${databaseTable("github_connection")}
       (id, owner_user_id, app_id, app_slug, app_name, app_url,
        app_owner_login, client_id, credentials_ciphertext, webhook_active,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.ownerUserId,
      input.appId,
      input.appSlug,
      input.appName,
      input.appUrl,
      input.appOwnerLogin,
      input.clientId,
      ciphertext,
      input.webhookActive,
      now,
      now,
    ]
  )
})

export const loadGitHubConnectionsEffect = Effect.fn("github.connections.load")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<ConnectionRow>(
      "github.connections.load",
      `SELECT ${connectionColumns}
       FROM ${databaseTable("github_connection")}
      ORDER BY created_at`
    )
    return rows.map(publicConnection)
  }
)

export const loadGitHubConnectionCredentialEffect = Effect.fn(
  "github.connection.credential"
)(function* (where: { appId: number } | { id: string }) {
  const database = yield* Database
  const [row] = yield* database.queryRows<ConnectionRow>(
    "github.connection.credential",
    `SELECT ${connectionColumns}
       FROM ${databaseTable("github_connection")}
      WHERE ${"id" in where ? "id" : "app_id"} = ?
      LIMIT 1`,
    ["id" in where ? where.id : where.appId]
  )
  if (!row) {
    return yield* ResourceNotFoundError.make({
      message: "GitHub connection not found",
      resource: "github_connection",
    })
  }
  const plaintext = yield* Effect.try({
    try: () =>
      decryptWithKeyring(
        row.credentials_ciphertext,
        betterAuthSecrets(),
        GITHUB_APP_CREDENTIALS_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        cause,
        operation: "decrypt_github_app_credentials",
      }),
  })
  const credentials = Option.getOrNull(
    decodeStoredCredentials(plaintext.plaintext)
  )
  if (!credentials) {
    return yield* CredentialError.make({
      cause: new Error("Stored GitHub App credentials are malformed"),
      operation: "decrypt_github_app_credentials",
    })
  }
  if (plaintext.needsRotation) {
    const rotated = yield* encryptCredentials(credentials)
    yield* database.execute(
      "github.connection.rotateCredential",
      `UPDATE ${databaseTable("github_connection")}
          SET credentials_ciphertext = ?
        WHERE id = ? AND credentials_ciphertext = ?`,
      [rotated, row.id, row.credentials_ciphertext]
    )
  }
  return {
    ...publicConnection(row),
    ...credentials,
  } satisfies GitHubConnectionCredential
})

export const saveGitHubInstallationEffect = Effect.fn(
  "github.connection.saveInstallation"
)(function* (
  connectionId: string,
  installation: GitHubInstallationRecord | null
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "github.connection.saveInstallation",
    `UPDATE ${databaseTable("github_connection")}
        SET installation_id = ?, account_login = ?, account_type = ?,
            account_avatar_url = ?, repository_selection = ?, suspended = ?,
            updated_at = ?
      WHERE id = ?`,
    [
      installation?.id ?? null,
      installation?.accountLogin ?? null,
      installation?.accountType ?? null,
      installation?.accountAvatarUrl ?? null,
      installation?.repositorySelection ?? null,
      installation?.suspended ?? false,
      now,
      connectionId,
    ]
  )
})

export const deleteGitHubConnectionEffect = Effect.fn(
  "github.connection.delete"
)(function* (connectionId: string) {
  const database = yield* Database
  // Its syncs go with it, by foreign key.
  yield* database.execute(
    "github.connection.delete",
    `DELETE FROM ${databaseTable("github_connection")} WHERE id = ?`,
    [connectionId]
  )
})

export const loadGitHubSyncsEffect = Effect.fn("github.syncs.load")(function* (
  where: { connectionId?: string; repositoryId?: number } = {}
) {
  const database = yield* Database
  const clauses: Array<string> = []
  const values: Array<string | number> = []
  if (where.connectionId !== undefined) {
    clauses.push("connection_id = ?")
    values.push(where.connectionId)
  }
  if (where.repositoryId !== undefined) {
    clauses.push("repository_id = ?")
    values.push(where.repositoryId)
  }
  const rows = yield* database.queryRows<SyncRow>(
    "github.syncs.load",
    `SELECT ${syncColumns}
         FROM ${databaseTable("github_sync")}
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at`,
    values
  )
  return rows.map(publicSync)
})

/** Auto syncs whose connection gets no webhooks, so Kiln polls them. */
export const loadPolledGitHubSyncsEffect = Effect.fn("github.syncs.polled")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<SyncRow>(
      "github.syncs.polled",
      `SELECT ${syncColumns
        .split(",")
        .map((column) => `s.${column.trim()}`)
        .join(", ")}
         FROM ${databaseTable("github_sync")} s
         JOIN ${databaseTable("github_connection")} c
           ON c.id = s.connection_id
        WHERE s.auto_sync = 1
          AND c.webhook_active = 0
          AND c.installation_id IS NOT NULL
          AND c.suspended = 0`
    )
    return rows.map(publicSync)
  }
)

export const loadGitHubSyncEffect = Effect.fn("github.sync.load")(function* (
  id: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<SyncRow & { synced_files: unknown }>(
    "github.sync.load",
    `SELECT ${syncColumns}, synced_files
       FROM ${databaseTable("github_sync")}
      WHERE id = ?
      LIMIT 1`,
    [id]
  )
  if (!row) {
    return yield* ResourceNotFoundError.make({
      message: "Sync not found",
      resource: "github_sync",
    })
  }
  return { ...publicSync(row), syncedFiles: syncedFiles(row.synced_files) }
})

export const insertGitHubSyncEffect = Effect.fn("github.sync.insert")(
  function* (
    input: GitHubSyncSettings & {
      connectionId: string
      createdBy: string
      id: string
      relayId: string
      resourceId: string
      resourceKind: GitHubSyncResourceKind
    }
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "github.sync.insert",
      `INSERT INTO ${databaseTable("github_sync")}
         (id, connection_id, relay_id, resource_kind, resource_id,
          repository_id, repository, branch, source_path, target_path,
          include_patterns, auto_sync, overwrite, synced_files, created_by,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      [
        input.id,
        input.connectionId,
        input.relayId,
        input.resourceKind,
        input.resourceId,
        input.repositoryId,
        input.repository,
        input.branch,
        input.sourcePath,
        input.targetPath,
        JSON.stringify(input.includePatterns),
        input.autoSync,
        input.overwrite,
        input.createdBy,
        now,
        now,
      ]
    )
  }
)

export const updateGitHubSyncEffect = Effect.fn("github.sync.update")(
  function* (id: string, settings: GitHubSyncSettings) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    // A new source makes the last commit meaningless, so the next sync
    // compares every file again.
    yield* database.execute(
      "github.sync.update",
      `UPDATE ${databaseTable("github_sync")}
          SET last_commit_sha = IF(
                repository_id = ? AND branch = ? AND source_path = ?
                  AND target_path = ? AND include_patterns = CAST(? AS JSON),
                last_commit_sha, NULL),
              repository_id = ?, repository = ?, branch = ?,
              source_path = ?, target_path = ?, include_patterns = ?,
              auto_sync = ?, overwrite = ?, updated_at = ?
        WHERE id = ?`,
      [
        settings.repositoryId,
        settings.branch,
        settings.sourcePath,
        settings.targetPath,
        JSON.stringify(settings.includePatterns),
        settings.repositoryId,
        settings.repository,
        settings.branch,
        settings.sourcePath,
        settings.targetPath,
        JSON.stringify(settings.includePatterns),
        settings.autoSync,
        settings.overwrite,
        now,
        id,
      ]
    )
  }
)

export const deleteGitHubSyncEffect = Effect.fn("github.sync.delete")(
  function* (id: string) {
    const database = yield* Database
    yield* database.execute(
      "github.sync.delete",
      `DELETE FROM ${databaseTable("github_sync")} WHERE id = ?`,
      [id]
    )
  }
)

export const setGitHubSyncStatusEffect = Effect.fn("github.sync.status")(
  function* (id: string, status: GitHubSyncStatus) {
    const database = yield* Database
    yield* database.execute(
      "github.sync.status",
      `UPDATE ${databaseTable("github_sync")} SET status = ? WHERE id = ?`,
      [status, id]
    )
  }
)

export type GitHubSyncTrigger = "created" | "manual" | "poll" | "push"

/** A finished run, as Automations → History lists it. */
export interface GitHubSyncRun {
  changedCount: number
  commitMessage: string | null
  commitSha: string | null
  finishedAt: number
  id: string
  /** The failure, or a successful run's warning. */
  message: string | null
  startedAt: number
  status: "error" | "success"
  syncId: string
  trigger: GitHubSyncTrigger
}

interface SyncRunRow extends RowDataPacket {
  changed_count: number
  commit_message: string | null
  commit_sha: string | null
  finished_at: number | string
  id: string
  message: string | null
  started_at: number | string
  status: "error" | "success"
  sync_id: string
  trigger: GitHubSyncTrigger
}

const runsKeptPerSync = 50

/**
 * Saves a run's outcome on its sync and in its history. A failure the sync
 * already shows, as a poll repeats it every minute, changes neither.
 */
export const recordGitHubSyncResultEffect = Effect.fn("github.sync.record")(
  function* (
    id: string,
    run: { startedAt: number; trigger: GitHubSyncTrigger },
    result:
      | {
          changedCount: number
          commitMessage: string
          commitSha: string
          syncedFiles: Record<string, GitHubSyncedFile>
          /** Kept in `last_error` beside a successful status. */
          warning: string | null
        }
      | {
          error: string
          /** The run's file records, including writes it attempted. */
          syncedFiles?: Record<string, GitHubSyncedFile>
        }
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const message = "error" in result ? result.error : (result.warning ?? null)
    const commitMessage =
      "error" in result
        ? null
        : result.commitMessage.split("\n", 1)[0]!.slice(0, 255)
    if ("error" in result) {
      // Files written before the failure stay recorded, so a retry doesn't
      // write them again. Having maybe written some, the instance may no
      // longer be at the last synced commit, so the next poll syncs again.
      if (result.syncedFiles) {
        yield* database.execute(
          "github.sync.recordFiles",
          `UPDATE ${databaseTable("github_sync")}
              SET synced_files = ?, last_commit_sha = NULL
            WHERE id = ?`,
          [JSON.stringify(result.syncedFiles), id]
        )
      }
      // The failure the sync already shows, as a poll repeats it, isn't a
      // new outcome.
      const updated = yield* database.execute(
        "github.sync.recordError",
        `UPDATE ${databaseTable("github_sync")}
            SET status = 'error', last_error = ?, last_synced_at = ?
          WHERE id = ?
            AND NOT (status = 'error' AND last_error <=> ?)`,
        [result.error.slice(0, 1024), now, id, result.error.slice(0, 1024)]
      )
      if (updated.affectedRows === 0) return false
    } else {
      yield* database.execute(
        "github.sync.recordSuccess",
        `UPDATE ${databaseTable("github_sync")}
            SET status = 'success', last_error = ?, last_synced_at = ?,
                last_commit_sha = ?, last_commit_message = ?,
                last_changed_count = ?, synced_files = ?
          WHERE id = ?`,
        [
          message?.slice(0, 1024) ?? null,
          now,
          result.commitSha,
          commitMessage,
          result.changedCount,
          JSON.stringify(result.syncedFiles),
          id,
        ]
      )
    }
    yield* database.execute(
      "github.sync.run.insert",
      `INSERT INTO ${databaseTable("github_sync_run")}
         (id, sync_id, \`trigger\`, status, message, commit_sha,
          commit_message, changed_count, started_at, finished_at)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        run.trigger,
        "error" in result ? "error" : "success",
        message?.slice(0, 1024) ?? null,
        "error" in result ? null : result.commitSha,
        commitMessage,
        "error" in result ? 0 : result.changedCount,
        run.startedAt,
        now,
      ]
    )
    // Keep each sync's history short; older runs go.
    yield* database.execute(
      "github.sync.run.prune",
      `DELETE FROM ${databaseTable("github_sync_run")}
        WHERE sync_id = ?
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM ${databaseTable("github_sync_run")}
               WHERE sync_id = ?
               ORDER BY started_at DESC
               LIMIT ${runsKeptPerSync}
            ) AS kept
          )`,
      [id, id]
    )
    return true
  }
)

/** Records a write about to be attempted, before it's attempted. */
export const recordGitHubSyncAttemptEffect = Effect.fn(
  "github.sync.recordAttempt"
)(function* (id: string, path: string, file: GitHubSyncedFile) {
  const database = yield* Database
  // One path, so a run's attempts don't each rewrite every record. Once a
  // write is attempted the instance may no longer be at the last synced
  // commit, whatever fails next, so polls sync again until a run succeeds.
  yield* database.execute(
    "github.sync.recordAttempt",
    `UPDATE ${databaseTable("github_sync")}
        SET synced_files = JSON_SET(
              synced_files, CONCAT('$.', JSON_QUOTE(?)), CAST(? AS JSON)),
            last_commit_sha = NULL
      WHERE id = ?`,
    [path, JSON.stringify(file), id]
  )
})

/** Clears a failure that passed, leaving the sync as it last succeeded. */
export const restoreGitHubSyncEffect = Effect.fn("github.sync.restore")(
  function* (id: string) {
    const database = yield* Database
    yield* database.execute(
      "github.sync.restore",
      `UPDATE ${databaseTable("github_sync")}
          SET status = 'success', last_error = NULL
        WHERE id = ? AND status = 'error'`,
      [id]
    )
  }
)

/** The latest runs of every sync, newest first. */
export const loadGitHubSyncRunsEffect = Effect.fn("github.sync.runs")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<SyncRunRow>(
      "github.sync.runs",
      `SELECT id, sync_id, \`trigger\`, status, message, commit_sha,
              commit_message, changed_count, started_at, finished_at
         FROM ${databaseTable("github_sync_run")}
        ORDER BY started_at DESC
        LIMIT 500`
    )
    return rows.map((row): GitHubSyncRun => ({
      changedCount: Number(row.changed_count),
      commitMessage: row.commit_message,
      commitSha: row.commit_sha,
      finishedAt: Number(row.finished_at),
      id: row.id,
      message: row.message,
      startedAt: Number(row.started_at),
      status: row.status,
      syncId: row.sync_id,
      trigger: row.trigger,
    }))
  }
)

function encryptCredentials(
  credentials: typeof StoredCredentialsSchema.Type
): Effect.Effect<string, CredentialError> {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        JSON.stringify(credentials),
        betterAuthSecrets(),
        GITHUB_APP_CREDENTIALS_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        cause,
        operation: "encrypt_github_app_credentials",
      }),
  })
}

function publicConnection(row: ConnectionRow): GitHubConnection {
  return {
    appId: Number(row.app_id),
    appName: row.app_name,
    appOwnerLogin: row.app_owner_login,
    appSlug: row.app_slug,
    appUrl: row.app_url,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    id: row.id,
    installation:
      row.installation_id === null || row.account_login === null
        ? null
        : {
            accountAvatarUrl: row.account_avatar_url,
            accountLogin: row.account_login,
            accountType: row.account_type ?? "User",
            id: Number(row.installation_id),
            repositorySelection: row.repository_selection ?? "selected",
            suspended: Boolean(row.suspended),
          },
    ownerUserId: row.owner_user_id,
    webhookActive: Boolean(row.webhook_active),
  }
}

function publicSync(row: SyncRow): GitHubSync {
  return {
    autoSync: Boolean(row.auto_sync),
    branch: row.branch,
    connectionId: row.connection_id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    createdBy: row.created_by,
    id: row.id,
    includePatterns: stringArray(row.include_patterns),
    lastChangedCount: Number(row.last_changed_count),
    lastCommitMessage: row.last_commit_message,
    lastCommitSha: row.last_commit_sha,
    lastError: row.last_error,
    lastSyncedAt:
      row.last_synced_at === null
        ? null
        : new Date(Number(row.last_synced_at)).toISOString(),
    overwrite: Boolean(row.overwrite),
    relayId: row.relay_id,
    repository: row.repository,
    repositoryId: Number(row.repository_id),
    resourceId: row.resource_id,
    resourceKind: row.resource_kind,
    sourcePath: row.source_path,
    status: row.status,
    targetPath: row.target_path,
  }
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  return Option.getOrNull(decodeJsonString(value))
}

function stringArray(value: unknown): Array<string> {
  return Option.match(decodeStringArray(decodeJson(value)), {
    onNone: () => [],
    onSome: (patterns) => [...patterns],
  })
}

function syncedFiles(value: unknown): Record<string, GitHubSyncedFile> {
  return Option.match(decodeSyncedFiles(decodeJson(value)), {
    onNone: () => ({}),
    onSome: (files) =>
      Object.fromEntries(
        Object.entries(files).map(([path, file]) => [
          path,
          typeof file === "string" ? { blob: file, modifiedAt: null } : file,
        ])
      ),
  })
}
