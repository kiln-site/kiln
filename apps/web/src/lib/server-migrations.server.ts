/**
 * Copying a game server to a new one: a duplicate, on any Relay the person
 * may create servers on, or a move to another Relay, which hands the old
 * server's place to the copy. The copy is always a new server with its own
 * ID. A migration is a durable operation (`server.migration`,
 * docs/hearth-operations.md): its locks hold the old server and the copy for
 * as long as it runs, and its workflow's steps, stored as each finishes,
 * carry it on after Hearth restarts. `server_migration` keeps how far it got
 * and how it ended, for its person and for activity history. A copy that
 * fails or is cancelled before it's finished is removed and the old server
 * put back as it was; the person is told how it ended either way.
 */
import { randomUUID } from "node:crypto"

import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  relayControlDeadlineMs,
  relayCreateInstanceSchema,
  relayInstanceWebRouteStateSchema,
  relaySnapshotSchema,
  type RelayInstance,
} from "@workspace/contracts"
import { Cause, Clock, Duration, Effect, Schedule, Schema } from "effect"
import { Activity } from "effect/workflow"
import type { RowDataPacket } from "mysql2/promise"

import {
  getBackupCatalogRecordEffect,
  linkInstanceBackupsEffect,
  reserveInstanceBackupEffect,
} from "@/effect/backups"
import { Database } from "@/effect/database"
import { DatabaseError } from "@/effect/errors"
import { setInstanceDomainOptOutEffect } from "@/effect/domains"
import {
  notifyUsersEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import { findResourceDeletionEffect } from "@/effect/resource-deletions"
import { forkAppEffect } from "@/effect/runtime"
import {
  copyInstanceAccessEffect,
  publishResourceAccessChange,
} from "@/lib/access-policy-mutations"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { advanceAuthorizationRevisionEffect } from "@/lib/authorization-revision"
import { backupStorageSettingsKey } from "@/lib/backup-lanes"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { resolveAuthorizedBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { activeRelay, type PersistedRelay } from "@/lib/relay-registry"
import { requestResourceDeletionEffect } from "@/lib/resource-deletion.server"
import { relayResourceLimitsRequest } from "@/lib/resource-limits.server"
import {
  instanceScope,
  relayScope,
  resolveScopeAuthorization,
} from "@/lib/scope-authorization.server"
import {
  serverMigrationOptionsSchema,
  type ServerMigrationOptions,
} from "@/lib/server-migration-input"
import { checkMigrationRoom } from "@/lib/server-migration-room.server"
import { provisioningInstanceId } from "@/lib/provisioning.server"
import { provisionServer } from "@/lib/server-provisioning.server"
import { currentActingUser } from "@/operations/acting-user"
import {
  durableOperation,
  queueDurableOperation,
  startDurableOperation,
  whileMySqlIsAway,
} from "@/operations/durable"
import {
  exclusive,
  partKey,
  relayKey,
  resourceKey,
  shared,
} from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { brickRecipeDefinition } from "@/server/bricks"
import { loadInstanceRecipe } from "@/server/bricks.server"
import {
  moveInstanceDomainsEffect,
  provisionInstanceDomainBestEffort,
} from "@/server/domains.server"
import {
  advanceRelayTransferEffect,
  beginRelayTransferEffect,
  type RelayTransferRequest,
} from "@/server/relay-transfers.server"
import { moveResourceWebHostnamesEffect } from "@/server/web-hostnames.server"
import { webRoutesForRelay } from "@/server/web-route-compatibility.server"

// Waits look again this often, in memory, and store one step a window, so a
// long one keeps few; a window cut off, as when Hearth stops, starts again.
const POLL = Duration.seconds(2)
const WATCH_WINDOW = Duration.minutes(5)
// How many windows a new server may take to provision and its backup to
// finish: 30 minutes. The old server gets 10 minutes to stop.
const PROVISION_WINDOWS = 6
const STOP_WINDOWS = 2
// Progress is published to the person at most this often while files copy.
const PROGRESS_INTERVAL_MS = 1_000

export type ServerMigrationMode = "duplicate" | "migrate"
type MigrationState =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
// In order: the copy is made and checked for room before the old server
// is backed up or stopped, so nothing changes for a copy that can't fit,
// and the old server keeps running while the new one is built.
type MigrationStep =
  | "create"
  | "provision"
  | "backup"
  | "stop"
  | "copy"
  | "finish"

interface MigrationRow extends RowDataPacket {
  actor: unknown
  backup_id: string | null
  create_key: string
  created_at: number
  destination_instance_id: string
  destination_name: string
  destination_relay_id: string
  error: string | null
  finished_at: number | null
  id: string
  mode: ServerMigrationMode
  operation_id: string | null
  options: unknown
  received_bytes: number
  requested_by: string
  source_instance_id: string
  source_name: string
  source_relay_id: string
  source_was_running: number | null
  state: MigrationState
  step: MigrationStep
  total_bytes: number | null
  transfer_id: string | null
  updated_at: number
}

/** A migration as its person sees it. */
export interface ServerMigrationView {
  /** Whether it can still be cancelled. */
  readonly cancellable: boolean
  readonly createdAt: number
  readonly destination: {
    readonly instanceId: string
    readonly name: string
    readonly relayId: string
  }
  readonly error: string | null
  readonly finishedAt: number | null
  readonly id: string
  readonly mode: ServerMigrationMode
  readonly receivedBytes: number
  readonly source: {
    readonly instanceId: string
    readonly name: string
    readonly relayId: string
  }
  readonly state: MigrationState
  readonly step: MigrationStep
  readonly totalBytes: number | null
}

// A move that deletes its old server can't be cancelled once it's handing
// things over: its last part, asking for the old server's final backup and
// deletion, can't be taken back. Entering that step and accepting a cancel
// are each one conditional write, so exactly one of them wins.
const handingOverDeletion = `step = 'finish' AND mode = 'migrate'
  AND COALESCE(JSON_TYPE(JSON_EXTRACT(options, '$.deleteSource')), '') = 'OBJECT'`

/** Why a migration stopped, for its person. */
export class ServerMigrationError extends Schema.TaggedError<ServerMigrationError>()(
  "ServerMigrationError",
  { message: Schema.String }
) {}

// Its person cancelled it: cleaned up, not carried on.
class MigrationCancelled extends Schema.TaggedError<MigrationCancelled>()(
  "MigrationCancelled",
  {}
) {}

const Side = Schema.Struct({
  instanceId: Schema.String,
  name: Schema.String,
  relayId: Schema.String,
})

/**
 * A migration as it was asked for and checked, kept with its operation. The
 * copy's ID comes from its provisioning key, chosen before it's admitted,
 * since its locks name it. Never the person's password.
 */
const MigrationInput = Schema.Struct({
  /** The person as they signed in, read again each time they act. */
  actor: Schema.Unknown,
  /** Where a backup first goes, settled when it was asked for. */
  backupStorageIds: Schema.Array(Schema.NullOr(Schema.String)),
  createKey: Schema.String,
  destination: Side,
  migrationId: Schema.String,
  mode: Schema.Literals(["duplicate", "migrate"]),
  /** `ServerMigrationOptions`, normalized for its mode. */
  options: Schema.Unknown,
  requestedBy: Schema.String,
  source: Side,
})
export type ServerMigrationInput = typeof MigrationInput.Type

const migrationKey = (id: string) => `server-migration:${id}`

// What a migration holds while it runs. A move holds the old server whole,
// so nothing else changes it until its place is handed over. A duplicate
// lets the old server keep running, and holds its `#migration`, so it's
// copied once at a time; one that stops the old server also holds its power
// and its DNS, which starting it again provisions. Either holds the copy
// whole, both Relays shared, and each backup destination a backup first is
// reserved to.
const migrationLocks = (input: ServerMigrationInput) => {
  const source = resourceKey(
    "instance",
    input.source.relayId,
    input.source.instanceId
  )
  return [
    ...(input.mode === "migrate"
      ? [exclusive(source)]
      : [
          shared(source),
          exclusive(partKey(source, "migration")),
          ...(optionsOf(input).stopSource
            ? [
                exclusive(partKey(source, "power")),
                exclusive(partKey(source, "dns")),
              ]
            : []),
        ]),
    exclusive(
      resourceKey(
        "instance",
        input.destination.relayId,
        input.destination.instanceId
      )
    ),
    shared(relayKey(input.source.relayId)),
    shared(relayKey(input.destination.relayId)),
    ...[...new Set(input.backupStorageIds)].flatMap((id) =>
      id ? [shared(backupStorageSettingsKey(id))] : []
    ),
  ]
}

export const serverMigration = durableOperation({
  doing: (input) =>
    input.mode === "migrate"
      ? "Moving this game server"
      : "Copying this game server",
  error: ServerMigrationError,
  input: MigrationInput,
  kind: "server.migration",
  locks: migrationLocks,
  run: (input, { id }) =>
    migrationSteps(input, id).pipe(
      // However it stopped short of finishing, short of Hearth stopping,
      // it's undone as far as it got and recorded.
      Effect.catchCause((cause) => {
        // Waiting to resume, or stopped with Hearth: it carries on later.
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause as Cause.Cause<never>)
        }
        const failure = Cause.squash(cause)
        const cancelled = Schema.is(MigrationCancelled)(failure)
        return endStep(
          input.migrationId,
          cancelled ? "cancelled" : "failed",
          cancelled ? null : messageOf(failure)
        )
      }),
      Effect.annotateLogs({ "kiln.migration.id": input.migrationId })
    ),
  version: 1,
})

