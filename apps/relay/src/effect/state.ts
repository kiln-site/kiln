import { randomUUID } from "node:crypto"

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import type { z } from "zod"
import { Context, Effect, Layer, Predicate, Result, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type {
  BackupFailureCode,
  BackupTaskInput,
  BackupTaskPhase,
  BackupTaskResult,
  DatabaseConnectionMember,
  DatabaseConnectionMemberKind,
  RelayBackupTask,
  RelayDesiredState,
  RelayInstanceLifecycleEvent,
  RelayInstanceRecovery,
  RelayInstancePendingPrimaryPort,
  RelayInstancePortProtocol,
  RelayInstanceWebRoute,
  RelayBrowserAuthorizationRevision,
} from "@workspace/contracts"
import {
  BACKUP_EXPORT_TTL_MIN_MS,
  backupTargetSchema,
  backupTaskInputSchema,
  backupTaskResultSchema,
  omitBackupSecrets,
  relayBackupTaskSchema,
  relayAppSchema,
  relayCreateAppSchema,
  relayCreateDatabaseSchema,
  relayCreateInstanceSchema,
  relayInstanceSchema,
  relayManagedDatabaseSchema,
  resticSnapshotIdSchema,
} from "@workspace/contracts"

import { RelayStateError } from "./errors.js"
import { BROWSER_AUTHORIZATION_FLOOR_RETENTION_MS } from "../browser-security.js"
import {
  makeRelayScheduleState,
  type RelayScheduleState,
} from "./schedule-state.js"

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
  // The only Hearth client that may pair with it, by key fingerprint, as a
  // join's invitation is; null for any holder of the token.
  readonly clientId?: string | null
  readonly createdAt: number
  readonly expiresAt: number
  readonly id: string
  readonly role: RelayClientRole
  readonly tokenHash: string
}

export interface RelayInvitation {
  readonly actions: ReadonlyArray<string>
  readonly clientId: string | null
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

export interface RelayBrowserAuthorityQuery {
  // The server whose revisions apply, or null for other kinds of resource.
  readonly instanceId: string | null
  readonly issuer: string
  readonly loginSessionId: string
  readonly subject: string
}

export interface RelayBrowserAuthority {
  readonly issuerGeneration: number
  readonly minimumRevision: number
}

export interface RelayBrowserAuthorizationResult {
  readonly issuerGeneration: number
  readonly items: ReadonlyArray<RelayBrowserAuthorizationRevision>
}

export type RelayBrowserFileReplayReservation = "full" | "replayed" | "reserved"

export interface RelayAuditQuery {
  readonly from?: number
  readonly instanceIds?: ReadonlyArray<string>
  readonly limit: number
  readonly to?: number
}

// A server's route, or an app's (owned by `app:<appId>`), which also names
// the app's service it reaches.
export interface RelayStoredWebRoute extends RelayInstanceWebRoute {
  readonly instanceId: string
  readonly service?: string
}

/**
 * A member's connection to a database: a game server's, an App's (every
 * service of it), or another database's. Game servers name the Relay the
 * database is on; Apps and databases only connect to databases on theirs.
 */
export interface RelayStoredDatabaseConnection {
  readonly memberKind: DatabaseConnectionMemberKind
  readonly memberId: string
  readonly databaseId: string
  readonly relayId: string
}

export const DATABASE_CONNECTION_RECOVERY_KEY = "database_connections_recovered"
const OPERATION_JOURNAL_METADATA_KEY = "operation_journal_id"

export interface RelayStoredInstanceName {
  readonly instanceId: string
  readonly name: string
}

export interface RelayStoredVolumeName {
  readonly name: string
  readonly volumeId: string
}

/**
 * A Kiln volume an App's configuration mounts, deployed or not, as the
 * Hearth that keeps that configuration said.
 */
export interface RelayAppVolumeReference {
  readonly appId: string
  readonly clientId: string
  readonly volumeId: string
}

/**
 * That a Hearth has sent every App configuration it keeps for this Relay,
 * but for those it couldn't read, which it still owes, on one of its
 * control connections.
 */
export interface RelayVolumeReferenceImport {
  readonly clientId: string
  readonly connectionId: string
  readonly importedAt: number
  readonly unresolvedAppIds: ReadonlyArray<string>
}

/** Kinds of instance whose disk limit the Relay keeps here, not on Docker. */
export type RelayDiskLimitKind = "app" | "database"

export interface RelayStoredPendingPrimaryPort extends RelayInstancePendingPrimaryPort {
  readonly instanceId: string
}

export interface RelayStoredLifecycleSession {
  readonly events: Array<RelayInstanceLifecycleEvent>
  readonly instanceId: string
}

export type RelayProvisioningJobStatus =
  | "awaiting_claim"
  | "queued"
  | "running"
  | "failed"

// What each kind of instance provisions from, and what it shows until it
// exists: its create request and its placeholder.
const provisioningSchemas = {
  app: { input: relayCreateAppSchema, placeholder: relayAppSchema },
  database: {
    input: relayCreateDatabaseSchema,
    placeholder: relayManagedDatabaseSchema,
  },
  server: {
    input: relayCreateInstanceSchema,
    placeholder: relayInstanceSchema,
  },
}

export type RelayProvisioningKind = keyof typeof provisioningSchemas

/** A job to provision one instance, of one kind. */
export type RelayProvisioningJob<
  Kind extends RelayProvisioningKind = RelayProvisioningKind,
> = {
  readonly [K in Kind]: {
    readonly attempt: number
    readonly createdAt: number
    readonly error: string | null
    readonly idempotencyKey: string
    readonly input: z.infer<(typeof provisioningSchemas)[K]["input"]>
    /** The ID of the instance it provisions. */
    readonly instanceId: string
    readonly kind: K
    readonly placeholder: z.infer<
      (typeof provisioningSchemas)[K]["placeholder"]
    >
    readonly status: RelayProvisioningJobStatus
    readonly updatedAt: number
  }
}[Kind]

export type RelayRuntimeRecoveryPhase =
  | "idle"
  | "pending"
  | "restarting"
  | "monitoring"
  | "failed"

/**
 * A change Hearth sent under an `operationId`, kept to answer lookups. Only
 * its outcome is kept, never its reply, which can carry secrets.
 */
export interface RelayOperationRecord {
  readonly clientId: string
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly finishedAt: number | null
  readonly operation: string
  readonly operationId: string
  readonly payloadSha256: string
  readonly retryable: boolean
  readonly startedAt: number
  readonly status: "failed" | "interrupted" | "running" | "succeeded"
}

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
  clientId: Schema.NullOr(Schema.String),
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
  httpsRedirect: Schema.Number,
  id: Schema.String,
  instanceId: Schema.String,
  isPrimary: Schema.Number,
  name: Schema.String,
  path: Schema.String,
  redirectPermanent: Schema.Number,
  redirectPreservePath: Schema.Number,
  redirectTo: Schema.NullOr(Schema.String),
  service: Schema.NullOr(Schema.String),
  stripPrefix: Schema.Number,
  targetPort: Schema.NullOr(Schema.Number),
  www: Schema.Literals(["none", "redirect", "serve"]),
})

const RelayInstancePortProtocolSchema = Schema.Literals(["tcp", "udp", "both"])

const RelayPendingPrimaryPortRowSchema = Schema.Struct({
  instanceId: Schema.String,
  internalPort: Schema.Number,
  protocol: RelayInstancePortProtocolSchema,
})

const RelayInstanceLifecycleStateSchema = Schema.Literals([
  "started",
  "ready",
  "stopping",
  "stopped",
  "failed",
])

