/**
 * Copying a resource to a new one: a duplicate, on any Relay the person may
 * create one on, or a move to another Relay, which hands the old one's
 * place to the copy. The copy is always a new resource with its own ID. A
 * migration is a durable operation (`resource.migration`,
 * docs/hearth-operations.md): its locks hold the old one and the copy for as
 * long as it runs, and its workflow's steps, stored as each finishes, carry
 * it on after Hearth restarts. `resource_migration` keeps how far it got and
 * how it ended, for its person and for activity history. A copy that fails
 * or is cancelled before it's finished is removed and the old one put back
 * as it was; the person is told how it ended either way.
 *
 * This is the same for every kind of resource. What a kind adds, as how its
 * copy is made and where its data is, is its `MigratedKind`
 * (`resource-migration-kinds/`).
 */
import { randomUUID } from "node:crypto"

import { Cause, Clock, Duration, Effect, Result, Schema } from "effect"
import { Activity } from "effect/workflow"
import type { RowDataPacket } from "mysql2/promise"

import { getBackupCatalogRecordEffect } from "@/effect/backups"
import { Database } from "@/effect/database"
import { DatabaseError } from "@/effect/errors"
import {
  notifyUsersEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import { findResourceDeletionEffect } from "@/effect/resource-deletions"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { backupStorageSettingsKey } from "@/lib/backup-lanes"
import { databaseTable } from "@/lib/database-config"
import {
  relayRequest,
  type MigratedKind,
  type Migration,
  type MigrationHandOver,
  type MigrationPart,
} from "@/lib/resource-migration-kinds/kind.server"
import {
  migratedKind,
  requireMigrationPermissions,
} from "@/lib/resource-migration-kinds/registry.server"
import { checkMigrationRoom } from "@/lib/resource-migration-room.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { activeRelay } from "@/lib/relay-registry"
import { requestResourceDeletionEffect } from "@/lib/resource-deletion.server"
import {
  resourceMigrationOptionsSchema,
  type MigratedKindName,
  type ResourceMigrationOptions,
} from "@/lib/resource-migration-input"
import { currentActingUser } from "@/operations/acting-user"
import {
  durableOperation,
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
import {
  advanceRelayTransferEffect,
  beginRelayTransferEffect,
  type RelayTransferRequest,
} from "@/server/relay-transfers.server"

// Waits look again this often, in memory, and store one step a window, so a
// long one keeps few; a window cut off, as when Hearth stops, starts again.
const POLL = Duration.seconds(2)
const WATCH_WINDOW = Duration.minutes(5)
// How many windows a new server may take to provision and its backup to
// finish: 30 minutes. The old server gets 10 minutes to stop.
const PROVISION_WINDOWS = 6
const STOP_WINDOWS = 2
// How long the copy's Relay may take to serve it, which is near at once.
const SERVE_WITHIN = Duration.seconds(20)
// Progress is published to the person at most this often while files copy.
const PROGRESS_INTERVAL_MS = 1_000

export type ResourceMigrationMode = "duplicate" | "migrate"
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
  | "deploy"
  | "finish"

interface MigrationRow extends RowDataPacket {
  actor: unknown
  backup_id: string | null
  create_key: string
  created_at: number
  destination_id: string
  destination_name: string
  destination_relay_id: string
  error: string | null
  finished_at: number | null
  id: string
  kind: MigratedKindName
  mode: ResourceMigrationMode
  operation_id: string | null
  options: unknown
  /** Which of its parts is being copied, from 1, and how many it has. */
  part: number
  /** The parts it settled on, as JSON, once it has. */
  part_roots: unknown
  parts: number
  received_bytes: number
  requested_by: string
  source_id: string
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
export interface ResourceMigrationView {
  /** Whether it can still be cancelled. */
  readonly cancellable: boolean
  readonly createdAt: number
  readonly destination: {
    readonly id: string
    readonly name: string
    readonly relayId: string
  }
  readonly error: string | null
  readonly finishedAt: number | null
  readonly id: string
  readonly kind: MigratedKindName
  readonly mode: ResourceMigrationMode
  /** Which of its parts is being copied, from 1, and how many it has. */
  readonly part: number
  readonly parts: number
  readonly receivedBytes: number
  readonly source: {
    readonly id: string
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
export class ResourceMigrationError extends Schema.TaggedError<ResourceMigrationError>()(
  "ResourceMigrationError",
  { message: Schema.String }
) {}

// Its person cancelled it: cleaned up, not carried on.
class MigrationCancelled extends Schema.TaggedError<MigrationCancelled>()(
  "MigrationCancelled",
  {}
) {}

const Side = Schema.Struct({
  id: Schema.String,
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
  kind: Schema.Literals(["instance", "database", "app", "volume"]),
  migrationId: Schema.String,
  mode: Schema.Literals(["duplicate", "migrate"]),
  /** `ResourceMigrationOptions`, normalized for its mode. */
  options: Schema.Unknown,
  requestedBy: Schema.String,
  source: Side,
})
export type ResourceMigrationInput = typeof MigrationInput.Type

const migrationKey = (id: string) => `resource-migration:${id}`

const kindOf = (migration: { readonly kind: MigratedKindName }): MigratedKind =>
  migratedKind(migration.kind)

// What a migration holds while it runs. A move holds the old one whole, so
// nothing else changes it until its place is handed over. A duplicate lets
// the old one keep running, and holds its `#migration`, so it's copied once
// at a time; one that stops the old one also holds its power and its DNS,
// which starting it again provisions. Either holds the copy whole, both
// Relays shared, and each backup destination a backup first is reserved to.
const migrationLocks = (input: ResourceMigrationInput) => {
  const { kind, powered } = kindOf(input)
  const source = resourceKey(kind, input.source.relayId, input.source.id)
  return [
    ...(input.mode === "migrate"
      ? [exclusive(source)]
      : [
          shared(source),
          exclusive(partKey(source, "migration")),
          ...(optionsOf(input).stopSource && powered
            ? [
                exclusive(partKey(source, "power")),
                exclusive(partKey(source, "dns")),
              ]
            : []),
        ]),
    exclusive(
      resourceKey(kind, input.destination.relayId, input.destination.id)
    ),
    shared(relayKey(input.source.relayId)),
    shared(relayKey(input.destination.relayId)),
    ...[...new Set(input.backupStorageIds)].flatMap((id) =>
      id ? [shared(backupStorageSettingsKey(id))] : []
    ),
  ]
}

export const resourceMigration = durableOperation({
  doing: (input) =>
    `${input.mode === "migrate" ? "Moving" : "Copying"} this ${kindOf(input).noun}`,
  error: ResourceMigrationError,
  input: MigrationInput,
  kind: "resource.migration",
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
 * waited its turn; a copy already under way of the same resource, or work
 * replacing either, refuses it.
 */
export const startResourceMigrationEffect = Effect.fn(
  "resourceMigrations.start"
)(function* (input: {
  readonly actor: AuthenticatedUser
  readonly backupStorageIds: ReadonlyArray<string | null>
  readonly destinationName: string
  readonly destinationRelayId: string
  readonly kind: MigratedKindName
  readonly mode: ResourceMigrationMode
  readonly options: ResourceMigrationOptions
  readonly source: {
    readonly id: string
    readonly name: string
    readonly relayId: string
  }
}) {
  const createKey = randomUUID()
  // Reserved before the migration starts, so every run of it provisions
  // the same copy.
  const destinationId = yield* kindOf(input).reserveId(createKey)
  const migration: ResourceMigrationInput = {
    actor: input.actor,
    backupStorageIds: input.backupStorageIds,
    createKey,
    destination: {
      id: destinationId,
      name: input.destinationName,
      relayId: input.destinationRelayId,
    },
    kind: input.kind,
    migrationId: randomUUID(),
    mode: input.mode,
    options: input.options,
    requestedBy: input.actor.id,
    source: input.source,
  }
  yield* startDurableOperation(resourceMigration, migration, {
    actorId: input.actor.id,
    authorize: promiseEffect(() => mayMigrate(input.actor, migration)),
  })
  return migration.migrationId
})

// What a migration needs of the person, as it was asked. Checked when it
// starts, and again before each step that changes something.
const mayMigrate = (user: AuthenticatedUser, input: ResourceMigrationInput) =>
  requireMigrationPermissions(user, {
    destination: input.destination,
    kind: input.kind,
    mode: input.mode,
    options: optionsOf(input),
    source: input.source,
  })

/** The person's migrations still running and those that ended lately. */
export const listResourceMigrationsEffect = Effect.fn(
  "resourceMigrations.list"
)(function* (userId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<MigrationRow>(
    "resourceMigrations.list",
    `SELECT * FROM ${databaseTable("resource_migration")}
        WHERE requested_by = ?
          AND (state IN ('running', 'cancelling') OR updated_at > ?)
        ORDER BY created_at DESC
        LIMIT 20`,
    [userId, now - 24 * 60 * 60_000]
  )
  return rows.map(migrationView)
})

/**
 * Asks the person's running migration to stop, in one write its workflow
 * sees between steps and while it waits, then undoes it.
 */
export const cancelResourceMigrationEffect = Effect.fn(
  "resourceMigrations.cancel"
)(function* (userId: string, id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "resourceMigrations.cancel",
    `UPDATE ${databaseTable("resource_migration")}
          SET state = 'cancelling', updated_at = ?
        WHERE id = ? AND requested_by = ? AND state = 'running'
          AND NOT (${handingOverDeletion})`,
    [now, id, userId]
  )
  if (result.affectedRows === 0) {
    const row = yield* loadMigration(id)
    return yield* new ResourceMigrationError({
      message:
        row?.requested_by === userId &&
        row.state === "running" &&
        !migrationCancellable(row)
          ? "This move is handing over to the new server and can't be cancelled"
          : "This copy is no longer running",
    })
  }
})

// Cancelling one migration's task: only who started it may, as its write
// requires.
const cancelMigration = operation<{ readonly id: string }>()({
  name: "resource.migration.cancel",
  doing: "Cancelling this copy",
  authorize: ({ user }) => signedIn(user),
  locks: ({ input }) => [exclusive(partKey(migrationKey(input.id), "task"))],
  run: ({ context: person, input }) =>
    cancelResourceMigrationEffect(person.id, input.id),
  publish: ({ context: person }) => publishMigrationChange(person.id),
})

/** Cancels one of the person's copies, as an operation. */
export function cancelResourceMigration(user: AuthenticatedUser, id: string) {
  return runOperationPromise(cancelMigration, { id }, { user })
}

// ---------------------------------------------------------- the workflow

const Parts = Schema.Array(
  Schema.Struct({ destination: Schema.String, source: Schema.String })
)

const migrationSteps = (input: ResourceMigrationInput, operationId: string) =>
  Effect.gen(function* () {
    const options = optionsOf(input)
    const kind = kindOf(input)
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
      "the copy to be created",
      () => provisioned(input)
    )
    const settled = kind.settled
    if (settled) {
      yield* step(input, "settle", (actor) => settled(input, actor, options))
    }
    const backupFirst = kind.backupFirst
    if (options.backup && backupFirst) {
      yield* checkpoint(input, "backup")
      yield* step(input, "backup", (actor) =>
        backupFirst(input, actor, backupIdOf(input))
      )
      yield* watch(input, "backup", PROVISION_WINDOWS, "the backup", () =>
        backupAvailable(input)
      )
    }
    // Stopped first, so nothing writes to it while it's copied. One that
    // has to run to be copied is stopped once its copy is in.
    const stops = options.stopSource && kind.powered
    const stop = Effect.gen(function* () {
      yield* checkpoint(input, "stop")
      yield* step(input, "stop", (actor) => stopSource(input, actor))
      yield* watch(input, "stop", STOP_WINDOWS, "it to stop", () =>
        sourceStopped(input)
      )
    })
    if (stops && !kind.copiedRunning) yield* stop
    yield* checkpoint(input, "copy")
    // What the copy is filled from, settled once: each part is one transfer
    // between the Relays, and they go one at a time, so no Relay holds more
    // than one part's archive.
    const parts = yield* Activity.make({
      name: "parts",
      success: Parts,
      execute: kind.parts(input).pipe(
        Effect.tap((settled) => recordParts(input.migrationId, settled)),
        Effect.orDie
      ),
    })
    for (const [index, part] of parts.entries()) {
      // The old one's Relay packs the part under its transfer ID, so asking
      // again asks under the same one.
      yield* step(input, `copy/${index}`, (actor) =>
        startPart(input, actor, part, index, parts.length)
      )
      yield* watch(input, `copy/${index}`, null, "its data to copy", () =>
        copied(input, part, index)
      )
    }
    if (stops && kind.copiedRunning && input.mode === "migrate") yield* stop
    const deploy =
      options.deployCopy && input.mode === "migrate" ? kind.deploy : undefined
    const deployed = deploy
      ? yield* deployCopy(input, operationId, kind.noun, deploy)
      : false
    // From here what's handed over stays handed over. A cancel accepted
    // meanwhile stops it before its next part.
    yield* checkpoint(input, "finish")
    // The owner before access is copied, so whoever moved it is given the
    // access they had to the old one rather than skipped as the copy's
    // owner. Each only for a kind that has it.
    const handOver = (name: MigrationHandOver, chosen: boolean) => {
      const hand = kind.handOver[name]
      return chosen && hand
        ? step(input, `finish/${name}`, (actor) => hand(input, actor))
        : Effect.void
    }
    const moved = input.mode === "migrate"
    yield* handOver("owner", moved)
    yield* handOver("access", options.copyAccess)
    yield* handOver("backups", options.linkBackups)
    yield* handOver("domains", moved && options.moveDomain)
    yield* handOver("routes", moved && options.moveWebRoutes)
    yield* handOver("deploys", moved)
    if (deploy && deployed) yield* deploy.after(operationId, deployStep)
    if (input.mode === "duplicate" && kind.powered) {
      yield* step(input, "finish/restart", (actor) =>
        restartSource(input.migrationId, actor)
      )
    }
    // Last, once everything it held belongs to the copy: the old one is
    // backed up in full and then deleted, as deleting it with a final backup
    // does, queued behind this move, which holds it until it ends. Asking
    // again finds the same deletion.
    const deletion = options.deleteSource
    if (input.mode === "migrate" && deletion) {
      yield* step(input, "finish/delete", (actor) =>
        requestResourceDeletionEffect({
          finalBackup: true,
          kind: kind.kind,
          queued: true,
          relayId: input.source.relayId,
          resourceId: input.source.id,
          storageId: deletion.storageId,
          user: actor,
        })
      )
    }
    yield* endStep(input.migrationId, "completed", null)
  })

// Runs the copy as the old one ran, and waits until it's ready, before
// anything is handed to it: one that never is ends the move with the old one
// started again and everything still its own. One that wasn't running isn't
// run. Says whether it was.
const deployCopy = (
  input: ResourceMigrationInput,
  // What its deployment is known by too, so nothing else follows it.
  operationId: string,
  noun: string,
  deploy: NonNullable<MigratedKind["deploy"]>
) =>
  Effect.gen(function* () {
    const ran = yield* Activity.make({
      name: "deploy/needed",
      success: Schema.Boolean,
      execute: loadMigration(input.migrationId).pipe(
        Effect.map((row) => row?.source_was_running === 1),
        untilMySqlAnswers
      ),
    })
    if (!ran) return false
    yield* checkpoint(input, "deploy")
    // As the person, while they may still do what they asked.
    yield* step(input, "deploy/allowed", () => Effect.void)
    yield* deploy
      .start(input, input.requestedBy, operationId, deployStep)
      .pipe(Effect.mapError(asMigrationError))
    yield* watch(input, "deploy/follow", null, "the copy to start", () =>
      deploy
        .state(operationId)
        .pipe(
          Effect.flatMap((state) =>
            typeof state === "object"
              ? fail(`The copied ${noun} didn't start: ${state.failed}`)
              : Effect.succeed(state === "ready")
          )
        )
    )
    if (optionsOf(input).moveWebRoutes) {
      yield* step(input, "deploy/serve", (actor) => deploy.serve(input, actor))
      yield* copyServed(input, noun, deploy)
    }
    return true
  })

// Waits until the copy's Relay serves what it's about to be sent visitors
// for, all of it while there's time, and some of it after that: a route that
// never worked stops no move. One whose Relay can't say, as where another
// proxy serves it, isn't waited for, nor one that only ever answers as
// Traefik does with no route: an App may answer just the same. A Relay that
// can't be reached just now is asked again.
const copyServed = (
  input: ResourceMigrationInput,
  noun: string,
  deploy: NonNullable<MigratedKind["deploy"]>
) => {
  let until: number | null = null
  return watch(input, "deploy/served", null, "it to be served", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      until ??= now + Duration.toMillis(SERVE_WITHIN)
      const served = yield* deploy
        .served(input)
        .pipe(
          Effect.timeout(Duration.millis(Math.max(until - now, 1_000))),
          Effect.result
        )
      const waits = (yield* Clock.currentTimeMillis) < until
      if (Result.isSuccess(served)) {
        const { success: state } = served
        if (state === "served" || state === "unknown") return true
        if (waits) return false
        if (state !== "down") return true
      } else if (waits) {
        return false
      }
      return yield* fail(
        Result.isSuccess(served)
          ? `The copied ${noun} runs, but its new Relay's proxy can't reach it`
          : `The copied ${noun} runs, but its new Relay couldn't be asked whether it serves it`
      )
    })
  )
}

const deployStep = (name: string) => `deploy/${name}`

// One step that changes something, run once, its failure kept for the
// person. Unless the migration was cancelled meanwhile, it runs as the
// person as their account is now, while they may still do what they asked.
const step = <R>(
  input: ResourceMigrationInput,
  name: string,
  run: (actor: AuthenticatedUser) => Effect.Effect<unknown, unknown, R>
) =>
  Activity.make({
    name,
    error: Schema.Union([ResourceMigrationError, MigrationCancelled]),
    execute: Effect.gen(function* () {
      const row = yield* loadMigration(input.migrationId)
      if (row?.state !== "running") return yield* new MigrationCancelled()
      const actor = yield* currentActingUser(input.requestedBy, input.actor)
      yield* promiseEffect(() => mayMigrate(actor, input))
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
            new ResourceMigrationError({
              message: ended.error ?? "The copy failed",
            })
          )
        : Effect.void
    )
  )

// Records the migration for its person, once, under its operation, with the
// IDs its backup first and its first part's transfer take, so asking again
// asks under the same ones.
const recordMigration = (input: ResourceMigrationInput, operationId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "resourceMigrations.insert",
      `INSERT INTO ${databaseTable("resource_migration")}
         (id, operation_id, requested_by, actor, kind, mode, source_relay_id,
          source_id, source_name, destination_relay_id,
          destination_id, destination_name, create_key, options,
          backup_id, transfer_id, state, step, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running',
               'create', ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        input.migrationId,
        operationId,
        input.requestedBy,
        JSON.stringify(input.actor),
        input.kind,
        input.mode,
        input.source.relayId,
        input.source.id,
        input.source.name,
        input.destination.relayId,
        input.destination.id,
        input.destination.name,
        input.createKey,
        JSON.stringify(input.options),
        optionsOf(input).backup ? backupIdOf(input) : null,
        transferIdOf(input, 0),
        now,
        now,
      ]
    )
    publishMigrationChange(input.requestedBy)
  }).pipe(untilMySqlAnswers)

// Moves the migration on to `next`, unless it was cancelled meanwhile, as a
// step: what it found holds however often the workflow runs again.
const checkpoint = (input: ResourceMigrationInput, next: MigrationStep) =>
  Activity.make({
    name: `at/${next}`,
    success: Schema.Boolean,
    execute: Effect.gen(function* () {
      const database = yield* Database
      const now = yield* Clock.currentTimeMillis
      const moved = yield* database.execute(
        "resourceMigrations.step",
        `UPDATE ${databaseTable("resource_migration")}
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
  input: ResourceMigrationInput,
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
        error: ResourceMigrationError,
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
        return yield* new ResourceMigrationError({
          message: `Timed out waiting for ${what}`,
        })
      }
    }
  })

// Creates the copy, stopped, as its kind makes one. Repeating it resumes
// the same copy, under the same provisioning key.
const createDestination = (
  input: ResourceMigrationInput,
  actor: AuthenticatedUser,
  options: ResourceMigrationOptions
) =>
  Effect.gen(function* () {
    const kind = kindOf(input)
    const [source, destination] = yield* Effect.all(
      [relay(input.source.relayId), relay(input.destination.relayId)],
      { concurrency: 2 }
    )
    // Read before its room is checked, so the copy is made from what the
    // old instance was then, whatever is changed on it meanwhile.
    const create = yield* kind.prepare(
      { destination, source },
      input,
      actor,
      options
    )
    // Before anything is made or changed: a copy that can't fit stops here.
    // One the Relay already made, before a restart cut this short, holds its
    // limits already.
    if (!(yield* kind.state(destination, input.destination.id, actor.id))) {
      yield* requireRoom(input, actor, options, true)
    }
    yield* create
  })

const provisioned = (input: ResourceMigrationInput) =>
  Effect.gen(function* () {
    const actor = yield* currentActingUser(input.requestedBy, input.actor)
    const destination = yield* relay(input.destination.relayId)
    const copy = yield* kindOf(input).state(
      destination,
      input.destination.id,
      actor.id
    )
    if (copy?.provisioning?.failed) {
      return yield* fail(
        `The copy couldn't be created: ${copy.provisioning.error ?? "provisioning failed"}`
      )
    }
    return copy !== null && !copy.provisioning && copy.ready
  })

const backupAvailable = (input: ResourceMigrationInput) =>
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

// Stops the old instance, remembering whether it ran, so a copy taken while
// nothing writes to it is consistent.
const stopSource = (input: ResourceMigrationInput, actor: AuthenticatedUser) =>
  Effect.gen(function* () {
    const source = yield* relay(input.source.relayId)
    const row = yield* loadMigration(input.migrationId)
    // Asked again before the server stops, since other work may have filled
    // a disk since the copy was made. Its limits are already reserved, and
    // a backup first already taken.
    if (row?.source_was_running == null) {
      yield* requireRoom(input, actor, null, false)
    }
    const kind = kindOf(input)
    const state = yield* kind.state(source, input.source.id, actor.id)
    if (!state) return yield* fail(`${input.source.name} no longer exists`)
    const database = yield* Database
    yield* database.execute(
      "resourceMigrations.sourceWasRunning",
      `UPDATE ${databaseTable("resource_migration")}
          SET source_was_running = ?
        WHERE id = ? AND source_was_running IS NULL`,
      [state.stopped ? 0 : 1, input.migrationId]
    )
    if (!state.stopped) {
      yield* relayRequest(source, "instance.action", actor.id, {
        action: "stop",
        id: input.source.id,
        kind: kind.kind,
      })
    }
  })

const sourceStopped = (input: ResourceMigrationInput) =>
  Effect.gen(function* () {
    const actor = yield* currentActingUser(input.requestedBy, input.actor)
    const source = yield* relay(input.source.relayId)
    const current = yield* kindOf(input).state(
      source,
      input.source.id,
      actor.id
    )
    return !current || current.stopped
  })

// Starts one part's copy, and says which part it is of how many.
const startPart = (
  input: ResourceMigrationInput,
  actor: AuthenticatedUser,
  part: MigrationPart,
  index: number,
  count: number
) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.execute(
      "resourceMigrations.part",
      `UPDATE ${databaseTable("resource_migration")}
          SET part = ?, parts = ?, received_bytes = 0, total_bytes = NULL,
              updated_at = ?
        WHERE id = ?`,
      [index + 1, count, yield* Clock.currentTimeMillis, input.migrationId]
    )
    publishMigrationChange(input.requestedBy)
    yield* beginRelayTransferEffect(
      actor,
      transferRequest(input, part),
      transferIdOf(input, index)
    )
  })