/**
 * Starts a migration someone confirmed, as a durable operation, and returns
 * its ID. `authorize`, what they may do, is checked first and again if it
 * waited its turn; a copy already under way of the same server, or work
 * replacing either, refuses it.
 */
export const startServerMigrationEffect = Effect.fn("serverMigrations.start")(
  function* (input: {
    readonly actor: AuthenticatedUser
    readonly backupStorageIds: ReadonlyArray<string | null>
    readonly destinationName: string
    readonly destinationRelayId: string
    readonly mode: ServerMigrationMode
    readonly options: ServerMigrationOptions
    readonly source: {
      readonly instanceId: string
      readonly name: string
      readonly relayId: string
    }
  }) {
    const createKey = randomUUID()
    const migration: ServerMigrationInput = {
      actor: input.actor,
      backupStorageIds: input.backupStorageIds,
      createKey,
      destination: {
        // The ID provisioning gives it, retried or not.
        instanceId: provisioningInstanceId(createKey),
        name: input.destinationName,
        relayId: input.destinationRelayId,
      },
      migrationId: randomUUID(),
      mode: input.mode,
      options: input.options,
      requestedBy: input.actor.id,
      source: input.source,
    }
    yield* startDurableOperation(serverMigration, migration, {
      actorId: input.actor.id,
      authorize: promiseEffect(() =>
        requireMigrationPermissions(input.actor, migration)
      ),
    })
    return migration.migrationId
  }
)

/**
 * What copying a game server needs of the person, as they asked it: its
 * files and settings, creating game servers where the copy goes, and each
 * option's own permission on the old server. Checked when it starts, and
 * again before each step that changes something.
 */
export async function requireMigrationPermissions(
  user: AuthenticatedUser,
  input: {
    readonly destination: { readonly relayId: string }
    readonly mode: ServerMigrationMode
    readonly options: unknown
    readonly source: { readonly instanceId: string; readonly relayId: string }
  }
) {
  const options = optionsOf(input)
  const authorization = await resolveScopeAuthorization({
    scope: instanceScope(input.source.relayId, input.source.instanceId),
    user,
  })
  authorization.require("instance.files.read")
  authorization.require("instance.configuration.read")
  ;(
    await resolveScopeAuthorization({
      scope: relayScope(input.destination.relayId),
      user,
    })
  ).require("instance.create")
  // Whether or not it runs now: it may be started before the copy stops
  // it, and starts again after a duplicate.
  if (options.stopSource) {
    authorization.require("instance.power.stop")
    if (input.mode === "duplicate") {
      authorization.require("instance.power.start")
    }
  }
  if (options.copyAccess) authorization.require("access.read")
  // A linked backup is the copy's to download and restore.
  if (options.linkBackups) authorization.require("backup.download")
  if (options.backup) authorization.require("backup.create")
  if (options.deleteSource) {
    authorization.require("instance.delete")
    authorization.require("backup.create")
  }
  if (options.moveDomain || options.moveWebRoutes) {
    authorization.require("instance.network.write")
  }
  return authorization
}