const RelayLifecycleEventRowSchema = Schema.Struct({
  instanceId: Schema.String,
  state: RelayInstanceLifecycleStateSchema,
  time: Schema.String,
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
export type ScheduledBackupPrune = {
  input: Extract<BackupTaskInput, { kind: "prune" }>
  /** Names the repository, so one queued prune covers it. */
  repositoryKey: string
}

const RelayBackupTaskRowSchema = Schema.Struct({
  backupId: Schema.String,
  bytesCompleted: Schema.Number,
  bytesTotal: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  currentArtifactId: Schema.NullOr(Schema.String),
  currentPath: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
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
  kind: Schema.Literals(["server", "database", "app"]),
  placeholderJson: Schema.String,
  status: RelayProvisioningJobStatusSchema,
  updatedAt: Schema.Number,
})

export class RelayStateStore extends Context.Service<
  RelayStateStore,
  {
    readonly schedules: RelayScheduleState
    readonly listDatabaseConnections: () => Effect.Effect<
      ReadonlyArray<RelayStoredDatabaseConnection>,
      RelayStateError
    >
    readonly listMemberDatabaseConnections: (
      member: DatabaseConnectionMember
    ) => Effect.Effect<
      ReadonlyArray<RelayStoredDatabaseConnection>,
      RelayStateError
    >
    readonly setDatabaseConnection: (
      connection: RelayStoredDatabaseConnection,
      connected: boolean
    ) => Effect.Effect<void, RelayStateError>
    /** Game servers' connections, recovered once from their containers. */
    readonly recoverDatabaseConnections: (
      connections: ReadonlyArray<RelayStoredDatabaseConnection>
    ) => Effect.Effect<void, RelayStateError>
    /**
     * Adds the connections not saved yet, keeping those that are, and none
     * someone has connected or disconnected (`setDatabaseConnection`) since.
     */
    readonly importDatabaseConnections: (
      connections: ReadonlyArray<RelayStoredDatabaseConnection>
    ) => Effect.Effect<number, RelayStateError>
    readonly deleteMemberDatabaseConnections: (
      member: DatabaseConnectionMember
    ) => Effect.Effect<void, RelayStateError>
    /**
     * Forgets a deleted database: every member's connection to it, and its
     * own connections to others.
     */
    readonly deleteDatabaseConnections: (
      relayId: string,
      databaseId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly appendAudit: (
      input: RelayAuditInput
    ) => Effect.Effect<void, RelayStateError>
    /**
     * Records a change as accepted, before it does anything. Returns the
     * record already kept under the same client and ID, if any, and records
     * nothing then.
     */
    readonly startOperation: (input: {
      readonly clientId: string
      readonly operation: string
      readonly operationId: string
      readonly payloadSha256: string
      readonly startedAt: number
    }) => Effect.Effect<RelayOperationRecord | null, RelayStateError>
    readonly finishOperation: (input: {
      readonly clientId: string
      readonly errorCode: string | null
      readonly errorMessage: string | null
      readonly finishedAt: number
      readonly operationId: string
      readonly retryable: boolean
      readonly status: "failed" | "succeeded"
    }) => Effect.Effect<void, RelayStateError>
    readonly getOperation: (
      clientId: string,
      operationId: string
    ) => Effect.Effect<RelayOperationRecord | null, RelayStateError>
    /** Marks changes a Relay restart cut off, which may or may not have applied. */
    readonly interruptRunningOperations: (
      now: number
    ) => Effect.Effect<void, RelayStateError>
    readonly pruneOperations: (
      finishedBefore: number
    ) => Effect.Effect<void, RelayStateError>
    /**
     * Names this journal of changes, made once with the Relay's state. A
     * rebuilt state starts a new journal under a new ID, even for the same
     * Relay and Hearth, so Hearth can tell "never ran" from "forgotten".
     */
    readonly operationJournalId: () => Effect.Effect<string, RelayStateError>
    /** The paired Hearths holding this Relay paused. */
    readonly listPauseHolds: () => Effect.Effect<
      ReadonlyArray<string>,
      RelayStateError
    >
    readonly setPauseHold: (
      clientId: string,
      paused: boolean,
      now: number
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
    readonly browserAuthority: (
      query: RelayBrowserAuthorityQuery
    ) => Effect.Effect<RelayBrowserAuthority, RelayStateError>
    readonly reviseBrowserAuthorization: (
      issuer: string,
      items: ReadonlyArray<RelayBrowserAuthorizationRevision>,
      minimumIssuerGeneration: number | undefined,
      now: number
    ) => Effect.Effect<RelayBrowserAuthorizationResult, RelayStateError>
    readonly reserveBrowserFileReplay: (input: {
      readonly capabilityId: string
      readonly expiresAt: number
      readonly maxEntries: number
      readonly nonce: string
      readonly now: number
    }) => Effect.Effect<RelayBrowserFileReplayReservation, RelayStateError>
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
    /** Puts back a claimed task that never started, as when a pause withdrew it. */
    readonly returnBackupTask: (
      taskId: string,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
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
      reason?: string,
      errorCode?: BackupFailureCode | null
    ) => Effect.Effect<boolean, RelayStateError>
    /**
     * Records a task's result. A `prune` is queued with it, in the same
     * transaction, unless one for the same repository is already waiting.
     */
    readonly completeBackupTask: (
      taskId: string,
      result: BackupTaskResult,
      now: number,
      prune?: ScheduledBackupPrune
    ) => Effect.Effect<boolean, RelayStateError>
    /**
     * Queues a prune of a restic repository unless one is already waiting.
     * A prune waits while deletes are queued, so a batch of them shares
     * one; it keeps its place ahead of later creates and restores.
     */
    readonly scheduleBackupPrune: (
      prune: ScheduledBackupPrune,
      now: number
    ) => Effect.Effect<void, RelayStateError>
    readonly failBackupTask: (
      taskId: string,
      error: string,
      now: number,
      errorCode?: BackupFailureCode | null
    ) => Effect.Effect<boolean, RelayStateError>
    readonly requeueInterruptedBackupTasks: (
      now: number
    ) => Effect.Effect<number, RelayStateError>
    readonly enqueueProvisioningJob: (
      input: Omit<
        RelayProvisioningJob,
        "attempt" | "createdAt" | "error" | "status" | "updatedAt"
      >,
      now: number
    ) => Effect.Effect<RelayProvisioningJob, RelayStateError>
    readonly claimProvisioningJob: (
      kind: RelayProvisioningKind,
      instanceId: string,
      now: number
    ) => Effect.Effect<RelayProvisioningJob | null, RelayStateError>
    /**
     * Takes the oldest queued job, passing over the kinds in `exceptKinds`,
     * as one whose kind runs a job at a time while one is running.
     */
    readonly claimNextProvisioningJob: (
      now: number,
      exceptKinds?: ReadonlyArray<RelayProvisioningKind>
    ) => Effect.Effect<RelayProvisioningJob | null, RelayStateError>
    readonly cancelProvisioningJob: (
      kind: RelayProvisioningKind,
      instanceId: string
    ) => Effect.Effect<boolean, RelayStateError>
    /**
     * Fails a job that hasn't started, so the worker never takes it, and
     * answers whether the job is failed now. A running job is left alone.
     */
    readonly withdrawProvisioningJob: (
      kind: RelayProvisioningKind,
      instanceId: string,
      error: string,
      placeholder: RelayProvisioningJob["placeholder"],
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly failProvisioningJob: (
      instanceId: string,
      error: string,
      placeholder: RelayProvisioningJob["placeholder"],
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
      placeholder: RelayProvisioningJob["placeholder"],
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
    readonly requeueInterruptedProvisioningJobs: (
      now: number
    ) => Effect.Effect<number, RelayStateError>
    /** Puts back a claimed job that never started, without using an attempt. */
    readonly returnProvisioningJob: (
      instanceId: string,
      now: number
    ) => Effect.Effect<boolean, RelayStateError>
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
    readonly listVolumeNames: () => Effect.Effect<
      ReadonlyArray<RelayStoredVolumeName>,
      RelayStateError
    >
    /** Disk limits by instance ID; one without a row has no limit. */
    readonly listDiskLimits: (
      kind: RelayDiskLimitKind
    ) => Effect.Effect<ReadonlyMap<string, number>, RelayStateError>
    readonly setDiskLimit: (
      kind: RelayDiskLimitKind,
      id: string,
      bytes: number | null
    ) => Effect.Effect<void, RelayStateError>
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
    readonly listLifecycleSessions: () => Effect.Effect<
      ReadonlyArray<RelayStoredLifecycleSession>,
      RelayStateError
    >
    readonly listInstanceRoutes: (
      instanceId: string
    ) => Effect.Effect<
      ReadonlyArray<RelayInstanceWebRoute & { readonly service?: string }>,
      RelayStateError
    >
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
    readonly setVolumeName: (
      volumeId: string,
      name: string
    ) => Effect.Effect<void, RelayStateError>
    readonly setRuntimeRecovery: (
      recovery: RelayRuntimeRecoveryRecord
    ) => Effect.Effect<void, RelayStateError>
    readonly setLifecycleSession: (
      session: RelayStoredLifecycleSession
    ) => Effect.Effect<void, RelayStateError>
    readonly deleteRuntimeRecovery: (
      instanceId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly deleteInstanceName: (
      instanceId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly deleteVolumeName: (
      volumeId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly listAppVolumeReferences: () => Effect.Effect<
      ReadonlyArray<RelayAppVolumeReference>,
      RelayStateError
    >
    readonly listVolumeReferenceImports: () => Effect.Effect<
      ReadonlyArray<RelayVolumeReferenceImport>,
      RelayStateError
    >
    /**
     * Replaces the volumes one App's configuration names, as one Hearth
     * keeps it. That Hearth read the configuration, so it no longer owes it.
     */
    readonly replaceAppVolumeReferences: (
      clientId: string,
      appId: string,
      volumeIds: ReadonlyArray<string>
    ) => Effect.Effect<void, RelayStateError>
    /**
     * Replaces every App configuration's volumes one Hearth sent before
     * with these, and records that it sent them all but those it couldn't
     * read, together.
     */
    readonly importAppVolumeReferences: (
      clientId: string,
      connectionId: string,
      apps: ReadonlyArray<{
        readonly appId: string
        readonly volumeIds: ReadonlyArray<string>
      }>,
      unresolvedAppIds: ReadonlyArray<string>
    ) => Effect.Effect<void, RelayStateError>
    /**
     * Forgets what one Hearth said a deleted App's configuration named, and
     * that it couldn't read it; other Hearths' keep theirs until they send
     * their configurations again.
     */
    readonly deleteAppVolumeReferences: (
      clientId: string,
      appId: string
    ) => Effect.Effect<void, RelayStateError>
    /**
     * Forgets that a Hearth has sent its Apps' configurations, so deletion
     * waits until it sends them again; what it named stays.
     */
    readonly holdVolumeReferenceImport: (
      clientId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly deletePendingPrimaryPort: (
      instanceId: string
    ) => Effect.Effect<void, RelayStateError>
    readonly deleteLifecycleSession: (
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
      routes: ReadonlyArray<
        RelayInstanceWebRoute & { readonly service?: string }
      >
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
  "12_instance_ready_sessions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_instance_ready_sessions (
        instance_id TEXT PRIMARY KEY NOT NULL,
        started_at TEXT NOT NULL,
        ready_at TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `
  }),
  "13_instance_lifecycle_sessions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_instance_lifecycle_events (
        instance_id TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('started', 'ready', 'stopping', 'stopped', 'failed')),
        time TEXT NOT NULL,
        PRIMARY KEY (instance_id, state)
      ) STRICT
    `
    yield* sql`
      INSERT INTO relay_instance_lifecycle_events (instance_id, state, time)
      SELECT instance_id, 'started', started_at
      FROM relay_instance_ready_sessions
    `
    yield* sql`
      INSERT INTO relay_instance_lifecycle_events (instance_id, state, time)
      SELECT instance_id, 'ready', ready_at
      FROM relay_instance_ready_sessions
    `
    yield* sql`DROP TABLE relay_instance_ready_sessions`
  }),
  "14_browser_authorization": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_browser_issuer_generations (
        issuer TEXT PRIMARY KEY NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT
    `
    yield* sql`
      CREATE TABLE relay_browser_authorization_floors (
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        scope_kind TEXT NOT NULL
          CHECK (scope_kind IN ('subject_relay', 'instance', 'login_session')),
        scope_id TEXT NOT NULL,
        minimum_revision INTEGER NOT NULL CHECK (minimum_revision >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (issuer, subject, scope_kind, scope_id)
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_browser_authorization_floors_updated
      ON relay_browser_authorization_floors (updated_at)
    `
    yield* sql`
      CREATE TABLE relay_browser_file_replays (
        capability_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (capability_id, nonce)
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_browser_file_replays_expiry
      ON relay_browser_file_replays (expires_at)
    `
  }),
  "15_database_connections": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_database_connections (
        instance_id TEXT NOT NULL,
        database_id TEXT NOT NULL,
        relay_id TEXT NOT NULL,
        PRIMARY KEY (instance_id, database_id)
      ) STRICT
    `
    yield* sql`
      CREATE INDEX relay_database_connections_target
      ON relay_database_connections (relay_id, database_id)
    `
  }),
  "16_granular_file_mutation_actions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Before action-specific dispatch, write admitted delete and rename through
    // the shared mutation endpoint. Snapshot those rights once; new policies stay granular.
    yield* sql`
      UPDATE relay_clients
         SET actions_json = json_insert(actions_json, '$[#]', 'instance.files.delete')
       WHERE role = 'custom'
         AND EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.write')
         AND NOT EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.delete')
    `
    yield* sql`
      UPDATE relay_clients
         SET actions_json = json_insert(actions_json, '$[#]', 'instance.files.rename')
       WHERE role = 'custom'
         AND EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.write')
         AND NOT EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.rename')
    `
    yield* sql`
      UPDATE relay_invitations
         SET actions_json = json_insert(actions_json, '$[#]', 'instance.files.delete')
       WHERE role = 'custom'
         AND EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.write')
         AND NOT EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.delete')
    `
    yield* sql`
      UPDATE relay_invitations
         SET actions_json = json_insert(actions_json, '$[#]', 'instance.files.rename')
       WHERE role = 'custom'
         AND EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.write')
         AND NOT EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'instance.files.rename')
    `
  }),
  // App routes reach one of the app's services.
  "17_web_route_services": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql<{ name: string }>`
      SELECT name FROM pragma_table_info('relay_web_routes')
    `
    if (columns.some((column) => column.name === "service")) return
    yield* sql`
      ALTER TABLE relay_web_routes ADD COLUMN service TEXT
    `
  }),
  "18_schedule_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE relay_schedules (
      schedule_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      next_run_at INTEGER,
      definition_json TEXT NOT NULL
    ) STRICT`
    yield* sql`CREATE INDEX relay_schedules_due ON relay_schedules (next_run_at, schedule_id)
      WHERE enabled = 1 AND next_run_at IS NOT NULL`
    yield* sql`CREATE TABLE relay_schedule_tombstones (
      schedule_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0)
    ) STRICT`
    yield* sql`CREATE TABLE relay_schedule_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      schedule_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'noop', 'interrupted', 'missed')),
      sequence_attempts_json TEXT NOT NULL,
      target_runs_json TEXT NOT NULL,
      UNIQUE (schedule_id, scheduled_at)
    ) STRICT`
    yield* sql`CREATE INDEX relay_schedule_runs_history ON relay_schedule_runs (finished_at DESC, run_id DESC)
      WHERE status <> 'running'`
    yield* sql`CREATE INDEX relay_schedule_runs_unfinished ON relay_schedule_runs (run_id) WHERE status = 'running'`
  }),
  "19_operations": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE relay_operations (
      client_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      PRIMARY KEY (client_id, operation_id)
    ) STRICT`
    yield* sql`CREATE INDEX relay_operations_started ON relay_operations (started_at)`
  }),
  "20_pause_holds": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE relay_pause_holds (
      client_id TEXT PRIMARY KEY NOT NULL,
      paused_at INTEGER NOT NULL
    ) STRICT`
  }),
  // Docker can't change a container's labels, so the disk limits of
  // instances whose limits change in place live here.
  "21_disk_limits": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE relay_disk_limits (
      kind TEXT NOT NULL CHECK (kind IN ('app', 'database')),
      resource_id TEXT NOT NULL,
      disk_bytes INTEGER NOT NULL CHECK (disk_bytes > 0),
      PRIMARY KEY (kind, resource_id)
    ) STRICT`
  }),
  // Jobs provision any kind of instance; those before kinds are game
  // servers'.
  "22_provisioning_job_kinds": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql<{ name: string }>`
      SELECT name FROM pragma_table_info('relay_instance_provisioning_jobs')
    `
    if (columns.some((column) => column.name === "kind")) return
    yield* sql`
      ALTER TABLE relay_instance_provisioning_jobs
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'server'
        CHECK (kind IN ('server', 'database', 'app'))
    `
  }),
  // Docker can't rename a volume or change its labels, so the names its
  // volumes are shown by live here.
  "23_volume_names": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE relay_volume_names (
      volume_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`
  }),
  // Why a backup task failed, when the Relay can tell; see
  // `backupFailureCodes`.
  "24_backup_task_error_codes": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql<{
      name: string
    }>`PRAGMA table_info(relay_backup_tasks)`
    if (columns.some((column) => column.name === "error_code")) return
    yield* sql`ALTER TABLE relay_backup_tasks ADD COLUMN error_code TEXT`
  }),
  // The repository a queued prune covers, so deletes share one.
  "25_backup_task_maintenance_key": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql<{
      name: string
    }>`PRAGMA table_info(relay_backup_tasks)`
    if (columns.some((column) => column.name === "maintenance_key")) return
    yield* sql`ALTER TABLE relay_backup_tasks ADD COLUMN maintenance_key TEXT`
  }),
  // The Hearth client a join's invitation is for.
  "26_invitation_client": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql<{
      name: string
    }>`PRAGMA table_info(relay_invitations)`
    if (columns.some((column) => column.name === "client_id")) return
    yield* sql`ALTER TABLE relay_invitations ADD COLUMN client_id TEXT`
  }),
  // Routes take a www counterpart, plain HTTP, a primary flag, and a
  // redirect, which has no port.
  "27_web_route_options": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relay_web_routes_next (
        id TEXT PRIMARY KEY NOT NULL,
        instance_id TEXT NOT NULL,
        hostname TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        strip_prefix INTEGER NOT NULL CHECK (strip_prefix IN (0, 1)),
        target_port INTEGER
          CHECK (target_port IS NULL OR target_port BETWEEN 1 AND 65535),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        service TEXT,
        www TEXT NOT NULL DEFAULT 'none'
          CHECK (www IN ('none', 'redirect', 'serve')),
        https_redirect INTEGER NOT NULL DEFAULT 1
          CHECK (https_redirect IN (0, 1)),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        redirect_to TEXT,
        redirect_permanent INTEGER NOT NULL DEFAULT 1
          CHECK (redirect_permanent IN (0, 1)),
        redirect_preserve_path INTEGER NOT NULL DEFAULT 1
          CHECK (redirect_preserve_path IN (0, 1)),
        CHECK ((redirect_to IS NULL) <> (target_port IS NULL)),
        UNIQUE (hostname, path)
      ) STRICT
    `
    yield* sql`
      INSERT INTO relay_web_routes_next (
        id, instance_id, hostname, path, strip_prefix, target_port,
        created_at, updated_at, name, service
      )
      SELECT
        id, instance_id, hostname, path, strip_prefix, target_port,
        created_at, updated_at, name, service
      FROM relay_web_routes
    `
    yield* sql`DROP TABLE relay_web_routes`
    yield* sql`ALTER TABLE relay_web_routes_next RENAME TO relay_web_routes`
    yield* sql`
      CREATE INDEX relay_web_routes_instance
      ON relay_web_routes (instance_id)
    `
  }),
  // Connections name their member by kind: game servers, whose connections
  // these all were, Apps, and databases. Choices remember every pair someone
  // connected or disconnected, so a handover of Apps' old connections from
  // a Hearth never overrules one.
  "28_database_connection_members": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS relay_database_connection_choices (
        member_kind TEXT NOT NULL
          CHECK (member_kind IN ('instance', 'app', 'database')),
        member_id TEXT NOT NULL,
        database_id TEXT NOT NULL,
        PRIMARY KEY (member_kind, member_id, database_id)
      ) STRICT
    `
    const columns = yield* sql<{
      name: string
    }>`PRAGMA table_info(relay_database_connections)`
    if (columns.some((column) => column.name === "member_kind")) return
    yield* sql`
      CREATE TABLE relay_database_connections_next (
        member_kind TEXT NOT NULL
          CHECK (member_kind IN ('instance', 'app', 'database')),
        member_id TEXT NOT NULL,
        database_id TEXT NOT NULL,
        relay_id TEXT NOT NULL,
        PRIMARY KEY (member_kind, member_id, database_id),
        CHECK (member_kind <> 'database' OR member_id <> database_id)
      ) STRICT
    `
    yield* sql`
      INSERT INTO relay_database_connections_next (
        member_kind, member_id, database_id, relay_id
      )
      SELECT 'instance', instance_id, database_id, relay_id
      FROM relay_database_connections
    `
    yield* sql`DROP TABLE relay_database_connections`
    yield* sql`
      ALTER TABLE relay_database_connections_next
      RENAME TO relay_database_connections
    `
    yield* sql`
      CREATE INDEX relay_database_connections_target
      ON relay_database_connections (relay_id, database_id)
    `
  }),
  // The Kiln volumes each App's configuration mounts, which the Hearth that
  // keeps it says, so the Relay can refuse to delete one an App would mount
  // when it next deploys; and which paired Hearths have sent all of theirs.
  // Relays from before start empty and wait for each Hearth to send them.
  "29_app_volume_references": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS relay_app_volume_references (
      client_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      volume_id TEXT NOT NULL,
      PRIMARY KEY (client_id, app_id, volume_id)
    ) STRICT`
    yield* sql`CREATE TABLE IF NOT EXISTS relay_volume_reference_imports (
      client_id TEXT PRIMARY KEY NOT NULL,
      connection_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      unresolved_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT`
    yield* sql`
      CREATE INDEX IF NOT EXISTS relay_app_volume_references_volume
      ON relay_app_volume_references (volume_id)
    `
  }),
})