// Copies one part of the old resource into the copy's, Relay to Relay,
// publishing progress as it goes.
const copied = (
  input: ResourceMigrationInput,
  part: MigrationPart,
  index: number
) => {
  let publishedAt = 0
  return Effect.gen(function* () {
    const actor = yield* currentActingUser(input.requestedBy, input.actor)
    const status = yield* advanceRelayTransferEffect(
      actor,
      transferRequest(input, part),
      transferIdOf(input, index)
    )
    if (status.phase === "failed" || status.phase === "cancelled") {
      return yield* fail(
        `Copying its data failed: ${status.error ?? status.phase}`
      )
    }
    const now = yield* Clock.currentTimeMillis
    if (now - publishedAt > PROGRESS_INTERVAL_MS) {
      publishedAt = now
      const database = yield* Database
      yield* database.execute(
        "resourceMigrations.progress",
        `UPDATE ${databaseTable("resource_migration")}
            SET received_bytes = ?, total_bytes = ?, updated_at = ?
          WHERE id = ?`,
        [status.receivedBytes, status.size, now, input.migrationId]
      )
      publishMigrationChange(input.requestedBy)
    }
    return status.phase === "completed"
  })
}

// The old one goes back to running if it ran before the copy stopped it: as
// the person, as a duplicate's last part, or as Hearth, undoing the copy.
const restartSource = (id: string, actor: AuthenticatedUser | null) =>
  Effect.gen(function* () {
    const row = yield* loadMigration(id)
    if (row?.source_was_running !== 1) return
    const kind = kindOf(row)
    const source = yield* relay(row.source_relay_id)
    const state = yield* kind.state(source, row.source_id, actor?.id)
    if (!state?.stopped) return
    yield* relayRequest(source, "instance.action", actor?.id, {
      action: "start",
      id: row.source_id,
      kind: kind.kind,
    })
    yield* kind.started?.(source, row.source_id, actor?.id) ?? Effect.void
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
    if (!row) return yield* Effect.die(`Migration ${id} is gone`)
    // Ended already, by this same step cut short after it wrote.
    if (row.state !== "running" && row.state !== "cancelling") {
      yield* notifyEnded(row, row.state, row.error)
      return {
        error: row.error,
        state: row.state as "completed" | "failed" | "cancelled",
      }
    }
    const options = rowOptions(row)
    const kind = kindOf(row)
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
          kind.kind,
          row.source_id
        )
      )
    const database = yield* Database
    let state = sourceDeleting ? "completed" : ending
    const error = sourceDeleting ? null : endingError
    if (state === "completed" && !sourceDeleting) {
      // Finished only while no cancel was accepted, in one write: a cancel
      // accepted first wins, and it's undone as any cancelled copy is.
      const finished = yield* database.execute(
        "resourceMigrations.complete",
        `UPDATE ${databaseTable("resource_migration")}
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
        "resourceMigrations.ending",
        `UPDATE ${databaseTable("resource_migration")}
            SET state = 'cancelling', error = ?, updated_at = ?
          WHERE id = ? AND state IN ('running', 'cancelling')`,
        [error?.slice(0, 512) ?? null, yield* Clock.currentTimeMillis, id]
      )
      publishMigrationChange(row.requested_by)
      yield* discardTransfers(row)
      if (
        row.step !== "finish" &&
        (yield* kind.recorded(row.destination_relay_id, row.destination_id))
      ) {
        const person = yield* currentActingUser(
          row.requested_by,
          row.actor
        ).pipe(
          Effect.orElseSucceed(() => parsed(row.actor) as AuthenticatedUser)
        )
        yield* Effect.gen(function* () {
          // What was made for the copy alone goes with it.
          const volumeIds = kind.copyVolumes
            ? yield* kind.copyVolumes(migrationOf(row), person)
            : []
          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: kind.kind,
            queued: true,
            relayId: row.destination_relay_id,
            resourceId: row.destination_id,
            storageId: null,
            user: person,
            ...(volumeIds.length > 0 ? { volumeIds } : {}),
          })
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
      "resourceMigrations.end",
      `UPDATE ${databaseTable("resource_migration")}
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
  notifyUsersEffect([row.requested_by], `resource.migration:${row.id}`, {
    destination: {
      id: row.destination_id,
      name: row.destination_name,
      relayId: row.destination_relay_id,
      type: kindOf(row).kind,
    },
    ...(message ? { error: message } : {}),
    ...(state === "completed" &&
    row.mode === "migrate" &&
    rowOptions(row).deleteSource
      ? { sourceDeleting: true }
      : {}),
    kind: "resource.migration",
    migrationId: row.id,
    mode: row.mode,
    outcome: state,
    source: {
      id: row.source_id,
      name: row.source_name,
      relayId: row.source_relay_id,
      type: kindOf(row).kind,
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        publishNotificationChange([row.requested_by])
        publishMigrationChange(row.requested_by)
      })
    )
  )

// A migration as its kind is told of it, from its row.
function migrationOf(row: MigrationRow): Migration {
  return {
    backupStorageIds: [],
    createKey: row.create_key,
    destination: {
      id: row.destination_id,
      name: row.destination_name,
      relayId: row.destination_relay_id,
    },
    kind: row.kind,
    mode: row.mode,
    source: {
      id: row.source_id,
      name: row.source_name,
      relayId: row.source_relay_id,
    },
  }
}

// Keeps the parts a copy settled on, before any of them starts, so undoing
// it discards exactly those, whatever its kind would answer by then.
const recordParts = (id: string, parts: ReadonlyArray<MigrationPart>) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.execute(
      "resourceMigrations.parts",
      `UPDATE ${databaseTable("resource_migration")}
          SET part_roots = ?, updated_at = ?
        WHERE id = ?`,
      [JSON.stringify(parts), yield* Clock.currentTimeMillis, id]
    )
  })