/** The person's migrations still running and those that ended lately. */
export const listServerMigrationsEffect = Effect.fn("serverMigrations.list")(
  function* (userId: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.queryRows<MigrationRow>(
      "serverMigrations.list",
      `SELECT * FROM ${databaseTable("server_migration")}
        WHERE requested_by = ?
          AND (state IN ('running', 'cancelling') OR updated_at > ?)
        ORDER BY created_at DESC
        LIMIT 20`,
      [userId, now - 24 * 60 * 60_000]
    )
    return rows.map(migrationView)
  }
)

/**
 * Asks the person's running migration to stop, in one write its workflow
 * sees between steps and while it waits, then undoes it.
 */
export const cancelServerMigrationEffect = Effect.fn("serverMigrations.cancel")(
  function* (userId: string, id: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "serverMigrations.cancel",
      `UPDATE ${databaseTable("server_migration")}
          SET state = 'cancelling', updated_at = ?
        WHERE id = ? AND requested_by = ? AND state = 'running'
          AND NOT (${handingOverDeletion})`,
      [now, id, userId]
    )
    if (result.affectedRows === 0) {
      const row = yield* loadMigration(id)
      return yield* new ServerMigrationError({
        message:
          row?.requested_by === userId &&
          row.state === "running" &&
          !migrationCancellable(row)
            ? "This move is handing over to the new server and can't be cancelled"
            : "This copy is no longer running",
      })
    }
  }
)

// Cancelling one migration's task: only who started it may, as its write
// requires.
const cancelMigration = operation<{ readonly id: string }>()({
  name: "server.migration.cancel",
  doing: "Cancelling this copy",
  authorize: ({ user }) => signedIn(user),
  locks: ({ input }) => [exclusive(partKey(migrationKey(input.id), "task"))],
  run: ({ context: person, input }) =>
    cancelServerMigrationEffect(person.id, input.id),
  publish: ({ context: person }) => publishMigrationChange(person.id),
})

/** Cancels one of the person's copies, as an operation. */
export function cancelServerMigration(user: AuthenticatedUser, id: string) {
  return runOperationPromise(cancelMigration, { id }, { user })
}

// ---------------------------------------------------------- the workflow

const migrationSteps = (input: ServerMigrationInput, operationId: string) =>
  Effect.gen(function* () {
    const options = optionsOf(input)
    yield* Activity.make({
      name: "record",
      execute: recordMigration(input, operationId),
    })
    yield* checkpoint(input, "create")
    yield* step(input, "create", (actor) =>
      createDestination(input, actor, options)
    )
    yield* checkpoint(input, "provision")
    yield* watch(
      input,
      "provision",
      PROVISION_WINDOWS,
      "the new server to be created",
      () => provisioned(input)
    )
    if (options.backup) {
      yield* checkpoint(input, "backup")
      yield* step(input, "backup", (actor) => reserveBackup(input, actor))
      yield* watch(input, "backup", PROVISION_WINDOWS, "the backup", () =>
        backupAvailable(input)
      )
    }
    if (options.stopSource) {
      yield* checkpoint(input, "stop")
      yield* step(input, "stop", (actor) => stopSource(input, actor))
      yield* watch(input, "stop", STOP_WINDOWS, "the server to stop", () =>
        sourceStopped(input)
      )
    }
    yield* checkpoint(input, "copy")
    // The old server's Relay packs its whole folder, under the copy's
    // transfer ID, so asking again asks under the same one.
    yield* step(input, "copy", (actor) =>
      beginRelayTransferEffect(
        actor,
        transferRequest(input),
        transferIdOf(input)
      )
    )
    yield* watch(input, "copy", null, "the files to copy", () => copied(input))
    // From here what's handed over stays handed over. A cancel accepted
    // meanwhile stops it before its next part.
    yield* checkpoint(input, "finish")
    // Before access is copied, so whoever moved it is given the access they
    // had to the old server rather than skipped as the copy's owner.
    if (input.mode === "migrate") {
      yield* step(input, "finish/owner", (actor) => handOverOwner(input, actor))
    }
    if (options.copyAccess) {
      yield* step(input, "finish/access", (actor) =>
        copyInstanceAccessEffect({
          actorId: actor.id,
          from: sideOf(input.source),
          to: sideOf(input.destination),
        }).pipe(
          Effect.flatMap((userIds) =>
            promiseEffect(() =>
              publishResourceAccessChange(userIds, [input.destination.relayId])
            )
          )
        )
      )
    }
    if (options.linkBackups) {
      yield* step(input, "finish/backups", (actor) =>
        linkInstanceBackupsEffect({
          from: sideOf(input.source),
          linkedBy: actor.id,
          to: sideOf(input.destination),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              publishBackupChange(input.source.relayId)
              publishBackupChange(input.destination.relayId)
            })
          )
        )
      )
    }
    if (input.mode === "migrate" && options.moveDomain) {
      yield* step(input, "finish/domains", (actor) =>
        Effect.gen(function* () {
          const destination = yield* relay(input.destination.relayId)
          const instance = yield* snapshotInstance(
            destination,
            input.destination.instanceId,
            actor.id
          )
          if (!instance) return yield* fail("The new server is gone")
          yield* moveInstanceDomainsEffect(sideOf(input.source), {
            ...instance,
            relayId: destination.id,
          })
        })
      )
    }
    if (input.mode === "migrate" && options.moveWebRoutes) {
      yield* step(input, "finish/routes", (actor) =>
        moveWebRoutes(input, actor)
      )
    }
    if (input.mode === "duplicate") {
      yield* step(input, "finish/restart", (actor) =>
        restartSource(input.migrationId, actor)
      )
    }
    // Last, once everything it held belongs to the copy: the old server is
    // backed up in full and then deleted, as deleting it with a final backup
    // does, queued behind this move, which holds it until it ends. Asking
    // again finds the same deletion.
    const deletion = options.deleteSource
    if (input.mode === "migrate" && deletion) {
      yield* step(input, "finish/delete", (actor) =>
        requestResourceDeletionEffect({
          finalBackup: true,
          kind: "instance",
          queued: true,
          relayId: input.source.relayId,
          resourceId: input.source.instanceId,
          user: actor,
          ...(deletion.storageId === undefined
            ? {}
            : { storageId: deletion.storageId }),
        })
      )
    }
    yield* endStep(input.migrationId, "completed", null)
  })