// The App IDs a Hearth still owes, as stored; anything unreadable owes
// nothing it can name, so it's kept as it is.
function decodeUnresolved(json: string): Array<string> {
  return Result.getOrElse(
    Result.try(() => {
      const parsed = JSON.parse(json) as unknown
      return Array.isArray(parsed) ? parsed.filter(Predicate.isString) : []
    }),
    () => []
  )
}

function scrubBackupTaskInputJson(inputJson: string): string {
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
  // In WAL mode, NORMAL commits without waiting for the disk: a Relay crash
  // or restart loses nothing, and only a host power loss can roll back the
  // last moments of commits. FULL cost about 2.5 ms a commit on a Relay.
  yield* sql`PRAGMA synchronous = NORMAL`
  yield* SqliteMigrator.run({ loader: migrations })

  const run = <T>(operation: string, effect: Effect.Effect<T, unknown>) =>
    effect.pipe(
      Effect.mapError((cause) => RelayStateError.make({ operation, cause })),
      Effect.withSpan(`relay.state.${operation}`)
    )

  const selectOperation = (clientId: string, operationId: string) =>
    sql<Omit<RelayOperationRecord, "retryable"> & { retryable: number }>`
      SELECT client_id AS clientId, operation_id AS operationId,
        operation, payload_sha256 AS payloadSha256, status,
        error_code AS errorCode,
        error_message AS errorMessage, retryable, started_at AS startedAt,
        finished_at AS finishedAt
      FROM relay_operations
      WHERE client_id = ${clientId} AND operation_id = ${operationId}
      LIMIT 1
    `.pipe(
      Effect.map((rows): RelayOperationRecord | null =>
        rows[0] ? { ...rows[0], retryable: rows[0].retryable === 1 } : null
      )
    )

  const insertAppVolumeReferences = (
    clientId: string,
    appId: string,
    volumeIds: ReadonlyArray<string>
  ) =>
    Effect.forEach(
      new Set(volumeIds),
      (volumeId) => sql`
        INSERT INTO relay_app_volume_references (client_id, app_id, volume_id)
        VALUES (${clientId}, ${appId}, ${volumeId})
      `,
      { discard: true }
    )

  // Takes Apps off what a Hearth still owes, or off every Hearth's.
  const resolveAppVolumeReferences = (
    clientId: string | null,
    appIds: ReadonlySet<string>
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ clientId: string; unresolvedJson: string }>`
        SELECT client_id AS clientId, unresolved_json AS unresolvedJson
        FROM relay_volume_reference_imports
      `
      for (const row of rows) {
        if (clientId !== null && row.clientId !== clientId) continue
        const unresolved = decodeUnresolved(row.unresolvedJson)
        const remaining = unresolved.filter((appId) => !appIds.has(appId))
        if (remaining.length === unresolved.length) continue
        yield* sql`
          UPDATE relay_volume_reference_imports
          SET unresolved_json = ${JSON.stringify(remaining)}
          WHERE client_id = ${row.clientId}
        `
      }
    })

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
  const decodeLifecycleEventRows = Schema.decodeUnknownEffect(
    Schema.Array(RelayLifecycleEventRowSchema)
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

  const lifecycleSessions = Effect.fn("RelayStateStore.lifecycleSessions")(
    function* () {
      const rows = yield* sql<Record<string, unknown>>`
      SELECT
        instance_id AS instanceId,
        state,
        time
      FROM relay_instance_lifecycle_events
      ORDER BY instance_id ASC, time ASC
    `
      const decoded = yield* decodeLifecycleEventRows(rows)
      const sessions = new Map<string, Array<RelayInstanceLifecycleEvent>>()
      for (const { instanceId, state, time } of decoded) {
        const events = sessions.get(instanceId) ?? []
        events.push({ state, time })
        sessions.set(instanceId, events)
      }
      return Array.from(sessions, ([instanceId, events]) => ({
        events,
        instanceId,
      }))
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
        errorCode: row.errorCode,
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
            error_code AS errorCode,
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
              error_code AS errorCode,
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
              error_code AS errorCode,
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
                     kind,
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
                     kind,
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
                   kind,
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
          try: (): RelayProvisioningJob => {
            const schemas = provisioningSchemas[row.kind]
            // Each kind's input and placeholder parse with its own schemas,
            // which TypeScript can't follow through the indexed lookup.
            return {
              attempt: row.attempt,
              createdAt: row.createdAt,
              error: row.error,
              idempotencyKey: row.idempotencyKey,
              input: schemas.input.parse(JSON.parse(row.inputJson)),
              instanceId: row.instanceId,
              kind: row.kind,
              placeholder: schemas.placeholder.parse(
                JSON.parse(row.placeholderJson)
              ),
              status: row.status,
              updatedAt: row.updatedAt,
            } as RelayProvisioningJob
          },
          catch: (cause) => cause,
        })
      )
    }
  )

  const warnedUnparseableTaskIds = new Set<string>()
  const insertBackupPrune = (prune: ScheduledBackupPrune, now: number) =>
    Effect.gen(function* () {
      const waiting = yield* sql`
        SELECT task_id
        FROM relay_backup_tasks
        WHERE kind = 'prune'
          AND status = 'queued'
          AND maintenance_key = ${prune.repositoryKey}
        LIMIT 1
      `
      if (waiting[0]) return
      yield* sql`
        INSERT INTO relay_backup_tasks (
          task_id,
          backup_id,
          kind,
          status,
          input_json,
          maintenance_key,
          created_at,
          updated_at
        ) VALUES (
          ${prune.input.taskId},
          ${prune.input.backupId},
          'prune',
          'queued',
          ${JSON.stringify(prune.input)},
          ${prune.repositoryKey},
          ${now},
          ${now}
        )
      `
    })
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
            service,
            strip_prefix AS stripPrefix,
            target_port AS targetPort,
            www,
            https_redirect AS httpsRedirect,
            is_primary AS isPrimary,
            redirect_to AS redirectTo,
            redirect_permanent AS redirectPermanent,
            redirect_preserve_path AS redirectPreservePath
          FROM relay_web_routes
          WHERE instance_id = ${instanceId}
          ORDER BY created_at ASC, rowid ASC
        `
      : yield* sql<Record<string, unknown>>`
          SELECT
            id,
            instance_id AS instanceId,
            hostname,
            name,
            path,
            service,
            strip_prefix AS stripPrefix,
            target_port AS targetPort,
            www,
            https_redirect AS httpsRedirect,
            is_primary AS isPrimary,
            redirect_to AS redirectTo,
            redirect_permanent AS redirectPermanent,
            redirect_preserve_path AS redirectPreservePath
          FROM relay_web_routes
          ORDER BY created_at ASC, rowid ASC
        `
    const decoded = yield* decodeWebRouteRows(rows)
    return decoded.map((row) => ({
      hostname: row.hostname,
      httpsRedirect: row.httpsRedirect === 1,
      id: row.id,
      instanceId: row.instanceId,
      name: row.name,
      path: row.path || null,
      primary: row.isPrimary === 1,
      redirect:
        row.redirectTo === null
          ? null
          : {
              permanent: row.redirectPermanent === 1,
              preservePath: row.redirectPreservePath === 1,
              to: row.redirectTo,
            },
      ...(row.service === null ? {} : { service: row.service }),
      stripPrefix: row.stripPrefix === 1,
      targetPort: row.targetPort,
      www: row.www,
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

  const browserScopeId = (scope: RelayBrowserAuthorizationRevision["scope"]) =>
    scope.kind === "instance"
      ? scope.instanceId
      : scope.kind === "login_session"
        ? scope.loginSessionId
        : ""

  return RelayStateStore.of({
    schedules: makeRelayScheduleState(sql),
    listDatabaseConnections: () =>
      run(
        "list_database_connections",
        sql<RelayStoredDatabaseConnection>`
          SELECT member_kind AS memberKind, member_id AS memberId,
                 database_id AS databaseId, relay_id AS relayId
          FROM relay_database_connections
          ORDER BY member_kind, member_id, database_id
        `
      ),
    listMemberDatabaseConnections: (member) =>
      run(
        "list_member_database_connections",
        sql<RelayStoredDatabaseConnection>`
          SELECT member_kind AS memberKind, member_id AS memberId,
                 database_id AS databaseId, relay_id AS relayId
          FROM relay_database_connections
          WHERE member_kind = ${member.kind} AND member_id = ${member.id}
          ORDER BY database_id
        `
      ),
    setDatabaseConnection: (connection, connected) =>
      run(
        "set_database_connection",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* connected
              ? sql`
                  INSERT INTO relay_database_connections (
                    member_kind, member_id, database_id, relay_id
                  ) VALUES (
                    ${connection.memberKind}, ${connection.memberId},
                    ${connection.databaseId}, ${connection.relayId}
                  )
                  ON CONFLICT (member_kind, member_id, database_id)
                  DO UPDATE SET relay_id = excluded.relay_id
                `
              : sql`
                  DELETE FROM relay_database_connections
                  WHERE member_kind = ${connection.memberKind}
                    AND member_id = ${connection.memberId}
                    AND database_id = ${connection.databaseId}
                    AND relay_id = ${connection.relayId}
                `
            yield* sql`
              INSERT INTO relay_database_connection_choices (
                member_kind, member_id, database_id
              ) VALUES (
                ${connection.memberKind}, ${connection.memberId},
                ${connection.databaseId}
              )
              ON CONFLICT DO NOTHING
            `
          })
        )
      ),
    recoverDatabaseConnections: (connections) =>
      run(
        "recover_database_connections",
        sql.withTransaction(
          Effect.gen(function* () {
            const initialized = yield* sql`
              SELECT value FROM relay_metadata
              WHERE key = ${DATABASE_CONNECTION_RECOVERY_KEY}
            `
            if (initialized.length > 0) return
            for (const connection of connections) {
              yield* sql`
                INSERT INTO relay_database_connections (
                  member_kind, member_id, database_id, relay_id
                ) VALUES (
                  ${connection.memberKind}, ${connection.memberId},
                  ${connection.databaseId}, ${connection.relayId}
                )
                ON CONFLICT (member_kind, member_id, database_id) DO NOTHING
              `
            }
            yield* sql`
              INSERT INTO relay_metadata (key, value)
              VALUES (${DATABASE_CONNECTION_RECOVERY_KEY}, '1')
            `
          })
        )
      ),
    importDatabaseConnections: (connections) =>
      run(
        "import_database_connections",
        sql.withTransaction(
          Effect.gen(function* () {
            let imported = 0
            for (const connection of connections) {
              // A pair someone chose since stays as they left it.
              const rows = yield* sql<{ memberId: string }>`
                INSERT INTO relay_database_connections (
                  member_kind, member_id, database_id, relay_id
                )
                SELECT ${connection.memberKind}, ${connection.memberId},
                       ${connection.databaseId}, ${connection.relayId}
                WHERE NOT EXISTS (
                  SELECT 1 FROM relay_database_connection_choices
                  WHERE member_kind = ${connection.memberKind}
                    AND member_id = ${connection.memberId}
                    AND database_id = ${connection.databaseId}
                )
                ON CONFLICT (member_kind, member_id, database_id) DO NOTHING
                RETURNING member_id AS memberId
              `
              imported += rows.length
            }
            return imported
          })
        )
      ),
    deleteMemberDatabaseConnections: (member) =>
      run(
        "delete_member_database_connections",
        sql.withTransaction(
          Effect.gen(function* () {
            for (const table of [
              "relay_database_connections",
              "relay_database_connection_choices",
            ]) {
              yield* sql`
                DELETE FROM ${sql(table)}
                WHERE member_kind = ${member.kind} AND member_id = ${member.id}
              `
            }
          })
        )
      ),
    deleteDatabaseConnections: (relayId, databaseId) =>
      run(
        "delete_database_connections",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_database_connections
              WHERE (relay_id = ${relayId} AND database_id = ${databaseId})
                 OR (member_kind = 'database' AND member_id = ${databaseId})
            `
            yield* sql`
              DELETE FROM relay_database_connection_choices
              WHERE database_id = ${databaseId}
                 OR (member_kind = 'database' AND member_id = ${databaseId})
            `
          })
        )
      ),
    startOperation: (input) =>
      run(
        "start_operation",
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* selectOperation(
              input.clientId,
              input.operationId
            )
            if (existing) return existing
            yield* sql`
              INSERT INTO relay_operations (
                client_id, operation_id, operation, payload_sha256, status,
                started_at
              ) VALUES (
                ${input.clientId},
                ${input.operationId},
                ${input.operation},
                ${input.payloadSha256},
                'running',
                ${input.startedAt}
              )
            `
            return null
          })
        )
      ),
    finishOperation: (input) =>
      run(
        "finish_operation",
        sql`
          UPDATE relay_operations
          SET status = ${input.status},
              error_code = ${input.errorCode},
              error_message = ${input.errorMessage},
              retryable = ${input.retryable ? 1 : 0},
              finished_at = ${input.finishedAt}
          WHERE client_id = ${input.clientId}
            AND operation_id = ${input.operationId}
        `.pipe(Effect.asVoid)
      ),
    getOperation: (clientId, operationId) =>
      run("get_operation", selectOperation(clientId, operationId)),
    interruptRunningOperations: (now) =>
      run(
        "interrupt_running_operations",
        sql`
          UPDATE relay_operations
          SET status = 'interrupted', finished_at = ${now}
          WHERE status = 'running'
        `.pipe(Effect.asVoid)
      ),
    pruneOperations: (finishedBefore) =>
      run(
        "prune_operations",
        sql`
          DELETE FROM relay_operations
          WHERE status <> 'running' AND started_at < ${finishedBefore}
        `.pipe(Effect.asVoid)
      ),
    operationJournalId: () =>
      run(
        "operation_journal_id",
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO relay_metadata (key, value)
            VALUES (${OPERATION_JOURNAL_METADATA_KEY}, ${randomUUID()})
            ON CONFLICT (key) DO NOTHING
          `
          const rows = yield* sql<{ value: string }>`
            SELECT value FROM relay_metadata
            WHERE key = ${OPERATION_JOURNAL_METADATA_KEY}
          `
          return rows[0]!.value
        })
      ),
    listPauseHolds: () =>
      run(
        "list_pause_holds",
        sql<{ clientId: string }>`
          SELECT client_id AS clientId FROM relay_pause_holds
        `.pipe(Effect.map((rows) => rows.map((row) => row.clientId)))
      ),
    setPauseHold: (clientId, paused, now) =>
      run(
        "set_pause_hold",
        (paused
          ? // Only while the Hearth is still paired: a pause that raced its
            // revocation leaves no hold behind that nobody could lift.
            sql`
              INSERT INTO relay_pause_holds (client_id, paused_at)
              SELECT ${clientId}, ${now}
              WHERE EXISTS (
                SELECT 1 FROM relay_clients
                WHERE id = ${clientId} AND revoked_at IS NULL
              )
              ON CONFLICT (client_id) DO NOTHING
            `
          : sql`DELETE FROM relay_pause_holds WHERE client_id = ${clientId}`
        ).pipe(Effect.asVoid)
      ),
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
            id, token_hash, role, actions_json, created_at, expires_at,
            client_id
          ) VALUES (
            ${input.id},
            ${input.tokenHash},
            ${input.role},
            ${JSON.stringify(input.actions)},
            ${input.createdAt},
            ${input.expiresAt},
            ${input.clientId ?? null}
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
                      error_code = NULL,
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
                  -- A prune waits while deletes are queued, so a batch of
                  -- them shares one; other work keeps its place in line.
                  AND (
                    kind <> 'prune'
                    OR NOT EXISTS (
                      SELECT 1
                      FROM relay_backup_tasks AS deletion
                      WHERE deletion.kind = 'delete'
                        AND deletion.status = 'queued'
                        AND deletion.input_refresh_required = 0
                    )
                  )
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
                    error_code = NULL,
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
    returnBackupTask: (taskId, now) =>
      run(
        "return_backup_task",
        sql<{ taskId: string }>`
          UPDATE relay_backup_tasks
          SET status = 'queued',
              started_at = NULL,
              phase = NULL,
              updated_at = ${now}
          WHERE task_id = ${taskId} AND status = 'running'
          RETURNING task_id AS taskId
        `.pipe(Effect.map((rows) => rows.length > 0))
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
    cancelBackupTask: (
      taskId,
      now,
      reason = "Cancelled by user",
      errorCode = null
    ) =>
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
                  error_code = ${errorCode},
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
    completeBackupTask: (taskId, result, now, prune) =>
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
                  error_code = NULL,
                  phase = NULL,
                  current_artifact_id = NULL,
                  current_path = NULL,
                  finished_at = ${now},
                  updated_at = ${now}
              WHERE task_id = ${taskId} AND status = 'running'
            `
            yield* pruneSupersededExportTasks()
            if (prune) yield* insertBackupPrune(prune, now)
            return true
          })
        )
      ),
    scheduleBackupPrune: (prune, now) =>
      run(
        "schedule_backup_prune",
        sql.withTransaction(insertBackupPrune(prune, now))
      ),
    failBackupTask: (taskId, error, now, errorCode = null) =>
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
                  error_code = ${errorCode},
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
                instance_id, kind, idempotency_key, status, input_json,
                placeholder_json, created_at, updated_at
              ) VALUES (
                ${input.instanceId},
                ${input.kind},
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
    claimProvisioningJob: (kind, instanceId, now) =>
      run(
        "claim_provisioning_job",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE relay_instance_provisioning_jobs
              SET status = 'queued', updated_at = ${now}, error = NULL
              WHERE instance_id = ${instanceId}
                AND kind = ${kind}
                AND status = 'awaiting_claim'
            `
            const job = (yield* provisioningJobs({ instanceId }))[0]
            return job?.kind === kind ? job : null
          })
        )
      ),
    claimNextProvisioningJob: (now, exceptKinds = []) =>
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
                  ${exceptKinds.length > 0 ? sql`AND kind NOT IN ${sql.in(exceptKinds)}` : sql``}
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
    cancelProvisioningJob: (kind, instanceId) =>
      run(
        "cancel_provisioning_job",
        Effect.gen(function* () {
          const rows = yield* sql<{ instanceId: string }>`
            DELETE FROM relay_instance_provisioning_jobs
            WHERE instance_id = ${instanceId}
              AND kind = ${kind}
              AND status IN ('awaiting_claim', 'queued', 'failed')
            RETURNING instance_id AS instanceId
          `
          return rows.length > 0
        })
      ),
    withdrawProvisioningJob: (kind, instanceId, error, placeholder, now) =>
      run(
        "withdraw_provisioning_job",
        Effect.gen(function* () {
          yield* sql`
            UPDATE relay_instance_provisioning_jobs
            SET status = 'failed',
                placeholder_json = ${JSON.stringify(placeholder)},
                error = ${error.slice(0, 2_048)},
                updated_at = ${now}
            WHERE instance_id = ${instanceId}
              AND kind = ${kind}
              AND status IN ('awaiting_claim', 'queued')
          `
          const rows = yield* sql<{ instanceId: string }>`
            SELECT instance_id AS instanceId
            FROM relay_instance_provisioning_jobs
            WHERE instance_id = ${instanceId}
              AND kind = ${kind}
              AND status = 'failed'
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
    returnProvisioningJob: (instanceId, now) =>
      run(
        "return_provisioning_job",
        sql<{ instanceId: string }>`
          UPDATE relay_instance_provisioning_jobs
          SET status = 'queued',
              attempt = attempt - 1,
              updated_at = ${now}
          WHERE instance_id = ${instanceId} AND status = 'running'
          RETURNING instance_id AS instanceId
        `.pipe(Effect.map((rows) => rows.length > 0))
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
              client_id AS clientId,
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
            clientId: invitation.clientId,
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
    browserAuthority: (query) =>
      run(
        "browser_authority",
        Effect.gen(function* () {
          const generations = yield* sql<{ generation: number }>`
            SELECT generation
            FROM relay_browser_issuer_generations
            WHERE issuer = ${query.issuer}
            LIMIT 1
          `
          const floors = yield* sql<{ minimumRevision: number | null }>`
            SELECT MAX(minimum_revision) AS minimumRevision
            FROM relay_browser_authorization_floors
            WHERE issuer = ${query.issuer}
              AND subject = ${query.subject}
              AND (
                (scope_kind = 'subject_relay' AND scope_id = '')
                -- Instance floors never have an empty ID, so '' matches none.
                OR (
                  scope_kind = 'instance'
                  AND scope_id = ${query.instanceId ?? ""}
                )
                OR (
                  scope_kind = 'login_session'
                  AND scope_id = ${query.loginSessionId}
                )
              )
          `
          return {
            issuerGeneration: generations[0]?.generation ?? 0,
            minimumRevision: floors[0]?.minimumRevision ?? 0,
          }
        })
      ),
    reviseBrowserAuthorization: (issuer, items, minimumIssuerGeneration, now) =>
      run(
        "revise_browser_authorization",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_browser_authorization_floors
              WHERE updated_at <= ${now - BROWSER_AUTHORIZATION_FLOOR_RETENTION_MS}
            `
            if (minimumIssuerGeneration !== undefined) {
              yield* sql`
                INSERT INTO relay_browser_issuer_generations (
                  issuer, generation, updated_at
                ) VALUES (
                  ${issuer}, ${minimumIssuerGeneration}, ${now}
                )
                ON CONFLICT (issuer) DO UPDATE SET
                  generation = MAX(generation, excluded.generation),
                  updated_at = excluded.updated_at
              `
            }
            const persisted: Array<RelayBrowserAuthorizationRevision> = []
            for (const item of items) {
              const scopeId = browserScopeId(item.scope)
              yield* sql`
                INSERT INTO relay_browser_authorization_floors (
                  issuer, subject, scope_kind, scope_id,
                  minimum_revision, updated_at
                ) VALUES (
                  ${issuer}, ${item.subject}, ${item.scope.kind}, ${scopeId},
                  ${item.minimumRevision}, ${now}
                )
                ON CONFLICT (issuer, subject, scope_kind, scope_id)
                DO UPDATE SET
                  minimum_revision = MAX(
                    minimum_revision,
                    excluded.minimum_revision
                  ),
                  updated_at = excluded.updated_at
              `
              const rows = yield* sql<{ minimumRevision: number }>`
                SELECT minimum_revision AS minimumRevision
                FROM relay_browser_authorization_floors
                WHERE issuer = ${issuer}
                  AND subject = ${item.subject}
                  AND scope_kind = ${item.scope.kind}
                  AND scope_id = ${scopeId}
                LIMIT 1
              `
              persisted.push({
                minimumRevision:
                  rows[0]?.minimumRevision ?? item.minimumRevision,
                scope: item.scope,
                subject: item.subject,
              })
            }
            const generations = yield* sql<{ generation: number }>`
              SELECT generation
              FROM relay_browser_issuer_generations
              WHERE issuer = ${issuer}
              LIMIT 1
            `
            return {
              issuerGeneration: generations[0]?.generation ?? 0,
              items: persisted,
            }
          })
        )
      ),
    reserveBrowserFileReplay: (input) =>
      run(
        "reserve_browser_file_replay",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_browser_file_replays
              WHERE expires_at <= ${input.now}
            `
            const replay = yield* sql<{ found: number }>`
              SELECT 1 AS found
              FROM relay_browser_file_replays
              WHERE capability_id = ${input.capabilityId}
                AND nonce = ${input.nonce}
              LIMIT 1
            `
            if (replay[0]) return "replayed" as const
            const totals = yield* sql<{ count: number }>`
              SELECT COUNT(*) AS count FROM relay_browser_file_replays
            `
            if ((totals[0]?.count ?? 0) >= input.maxEntries) {
              return "full" as const
            }
            yield* sql`
              INSERT INTO relay_browser_file_replays (
                capability_id, nonce, expires_at
              ) VALUES (
                ${input.capabilityId}, ${input.nonce}, ${input.expiresAt}
              )
            `
            return "reserved" as const
          })
        )
      ),
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
              client_id AS clientId,
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
            clientId: invitation.clientId,
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
              client_id AS clientId,
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
                clientId: invitation.clientId,
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
    listVolumeNames: () =>
      run(
        "list_volume_names",
        sql<RelayStoredVolumeName>`
          SELECT volume_id AS volumeId, name
          FROM relay_volume_names
          ORDER BY volume_id ASC
        `
      ),
    listRuntimeRecoveries: () =>
      run("list_runtime_recoveries", runtimeRecoveries()),
    listDiskLimits: (kind) =>
      run(
        "list_disk_limits",
        sql<{ id: string; bytes: number }>`
          SELECT resource_id AS id, disk_bytes AS bytes
          FROM relay_disk_limits
          WHERE kind = ${kind}
        `.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.id, row.bytes])))
        )
      ),
    setDiskLimit: (kind, id, bytes) =>
      run(
        "set_disk_limit",
        (bytes === null
          ? sql`
              DELETE FROM relay_disk_limits
              WHERE kind = ${kind} AND resource_id = ${id}
            `
          : sql`
              INSERT INTO relay_disk_limits (kind, resource_id, disk_bytes)
              VALUES (${kind}, ${id}, ${bytes})
              ON CONFLICT (kind, resource_id) DO UPDATE
              SET disk_bytes = excluded.disk_bytes
            `
        ).pipe(Effect.asVoid)
      ),
    getPendingPrimaryPort: (instanceId) =>
      run(
        "get_pending_primary_port",
        pendingPrimaryPorts(instanceId).pipe(
          Effect.map((ports) => ports[0] ?? null)
        )
      ),
    listPendingPrimaryPorts: () =>
      run("list_pending_primary_ports", pendingPrimaryPorts()),
    listLifecycleSessions: () =>
      run("list_lifecycle_sessions", lifecycleSessions()),
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
            // A revoked Hearth no longer holds the Relay paused.
            yield* sql`DELETE FROM relay_pause_holds WHERE client_id = ${clientId}`
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
    setVolumeName: (volumeId, name) =>
      run(
        "set_volume_name",
        sql`
          INSERT INTO relay_volume_names (volume_id, name, updated_at)
          VALUES (${volumeId}, ${name}, ${Date.now()})
          ON CONFLICT (volume_id) DO UPDATE
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
    setLifecycleSession: (session) =>
      run(
        "set_lifecycle_session",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_instance_lifecycle_events
              WHERE instance_id = ${session.instanceId}
            `
            yield* Effect.forEach(
              session.events,
              (event) =>
                sql`
                  INSERT INTO relay_instance_lifecycle_events (
                    instance_id,
                    state,
                    time
                  ) VALUES (
                    ${session.instanceId},
                    ${event.state},
                    ${event.time}
                  )
                `,
              { discard: true }
            )
          })
        )
      ),
    deleteInstanceName: (instanceId) =>
      run(
        "delete_instance_name",
        sql`
          DELETE FROM relay_instance_names WHERE instance_id = ${instanceId}
        `.pipe(Effect.asVoid)
      ),
    deleteVolumeName: (volumeId) =>
      run(
        "delete_volume_name",
        sql`
          DELETE FROM relay_volume_names WHERE volume_id = ${volumeId}
        `.pipe(Effect.asVoid)
      ),
    listAppVolumeReferences: () =>
      run(
        "list_app_volume_references",
        sql<RelayAppVolumeReference>`
          SELECT client_id AS clientId, app_id AS appId, volume_id AS volumeId
          FROM relay_app_volume_references
          ORDER BY client_id ASC, app_id ASC, volume_id ASC
        `
      ),
    listVolumeReferenceImports: () =>
      run(
        "list_volume_reference_imports",
        sql<{
          clientId: string
          connectionId: string
          importedAt: number
          unresolvedJson: string
        }>`
          SELECT client_id AS clientId, connection_id AS connectionId,
            imported_at AS importedAt, unresolved_json AS unresolvedJson
          FROM relay_volume_reference_imports
          ORDER BY client_id ASC
        `.pipe(
          Effect.map((rows) =>
            rows.map((row): RelayVolumeReferenceImport => ({
              clientId: row.clientId,
              connectionId: row.connectionId,
              importedAt: row.importedAt,
              unresolvedAppIds: decodeUnresolved(row.unresolvedJson),
            }))
          )
        )
      ),
    replaceAppVolumeReferences: (clientId, appId, volumeIds) =>
      run(
        "replace_app_volume_references",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_app_volume_references
              WHERE client_id = ${clientId} AND app_id = ${appId}
            `
            yield* insertAppVolumeReferences(clientId, appId, volumeIds)
            yield* resolveAppVolumeReferences(clientId, new Set([appId]))
          })
        )
      ),
    importAppVolumeReferences: (
      clientId,
      connectionId,
      apps,
      unresolvedAppIds
    ) =>
      run(
        "import_app_volume_references",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_app_volume_references
              WHERE client_id = ${clientId}
            `
            for (const app of apps) {
              yield* insertAppVolumeReferences(
                clientId,
                app.appId,
                app.volumeIds
              )
            }
            const unresolved = JSON.stringify([...new Set(unresolvedAppIds)])
            yield* sql`
              INSERT INTO relay_volume_reference_imports (
                client_id, connection_id, imported_at, unresolved_json
              ) VALUES (
                ${clientId}, ${connectionId}, ${Date.now()}, ${unresolved}
              )
              ON CONFLICT (client_id) DO UPDATE
              SET connection_id = excluded.connection_id,
                  imported_at = excluded.imported_at,
                  unresolved_json = excluded.unresolved_json
            `
          })
        )
      ),
    deleteAppVolumeReferences: (clientId, appId) =>
      run(
        "delete_app_volume_references",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM relay_app_volume_references
              WHERE client_id = ${clientId} AND app_id = ${appId}
            `
            yield* resolveAppVolumeReferences(clientId, new Set([appId]))
          })
        )
      ),
    holdVolumeReferenceImport: (clientId) =>
      run(
        "hold_volume_reference_import",
        sql`
          DELETE FROM relay_volume_reference_imports
          WHERE client_id = ${clientId}
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
    deleteLifecycleSession: (instanceId) =>
      run(
        "delete_lifecycle_session",
        sql`
          DELETE FROM relay_instance_lifecycle_events
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
                  service,
                  strip_prefix,
                  target_port,
                  www,
                  https_redirect,
                  is_primary,
                  redirect_to,
                  redirect_permanent,
                  redirect_preserve_path,
                  created_at,
                  updated_at
                ) VALUES (
                  ${route.id},
                  ${instanceId},
                  ${route.hostname},
                  ${route.name},
                  ${route.path ?? ""},
                  ${route.service ?? null},
                  ${route.stripPrefix ? 1 : 0},
                  ${route.targetPort},
                  ${route.www},
                  ${route.httpsRedirect ? 1 : 0},
                  ${route.primary ? 1 : 0},
                  ${route.redirect?.to ?? null},
                  ${route.redirect?.permanent === false ? 0 : 1},
                  ${route.redirect?.preservePath === false ? 0 : 1},
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