// Deletes what either Relay packed or fetched for each of the copy's parts,
// as Hearth's. A copy that settled none started none.
const discardTransfers = (row: MigrationRow) =>
  Schema.decodeUnknownEffect(Schema.NullOr(Parts))(parsed(row.part_roots)).pipe(
    Effect.flatMap((parts) =>
      Effect.forEach(
        (parts ?? []).flatMap((part, index) => [
          [
            "transfer.pull.cancel",
            row.destination_relay_id,
            part.destination,
            index,
          ] as const,
          [
            "transfer.source.discard",
            row.source_relay_id,
            part.source,
            index,
          ] as const,
        ]),
        ([operation, relayId, rootId, index]) =>
          relay(relayId).pipe(
            Effect.flatMap((found) =>
              relayRequest(found, operation, undefined, {
                rootId,
                transferId: transferIdOf({ migrationId: row.id }, index),
              })
            ),
            Effect.ignore
          ),
        { discard: true }
      )
    ),
    Effect.ignore
  )

// ---------------------------------------------------------- helpers

// Fails unless the copy still fits: its limits, before it's created, and
// the disk the move needs on both Relays.
const requireRoom = (
  input: ResourceMigrationInput,
  actor: AuthenticatedUser,
  options: ResourceMigrationOptions | null,
  limits: boolean
) =>
  Effect.gen(function* () {
    const [source, destination] = yield* Effect.all(
      [relay(input.source.relayId), relay(input.destination.relayId)],
      { concurrency: 2 }
    )
    const problems = yield* promiseEffect(() =>
      checkMigrationRoom({
        backup: options?.backup ?? null,
        copyLimits: optionsOf(input).limits,
        destination,
        kind: input.kind,
        limits,
        source,
        sourceId: input.source.id,
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
      "resourceMigrations.load",
      `SELECT * FROM ${databaseTable("resource_migration")} WHERE id = ? LIMIT 1`,
      [id]
    )
    return rows[0] ?? null
  })

function relay(id: string) {
  return promiseEffect(() => activeRelay(id))
}

// A copy's backup first and each of its parts' transfers are named after
// it.
function backupIdOf(input: ResourceMigrationInput) {
  return input.migrationId
}

function transferIdOf(input: { readonly migrationId: string }, index: number) {
  const id = input.migrationId.replaceAll("-", "")
  return index === 0 ? id : `${id}-${index}`
}

function transferRequest(
  input: ResourceMigrationInput,
  part: MigrationPart
): RelayTransferRequest {
  return {
    destination: {
      path: "",
      relayId: input.destination.relayId,
      rootId: part.destination,
    },
    source: {
      paths: [],
      relayId: input.source.relayId,
      rootId: part.source,
    },
  }
}

function optionsOf(
  input: Pick<ResourceMigrationInput, "options">
): ResourceMigrationOptions {
  return resourceMigrationOptionsSchema.parse(input.options)
}

function rowOptions(row: MigrationRow): ResourceMigrationOptions {
  return optionsOf({ options: parsed(row.options) })
}

// A JSON column, as mysql2 reads it: parsed, or still its text.
function parsed(saved: unknown): unknown {
  return typeof saved === "string" ? JSON.parse(saved) : saved
}

function migrationView(row: MigrationRow): ResourceMigrationView {
  return {
    cancellable: row.state === "running" && migrationCancellable(row),
    createdAt: Number(row.created_at),
    destination: {
      id: row.destination_id,
      name: row.destination_name,
      relayId: row.destination_relay_id,
    },
    error: row.error,
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    part: Number(row.part),
    parts: Number(row.parts),
    receivedBytes: Number(row.received_bytes),
    source: {
      id: row.source_id,
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
    topics: ["resource-migrations"],
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
  return Effect.fail(new ResourceMigrationError({ message }))
}

function asMigrationError(cause: unknown): ResourceMigrationError {
  return Schema.is(ResourceMigrationError)(cause)
    ? cause
    : new ResourceMigrationError({ message: messageOf(cause) })
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