// One step that changes something, run once, its failure kept for the
// person. Unless the migration was cancelled meanwhile, it runs as the
// person as their account is now, while they may still do what they asked.
const step = <R>(
  input: ServerMigrationInput,
  name: string,
  run: (actor: AuthenticatedUser) => Effect.Effect<unknown, unknown, R>
) =>
  Activity.make({
    name,
    error: Schema.Union([ServerMigrationError, MigrationCancelled]),
    execute: Effect.gen(function* () {
      const row = yield* loadMigration(input.migrationId)
      if (row?.state !== "running") return yield* new MigrationCancelled()
      const actor = yield* currentActingUser(input.requestedBy, input.actor)
      yield* promiseEffect(() => requireMigrationPermissions(actor, input))
      yield* run(actor)
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(MigrationCancelled)(cause) ? cause : asMigrationError(cause)
      )
    ),
  })

const Ending = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  state: Schema.Literals(["completed", "failed", "cancelled"]),
})

// Ends the migration, as one step, and fails the operation with why, when
// it failed.
const endStep = (
  id: string,
  ending: "completed" | "failed" | "cancelled",
  error: string | null
) =>
  Activity.make({
    name: "end",
    success: Ending,
    execute: endMigrationEffect(id, ending, error).pipe(untilMySqlAnswers),
  }).pipe(
    Effect.flatMap((ended) =>
      ended.state === "failed"
        ? Effect.fail(
            new ServerMigrationError({
              message: ended.error ?? "The copy failed",
            })
          )
        : Effect.void
    )
  )

// Records the migration for its person, once, under its operation, with the
// IDs its backup first and its files' transfer take, so asking again asks
// under the same ones.
const recordMigration = (input: ServerMigrationInput, operationId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "serverMigrations.insert",
      `INSERT INTO ${databaseTable("server_migration")}
         (id, operation_id, requested_by, actor, mode, source_relay_id,
          source_instance_id, source_name, destination_relay_id,
          destination_instance_id, destination_name, create_key, options,
          backup_id, transfer_id, state, step, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'create',
               ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        input.migrationId,
        operationId,
        input.requestedBy,
        JSON.stringify(input.actor),
        input.mode,
        input.source.relayId,
        input.source.instanceId,
        input.source.name,
        input.destination.relayId,
        input.destination.instanceId,
        input.destination.name,
        input.createKey,
        JSON.stringify(input.options),
        optionsOf(input).backup ? backupIdOf(input) : null,
        transferIdOf(input),
        now,
        now,
      ]
    )
    publishMigrationChange(input.requestedBy)
  }).pipe(untilMySqlAnswers)

// Moves the migration on to `next`, unless it was cancelled meanwhile, as a
// step: what it found holds however often the workflow runs again.
const checkpoint = (input: ServerMigrationInput, next: MigrationStep) =>
  Activity.make({
    name: `at/${next}`,
    success: Schema.Boolean,
    execute: Effect.gen(function* () {
      const database = yield* Database
      const now = yield* Clock.currentTimeMillis
      const moved = yield* database.execute(
        "serverMigrations.step",
        `UPDATE ${databaseTable("server_migration")}
            SET step = ?, updated_at = ?
          WHERE id = ? AND state = 'running'`,
        [next, now, input.migrationId]
      )
      if (moved.affectedRows > 0) publishMigrationChange(input.requestedBy)
      return moved.affectedRows > 0
    }).pipe(untilMySqlAnswers),
  }).pipe(
    Effect.flatMap((running) =>
      running ? Effect.void : Effect.fail(new MigrationCancelled())
    )
  )

// Waits for `check` to be done, a window a step, failing after `windows` of
// them, unless it's null, and stopping once the migration is cancelled.
const watch = <R>(
  input: ServerMigrationInput,
  name: string,
  windows: number | null,
  what: string,
  check: () => Effect.Effect<boolean, unknown, R>
) =>
  Effect.gen(function* () {
    for (let window = 0; ; window++) {
      const found = yield* Activity.make({
        name: `${name}/${window}`,
        success: Schema.Literals(["done", "waiting", "cancelled"]),
        error: ServerMigrationError,
        execute: Effect.gen(function* () {
          const checking = check()
          const until =
            (yield* Clock.currentTimeMillis) + Duration.toMillis(WATCH_WINDOW)
          while (true) {
            if (yield* checking) return "done" as const
            const row = yield* loadMigration(input.migrationId)
            if (row?.state !== "running") return "cancelled" as const
            if ((yield* Clock.currentTimeMillis) >= until) {
              return "waiting" as const
            }
            yield* Effect.sleep(POLL)
          }
        }).pipe(Effect.mapError(asMigrationError)),
      })
      if (found === "done") return
      if (found === "cancelled") return yield* new MigrationCancelled()
      if (windows !== null && window + 1 >= windows) {
        return yield* new ServerMigrationError({
          message: `Timed out waiting for ${what}`,
        })
      }
    }
  })

// Creates the copy, stopped, from the exact Brick the old server was built
// from, with its settings, and its limits unless it was given its own.
// Repeating it resumes the same server, under the same provisioning key.
const createDestination = (
  input: ServerMigrationInput,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions
) =>
  Effect.gen(function* () {
    const [source, destination] = yield* relays(input)
    const instance = yield* snapshotInstance(
      source,
      input.source.instanceId,
      actor.id
    )
    if (!instance?.brickSource) {
      return yield* fail(
        `${input.source.name} has no Brick to build its copy from`
      )
    }
    // Before anything is made or changed: a copy that can't fit stops here.
    // One the Relay already made, before a restart cut this short, holds its
    // limits already.
    if (
      !(yield* snapshotInstance(
        destination,
        input.destination.instanceId,
        actor.id
      ))
    ) {
      yield* requireRoom(input, actor, options, true)
    }
    const recipe = yield* promiseEffect(() =>
      loadInstanceRecipe(source, instance)
    )
    const diskLimitBytes =
      (options.limits ?? instance.limits).diskBytes ??
      DEFAULT_INSTANCE_DISK_LIMIT_BYTES
    // A Relay that can't take these limits fails the copy.
    const create = yield* Effect.try({
      try: () =>
        relayCreateInstanceSchema.parse({
          diskLimitBytes,
          ...relayResourceLimitsRequest(
            destination.id,
            { cpuMillis: null, diskBytes: diskLimitBytes, memoryBytes: null },
            options.limits ?? instance.limits
          ),
          name: input.destination.name,
          recipe: recipe.brickSource,
          recipeDefinition: brickRecipeDefinition(recipe.brick),
          start: false,
          variables: instance.variables ?? {},
        }),
      catch: (cause) => cause,
    })
    // A move takes the old server's domains along, so the copy isn't given
    // one of its own when it's provisioned.
    if (input.mode === "migrate" && options.moveDomain) {
      yield* setInstanceDomainOptOutEffect(
        destination.id,
        input.destination.instanceId,
        true
      )
    }
    // Whoever copies a server owns the copy while it's built, so they may
    // fill it; a finished move hands it to the old server's owner.
    yield* promiseEffect(() =>
      provisionServer({
        create,
        idempotencyKey: input.createKey,
        ownerId: actor.id,
        relay: destination,
        requestedBy: actor.id,
      })
    )
  })

const provisioned = (input: ServerMigrationInput) =>
  Effect.gen(function* () {
    const actor = yield* currentActingUser(input.requestedBy, input.actor)
    const destination = yield* relay(input.destination.relayId)
    const instance = yield* snapshotInstance(
      destination,
      input.destination.instanceId,
      actor.id
    )
    if (instance?.provisioning?.phase === "failed") {
      return yield* fail(
        `The new server couldn't be created: ${instance.provisioning.error ?? "provisioning failed"}`
      )
    }
    return (
      instance !== null &&
      !instance.provisioning &&
      instance.observedState === "stopped"
    )
  })

