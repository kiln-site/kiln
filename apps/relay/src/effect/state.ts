import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer, Result, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type {
  BackupTaskInput,
  BackupTaskPhase,
  BackupTaskResult,
  RelayBackupTask,
  RelayDesiredState,
  RelayCreateInstance,
  RelayInstance,
  RelayInstanceRecovery,
  RelayInstancePendingPrimaryPort,
  RelayInstancePortProtocol,
  RelayInstanceWebRoute,
} from "@workspace/contracts"
import {
  BACKUP_EXPORT_TTL_MIN_MS,
  backupTargetSchema,
  backupTaskInputSchema,
  backupTaskResultSchema,
  omitBackupSecrets,
  relayBackupTaskSchema,
  relayCreateInstanceSchema,
  relayInstanceSchema,
  resticSnapshotIdSchema,
} from "@workspace/contracts"

import { RelayStateError } from "./errors.js"

export type RelayClientRole = "custom" | "full_access" | "read_only"

export interface RelayClientGrant {
  readonly actions: ReadonlyArray<string>
  readonly id: string
  readonly name: string
  readonly origins: ReadonlyArray<string>
  readonly publicKey: string
  readonly role: RelayClientRole
  readonly sourceCidrs: ReadonlyArray<string>
}

export interface RelayClientRecord extends RelayClientGrant {
  readonly createdAt: number
  readonly invitationId: string
  readonly lastAddress: string | null
  readonly lastSeenAt: number | null
}

export interface RelayInvitationInput {
  readonly actions: ReadonlyArray<string>
  readonly createdAt: number
  readonly expiresAt: number
  readonly id: string
  readonly role: RelayClientRole
  readonly tokenHash: string
}

export interface RelayInvitation {
  readonly actions: ReadonlyArray<string>
  readonly createdAt: number
  readonly expiresAt: number
  readonly id: string
  readonly role: RelayClientRole
  readonly tokenHash: string
}

export interface PairRelayClientInput extends RelayClientGrant {
  readonly invitationId: string
  readonly pairedAt: number
}

export interface RelayAuditInput {
  readonly clientId: string | null
  readonly details: Readonly<Record<string, unknown>>
  readonly event: string
  readonly id: string
  readonly occurredAt: number
  readonly requestId: string | null
}

export interface RelayAuditRecord extends RelayAuditInput {}

export interface RelayAuditQuery {
  readonly from?: number
  readonly instanceIds?: ReadonlyArray<string>
  readonly limit: number
  readonly to?: number
}

export interface RelayStoredWebRoute extends RelayInstanceWebRoute {
  readonly instanceId: string
}

export interface RelayStoredInstanceName {
  readonly instanceId: string
  readonly name: string
}

export interface RelayStoredPendingPrimaryPort extends RelayInstancePendingPrimaryPort {
  readonly instanceId: string
}

export type RelayProvisioningJobStatus =
  | "awaiting_claim"
  | "queued"
  | "running"
  | "failed"

export interface RelayProvisioningJob {
  readonly attempt: number
  readonly createdAt: number
  readonly error: string | null
  readonly idempotencyKey: string
  readonly input: RelayCreateInstance
  readonly instanceId: string
  readonly placeholder: RelayInstance
  readonly status: RelayProvisioningJobStatus
  readonly updatedAt: number
}

export type RelayRuntimeRecoveryPhase =
  | "idle"
  | "pending"
  | "restarting"
  | "monitoring"
  | "failed"

export interface RelayRuntimeRecoveryRecord {
  readonly attempts: number
  readonly desiredState: RelayDesiredState
  readonly instanceId: string
  readonly lastExitAt: number | null
  readonly lastExitCode: number | null
  readonly lastOomKilled: boolean
  readonly lastReason: RelayInstanceRecovery["reason"] | null
  readonly lastRuntimeMs: number | null
  readonly lastStartedAt: string | null
  readonly nextAttemptAt: number | null
  readonly phase: RelayRuntimeRecoveryPhase
  readonly stopPending: boolean
  readonly updatedAt: number
}

const RelayClientRoleSchema = Schema.Literals([
  "custom",
  "full_access",
  "read_only",
])

const RelayClientRowSchema = Schema.Struct({
  actionsJson: Schema.String,
  createdAt: Schema.Number,
  id: Schema.String,
  invitationId: Schema.String,
  lastAddress: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.Number),
  name: Schema.String,
  originsJson: Schema.String,
  publicKey: Schema.String,
  role: RelayClientRoleSchema,
  sourceCidrsJson: Schema.String,
})

const RelayInvitationRowSchema = Schema.Struct({
  actionsJson: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  id: Schema.String,
  role: RelayClientRoleSchema,
  tokenHash: Schema.String,
})

const StringArraySchema = Schema.Array(Schema.String)

const RelayAuditDetailsSchema = Schema.Record(Schema.String, Schema.Unknown)

const RelayAuditRowSchema = Schema.Struct({
  clientId: Schema.NullOr(Schema.String),
  detailsJson: Schema.String,
  event: Schema.String,
  id: Schema.String,
  occurredAt: Schema.Number,
  requestId: Schema.NullOr(Schema.String),
})

const RelayWebRouteRowSchema = Schema.Struct({
  hostname: Schema.String,
  id: Schema.String,
  instanceId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  stripPrefix: Schema.Number,
  targetPort: Schema.Number,
})

const RelayInstancePortProtocolSchema = Schema.Literals(["tcp", "udp", "both"])

const RelayPendingPrimaryPortRowSchema = Schema.Struct({
  instanceId: Schema.String,
  internalPort: Schema.Number,
  protocol: RelayInstancePortProtocolSchema,
})

const RelayDesiredStateSchema = Schema.Literals(["stopped", "running"])
const RelayRuntimeRecoveryPhaseSchema = Schema.Literals([
  "idle",
  "pending",
  "restarting",
  "monitoring",
  "failed",
])
const RelayRuntimeRecoveryReasonSchema = Schema.Literals([
  "clean_exit",
  "process_exit",
  "out_of_memory",
  "start_failed",
])
const RelayRuntimeRecoveryRowSchema = Schema.Struct({
  attempts: Schema.Number,
  desiredState: RelayDesiredStateSchema,
  instanceId: Schema.String,
  lastExitAt: Schema.NullOr(Schema.Number),
  lastExitCode: Schema.NullOr(Schema.Number),
  lastOomKilled: Schema.Number,
  lastReason: Schema.NullOr(RelayRuntimeRecoveryReasonSchema),
  lastRuntimeMs: Schema.NullOr(Schema.Number),
  lastStartedAt: Schema.NullOr(Schema.String),
  nextAttemptAt: Schema.NullOr(Schema.Number),
  phase: RelayRuntimeRecoveryPhaseSchema,
  stopPending: Schema.Number,
  updatedAt: Schema.Number,
})

const RelayBackupTaskKindSchema = Schema.Literals([
  "create",
  "restore",
  "delete",
  "export",
  "prune",
])
const RelayBackupTaskStatusSchema = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])
const RelayBackupTaskPhaseSchema = Schema.Literals([
  "preparing",
  "collecting",
  "archiving",
  "dumping",
  "uploading",
  "finalizing",
])
const RelayBackupTaskRowSchema = Schema.Struct({
  backupId: Schema.String,
  bytesCompleted: Schema.Number,
  bytesTotal: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  currentArtifactId: Schema.NullOr(Schema.String),
  currentPath: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.Number),
  inputRefreshRequired: Schema.Number,
  inputJson: Schema.String,
  kind: RelayBackupTaskKindSchema,
  phase: Schema.NullOr(RelayBackupTaskPhaseSchema),
  resultJson: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  status: RelayBackupTaskStatusSchema,
  taskId: Schema.String,
  updatedAt: Schema.Number,
})

const RelayProvisioningJobStatusSchema = Schema.Literals([
  "awaiting_claim",
  "queued",
  "running",
  "failed",
])
const RelayProvisioningJobRowSchema = Schema.Struct({
  attempt: Schema.Number,
  createdAt: Schema.Number,
  error: Schema.NullOr(Schema.String),
  idempotencyKey: Schema.String,
  inputJson: Schema.String,
  instanceId: Schema.String,
  placeholderJson: Schema.String,
  status: RelayProvisioningJobStatusSchema,
  updatedAt: Schema.Number,
})