// A full archive of the old server, to the destinations settled when it was
// asked for, finished before the old server stops. Under the copy's backup
// ID, a step cut off once it's reserved finds it, so it's reserved once.
const reserveBackup = (input: ServerMigrationInput, actor: AuthenticatedUser) =>
  Effect.gen(function* () {
    for (const storageId of new Set(input.backupStorageIds)) {
      if (storageId === null) continue
      yield* promiseEffect(() =>
        resolveAuthorizedBackupStorageSelection({
          relayId: input.source.relayId,
          storageId,
          targetId: input.source.instanceId,
          targetKind: "instance",
          user: actor,
        })
      )
    }
    const backupId = backupIdOf(input)
    if (yield* getBackupCatalogRecordEffect(backupId)) return
    const [source, destination] = yield* relays(input)
    const dispatch = yield* reserveInstanceBackupEffect({
      backupId,
      createdBy: actor.id,
      mode: "full",
      name: `Before ${input.mode === "migrate" ? "moving" : "copying"} to ${destination.name}`.slice(
        0,
        120
      ),
      relayId: source.id,
      requestedMaxBytes: null,
      storageIds: input.backupStorageIds,
      targetId: input.source.instanceId,
      taskId: randomUUID(),
    })
    publishBackupChange(source.id, backupId)
    // Queued on the Relay now if it answers; otherwise reconciling the
    // Relay's backups, as each check does, queues it.
    yield* promiseEffect(async () => {
      const { dispatchBackupTask } = await import("@/lib/backup-reconciliation")
      await dispatchBackupTask(source, dispatch, actor.id)
    }).pipe(Effect.ignore)
  })

const backupAvailable = (input: ServerMigrationInput) =>
  Effect.gen(function* () {
    // The Relay's tasks are read in, and a backup not yet queued there is;
    // one that can't be now is looked at again on the next check.
    yield* promiseEffect(async () => {
      const source = await activeRelay(input.source.relayId)
      const { reconcileRelayBackups } =
        await import("@/lib/backup-reconciliation")
      await reconcileRelayBackups(source)
    }).pipe(Effect.ignore)
    const backup = yield* getBackupCatalogRecordEffect(backupIdOf(input))
    if (!backup || backup.status === "failed" || backup.status === "deleted") {
      return yield* fail(
        `The backup before copying failed${backup?.taskError ? `: ${backup.taskError}` : ""}`
      )
    }
    return backup.status === "available"
  })

// Stops the old server, remembering whether it ran, so a copy taken while
// nothing writes to it is consistent.
const stopSource = (input: ServerMigrationInput, actor: AuthenticatedUser) =>
  Effect.gen(function* () {
    const source = yield* relay(input.source.relayId)
    const row = yield* loadMigration(input.migrationId)
    // Asked again before the server stops, since other work may have filled
    // a disk since the copy was made. Its limits are already reserved, and
    // a backup first already taken.
    if (row?.source_was_running == null) {
      yield* requireRoom(input, actor, null, false)
    }
    const instance = yield* snapshotInstance(
      source,
      input.source.instanceId,
      actor.id
    )
    if (!instance) return yield* fail(`${input.source.name} no longer exists`)
    const database = yield* Database
    yield* database.execute(
      "serverMigrations.sourceWasRunning",
      `UPDATE ${databaseTable("server_migration")}
          SET source_was_running = ?
        WHERE id = ? AND source_was_running IS NULL`,
      [instance.observedState === "stopped" ? 0 : 1, input.migrationId]
    )
    if (instance.observedState !== "stopped") {
      yield* rpc(source, "instance.action", actor.id, {
        action: "stop",
        instanceId: input.source.instanceId,
      })
    }
  })

const sourceStopped = (input: ServerMigrationInput) =>
  Effect.gen(function* () {
    const actor = yield* currentActingUser(input.requestedBy, input.actor)
    const source = yield* relay(input.source.relayId)
    const current = yield* snapshotInstance(
      source,
      input.source.instanceId,
      actor.id
    )
    return !current || current.observedState === "stopped"
  })

// Copies the folder into the new server's, Relay to Relay, publishing
// progress as it goes.
const copied = (input: ServerMigrationInput) => {
  let publishedAt = 0
  return Effect.gen(function* () {
    const actor = yield* currentActingUser(input.requestedBy, input.actor)
    const status = yield* advanceRelayTransferEffect(
      actor,
      transferRequest(input),
      transferIdOf(input)
    )
    if (status.phase === "failed" || status.phase === "cancelled") {
      return yield* fail(
        `Copying the files failed: ${status.error ?? status.phase}`
      )
    }
    const now = yield* Clock.currentTimeMillis
    if (now - publishedAt > PROGRESS_INTERVAL_MS) {
      publishedAt = now
      const database = yield* Database
      yield* database.execute(
        "serverMigrations.progress",
        `UPDATE ${databaseTable("server_migration")}
            SET received_bytes = ?, total_bytes = ?, updated_at = ?
          WHERE id = ?`,
        [status.receivedBytes, status.size, now, input.migrationId]
      )
      publishMigrationChange(input.requestedBy)
    }
    return status.phase === "completed"
  })
}

// A moved server keeps its owner: the copy passes from whoever moved it to
// the old server's owner, and both see their authority change.
const handOverOwner = (input: ServerMigrationInput, actor: AuthenticatedUser) =>
  Effect.gen(function* () {
    const database = yield* Database
    const [owner] = yield* database.queryRows<
      RowDataPacket & { owner_id: string | null }
    >(
      "serverMigrations.owner",
      `SELECT owner_id FROM ${databaseTable("instance")}
        WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
      [input.source.relayId, input.source.instanceId]
    )
    const ownerId = owner?.owner_id
    if (!ownerId || ownerId === actor.id) return
    yield* database.transaction(
      "serverMigrations.handOverOwner",
      (transaction) =>
        Effect.gen(function* () {
          yield* transaction.execute(
            `UPDATE ${databaseTable("instance")}
                SET owner_id = ?, owner_provisional = 0
              WHERE relay_id = ? AND instance_id = ?`,
            [ownerId, input.destination.relayId, input.destination.instanceId]
          )
          for (const userId of [actor.id, ownerId]) {
            yield* advanceAuthorizationRevisionEffect(transaction, {
              targets: [
                {
                  relayId: input.destination.relayId,
                  scope: {
                    instanceId: input.destination.instanceId,
                    kind: "instance",
                  },
                },
              ],
              userId,
            })
          }
        })
    )
    yield* promiseEffect(() =>
      publishResourceAccessChange(
        [actor.id, ownerId],
        [input.destination.relayId]
      )
    )
  })

const moveWebRoutes = (input: ServerMigrationInput, actor: AuthenticatedUser) =>
  Effect.gen(function* () {
    const [source, destination] = yield* relays(input)
    const state = relayInstanceWebRouteStateSchema.parse(
      yield* rpc(source, "instance.network.routes.read", actor.id, {
        instanceId: input.source.instanceId,
      })
    )
    // Run again after the routes moved, it finds none, and still hands the
    // hostnames over.
    if (state.routes.length > 0) {
      const routes = yield* Effect.try(() =>
        webRoutesForRelay(
          destination.id,
          state.routes.map(({ id: _id, ...route }) => route)
        )
      )
      yield* rpc(destination, "instance.network.routes.write", actor.id, {
        instanceId: input.destination.instanceId,
        routes,
      })
      yield* rpc(source, "instance.network.routes.write", actor.id, {
        instanceId: input.source.instanceId,
        routes: [],
      })
    }
    // Its hostnames belong to the copy now, and their DNS records point at
    // its Relay.
    yield* moveResourceWebHostnamesEffect(
      {
        relayId: input.source.relayId,
        resourceId: input.source.instanceId,
        resourceType: "instance",
      },
      {
        relayId: destination.id,
        resourceId: input.destination.instanceId,
        resourceType: "instance",
      }
    )
  })

// The old server goes back to running if it ran before the copy stopped it:
// as the person, as a duplicate's last part, or as Hearth, undoing the copy.
const restartSource = (id: string, actor: AuthenticatedUser | null) =>
  Effect.gen(function* () {
    const row = yield* loadMigration(id)
    if (row?.source_was_running !== 1) return
    const source = yield* relay(row.source_relay_id)
    const instance = yield* snapshotInstance(
      source,
      row.source_instance_id,
      actor?.id
    )
    if (!instance || instance.observedState !== "stopped") return
    yield* rpc(source, "instance.action", actor?.id, {
      action: "start",
      instanceId: row.source_instance_id,
    })
    yield* promiseEffect(() =>
      provisionInstanceDomainBestEffort(instance, source.id)
    )
  })

/**
 * Ends a migration and tells its person. A copy that didn't finish is
 * removed, and the old server is started again if the copy stopped it. One
 * that failed or was cancelled while handing things over keeps its new
 * server, since it may hold what was already moved to it.
 *
 * Undoing it is Hearth's own work, whoever asked: it only takes back what
 * the copy itself did, so it goes on even once the person can't act, and
 * leaves nothing stranded. Its Relay requests go as Hearth's. Removing the
 * partial copy is a deletion for the person, the copy's owner, as any is,
 * queued behind the migration; if their account can no longer act, it
 * stops and says so on the copy's page, for an administrator to finish.
 */
const endMigrationEffect = (
  id: string,
  ending: "completed" | "failed" | "cancelled",
  endingError: string | null
) =>
  Effect.gen(function* () {
    const row = yield* loadMigration(id)
    if (!row) return yield* Effect.die(`Server migration ${id} is gone`)
    // Ended already, by this same step cut short after it wrote.
    if (row.state !== "running" && row.state !== "cancelling") {
      yield* notifyEnded(row, row.state, row.error)
      return {
        error: row.error,
        state: row.state as "completed" | "failed" | "cancelled",
      }
    }
    const options = rowOptions(row)
    // Handing the old server to its deletion is the move's last part, and
    // can't be taken back: once it's asked for, the move is done, and the
    // old server stays stopped for it, however the move ended.
    const sourceDeleting =
      ending !== "completed" &&
      row.mode === "migrate" &&
      row.step === "finish" &&
      options.deleteSource !== null &&
      sourceHandedToDeletion(
        yield* findResourceDeletionEffect(
          row.source_relay_id,
          "instance",
          row.source_instance_id
        )
      )
    const database = yield* Database
    let state = sourceDeleting ? "completed" : ending
    const error = sourceDeleting ? null : endingError
    if (state === "completed" && !sourceDeleting) {
      // Finished only while no cancel was accepted, in one write: a cancel
      // accepted first wins, and it's undone as any cancelled copy is.
      const finished = yield* database.execute(
        "serverMigrations.complete",
        `UPDATE ${databaseTable("server_migration")}
            SET state = 'completed', error = NULL, finished_at = ?,
                updated_at = ?
          WHERE id = ? AND state = 'running'`,
        [yield* Clock.currentTimeMillis, yield* Clock.currentTimeMillis, id]
      )
      if (finished.affectedRows > 0) {
        yield* notifyEnded(row, "completed", null)
        return { error: null, state: "completed" as const }
      }
      state = "cancelled"
    }
    const cleanup: Array<string> = []
    if (state !== "completed") {
      // Shown as ending, and no longer cancellable, while it's undone.
      yield* database.execute(
        "serverMigrations.ending",
        `UPDATE ${databaseTable("server_migration")}
            SET state = 'cancelling', error = ?, updated_at = ?
          WHERE id = ? AND state IN ('running', 'cancelling')`,
        [error?.slice(0, 512) ?? null, yield* Clock.currentTimeMillis, id]
      )
      publishMigrationChange(row.requested_by)
      if (row.transfer_id && (row.step === "copy" || row.step === "finish")) {
        yield* discardTransfer(row, row.transfer_id)
      }
      if (row.step !== "finish" && (yield* destinationRecorded(row))) {
        const person = yield* currentActingUser(
          row.requested_by,
          row.actor
        ).pipe(
          Effect.orElseSucceed(() => parsed(row.actor) as AuthenticatedUser)
        )
        yield* requestResourceDeletionEffect({
          finalBackup: false,
          kind: "instance",
          queued: true,
          relayId: row.destination_relay_id,
          resourceId: row.destination_instance_id,
          user: person,
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              cleanup.push(
                `The partial copy ${row.destination_name} couldn't be removed: ${messageOf(cause)}`
              )
            })
          )
        )
      }
      yield* restartSource(id, null).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            cleanup.push(
              `${row.source_name} couldn't be started again: ${messageOf(cause)}`
            )
          })
        )
      )
    }
    const message = [error, ...cleanup].filter(Boolean).join(". ") || null
    yield* database.execute(
      "serverMigrations.end",
      `UPDATE ${databaseTable("server_migration")}
          SET state = ?, error = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('running', 'cancelling')`,
      [
        state,
        message?.slice(0, 512) ?? null,
        yield* Clock.currentTimeMillis,
        yield* Clock.currentTimeMillis,
        id,
      ]
    )
    yield* notifyEnded(row, state, message)
    return { error: message, state }
  })