export class RelayStateStore extends Context.Service<
  RelayStateStore,
  {
    readonly appendAudit: (
      input: RelayAuditInput
    ) => Effect.Effect<void, RelayStateError>
    readonly createInvitation: (
      input: RelayInvitationInput
    ) => Effect.Effect<void, RelayStateError>
    readonly findActiveInvitation: (
      invitationId: string,
      now: number
    ) => Effect.Effect<RelayInvitation | null, RelayStateError>
    readonly findInvitationById: (
      invitationId: string
    ) => Effect.Effect<RelayInvitation | null, RelayStateError>
    readonly findClientByPublicKey: (
      publicKey: string
    ) => Effect.Effect<RelayClientRecord | null, RelayStateError>
    readonly findClientById: (
      clientId: string
    ) => Effect.Effect<RelayClientRecord | null, RelayStateError>
    readonly getMetadata: (
      key: string
    ) => Effect.Effect<string | null, RelayStateError>
    readonly enqueueBackupTask: (
      input: BackupTaskInput,
      now: number
    ) => Effect.Effect<RelayBackupTask, RelayStateError>
    readonly claimNextBackupTask: (
      now: number
    ) => Effect.Effect<RelayBackupTask | null, RelayStateError>
    readonly getBackupTask: (
      taskId: string
    ) => Effect.Effect<RelayBackupTask | null, RelayStateError>
    readonly listBackupTasks: (
      updatedAfter?: number
    ) => Effect.Effect<ReadonlyArray<RelayBackupTask>, RelayStateError>
    readonly updateBackupTaskProgress: (
      taskId: string,
      bytesCompleted: number,
      bytesTotal: number | null,
      phase: BackupTaskPhase,
      currentPath: string | null,
      currentArtifactId: string | null,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly updateBackupTaskOperationProgress: (
      taskId: string,
      currentArtifactId: string | null,
      result: BackupTaskResult,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly cancelBackupTask: (
      taskId: string,
      now: number,
      reason?: string
    ) => Effect.Effect<boolean, RelayStateError>
    readonly completeBackupTask: (
      taskId: string,
      result: BackupTaskResult,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly failBackupTask: (
      taskId: string,
      error: string,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly requeueInterruptedBackupTasks: (
      now: number
    ) => Effect.Effect<number, RelayStateError>
    readonly enqueueProvisioningJob: (
      input: {
        readonly idempotencyKey: string
        readonly instanceId: string
        readonly input: RelayCreateInstance
        readonly placeholder: RelayInstance
      },
      now: number
    ) => Effect.Effect<RelayProvisioningJob, RelayStateError>
    readonly claimProvisioningJob: (
      instanceId: string,
      now: number
    ) => Effect.Effect<RelayProvisioningJob | null, RelayStateError>
    readonly claimNextProvisioningJob: (
      now: number
    ) => Effect.Effect<RelayProvisioningJob | null, RelayStateError>
    readonly cancelProvisioningJob: (
      instanceId: string
    ) => Effect.Effect<boolean, RelayStateError>
    readonly failProvisioningJob: (
      instanceId: string,
      error: string,
      placeholder: RelayInstance,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly completeProvisioningJob: (
      instanceId: string
    ) => Effect.Effect<boolean, RelayStateError>
    readonly getProvisioningJob: (
      instanceId: string
    ) => Effect.Effect<RelayProvisioningJob | null, RelayStateError>
    readonly listProvisioningJobs: () => Effect.Effect<
      ReadonlyArray<RelayProvisioningJob>,
      RelayStateError
    >
    readonly updateProvisioningJobPlaceholder: (
      instanceId: string,
      placeholder: RelayInstance,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly requeueInterruptedProvisioningJobs: (
      now: number
    ) => Effect.Effect<number, RelayStateError>
    readonly listClients: () => Effect.Effect<
      ReadonlyArray<RelayClientRecord>,
      RelayStateError
    >
    readonly listAudits: (
      query: RelayAuditQuery
    ) => Effect.Effect<ReadonlyArray<RelayAuditRecord>, RelayStateError>
    readonly listInvitations: (
      now: number
    ) => Effect.Effect<ReadonlyArray<RelayInvitation>, RelayStateError>
    readonly listInstanceNames: () => Effect.Effect<
      ReadonlyArray<RelayStoredInstanceName>,
      RelayStateError
    >
    readonly getRuntimeRecovery: (
      instanceId: string
    ) => Effect.Effect<RelayRuntimeRecoveryRecord | null, RelayStateError>
    readonly listRuntimeRecoveries: () => Effect.Effect<
      ReadonlyArray<RelayRuntimeRecoveryRecord>,
      RelayStateError
    >
    readonly getPendingPrimaryPort: (
      instanceId: string
    ) => Effect.Effect<RelayStoredPendingPrimaryPort | null, RelayStateError>
    readonly listPendingPrimaryPorts: () => Effect.Effect<
      ReadonlyArray<RelayStoredPendingPrimaryPort>,
      RelayStateError
    >
    readonly listInstanceRoutes: (
      instanceId: string
    ) => Effect.Effect<ReadonlyArray<RelayInstanceWebRoute>, RelayStateError>
    readonly listWebRoutes: () => Effect.Effect<
      ReadonlyArray<RelayStoredWebRoute>,
      RelayStateError
    >
    readonly pairClient: (
      input: PairRelayClientInput
    ) => Effect.Effect<void, RelayStateError>
    readonly revokeClient: (
      clientId: string,
      revokedAt: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly revokeInvitation: (
      invitationId: string,
      revokedAt: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly setMetadata: (
      key: string,
      value: string
    ) => Effect.Effect<void, RelayStateError>
    readonly setInstanceName: (
      instanceId: string,
      name: string
    ) => Effect.Effect<void, RelayStateError>
    readonly setRuntimeRecovery: (
      recovery: RelayRuntimeRecoveryRecord
    ) => Effect.Effect<void, RelayStateError>
    readonly deleteRuntimeRecovery: (
      instanceId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly deleteInstanceName: (
      instanceId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly deletePendingPrimaryPort: (
      instanceId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly setPendingPrimaryPort: (
      instanceId: string,
      port: {
        readonly internalPort: number
        readonly protocol: RelayInstancePortProtocol
      }
    ) => Effect.Effect<void, RelayStateError>
    readonly replaceInstanceRoutes: (
      instanceId: string,
      routes: ReadonlyArray<RelayInstanceWebRoute>
    ) => Effect.Effect<void, RelayStateError>
    readonly touchClient: (
      clientId: string,
      seenAt: number,
      address: string | null
    ) => Effect.Effect<void, RelayStateError>
    readonly updateClient: (input: {
      readonly actions: ReadonlyArray<string>
      readonly clientId: string
      readonly name: string
      readonly role: RelayClientRole
      readonly sourceCidrs: ReadonlyArray<string>
    }) => Effect.Effect<boolean, RelayStateError>
  }
>()("kiln/RelayStateStore") {}

const migrations = SqliteMigrator.fromRecord({
  "1_initial_schema": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT
    `
    yield* sql`
      CREATE TABLE relay_clients (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('full_access', 'read_only', 'custom')),
        actions_json TEXT NOT NULL,
        origins_json TEXT NOT NULL,
        source_cidrs_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        last_address TEXT,
        invitation_id TEXT NOT NULL,
        revoked_reason TEXT,
        revoked_at INTEGER
      ) STRICT
    `
    yield* sql`
      CREATE TABLE relay_invitations (
        id TEXT PRIMARY KEY NOT NULL,
        token_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('full_access', 'read_only', 'custom')),
        actions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        revoked_at INTEGER
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_invitations_active
      ON relay_invitations (token_hash, expires_at)
      WHERE consumed_at IS NULL
    `
    yield* sql`
      CREATE TABLE relay_audit (
        id TEXT PRIMARY KEY NOT NULL,
        event TEXT NOT NULL,
        client_id TEXT,
        request_id TEXT,
        details_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_audit_occurred_at
      ON relay_audit (occurred_at DESC)
    `
    yield* sql`
      CREATE TABLE relay_web_routes (
        id TEXT PRIMARY KEY NOT NULL,
        instance_id TEXT NOT NULL,
        hostname TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        strip_prefix INTEGER NOT NULL CHECK (strip_prefix IN (0, 1)),
        target_port INTEGER NOT NULL CHECK (target_port BETWEEN 1 AND 65535),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (hostname, path)
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_web_routes_instance
      ON relay_web_routes (instance_id)
    `
    // Display names are labels, not identifiers. Multiple servers may
    // intentionally use the same name.
    yield* sql`
      CREATE TABLE relay_instance_names (
        instance_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `
  }),
  "2_pending_primary_ports": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_pending_primary_ports (
        instance_id TEXT PRIMARY KEY NOT NULL,
        internal_port INTEGER NOT NULL
          CHECK (internal_port BETWEEN 1 AND 65535),
        protocol TEXT NOT NULL CHECK (protocol IN ('tcp', 'udp', 'both')),
        updated_at INTEGER NOT NULL
      ) STRICT
    `
  }),
  "3_web_route_names": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      ALTER TABLE relay_web_routes
      ADD COLUMN name TEXT NOT NULL DEFAULT 'Web Route'
    `
    yield* sql`
      UPDATE relay_web_routes
      SET name = substr(hostname, 1, 32)
    `
  }),
  "4_runtime_recovery": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_runtime_recovery (
        instance_id TEXT PRIMARY KEY NOT NULL,
        desired_state TEXT NOT NULL
          CHECK (desired_state IN ('stopped', 'running')),
        phase TEXT NOT NULL
          CHECK (phase IN ('idle', 'pending', 'restarting', 'monitoring', 'failed')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        next_attempt_at INTEGER,
        last_started_at TEXT,
        last_exit_code INTEGER,
        last_exit_at INTEGER,
        last_oom_killed INTEGER NOT NULL
          CHECK (last_oom_killed IN (0, 1)),
        last_reason TEXT
          CHECK (last_reason IS NULL OR last_reason IN ('clean_exit', 'process_exit', 'out_of_memory', 'start_failed')),
        last_runtime_ms INTEGER CHECK (last_runtime_ms IS NULL OR last_runtime_ms >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT
    `
  }),
  "5_runtime_recovery_stop_pending": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      ALTER TABLE relay_runtime_recovery
      ADD COLUMN stop_pending INTEGER NOT NULL DEFAULT 0
        CHECK (stop_pending IN (0, 1))
    `
  }),
  "6_backup_tasks": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_backup_tasks (
        task_id TEXT PRIMARY KEY NOT NULL,
        backup_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('create', 'restore', 'delete')),
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        input_json TEXT NOT NULL,
        result_json TEXT,
        bytes_completed INTEGER NOT NULL DEFAULT 0
          CHECK (bytes_completed >= 0),
        bytes_total INTEGER CHECK (bytes_total IS NULL OR bytes_total >= 0),
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_backup_tasks_queue
      ON relay_backup_tasks (status, created_at, task_id)
    `
    yield* sql`
      CREATE INDEX relay_backup_tasks_updated
      ON relay_backup_tasks (updated_at, task_id)
    `
  }),
  "7_backup_task_input_refresh": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      ALTER TABLE relay_backup_tasks
      ADD COLUMN input_refresh_required INTEGER NOT NULL DEFAULT 0
        CHECK (input_refresh_required IN (0, 1))
    `
  }),
  "8_backup_task_progress_context": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      ALTER TABLE relay_backup_tasks
      ADD COLUMN phase TEXT
        CHECK (phase IS NULL OR phase IN (
          'preparing', 'collecting', 'archiving', 'dumping', 'uploading',
          'finalizing'
        ))
    `
    yield* sql`
      ALTER TABLE relay_backup_tasks
      ADD COLUMN current_path TEXT
    `
  }),
  "9_backup_task_current_artifact": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      ALTER TABLE relay_backup_tasks
      ADD COLUMN current_artifact_id TEXT
    `
  }),
  "10_backup_task_kinds_export_prune": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_backup_tasks_next (
        task_id TEXT PRIMARY KEY NOT NULL,
        backup_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('create', 'restore', 'delete', 'export', 'prune')),
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        input_json TEXT NOT NULL,
        result_json TEXT,
        bytes_completed INTEGER NOT NULL DEFAULT 0
          CHECK (bytes_completed >= 0),
        bytes_total INTEGER CHECK (bytes_total IS NULL OR bytes_total >= 0),
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        input_refresh_required INTEGER NOT NULL DEFAULT 0
          CHECK (input_refresh_required IN (0, 1)),
        phase TEXT
          CHECK (phase IS NULL OR phase IN (
            'preparing', 'collecting', 'archiving', 'dumping', 'uploading',
            'finalizing'
          )),
        current_path TEXT,
        current_artifact_id TEXT
      ) STRICT
    `
    yield* sql`
      INSERT INTO relay_backup_tasks_next (
        task_id, backup_id, kind, status, input_json, result_json,
        bytes_completed, bytes_total, error, created_at, started_at,
        finished_at, updated_at, input_refresh_required, phase, current_path,
        current_artifact_id
      )
      SELECT
        task_id, backup_id, kind, status, input_json, result_json,
        bytes_completed, bytes_total, error, created_at, started_at,
        finished_at, updated_at, input_refresh_required, phase, current_path,
        current_artifact_id
      FROM relay_backup_tasks
    `
    yield* sql`DROP TABLE relay_backup_tasks`
    yield* sql`
      ALTER TABLE relay_backup_tasks_next RENAME TO relay_backup_tasks
    `
    yield* sql`
      CREATE INDEX relay_backup_tasks_queue
      ON relay_backup_tasks (status, created_at, task_id)
    `
    yield* sql`
      CREATE INDEX relay_backup_tasks_updated
      ON relay_backup_tasks (updated_at, task_id)
    `
  }),
  "11_instance_provisioning_jobs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_instance_provisioning_jobs (
        instance_id TEXT PRIMARY KEY NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('awaiting_claim', 'queued', 'running', 'failed')),
        input_json TEXT NOT NULL,
        placeholder_json TEXT NOT NULL,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_instance_provisioning_queue
      ON relay_instance_provisioning_jobs (status, created_at, instance_id)
    `
  }),
})

export function scrubBackupTaskInputJson(inputJson: string): string {
  return Result.getOrElse(
    Result.try(() => {
      const parsed = JSON.parse(inputJson) as unknown
      return JSON.stringify(omitBackupSecrets(parsed))
    }),
    () => "{}"
  )
}

const makeRelayStateStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* SqliteMigrator.run({ loader: migrations })

  const run = <T>(operation: string, effect: Effect.Effect<T, unknown>) =>
    effect.pipe(
      Effect.mapError((cause) => RelayStateError.make({ operation, cause })),
      Effect.withSpan(`relay.state.${operation}`)
    )

  const decodeClientRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayClientRowSchema)
  )
  const decodeInvitationRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayInvitationRowSchema)
  )
  const decodeWebRouteRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayWebRouteRowSchema)
  )
  const decodePendingPrimaryPortRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayPendingPrimaryPortRowSchema)
  )
  const decodeRuntimeRecoveryRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayRuntimeRecoveryRowSchema)
  )
  const decodeBackupTaskRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayBackupTaskRowSchema)
  )
  const decodeProvisioningJobRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayProvisioningJobRowSchema)
  )

  const pendingPrimaryPorts = Effect.fn("RelayStateStore.pendingPrimaryPorts")(
    function* (instanceId?: string) {
      const rows = instanceId
        ? yield* sql<Record<string, unknown>>`
          SELECT
            instance_id AS instanceId,
            internal_port AS internalPort,
            protocol
          FROM relay_pending_primary_ports
          WHERE instance_id = ${instanceId}
          LIMIT 1
        `
        : yield* sql<Record<string, unknown>>`
          SELECT
            instance_id AS instanceId,
            internal_port AS internalPort,
            protocol
          FROM relay_pending_primary_ports
          ORDER BY instance_id ASC
        `
      const decoded = yield* decodePendingPrimaryPortRows(rows)
      return decoded.map(
        (row) =>
          ({
            id: "primary",
            instanceId: row.instanceId,
            internalPort: row.internalPort,
            name: "Default Server",
            protocol: row.protocol,
          }) satisfies RelayStoredPendingPrimaryPort
      )
    }
  )

  const runtimeRecoveries = Effect.fn("RelayStateStore.runtimeRecoveries")(
    function* (instanceId?: string) {
      const rows = instanceId
        ? yield* sql<Record<string, unknown>>`
            SELECT
              instance_id AS instanceId,
              desired_state AS desiredState,
              phase,
              attempts,
              next_attempt_at AS nextAttemptAt,
              last_started_at AS lastStartedAt,
              last_exit_code AS lastExitCode,
              last_exit_at AS lastExitAt,
              last_oom_killed AS lastOomKilled,
              last_reason AS lastReason,
              last_runtime_ms AS lastRuntimeMs,
              stop_pending AS stopPending,
              updated_at AS updatedAt
            FROM relay_runtime_recovery
            WHERE instance_id = ${instanceId}
            LIMIT 1
          `
        : yield* sql<Record<string, unknown>>`
            SELECT
              instance_id AS instanceId,
              desired_state AS desiredState,
              phase,
              attempts,
              next_attempt_at AS nextAttemptAt,
              last_started_at AS lastStartedAt,
              last_exit_code AS lastExitCode,
              last_exit_at AS lastExitAt,
              last_oom_killed AS lastOomKilled,
              last_reason AS lastReason,
              last_runtime_ms AS lastRuntimeMs,
              stop_pending AS stopPending,
              updated_at AS updatedAt
            FROM relay_runtime_recovery
            ORDER BY instance_id ASC
          `
      const decoded = yield* decodeRuntimeRecoveryRows(rows)
      return decoded.map(
        (row) =>
          ({
            ...row,
            lastOomKilled: row.lastOomKilled === 1,
            stopPending: row.stopPending === 1,
          }) satisfies RelayRuntimeRecoveryRecord
      )
    }
  )

  const backupTaskFromRow = Effect.fn("RelayStateStore.backupTaskFromRow")(
    function* (row: typeof RelayBackupTaskRowSchema.Type) {
      const input = yield* decodeBackupTaskInput(row.inputJson)
      const result = row.resultJson
        ? yield* decodeBackupTaskResult(row.resultJson)
        : null
      return {
        backupId: row.backupId,
        bytesCompleted: row.bytesCompleted,
        bytesTotal: row.bytesTotal,
        createdAt: row.createdAt,
        currentArtifactId: row.currentArtifactId,
        currentPath: row.currentPath,
        error: row.error,
        finishedAt: row.finishedAt,
        input,
        inputRefreshRequired: row.inputRefreshRequired === 1,
        kind: row.kind,
        phase: row.phase,
        result,
        startedAt: row.startedAt,
        status: row.status,
        taskId: row.taskId,
        updatedAt: row.updatedAt,
      } satisfies RelayBackupTask
    }
  )

  const backupTaskRows = Effect.fn("RelayStateStore.backupTaskRows")(function* (
    filter:
      | { readonly taskId: string }
      | { readonly updatedAfter?: number } = {}
  ) {
    return "taskId" in filter
      ? yield* sql<Record<string, unknown>>`
          SELECT
            task_id AS taskId,
            backup_id AS backupId,
            kind,
            status,
            input_json AS inputJson,
            input_refresh_required AS inputRefreshRequired,
            result_json AS resultJson,
            bytes_completed AS bytesCompleted,
            bytes_total AS bytesTotal,
            phase,
            current_artifact_id AS currentArtifactId,
            current_path AS currentPath,
            error,
            created_at AS createdAt,
            started_at AS startedAt,
            finished_at AS finishedAt,
            updated_at AS updatedAt
          FROM relay_backup_tasks
          WHERE task_id = ${filter.taskId}
          LIMIT 1
        `
      : filter.updatedAfter === undefined
        ? yield* sql<Record<string, unknown>>`
            SELECT
              task_id AS taskId,
              backup_id AS backupId,
              kind,
              status,
              input_json AS inputJson,
              input_refresh_required AS inputRefreshRequired,
              result_json AS resultJson,
              bytes_completed AS bytesCompleted,
              bytes_total AS bytesTotal,
              phase,
              current_artifact_id AS currentArtifactId,
              current_path AS currentPath,
              error,
              created_at AS createdAt,
              started_at AS startedAt,
              finished_at AS finishedAt,
              updated_at AS updatedAt
            FROM relay_backup_tasks
            ORDER BY updated_at ASC, task_id ASC
          `
        : yield* sql<Record<string, unknown>>`
            SELECT
              task_id AS taskId,
              backup_id AS backupId,
              kind,
              status,
              input_json AS inputJson,
              input_refresh_required AS inputRefreshRequired,
              result_json AS resultJson,
              bytes_completed AS bytesCompleted,
              bytes_total AS bytesTotal,
              phase,
              current_artifact_id AS currentArtifactId,
              current_path AS currentPath,
              error,
              created_at AS createdAt,
              started_at AS startedAt,
              finished_at AS finishedAt,
              updated_at AS updatedAt
            FROM relay_backup_tasks
            WHERE updated_at > ${filter.updatedAfter}
            ORDER BY updated_at ASC, task_id ASC
          `
  })

  const backupTasks = Effect.fn("RelayStateStore.backupTasks")(function* (
    filter:
      | { readonly taskId: string }
      | { readonly updatedAfter?: number } = {}
  ) {
    const rows = yield* backupTaskRows(filter)
    const decoded = yield* decodeBackupTaskRows(rows)
    return yield* Effect.forEach(decoded, backupTaskFromRow)
  })

  const provisioningJobs = Effect.fn("RelayStateStore.provisioningJobs")(
    function* (
      filter:
        | { readonly idempotencyKey: string }
        | { readonly instanceId: string }
        | undefined
    ) {
      const rows = filter
        ? "instanceId" in filter
          ? yield* sql<Record<string, unknown>>`
              SELECT instance_id AS instanceId,
                     idempotency_key AS idempotencyKey,
                     status,
                     input_json AS inputJson,
                     placeholder_json AS placeholderJson,
                     error,
                     attempt,
                     created_at AS createdAt,
                     updated_at AS updatedAt
              FROM relay_instance_provisioning_jobs
              WHERE instance_id = ${filter.instanceId}
              LIMIT 1
            `
          : yield* sql<Record<string, unknown>>`
              SELECT instance_id AS instanceId,
                     idempotency_key AS idempotencyKey,
                     status,
                     input_json AS inputJson,
                     placeholder_json AS placeholderJson,
                     error,
                     attempt,
                     created_at AS createdAt,
                     updated_at AS updatedAt
              FROM relay_instance_provisioning_jobs
              WHERE idempotency_key = ${filter.idempotencyKey}
              LIMIT 1
            `
        : yield* sql<Record<string, unknown>>`
            SELECT instance_id AS instanceId,
                   idempotency_key AS idempotencyKey,
                   status,
                   input_json AS inputJson,
                   placeholder_json AS placeholderJson,
                   error,
                   attempt,
                   created_at AS createdAt,
                   updated_at AS updatedAt
            FROM relay_instance_provisioning_jobs
            ORDER BY created_at ASC, instance_id ASC
          `
      const decoded = yield* decodeProvisioningJobRows(rows)
      return yield* Effect.forEach(decoded, (row) =>
        Effect.try({
          try: () =>
            ({
              attempt: row.attempt,
              createdAt: row.createdAt,
              error: row.error,
              idempotencyKey: row.idempotencyKey,
              input: relayCreateInstanceSchema.parse(JSON.parse(row.inputJson)),
              instanceId: row.instanceId,
              placeholder: relayInstanceSchema.parse(
                JSON.parse(row.placeholderJson)
              ),
              status: row.status,
              updatedAt: row.updatedAt,
            }) satisfies RelayProvisioningJob,
          catch: (cause) => cause,
        })
      )
    }
  )

  const warnedUnparseableTaskIds = new Set<string>()
  const pruneSupersededExportTasks = () => sql`
    DELETE FROM relay_backup_tasks
    WHERE kind = 'export'
      AND status IN ('succeeded', 'failed', 'cancelled')
      AND EXISTS (
        SELECT 1
        FROM relay_backup_tasks AS newer
        WHERE newer.kind = 'export'
          AND newer.backup_id = relay_backup_tasks.backup_id
          AND (
            newer.updated_at > relay_backup_tasks.updated_at
            OR (
              newer.updated_at = relay_backup_tasks.updated_at
              AND newer.task_id > relay_backup_tasks.task_id
            )
          )
      )
  `

  const listBackupTasksLenient = Effect.fn(
    "RelayStateStore.listBackupTasksLenient"
  )(function* (updatedAfter?: number) {
    yield* pruneSupersededExportTasks()
    const rows = yield* backupTaskRows({ updatedAfter })
    const tasks: RelayBackupTask[] = []
    for (const row of rows) {
      const decodedRow = yield* Schema.decodeUnknownEffect(
        RelayBackupTaskRowSchema
      )(row).pipe(Effect.result)
      if (Result.isFailure(decodedRow)) {
        const taskId = typeof row.taskId === "string" ? row.taskId : undefined
        if (taskId && !warnedUnparseableTaskIds.has(taskId)) {
          warnedUnparseableTaskIds.add(taskId)
          yield* Effect.logWarning("Skipped unparseable backup journal row", {
            taskId,
          })
        }
        continue
      }
      const decodedTask = yield* backupTaskFromRow(decodedRow.success).pipe(
        Effect.result
      )
      if (Result.isSuccess(decodedTask)) {
        tasks.push(decodedTask.success)
        continue
      }
      if (!warnedUnparseableTaskIds.has(decodedRow.success.taskId)) {
        warnedUnparseableTaskIds.add(decodedRow.success.taskId)
        yield* Effect.logWarning("Skipped unparseable backup journal row", {
          backupId: decodedRow.success.backupId,
          kind: decodedRow.success.kind,
          status: decodedRow.success.status,
          taskId: decodedRow.success.taskId,
        })
      }
      const fallback = fallbackFailedBackupTask(decodedRow.success)
      if (fallback) tasks.push(fallback)
    }
    return tasks
  })

  const webRoutes = Effect.fn("RelayStateStore.webRoutes")(function* (
    instanceId?: string
  ) {
    const rows = instanceId
      ? yield* sql<Record<string, unknown>>`
          SELECT
            id,
            instance_id AS instanceId,
            hostname,
            name,
            path,
            strip_prefix AS stripPrefix,
            target_port AS targetPort
          FROM relay_web_routes
          WHERE instance_id = ${instanceId}
          ORDER BY created_at ASC
        `
      : yield* sql<Record<string, unknown>>`
          SELECT
            id,
            instance_id AS instanceId,
            hostname,
            name,
            path,
            strip_prefix AS stripPrefix,
            target_port AS targetPort
          FROM relay_web_routes
          ORDER BY created_at ASC
        `
    const decoded = yield* decodeWebRouteRows(rows)
    return decoded.map((row) => ({
      hostname: row.hostname,
      id: row.id,
      instanceId: row.instanceId,
      name: row.name,
      path: row.path || null,
      stripPrefix: row.stripPrefix === 1,
      targetPort: row.targetPort,
    }))
  })

  const clientFromRow = Effect.fn("RelayStateStore.clientFromRow")(function* (
    row: typeof RelayClientRowSchema.Type
  ) {
    const [actions, origins, sourceCidrs] = yield* Effect.all([
      decodeJsonStringArray(row.actionsJson),
      decodeJsonStringArray(row.originsJson),
      decodeJsonStringArray(row.sourceCidrsJson),
    ])
    return {
      actions,
      createdAt: row.createdAt,
      id: row.id,
      invitationId: row.invitationId,
      lastAddress: row.lastAddress,
      lastSeenAt: row.lastSeenAt,
      name: row.name,
      origins,
      publicKey: row.publicKey,
      role: row.role,
      sourceCidrs,
    } satisfies RelayClientRecord
  })

  const findClientByPublicKey = Effect.fn(
    "RelayStateStore.findClientByPublicKey"
  )(function* (publicKey: string) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        id,
        name,
        created_at AS createdAt,
        invitation_id AS invitationId,
        last_address AS lastAddress,
        last_seen_at AS lastSeenAt,
        public_key AS publicKey,
        role,
        actions_json AS actionsJson,
        origins_json AS originsJson,
        source_cidrs_json AS sourceCidrsJson
      FROM relay_clients
      WHERE public_key = ${publicKey} AND revoked_at IS NULL
      LIMIT 1
    `
    const decoded = yield* decodeClientRows(rows)
    return decoded[0] ? yield* clientFromRow(decoded[0]) : null
  })

  const findClientById = Effect.fn("RelayStateStore.findClientById")(function* (
    clientId: string
  ) {
    const rows = yield* sql<Record<string, unknown>>`
        SELECT
          id,
          name,
          created_at AS createdAt,
          invitation_id AS invitationId,
          last_address AS lastAddress,
          last_seen_at AS lastSeenAt,
          public_key AS publicKey,
          role,
          actions_json AS actionsJson,
          origins_json AS originsJson,
          source_cidrs_json AS sourceCidrsJson
        FROM relay_clients
        WHERE id = ${clientId} AND revoked_at IS NULL
        LIMIT 1
      `
    const decoded = yield* decodeClientRows(rows)
    return decoded[0] ? yield* clientFromRow(decoded[0]) : null
  })

  return RelayStateStore.of({
    appendAudit: (input) =>
      run(
        "append_audit",
        sql`
          INSERT INTO relay_audit (
            id, event, client_id, request_id, details_json, occurred_at
          ) VALUES (
            ${input.id},
            ${input.event},
            ${input.clientId},
            ${input.requestId},
            ${JSON.stringify(input.details)},
            ${input.occurredAt}
          )
        `.pipe(Effect.asVoid)
      ),
    createInvitation: (input) =>
      run(
        "create_invitation",
        sql`
          INSERT INTO relay_invitations (
            id, token_hash, role, actions_json, created_at, expires_at
          ) VALUES (
            ${input.id},
            ${input.tokenHash},
            ${input.role},
            ${JSON.stringify(input.actions)},
            ${input.createdAt},
            ${input.expiresAt}
          )
        `.pipe(Effect.asVoid)
      ),
    enqueueBackupTask: (input, now) =>
      run(
        "enqueue_backup_task",
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = (yield* backupTasks({ taskId: input.taskId }))[0]
            if (existing) {
              if (
                existing.backupId !== input.backupId ||
                existing.kind !== input.kind ||
                existing.input.target.kind !== input.target.kind ||
                existing.input.target.id !== input.target.id
              ) {
                return yield* Effect.fail(
                  new Error("Backup task ID already has different input")
                )
              }
              if (existing.inputRefreshRequired) {
                yield* sql`
                  UPDATE relay_backup_tasks
                  SET input_json = ${JSON.stringify(input)},
                      input_refresh_required = 0,
                      error = NULL,
                      phase = NULL,
                      current_artifact_id = NULL,
                      current_path = NULL,
                      updated_at = ${now}
                  WHERE task_id = ${input.taskId}
                    AND status = 'queued'
                    AND input_refresh_required = 1
                `
                return (
                  (yield* backupTasks({ taskId: input.taskId }))[0] ?? existing
                )
              }
              return existing
            }
            yield* sql`
              INSERT INTO relay_backup_tasks (
                task_id,
                backup_id,
                kind,
                status,
                input_json,
                created_at,
                updated_at
              ) VALUES (
                ${input.taskId},
                ${input.backupId},
                ${input.kind},
                'queued',
                ${JSON.stringify(input)},
                ${now},
                ${now}
              )
            `
            if (input.kind === "export") {
              yield* pruneSupersededExportTasks()
            }
            const created = (yield* backupTasks({ taskId: input.taskId }))[0]
            return yield* created
              ? Effect.succeed(created)
              : Effect.fail(new Error("Backup task was not persisted"))
          })
        )
      ),
    claimNextBackupTask: (now) =>
      run(
        "claim_next_backup_task",
        sql.withTransaction(
          Effect.gen(function* () {
            while (true) {
              const rows = yield* sql<{ inputJson: string; taskId: string }>`
                SELECT task_id AS taskId, input_json AS inputJson
                FROM relay_backup_tasks
                WHERE status = 'queued' AND input_refresh_required = 0
                ORDER BY created_at ASC, task_id ASC
                LIMIT 1
              `
              const row = rows[0]
              if (!row) return null
              const decoded = yield* backupTasks({ taskId: row.taskId }).pipe(
                Effect.result
              )
              const task = Result.isSuccess(decoded)
                ? (decoded.success[0] ?? null)
                : null
              if (!task) {
                // A row the current schema cannot decode must not stall the
                // whole queue: fail it terminally and claim the next task.
                yield* sql`
                  UPDATE relay_backup_tasks
                  SET status = 'failed',
                      input_json = ${scrubBackupTaskInputJson(row.inputJson)},
                      result_json = NULL,
                      current_artifact_id = NULL,
                      error = ${UNPARSEABLE_BACKUP_TASK_ERROR},
                      finished_at = ${now},
                      updated_at = ${now}
                  WHERE task_id = ${row.taskId}
                `
                continue
              }
              yield* sql`
                UPDATE relay_backup_tasks
                SET status = 'running',
                    started_at = COALESCE(started_at, ${now}),
                    updated_at = ${now},
                    error = NULL,
                    phase = 'preparing',
                    current_artifact_id = NULL,
                    current_path = NULL,
                    finished_at = NULL
                WHERE task_id = ${row.taskId}
                  AND status = 'queued'
                  AND input_refresh_required = 0
              `
              return (yield* backupTasks({ taskId: row.taskId }))[0] ?? null
            }
          })
        )
      ),
    getBackupTask: (taskId) =>
      run(
        "get_backup_task",
        backupTasks({ taskId }).pipe(Effect.map((tasks) => tasks[0] ?? null))
      ),
    listBackupTasks: (updatedAfter) =>
      run("list_backup_tasks", listBackupTasksLenient(updatedAfter)),
    updateBackupTaskProgress: (
      taskId,
      bytesCompleted,
      bytesTotal,
      phase,
      currentPath,
      currentArtifactId,
      now
    ) =>
      run(
        "update_backup_task_progress",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ taskId: string }>`
              SELECT task_id AS taskId
              FROM relay_backup_tasks
              WHERE task_id = ${taskId} AND status = 'running'
              LIMIT 1
            `
            if (!rows[0]) return false
            yield* sql`
              UPDATE relay_backup_tasks
              SET bytes_completed = ${bytesCompleted},
                  bytes_total = ${bytesTotal},
                  phase = ${phase},
                  current_artifact_id = ${currentArtifactId},
                  current_path = ${currentPath?.slice(0, 2_048) ?? null},
                  updated_at = ${now}
              WHERE task_id = ${taskId} AND status = 'running'
                AND (
                  bytes_completed <> ${bytesCompleted}
                  OR bytes_total IS NOT ${bytesTotal}
                  OR phase IS NOT ${phase}
                  OR current_artifact_id IS NOT ${currentArtifactId}
                  OR current_path IS NOT ${currentPath?.slice(0, 2_048) ?? null}
                )
            `
            return true
          })
        )
      ),
    updateBackupTaskOperationProgress: (
      taskId,
      currentArtifactId,
      result,
      now
    ) =>
      run(
        "update_backup_task_operation_progress",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ taskId: string }>`
              SELECT task_id AS taskId
              FROM relay_backup_tasks
              WHERE task_id = ${taskId} AND kind = 'delete'
                AND status = 'running'
              LIMIT 1
            `
            if (!rows[0]) return false
            const resultJson = JSON.stringify(result)
            yield* sql`
              UPDATE relay_backup_tasks
              SET current_artifact_id = ${currentArtifactId},
                  result_json = ${resultJson},
                  updated_at = ${now}
              WHERE task_id = ${taskId} AND kind = 'delete'
                AND status = 'running'
                AND (
                  current_artifact_id IS NOT ${currentArtifactId}
                  OR result_json IS NOT ${resultJson}
                )
            `
            return true
          })
        )
      ),
    cancelBackupTask: (taskId, now, reason = "Cancelled by user") =>
      run(
        "cancel_backup_task",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ inputJson: string; taskId: string }>`
              SELECT task_id AS taskId, input_json AS inputJson
              FROM relay_backup_tasks
              WHERE task_id = ${taskId}
                AND kind = 'create'
                AND status IN ('queued', 'running')
              LIMIT 1
            `
            if (!rows[0]) return false
            yield* sql`
              UPDATE relay_backup_tasks
              SET status = 'cancelled',
                  input_json = ${scrubBackupTaskInputJson(rows[0].inputJson)},
                  result_json = NULL,
                  current_artifact_id = NULL,
                  error = ${reason.slice(0, 2_048)},
                  finished_at = ${now},
                  updated_at = ${now}
              WHERE task_id = ${taskId}
                AND kind = 'create'
                AND status IN ('queued', 'running')
            `
            return true
          })
        )
      ),
    completeBackupTask: (taskId, result, now) =>
      run(
        "complete_backup_task",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ inputJson: string; taskId: string }>`
              SELECT task_id AS taskId, input_json AS inputJson
              FROM relay_backup_tasks
              WHERE task_id = ${taskId} AND status = 'running'
              LIMIT 1
            `
            if (!rows[0]) return false
            const bytes = "bytes" in result ? result.bytes : 0
            yield* sql`
              UPDATE relay_backup_tasks
              SET status = 'succeeded',
                  input_json = ${scrubBackupTaskInputJson(rows[0].inputJson)},
                  result_json = ${JSON.stringify(result)},
                  bytes_completed = ${bytes},
                  bytes_total = ${bytes},
                  error = NULL,
                  phase = NULL,
                  current_artifact_id = NULL,
                  current_path = NULL,
                  finished_at = ${now},
                  updated_at = ${now}
              WHERE task_id = ${taskId} AND status = 'running'
            `
            yield* pruneSupersededExportTasks()
            return true
          })
        )
      ),
    failBackupTask: (taskId, error, now) =>
      run(
        "fail_backup_task",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ inputJson: string; taskId: string }>`
              SELECT task_id AS taskId, input_json AS inputJson
              FROM relay_backup_tasks
              WHERE task_id = ${taskId}
                AND status IN ('queued', 'running')
              LIMIT 1
            `
            if (!rows[0]) return false
            yield* sql`
              UPDATE relay_backup_tasks
              SET status = 'failed',
                  input_json = ${scrubBackupTaskInputJson(rows[0].inputJson)},
                  result_json = NULL,
                  current_artifact_id = NULL,
                  error = ${error.slice(0, 4_096)},
                  finished_at = ${now},
                  updated_at = ${now}
              WHERE task_id = ${taskId}
                AND status IN ('queued', 'running')
            `
            return true
          })
        )
      ),
    requeueInterruptedBackupTasks: (now) =>
      run(
        "requeue_interrupted_backup_tasks",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ count: number }>`
              SELECT COUNT(*) AS count
              FROM relay_backup_tasks
              WHERE status = 'running'
            `
            const count = rows[0]?.count ?? 0
            if (count === 0) return 0
            yield* sql`
              UPDATE relay_backup_tasks
              SET status = 'queued',
                  input_refresh_required = CASE
                    WHEN (
                      json_extract(input_json, '$.destination.kind') = 's3'
                      AND json_extract(input_json, '$.destination.uploadUrl')
                        IS NOT NULL
                    )
                      OR EXISTS (
                        SELECT 1
                        FROM json_each(input_json, '$.replicas')
                        WHERE json_extract(value, '$.kind') = 's3'
                          AND json_extract(value, '$.uploadUrl') IS NOT NULL
                      )
                    THEN 1
                    ELSE 0
                  END,
                  started_at = NULL,
                  finished_at = NULL,
                  result_json = NULL,
                  bytes_completed = 0,
                  bytes_total = NULL,
                  phase = NULL,
                  current_artifact_id = NULL,
                  current_path = NULL,
                  updated_at = ${now},
                  error = 'Relay restarted before the task completed'
              WHERE status = 'running' AND kind IN ('create', 'delete', 'export', 'prune')
            `
            const restores = yield* sql<{ inputJson: string; taskId: string }>`
              SELECT task_id AS taskId, input_json AS inputJson
              FROM relay_backup_tasks
              WHERE status = 'running' AND kind = 'restore'
            `
            for (const restore of restores) {
              yield* sql`
                UPDATE relay_backup_tasks
                SET status = 'failed',
                    input_json = ${scrubBackupTaskInputJson(restore.inputJson)},
                    current_artifact_id = NULL,
                    updated_at = ${now},
                    finished_at = ${now},
                    error = 'Relay restarted during a non-repeatable task; inspect the target before retrying'
                WHERE task_id = ${restore.taskId} AND status = 'running'
              `
            }
            yield* pruneSupersededExportTasks()
            return count
          })
        )
      ),
    enqueueProvisioningJob: (input, now) =>
      run(
        "enqueue_provisioning_job",
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = (yield* provisioningJobs({
              idempotencyKey: input.idempotencyKey,
            }))[0]
            if (existing) {
              if (
                JSON.stringify(existing.input) !== JSON.stringify(input.input)
              ) {
                return yield* Effect.fail(
                  new Error("Provisioning key already has different input")
                )
              }
              return existing
            }
            yield* sql`
              INSERT INTO relay_instance_provisioning_jobs (
                instance_id, idempotency_key, status, input_json,
                placeholder_json, created_at, updated_at
              ) VALUES (
                ${input.instanceId},
                ${input.idempotencyKey},
                'awaiting_claim',
                ${JSON.stringify(input.input)},
                ${JSON.stringify(input.placeholder)},
                ${now},
                ${now}
              )
            `
            const created = (yield* provisioningJobs({
              instanceId: input.instanceId,
            }))[0]
            return yield* created
              ? Effect.succeed(created)
              : Effect.fail(new Error("Provisioning job was not persisted"))
          })
        )
      ),
    claimProvisioningJob: (instanceId, now) =>
      run(
        "claim_provisioning_job",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE relay_instance_provisioning_jobs
              SET status = 'queued', updated_at = ${now}, error = NULL
              WHERE instance_id = ${instanceId}
                AND status = 'awaiting_claim'
            `
            return (yield* provisioningJobs({ instanceId }))[0] ?? null
          })
        )
      ),
    claimNextProvisioningJob: (now) =>
      run(
        "claim_next_provisioning_job",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ instanceId: string }>`
              UPDATE relay_instance_provisioning_jobs
              SET status = 'running',
                  attempt = attempt + 1,
                  updated_at = ${now},
                  error = NULL
              WHERE instance_id = (
                SELECT instance_id
                FROM relay_instance_provisioning_jobs
                WHERE status = 'queued'
                ORDER BY created_at ASC, instance_id ASC
                LIMIT 1
              )
                AND status = 'queued'
              RETURNING instance_id AS instanceId
            `
            const instanceId = rows[0]?.instanceId
            if (!instanceId) return null
            return (yield* provisioningJobs({ instanceId }))[0] ?? null
          })
        )
      ),
    cancelProvisioningJob: (instanceId) =>
      run(
        "cancel_provisioning_job",
        Effect.gen(function* () {
          const rows = yield* sql<{ instanceId: string }>`
            DELETE FROM relay_instance_provisioning_jobs
            WHERE instance_id = ${instanceId}
              AND status IN ('awaiting_claim', 'queued', 'failed')
            RETURNING instance_id AS instanceId
          `
          return rows.length > 0
        })
      ),
    failProvisioningJob: (instanceId, error, placeholder, now) =>
      run(
        "fail_provisioning_job",
        Effect.gen(function* () {
          const rows = yield* sql<{ instanceId: string }>`
            SELECT instance_id AS instanceId
            FROM relay_instance_provisioning_jobs
            WHERE instance_id = ${instanceId}
              AND status IN ('queued', 'running')
            LIMIT 1
          `
          if (!rows[0]) return false
          yield* sql`
            UPDATE relay_instance_provisioning_jobs
            SET status = 'failed',
                placeholder_json = ${JSON.stringify(placeholder)},
                error = ${error.slice(0, 2_048)},
                updated_at = ${now}
            WHERE instance_id = ${instanceId}
              AND status IN ('queued', 'running')
          `
          return true
        })
      ),
    completeProvisioningJob: (instanceId) =>
      run(
        "complete_provisioning_job",
        Effect.gen(function* () {
          const rows = yield* sql<{ instanceId: string }>`
            SELECT instance_id AS instanceId
            FROM relay_instance_provisioning_jobs
            WHERE instance_id = ${instanceId} AND status = 'running'
            LIMIT 1
          `
          if (!rows[0]) return false
          yield* sql`
            DELETE FROM relay_instance_provisioning_jobs
            WHERE instance_id = ${instanceId} AND status = 'running'
          `
          return true
        })
      ),
    getProvisioningJob: (instanceId) =>
      run(
        "get_provisioning_job",
        provisioningJobs({ instanceId }).pipe(
          Effect.map((jobs) => jobs[0] ?? null)
        )
      ),
    listProvisioningJobs: () =>
      run("list_provisioning_jobs", provisioningJobs(undefined)),
    updateProvisioningJobPlaceholder: (instanceId, placeholder, now) =>
      run(
        "update_provisioning_job_placeholder",
        Effect.gen(function* () {
          const rows = yield* sql<{ instanceId: string }>`
            SELECT instance_id AS instanceId
            FROM relay_instance_provisioning_jobs
            WHERE instance_id = ${instanceId}
              AND status IN ('awaiting_claim', 'queued', 'running')
            LIMIT 1
          `
          if (!rows[0]) return false
          yield* sql`
            UPDATE relay_instance_provisioning_jobs
            SET placeholder_json = ${JSON.stringify(placeholder)},
                updated_at = ${now}
            WHERE instance_id = ${instanceId}
              AND status IN ('awaiting_claim', 'queued', 'running')
          `
          return true
        })
      ),
    requeueInterruptedProvisioningJobs: (now) =>
      run(
        "requeue_interrupted_provisioning_jobs",
        Effect.gen(function* () {
          const rows = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count
            FROM relay_instance_provisioning_jobs
            WHERE status = 'running'
          `
          const count = rows[0]?.count ?? 0
          if (count === 0) return 0
          const error = "Relay restarted before provisioning completed"
          yield* sql`
            UPDATE relay_instance_provisioning_jobs
            SET status = 'failed',
                error = ${error},
                placeholder_json = json_set(
                  placeholder_json,
                  '$.observedState', 'failed',
                  '$.status', 'Provisioning failed',
                  '$.provisioning.failedPhase',
                    CASE json_extract(
                      placeholder_json,
                      '$.provisioning.phase'
                    )
                      WHEN 'preparing' THEN 'preparing'
                      WHEN 'pulling_image' THEN 'pulling_image'
                      WHEN 'creating_container' THEN 'creating_container'
                      WHEN 'finalizing' THEN 'finalizing'
                      ELSE 'preparing'
                    END,
                  '$.provisioning.phase', 'failed',
                  '$.provisioning.error', ${error}
                ),
                updated_at = ${now}
            WHERE status = 'running'
          `
          return count
        })
      ),
    findActiveInvitation: (invitationId, now) =>
      run(
        "find_active_invitation",
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              id,
              role,
              token_hash AS tokenHash,
              actions_json AS actionsJson,
              created_at AS createdAt,
              expires_at AS expiresAt
            FROM relay_invitations
            WHERE id = ${invitationId}
              AND consumed_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > ${now}
            LIMIT 1
          `
          const decoded = yield* decodeInvitationRows(rows)
          const invitation = decoded[0]
          if (!invitation) return null
          return {
            actions: yield* decodeJsonStringArray(invitation.actionsJson),
            createdAt: invitation.createdAt,
            expiresAt: invitation.expiresAt,
            id: invitation.id,
            role: invitation.role,
            tokenHash: invitation.tokenHash,
          } satisfies RelayInvitation
        })
      ),
    findClientByPublicKey: (publicKey) =>
      run("find_client_by_public_key", findClientByPublicKey(publicKey)),
    findClientById: (clientId) =>
      run("find_client_by_id", findClientById(clientId)),
    findInvitationById: (invitationId) =>
      run(
        "find_invitation_by_id",
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              id,
              role,
              token_hash AS tokenHash,
              actions_json AS actionsJson,
              created_at AS createdAt,
              expires_at AS expiresAt
            FROM relay_invitations
            WHERE id = ${invitationId} AND revoked_at IS NULL
            LIMIT 1
          `
          const decoded = yield* decodeInvitationRows(rows)
          const invitation = decoded[0]
          if (!invitation) return null
          return {
            actions: yield* decodeJsonStringArray(invitation.actionsJson),
            createdAt: invitation.createdAt,
            expiresAt: invitation.expiresAt,
            id: invitation.id,
            role: invitation.role,
            tokenHash: invitation.tokenHash,
          } satisfies RelayInvitation
        })
      ),
    getMetadata: (key) =>
      run(
        "get_metadata",
        Effect.gen(function* () {
          const rows = yield* sql<{ value: string }>`
            SELECT value FROM relay_metadata WHERE key = ${key} LIMIT 1
          `
          return rows[0]?.value ?? null
        })
      ),
    getRuntimeRecovery: (instanceId) =>
      run(
        "get_runtime_recovery",
        runtimeRecoveries(instanceId).pipe(
          Effect.map((recoveries) => recoveries[0] ?? null)
        )
      ),
    listClients: () =>
      run(
        "list_clients",
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              id,
              name,
              created_at AS createdAt,
              invitation_id AS invitationId,
              last_address AS lastAddress,
              last_seen_at AS lastSeenAt,
              public_key AS publicKey,
              role,
              actions_json AS actionsJson,
              origins_json AS originsJson,
              source_cidrs_json AS sourceCidrsJson
            FROM relay_clients
            WHERE revoked_at IS NULL
            ORDER BY created_at ASC
          `
          const decoded = yield* decodeClientRows(rows)
          return yield* Effect.forEach(decoded, clientFromRow)
        })
      ),
    listAudits: (query) =>
      run(
        "list_audits",
        Effect.gen(function* () {
          const boundedLimit = Math.min(
            Math.max(Math.trunc(query.limit), 1),
            2_000
          )
          const filters = []
          if (query.from !== undefined) {
            filters.push(sql`occurred_at >= ${query.from}`)
          }
          if (query.to !== undefined) {
            filters.push(sql`occurred_at <= ${query.to}`)
          }
          if (query.instanceIds !== undefined) {
            filters.push(
              sql`json_extract(details_json, '$.instanceId') IN ${sql.in(query.instanceIds)}`
            )
          }
          const where =
            filters.length > 0 ? sql`WHERE ${sql.and(filters)}` : sql``
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              id,
              event,
              client_id AS clientId,
              request_id AS requestId,
              details_json AS detailsJson,
              occurred_at AS occurredAt
            FROM relay_audit
            ${where}
            ORDER BY occurred_at DESC
            LIMIT ${boundedLimit}
          `
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Array(RelayAuditRowSchema)
          )(rows)
          return yield* Effect.forEach(decoded, (row) =>
            decodeAuditDetails(row.detailsJson).pipe(
              Effect.map((details) => ({
                clientId: row.clientId,
                details,
                event: row.event,
                id: row.id,
                occurredAt: row.occurredAt,
                requestId: row.requestId,
              }))
            )
          )
        })
      ),
    listInvitations: (now) =>
      run(
        "list_invitations",
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              id,
              role,
              token_hash AS tokenHash,
              actions_json AS actionsJson,
              created_at AS createdAt,
              expires_at AS expiresAt
            FROM relay_invitations
            WHERE consumed_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > ${now}
            ORDER BY created_at DESC
          `
          const decoded = yield* decodeInvitationRows(rows)
          return yield* Effect.forEach(decoded, (invitation) =>
            decodeJsonStringArray(invitation.actionsJson).pipe(
              Effect.map((actions) => ({
                actions,
                createdAt: invitation.createdAt,
                expiresAt: invitation.expiresAt,
                id: invitation.id,
                role: invitation.role,
                tokenHash: invitation.tokenHash,
              }))
            )
          )
        })
      ),
    listInstanceNames: () =>
      run(
        "list_instance_names",
        sql<RelayStoredInstanceName>`
          SELECT instance_id AS instanceId, name
          FROM relay_instance_names
          ORDER BY instance_id ASC
        `
      ),
    listRuntimeRecoveries: () =>
      run("list_runtime_recoveries", runtimeRecoveries()),
    getPendingPrimaryPort: (instanceId) =>
      run(
        "get_pending_primary_port",
        pendingPrimaryPorts(instanceId).pipe(
          Effect.map((ports) => ports[0] ?? null)
        )
      ),
    listPendingPrimaryPorts: () =>
      run("list_pending_primary_ports", pendingPrimaryPorts()),
    listInstanceRoutes: (instanceId) =>
      run(
        "list_instance_routes",
        webRoutes(instanceId).pipe(
          Effect.map((routes) =>
            routes.map(({ instanceId: _instanceId, ...route }) => route)
          )
        )
      ),
    listWebRoutes: () => run("list_web_routes", webRoutes()),
    pairClient: (input) =>
      run(
        "pair_client",
        sql.withTransaction(
          Effect.gen(function* () {
            const invitation = yield* sql<{ id: string }>`
              SELECT id
              FROM relay_invitations
              WHERE id = ${input.invitationId}
                AND consumed_at IS NULL
                AND revoked_at IS NULL
                AND expires_at > ${input.pairedAt}
              LIMIT 1
            `
            if (!invitation[0]) {
              return yield* Effect.fail(
                new Error("Pairing invitation is expired or already used")
              )
            }
            const existing = yield* sql<{ publicKey: string }>`
              SELECT public_key AS publicKey
              FROM relay_clients
              WHERE id = ${input.id}
              LIMIT 1
            `
            if (existing[0] && existing[0].publicKey !== input.publicKey) {
              return yield* Effect.fail(
                new Error("Relay client identity does not match")
              )
            }
            if (existing[0]) {
              yield* sql`
                UPDATE relay_clients
                SET name = ${input.name},
                    role = ${input.role},
                    actions_json = ${JSON.stringify(input.actions)},
                    origins_json = ${JSON.stringify(input.origins)},
                    source_cidrs_json = ${JSON.stringify(input.sourceCidrs)},
                    last_seen_at = ${input.pairedAt},
                    invitation_id = ${input.invitationId},
                    revoked_reason = NULL,
                    revoked_at = NULL
                WHERE id = ${input.id}
              `
            } else {
              yield* sql`
                INSERT INTO relay_clients (
                  id,
                  name,
                  public_key,
                  role,
                  actions_json,
                  origins_json,
                  source_cidrs_json,
                  created_at,
                  last_seen_at,
                  invitation_id
                ) VALUES (
                  ${input.id},
                  ${input.name},
                  ${input.publicKey},
                  ${input.role},
                  ${JSON.stringify(input.actions)},
                  ${JSON.stringify(input.origins)},
                  ${JSON.stringify(input.sourceCidrs)},
                  ${input.pairedAt},
                  ${input.pairedAt},
                  ${input.invitationId}
                )
              `
            }
            yield* sql`
              UPDATE relay_invitations
              SET consumed_at = ${input.pairedAt}
              WHERE id = ${input.invitationId} AND consumed_at IS NULL
            `
          })
        )
      ),
    revokeClient: (clientId, revokedAt) =>
      run(
        "revoke_client",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ id: string }>`
              SELECT id
              FROM relay_clients
              WHERE id = ${clientId} AND revoked_at IS NULL
              LIMIT 1
            `
            if (!rows[0]) return false
            yield* sql`
              UPDATE relay_clients
              SET revoked_at = ${revokedAt}
              WHERE id = ${clientId} AND revoked_at IS NULL
            `
            return true
          })
        )
      ),
    revokeInvitation: (invitationId, revokedAt) =>
      run(
        "revoke_invitation",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ id: string }>`
              SELECT id
              FROM relay_invitations
              WHERE id = ${invitationId}
                AND consumed_at IS NULL
                AND revoked_at IS NULL
              LIMIT 1
            `
            if (!rows[0]) return false
            yield* sql`
              UPDATE relay_invitations
              SET revoked_at = ${revokedAt}
              WHERE id = ${invitationId}
                AND consumed_at IS NULL
                AND revoked_at IS NULL
            `
            return true
          })
        )
      ),
    setMetadata: (key, value) =>
      run(
        "set_metadata",
        sql`
          INSERT INTO relay_metadata (key, value)
          VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value
        `.pipe(Effect.asVoid)
      ),
    setInstanceName: (instanceId, name) =>
      run(
        "set_instance_name",
        sql`
          INSERT INTO relay_instance_names (instance_id, name, updated_at)
          VALUES (${instanceId}, ${name}, ${Date.now()})
          ON CONFLICT (instance_id) DO UPDATE
          SET name = excluded.name, updated_at = excluded.updated_at
        `.pipe(Effect.asVoid)
      ),
    setRuntimeRecovery: (recovery) =>
      run(
        "set_runtime_recovery",
        sql`
          INSERT INTO relay_runtime_recovery (
            instance_id,
            desired_state,
            phase,
            attempts,
            next_attempt_at,
            last_started_at,
            last_exit_code,
            last_exit_at,
            last_oom_killed,
            last_reason,
            last_runtime_ms,
            stop_pending,
            updated_at
          ) VALUES (
            ${recovery.instanceId},
            ${recovery.desiredState},
            ${recovery.phase},
            ${recovery.attempts},
            ${recovery.nextAttemptAt},
            ${recovery.lastStartedAt},
            ${recovery.lastExitCode},
            ${recovery.lastExitAt},
            ${recovery.lastOomKilled ? 1 : 0},
            ${recovery.lastReason},
            ${recovery.lastRuntimeMs},
            ${recovery.stopPending ? 1 : 0},
            ${recovery.updatedAt}
          )
          ON CONFLICT (instance_id) DO UPDATE SET
            desired_state = excluded.desired_state,
            phase = excluded.phase,
            attempts = excluded.attempts,
            next_attempt_at = excluded.next_attempt_at,
            last_started_at = excluded.last_started_at,
            last_exit_code = excluded.last_exit_code,
            last_exit_at = excluded.last_exit_at,
            last_oom_killed = excluded.last_oom_killed,
            last_reason = excluded.last_reason,
            last_runtime_ms = excluded.last_runtime_ms,
            stop_pending = excluded.stop_pending,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid)
      ),
    deleteInstanceName: (instanceId) =>
      run(
        "delete_instance_name",
        sql`
          DELETE FROM relay_instance_names WHERE instance_id = ${instanceId}
        `.pipe(Effect.asVoid)
      ),
    deleteRuntimeRecovery: (instanceId) =>
      run(
        "delete_runtime_recovery",
        sql`
          DELETE FROM relay_runtime_recovery WHERE instance_id = ${instanceId}
        `.pipe(Effect.asVoid)
      ),
    deletePendingPrimaryPort: (instanceId) =>
      run(
        "delete_pending_primary_port",
        sql`
          DELETE FROM relay_pending_primary_ports
          WHERE instance_id = ${instanceId}
        `.pipe(Effect.asVoid)
      ),
    setPendingPrimaryPort: (instanceId, port) =>
      run(
        "set_pending_primary_port",
        sql`
          INSERT INTO relay_pending_primary_ports (
            instance_id,
            internal_port,
            protocol,
            updated_at
          ) VALUES (
            ${instanceId},
            ${port.internalPort},
            ${port.protocol},
            ${Date.now()}
          )
          ON CONFLICT (instance_id) DO UPDATE SET
            internal_port = excluded.internal_port,
            protocol = excluded.protocol,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid)
      ),
    replaceInstanceRoutes: (instanceId, routes) =>
      run(
        "replace_instance_routes",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_web_routes WHERE instance_id = ${instanceId}
            `
            const now = Date.now()
            for (const route of routes) {
              yield* sql`
                INSERT INTO relay_web_routes (
                  id,
                  instance_id,
                  hostname,
                  name,
                  path,
                  strip_prefix,
                  target_port,
                  created_at,
                  updated_at
                ) VALUES (
                  ${route.id},
                  ${instanceId},
                  ${route.hostname},
                  ${route.name},
                  ${route.path ?? ""},
                  ${route.stripPrefix ? 1 : 0},
                  ${route.targetPort},
                  ${now},
                  ${now}
                )
              `
            }
          })
        )
      ),
    touchClient: (clientId, seenAt, address) =>
      run(
        "touch_client",
        sql`
          UPDATE relay_clients
          SET last_seen_at = ${seenAt}, last_address = ${address}
          WHERE id = ${clientId} AND revoked_at IS NULL
        `.pipe(Effect.asVoid)
      ),
    updateClient: (input) =>
      run(
        "update_client",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ id: string }>`
              SELECT id
              FROM relay_clients
              WHERE id = ${input.clientId} AND revoked_at IS NULL
              LIMIT 1
            `
            if (!rows[0]) return false
            yield* sql`
              UPDATE relay_clients
              SET name = ${input.name},
                  role = ${input.role},
                  actions_json = ${JSON.stringify(input.actions)},
                  source_cidrs_json = ${JSON.stringify(input.sourceCidrs)}
              WHERE id = ${input.clientId} AND revoked_at IS NULL
            `
            return true
          })
        )
      ),
  })
})

export const RelayStateStoreLive = Layer.effect(
  RelayStateStore,
  makeRelayStateStore
)

export function makeRelayStateLayer(filename: string) {
  return RelayStateStoreLive.pipe(
    Layer.provide(SqliteClient.layer({ filename }))
  )
}

function decodeJsonStringArray(value: string) {
  return Effect.try({
    try: (): unknown => JSON.parse(value),
    catch: (cause) => RelayStateError.make({ operation: "decode_json", cause }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(StringArraySchema)))
}

function decodeAuditDetails(value: string) {
  return Effect.try({
    try: (): unknown => JSON.parse(value),
    catch: (cause) => RelayStateError.make({ operation: "decode_json", cause }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RelayAuditDetailsSchema)))
}

function decodeBackupTaskInput(value: string) {
  return Effect.try({
    try: () => backupTaskInputSchema.parse(JSON.parse(value)),
    catch: (cause) => RelayStateError.make({ operation: "decode_json", cause }),
  })
}

function decodeBackupTaskResult(value: string) {
  return Effect.try({
    try: () => backupTaskResultSchema.parse(JSON.parse(value)),
    catch: (cause) => RelayStateError.make({ operation: "decode_json", cause }),
  })
}

const UNPARSEABLE_BACKUP_TASK_ERROR =
  "The Relay journal row could not be parsed"

function parseBackupTaskInputJson(value: string): unknown {
  return Result.getOrNull(Result.try((): unknown => JSON.parse(value)))
}

function fallbackBackupTarget(input: unknown): BackupTaskInput["target"] {
  if (!input || typeof input !== "object" || !("target" in input)) {
    return { id: "unknown", kind: "instance" }
  }
  const parsed = backupTargetSchema.safeParse(input.target)
  return parsed.success ? parsed.data : { id: "unknown", kind: "instance" }
}

function fallbackSnapshotId(input: unknown): string {
  if (!input || typeof input !== "object" || !("snapshotId" in input)) {
    return "00000000"
  }
  const parsed = resticSnapshotIdSchema.safeParse(input.snapshotId)
  return parsed.success ? parsed.data : "00000000"
}

function fallbackBackupTaskInput(
  row: typeof RelayBackupTaskRowSchema.Type
): BackupTaskInput | null {
  const parsed = parseBackupTaskInputJson(row.inputJson)
  const target = fallbackBackupTarget(parsed)
  const snapshotId = fallbackSnapshotId(parsed)
  const candidate =
    row.kind === "export"
      ? {
          backupId: row.backupId,
          kind: "export" as const,
          snapshotId,
          target,
          taskId: row.taskId,
          ttlMs: BACKUP_EXPORT_TTL_MIN_MS,
        }
      : row.kind === "prune"
        ? {
            backupId: row.backupId,
            kind: "prune" as const,
            target,
            taskId: row.taskId,
          }
        : row.kind === "restore"
          ? {
              backupId: row.backupId,
              kind: "restore" as const,
              source: {
                bytes: 0,
                checksumSha256: "0".repeat(64),
                kind: "local" as const,
              },
              target,
              taskId: row.taskId,
            }
          : row.kind === "delete"
            ? {
                backupId: row.backupId,
                destination: { kind: "local" as const },
                kind: "delete" as const,
                target,
                taskId: row.taskId,
              }
            : {
                artifactKind: "archive" as const,
                backupId: row.backupId,
                destination: { kind: "local" as const },
                exclude: [],
                kind: "create" as const,
                maxBytes: null,
                mode: "full" as const,
                reason: "manual" as const,
                target,
                taskId: row.taskId,
              }
  const decoded = backupTaskInputSchema.safeParse(candidate)
  return decoded.success ? decoded.data : null
}

function fallbackFailedBackupTask(
  row: typeof RelayBackupTaskRowSchema.Type
): RelayBackupTask | null {
  if (
    row.status !== "cancelled" &&
    row.status !== "failed" &&
    row.status !== "succeeded"
  ) {
    return null
  }
  const input = fallbackBackupTaskInput(row)
  if (!input) return null
  const decoded = relayBackupTaskSchema.safeParse({
    backupId: row.backupId,
    bytesCompleted: row.bytesCompleted,
    bytesTotal: row.bytesTotal,
    createdAt: row.createdAt,
    currentArtifactId: null,
    currentPath: null,
    error: row.error ?? UNPARSEABLE_BACKUP_TASK_ERROR,
    finishedAt: row.finishedAt ?? row.updatedAt,
    input,
    inputRefreshRequired: false,
    kind: row.kind,
    phase: null,
    result: null,
    startedAt: row.startedAt,
    status: "failed",
    taskId: row.taskId,
    updatedAt: row.updatedAt,
  })
  return decoded.success ? decoded.data : null
}