// Tells the migration's person how it ended, once however often it's told.
const notifyEnded = (
  row: MigrationRow,
  state: "completed" | "failed" | "cancelled",
  message: string | null
) =>
  notifyUsersEffect([row.requested_by], `server.migration:${row.id}`, {
    destination: {
      id: row.destination_instance_id,
      name: row.destination_name,
      relayId: row.destination_relay_id,
      type: "instance",
    },
    ...(message ? { error: message } : {}),
    ...(state === "completed" &&
    row.mode === "migrate" &&
    rowOptions(row).deleteSource
      ? { sourceDeleting: true }
      : {}),
    kind: "server.migration",
    migrationId: row.id,
    mode: row.mode,
    outcome: state,
    source: {
      id: row.source_instance_id,
      name: row.source_name,
      relayId: row.source_relay_id,
      type: "instance",
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        publishNotificationChange([row.requested_by])
        publishMigrationChange(row.requested_by)
      })
    )
  )

// Deletes what either Relay packed or fetched for the copy, as Hearth's.
const discardTransfer = (row: MigrationRow, transferId: string) =>
  Effect.forEach(
    [
      [
        "transfer.pull.cancel",
        row.destination_relay_id,
        row.destination_instance_id,
      ],
      ["transfer.source.discard", row.source_relay_id, row.source_instance_id],
    ] as const,
    ([operation, relayId, rootId]) =>
      relay(relayId).pipe(
        Effect.flatMap((found) =>
          rpc(found, operation, undefined, { rootId, transferId })
        ),
        Effect.ignore
      ),
    { discard: true }
  )

// Whether Hearth recorded the copy, as provisioning does before it asks the
// Relay, and keeps when it can't tell whether the Relay made it.
const destinationRecorded = (row: MigrationRow) =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket>(
      "serverMigrations.destination",
      `SELECT 1 FROM ${databaseTable("instance")}
        WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
      [row.destination_relay_id, row.destination_instance_id]
    )
    return rows.length > 0
  })

// ------------------------------------------------- migrations from before

const LegacyInput = Schema.Struct({
  destination: Schema.Struct({
    instanceId: Schema.String,
    relayId: Schema.String,
  }),
  migrationId: Schema.String,
  source: Schema.Struct({ instanceId: Schema.String, relayId: Schema.String }),
})

/**
 * Ends a migration a Hearth from before migrations were operations left
 * running: it isn't carried on, but undone as any failed one is, holding
 * both servers whole and their Relays shared while it is.
 */
export const rollBackLegacyServerMigration = durableOperation({
  doing: () => "Undoing a copy of this game server",
  input: LegacyInput,
  kind: "server.migration.rollback-legacy",
  locks: (input) => [
    exclusive(
      resourceKey("instance", input.source.relayId, input.source.instanceId)
    ),
    exclusive(
      resourceKey(
        "instance",
        input.destination.relayId,
        input.destination.instanceId
      )
    ),
    shared(relayKey(input.source.relayId)),
    shared(relayKey(input.destination.relayId)),
  ],
  run: (input) =>
    Activity.make({
      name: "end",
      success: Ending,
      execute: Effect.gen(function* () {
        const row = yield* loadMigration(input.migrationId)
        if (!row) return { error: null, state: "cancelled" as const }
        const cancelled = row.state === "cancelling" && !row.error
        return yield* endMigrationEffect(
          input.migrationId,
          cancelled ? "cancelled" : "failed",
          cancelled
            ? null
            : (row.error ??
                "Hearth was updated while this copy ran, so it was stopped and undone. Start it again.")
        )
      }).pipe(untilMySqlAnswers),
    }).pipe(Effect.asVoid),
  version: 1,
})

/**
 * Queues the undoing of each migration a Hearth from before migrations were
 * operations left running, once each, by its ID.
 */
export const rollBackLegacyServerMigrationsEffect = Effect.fn(
  "serverMigrations.rollBackLegacy"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<MigrationRow>(
    "serverMigrations.legacy",
    `SELECT * FROM ${databaseTable("server_migration")}
      WHERE state IN ('running', 'cancelling') AND operation_id IS NULL`
  )
  for (const row of rows) {
    yield* queueDurableOperation(
      rollBackLegacyServerMigration,
      {
        destination: {
          instanceId: row.destination_instance_id,
          relayId: row.destination_relay_id,
        },
        migrationId: row.id,
        source: {
          instanceId: row.source_instance_id,
          relayId: row.source_relay_id,
        },
      },
      { actorId: row.requested_by, idempotencyKey: row.id }
    )
  }
})

/** Undoes migrations an earlier Hearth left running, at startup. */
export function startLegacyServerMigrationRollback(): void {
  forkAppEffect(
    "serverMigrations.rollBackLegacy",
    rollBackLegacyServerMigrationsEffect().pipe(
      Effect.retry(Schedule.spaced("30 seconds")),
      Effect.ignore
    )
  )
}

// ---------------------------------------------------------- helpers

// Fails unless the copy still fits: its limits, before it's created, and
// the disk the move needs on both Relays.
const requireRoom = (
  input: ServerMigrationInput,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions | null,
  limits: boolean
) =>
  Effect.gen(function* () {
    const [source, destination] = yield* relays(input)
    const copy = optionsOf(input)
    const problems = yield* promiseEffect(() =>
      checkMigrationRoom({
        backup: options?.backup ?? null,
        copyLimits: copy.limits,
        destination,
        instanceId: input.source.instanceId,
        limits,
        source,
        subject: actor.id,
      })
    )
    if (problems.length) {
      return yield* fail(problems.map((problem) => problem.message).join(". "))
    }
  })

const loadMigration = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<MigrationRow>(
      "serverMigrations.load",
      `SELECT * FROM ${databaseTable("server_migration")} WHERE id = ? LIMIT 1`,
      [id]
    )
    return rows[0] ?? null
  })

function relay(id: string) {
  return promiseEffect(() => activeRelay(id))
}

function relays(input: ServerMigrationInput) {
  return Effect.all(
    [relay(input.source.relayId), relay(input.destination.relayId)],
    { concurrency: 2 }
  )
}

function snapshotInstance(
  relay: PersistedRelay,
  instanceId: string,
  subject: string | undefined
): Effect.Effect<RelayInstance | null, unknown> {
  return rpc(relay, "relay.snapshot", subject, {}).pipe(
    Effect.map(
      (value) =>
        relaySnapshotSchema
          .parse(value)
          .instances.find((instance) => instance.id === instanceId) ?? null
    )
  )
}

// A Relay request as the person, whose permissions the Relay checks too, or
// as Hearth's own, with no subject.
function rpc(
  relay: PersistedRelay,
  operation:
    | "instance.action"
    | "instance.network.routes.read"
    | "instance.network.routes.write"
    | "relay.snapshot"
    | "transfer.pull.cancel"
    | "transfer.source.discard",
  subject: string | undefined,
  payload: unknown
) {
  return promiseEffect(async () => {
    const { relayRpc } = await import("@/lib/relay-connection")
    return relayRpc(
      relay,
      operation,
      payload,
      operation === "instance.action"
        ? relayControlDeadlineMs("instance.action")
        : 30_000,
      subject
    )
  })
}

// A copy's backup first and its files' transfer are named after it.
function backupIdOf(input: ServerMigrationInput) {
  return input.migrationId
}

function transferIdOf(input: ServerMigrationInput) {
  return input.migrationId.replaceAll("-", "")
}

function transferRequest(input: ServerMigrationInput): RelayTransferRequest {
  return {
    destination: {
      path: "",
      relayId: input.destination.relayId,
      rootId: input.destination.instanceId,
    },
    source: {
      paths: [],
      relayId: input.source.relayId,
      rootId: input.source.instanceId,
    },
  }
}

function sideOf(side: {
  readonly instanceId: string
  readonly relayId: string
}) {
  return { instanceId: side.instanceId, relayId: side.relayId }
}

function optionsOf(
  input: Pick<ServerMigrationInput, "options">
): ServerMigrationOptions {
  return serverMigrationOptionsSchema.parse(input.options)
}

function rowOptions(row: MigrationRow): ServerMigrationOptions {
  return optionsOf({ options: parsed(row.options) })
}

// A JSON column, as mysql2 reads it: parsed, or still its text.
function parsed(saved: unknown): unknown {
  return typeof saved === "string" ? JSON.parse(saved) : saved
}

function migrationView(row: MigrationRow): ServerMigrationView {
  return {
    cancellable: row.state === "running" && migrationCancellable(row),
    createdAt: Number(row.created_at),
    destination: {
      instanceId: row.destination_instance_id,
      name: row.destination_name,
      relayId: row.destination_relay_id,
    },
    error: row.error,
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    id: row.id,
    mode: row.mode,
    receivedBytes: Number(row.received_bytes),
    source: {
      instanceId: row.source_instance_id,
      name: row.source_name,
      relayId: row.source_relay_id,
    },
    state: row.state,
    step: row.step,
    totalBytes: row.total_bytes === null ? null : Number(row.total_bytes),
  }
}

// The old server's deletion was asked for and hasn't stopped: the move is
// done, however its last part ended.
function sourceHandedToDeletion(deletion: { status: string } | null): boolean {
  return (
    deletion !== null &&
    deletion.status !== "failed" &&
    deletion.status !== "cancelled"
  )
}

function migrationCancellable(row: MigrationRow): boolean {
  return !(
    row.step === "finish" &&
    row.mode === "migrate" &&
    rowOptions(row).deleteSource !== null
  )
}

function publishMigrationChange(userId: string) {
  publishRealtimeChange({
    audience: { kind: "users", userIds: [userId] },
    topics: ["server-migrations"],
    type: "hearth.invalidate",
  })
}

// A step of the migration's own bookkeeping is tried again until MySQL
// answers, so a passing outage doesn't leave it holding its locks for good.
const untilMySqlAnswers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: whileMySqlIsAway,
      while: (error) => Schema.is(DatabaseError)(error),
    }),
    Effect.orDie
  )

function fail(message: string) {
  return Effect.fail(new ServerMigrationError({ message }))
}

function asMigrationError(cause: unknown): ServerMigrationError {
  return Schema.is(ServerMigrationError)(cause)
    ? cause
    : new ServerMigrationError({ message: messageOf(cause) })
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message
  }
  return String(cause)
}
