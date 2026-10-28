/**
 * Copying a game server to a new one: a duplicate, on any Relay the person
 * may create servers on, or a move to another Relay, which hands the old
 * server's place to the copy. The copy is always a new server with its own
 * ID. A migration runs in the background as a sequence of steps, each safe
 * to repeat, recorded in `server_migration` with a lease, so one whose
 * worker stopped, such as when Hearth restarted, is carried on by the next
 * pass. A copy that fails before it's finished is removed and the old
 * server put back as it was; the person is told how it ended either way.
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
import { Clock, Effect, Schema } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import {
  serverMigrationOptionsSchema,
  type ServerMigrationOptions,
} from "@/lib/server-migration-input"

import type { AppCache } from "@/effect/cache"
import { Database } from "@/effect/database"
import {
  getBackupCatalogRecordEffect,
  linkInstanceBackupsEffect,
} from "@/effect/backups"
import { findResourceDeletionEffect } from "@/effect/resource-deletions"
import {
  notifyUsersEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { forkAppWorker, runAppEffect } from "@/effect/runtime"
import { currentActingUser } from "@/operations/acting-user"
import {
  copyInstanceAccessEffect,
  publishResourceAccessChange,
} from "@/lib/access-policy-mutations"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { advanceAuthorizationRevisionEffect } from "@/lib/authorization-revision"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { databaseTable } from "@/lib/database-config"
import { requestResourceDeletion } from "@/lib/resource-deletion.server"
import { startPollingWorker } from "@/lib/polling-worker"
import { provisioningInstanceId } from "@/lib/provisioning.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayResourceLimitsRequest } from "@/lib/resource-limits.server"
import { checkMigrationRoom } from "@/lib/server-migration-room.server"
import { activeRelay, type PersistedRelay } from "@/lib/relay-registry"
import { provisionServer } from "@/lib/server-provisioning.server"
import { createInstanceBackupHandler } from "@/server/backups.server"
import { brickRecipeDefinition } from "@/server/bricks"
import { loadInstanceRecipe } from "@/server/bricks.server"
import {
  moveInstanceDomainsEffect,
  provisionInstanceDomainBestEffort,
} from "@/server/domains.server"
import { setInstanceDomainOptOutEffect } from "@/effect/domains"
import { moveResourceWebHostnamesEffect } from "@/server/web-hostnames.server"
import {
  advanceRelayTransferEffect,
  beginRelayTransferEffect,
  cancelRelayTransferEffect,
  type RelayTransferRequest,
} from "@/server/relay-transfers.server"
import { webRoutesForRelay } from "@/server/web-route-compatibility.server"

// A worker holds a migration this long between renewals; one that stops
// renewing, as when Hearth stops, can be taken over once it lapses.
const LEASE_MS = 2 * 60_000
const LEASE_RENEW_MS = 30_000
const POLL_MS = 2_000
// Progress is published to the person at most this often while files copy.
const PROGRESS_INTERVAL_MS = 1_000
// How long a new server may take to provision, and its backup to finish.
const PROVISION_TIMEOUT_MS = 30 * 60_000

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
type FinishedPart =
  | "access"
  | "backups"
  | "delete"
  | "domains"
  | "owner"
  | "routes"
  | "restart"

interface MigrationRow extends RowDataPacket {
  actor: unknown
  backup_id: string | null
  claim_generation: number
  create_key: string
  created_at: number
  destination_created: number
  destination_instance_id: string
  destination_name: string
  destination_relay_id: string
  error: string | null
  finished_at: number | null
  finished_parts: unknown
  id: string
  lease_until: number | null
  mode: ServerMigrationMode
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
// deletion, can't be taken back.
const handingOverDeletion = `step = 'finish' AND mode = 'migrate'
  AND COALESCE(JSON_TYPE(JSON_EXTRACT(options, '$.deleteSource')), '') = 'OBJECT'`

class StaleClaim extends Error {}
class MigrationCancelled extends Error {}

/**
 * Records a migration someone confirmed and starts it. The caller has
 * checked they may make it.
 */
export const startServerMigrationEffect = Effect.fn("serverMigrations.start")(
  function* (input: {
    readonly actor: AuthenticatedUser
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
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const id = randomUUID()
    const createKey = randomUUID()
    const step: MigrationStep = "create"
    yield* database.transaction("serverMigrations.insert", (transaction) =>
      Effect.gen(function* () {
        // One copy of a server at a time: starts queue on its Relay's row,
        // taken first as everything else that locks it does, before checking.
        yield* transaction.queryRows<RowDataPacket>(
          `SELECT 1 FROM ${databaseTable("relay")} WHERE id = ? FOR UPDATE`,
          [input.source.relayId]
        )
        const running = yield* transaction.queryRows<RowDataPacket>(
          `SELECT 1 FROM ${databaseTable("server_migration")}
            WHERE source_relay_id = ? AND source_instance_id = ?
              AND state IN ('running', 'cancelling')
            LIMIT 1`,
          [input.source.relayId, input.source.instanceId]
        )
        if (running.length > 0) {
          return yield* Effect.fail(
            new Error("This server is already being copied")
          )
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("server_migration")}
             (id, requested_by, actor, mode, source_relay_id,
              source_instance_id, source_name, destination_relay_id,
              destination_instance_id, destination_name, create_key, options,
              state, step, claim_generation, lease_until, created_at,
              updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 1, ?, ?, ?)`,
          [
            id,
            input.actor.id,
            JSON.stringify(input.actor),
            input.mode,
            input.source.relayId,
            input.source.instanceId,
            input.source.name,
            input.destinationRelayId,
            provisioningInstanceId(createKey),
            input.destinationName,
            createKey,
            JSON.stringify(input.options),
            step,
            now + LEASE_MS,
            now,
            now,
          ]
        )
      })
    )
    publishMigrationChange(input.actor.id)
    forkMigrationWorker(id, 1)
    return id
  }
)

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

/** Asks the person's running migration to stop. */
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
      return yield* Effect.fail(
        new Error(
          row?.requested_by === userId &&
            row.state === "running" &&
            !migrationCancellable(row)
            ? "This move is handing over to the new server and can't be cancelled"
            : "This copy is no longer running"
        )
      )
    }
    publishMigrationChange(userId)
  }
)

/**
 * One pass of the worker that carries on migrations whose worker stopped:
 * takes over each whose lease lapsed. Answers when to look again.
 */
export const resumeServerMigrationsEffect = Effect.fn(
  "serverMigrations.resume"
)(function* () {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<
    RowDataPacket & {
      claim_generation: number
      id: string
      lease_until: number | null
    }
  >(
    "serverMigrations.resumable",
    `SELECT id, claim_generation, lease_until
       FROM ${databaseTable("server_migration")}
      WHERE state IN ('running', 'cancelling')`
  )
  let worked = false
  let nextAttemptAt: number | null = null
  for (const row of rows) {
    const leaseUntil = Number(row.lease_until ?? 0)
    if (leaseUntil > now) {
      nextAttemptAt = Math.min(nextAttemptAt ?? leaseUntil, leaseUntil)
      continue
    }
    const taken = yield* database.execute(
      "serverMigrations.takeOver",
      `UPDATE ${databaseTable("server_migration")}
          SET claim_generation = claim_generation + 1, lease_until = ?,
              updated_at = ?
        WHERE id = ? AND claim_generation = ?
          AND state IN ('running', 'cancelling')
          AND COALESCE(lease_until, 0) <= ?`,
      [now + LEASE_MS, now, row.id, row.claim_generation, now]
    )
    if (taken.affectedRows === 1) {
      worked = true
      forkMigrationWorker(row.id, Number(row.claim_generation) + 1)
    }
  }
  return worked
    ? ({ outcome: "worked" } as const)
    : ({ nextAttemptAt, outcome: "idle" } as const)
})

/**
 * Carries on migrations whose worker stopped, as after Hearth restarts,
 * looking again whenever one's lease lapses.
 */
export function startServerMigrationResumption(): void {
  startPollingWorker("ServerMigrations", () =>
    runAppEffect("serverMigrations.resume", resumeServerMigrationsEffect())
  )
}

function forkMigrationWorker(id: string, generation: number): void {
  forkAppWorker(
    driveMigration(id, generation).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Server migration ${id} stopped`, cause)
      )
    )
  )
}

// ---------------------------------------------------------- the worker

// Runs a migration while renewing its lease on the side, so the lease
// lapses only once this worker is gone. Should another worker take over
// anyway, this one stops at once, whatever it was doing.
const driveMigration = Effect.fn("serverMigrations.drive")(
  (id: string, generation: number) =>
    Effect.raceFirst(runMigration(id, generation), keepLease(id, generation))
)

const runMigration = Effect.fnUntraced(function* (
  id: string,
  generation: number
) {
  while (true) {
    const row = yield* loadMigration(id)
    if (
      !row ||
      Number(row.claim_generation) !== generation ||
      (row.state !== "running" && row.state !== "cancelling")
    ) {
      return
    }
    yield* Effect.annotateCurrentSpan({
      "kiln.migration.id": id,
      "kiln.migration.step": row.step,
    })
    // Cancelled, or ending as failed under a worker that has since stopped:
    // either way it's cleaned up, not carried on.
    if (row.state === "cancelling") {
      return yield* endMigration(
        row,
        generation,
        row.error ? "failed" : "cancelled",
        row.error
      )
    }
    const outcome = yield* migrationStep(row, generation).pipe(
      Effect.map(() => "next" as const),
      Effect.catch((cause) => {
        if (cause instanceof StaleClaim) return Effect.succeed("stop" as const)
        if (cause instanceof MigrationCancelled) {
          return Effect.succeed("next" as const)
        }
        return endMigration(
          row,
          generation,
          "failed",
          errorMessage(cause)
        ).pipe(Effect.as("stop" as const))
      })
    )
    if (outcome === "stop") return
  }
})

// Renews a worker's lease, ending only once another worker took over. It
// checks the claim alone, not the state, so a migration this worker just
// finished doesn't stop it partway through telling its person.
const keepLease = Effect.fnUntraced(function* (id: string, generation: number) {
  while (true) {
    yield* Effect.sleep(LEASE_RENEW_MS)
    const held = yield* loadMigration(id).pipe(
      Effect.flatMap((row) => {
        if (!row || Number(row.claim_generation) !== generation) {
          return Effect.succeed(false)
        }
        if (row.state !== "running" && row.state !== "cancelling") {
          return Effect.succeed(true)
        }
        return claimWrite(id, generation, "error = error", []).pipe(
          Effect.as(true)
        )
      }),
      Effect.catch((cause) =>
        cause instanceof StaleClaim
          ? Effect.succeed(true)
          : Effect.logWarning(
              `Server migration ${id} couldn't renew its lease`,
              cause
            ).pipe(Effect.as(true))
      )
    )
    if (!held) return
  }
})

const migrationStep = Effect.fnUntraced(function* (
  row: MigrationRow,
  generation: number
) {
  const actor = yield* currentActingUser(row.requested_by, row.actor)
  const options = migrationOptions(row)
  switch (row.step) {
    case "backup":
      return yield* backupSource(row, generation, actor, options)
    case "stop":
      return yield* stopSource(row, generation, actor, options)
    case "create":
      return yield* createDestination(row, generation, actor, options)
    case "provision":
      return yield* awaitProvisioned(row, generation, actor, options)
    case "copy":
      return yield* copyFiles(row, generation, actor)
    case "finish":
      return yield* finishMigration(row, generation, actor, options)
  }
})

// A full archive of the old server, to the chosen destination, finished
// before anything changes.
const backupSource = Effect.fnUntraced(function* (
  row: MigrationRow,
  generation: number,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions
) {
  const source = yield* relay(row.source_relay_id)
  let backupId = row.backup_id
  if (!backupId) {
    const destination = yield* relay(row.destination_relay_id)
    const created = yield* promise(() =>
      createInstanceBackupHandler(actor, {
        instanceId: row.source_instance_id,
        mode: "full",
        name: `Before ${row.mode === "migrate" ? "moving" : "copying"} to ${destination.name}`.slice(
          0,
          120
        ),
        relayId: source.id,
        ...(options.backup?.storageId === undefined
          ? {}
          : { storageId: options.backup.storageId }),
      })
    )
    backupId = created.backup.id
    yield* claimWrite(row.id, generation, "backup_id = ?", [backupId])
  }
  const id = backupId
  yield* waitUntil(row.id, generation, PROVISION_TIMEOUT_MS, "the backup", () =>
    Effect.gen(function* () {
      const { reconcileRelayBackups } = yield* Effect.promise(
        () => import("@/lib/backup-reconciliation")
      )
      yield* promise(() => reconcileRelayBackups(source))
      const backup = yield* getBackupCatalogRecordEffect(id)
      if (
        !backup ||
        backup.status === "failed" ||
        backup.status === "deleted"
      ) {
        return yield* Effect.fail(
          new Error(
            `The backup before copying failed${backup?.taskError ? `: ${backup.taskError}` : ""}`
          )
        )
      }
      return backup.status === "available"
    })
  )
  yield* claimWrite(row.id, generation, "step = ?", [
    nextStep(row, options, "backup"),
  ])
})

// Stops the old server, remembering whether it ran, so a copy taken while
// nothing writes to it is consistent.
const stopSource = Effect.fnUntraced(function* (
  row: MigrationRow,
  generation: number,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions
) {
  const source = yield* relay(row.source_relay_id)
  // Asked again before the server stops, since other work may have filled
  // a disk since the copy was made. Its limits are already reserved.
  if (row.source_was_running === null) {
    yield* requireRoom(row, actor, options, false)
  }
  const instance = yield* snapshotInstance(
    source,
    row.source_instance_id,
    actor
  )
  if (!instance) {
    return yield* Effect.fail(new Error(`${row.source_name} no longer exists`))
  }
  if (row.source_was_running === null) {
    yield* claimWrite(row.id, generation, "source_was_running = ?", [
      instance.observedState === "stopped" ? 0 : 1,
    ])
  }
  if (instance.observedState !== "stopped") {
    yield* rpc(source, "instance.action", actor, {
      action: "stop",
      instanceId: row.source_instance_id,
    })
    yield* waitUntil(
      row.id,
      generation,
      10 * 60_000,
      "the server to stop",
      () =>
        snapshotInstance(source, row.source_instance_id, actor).pipe(
          Effect.map(
            (current) => !current || current.observedState === "stopped"
          )
        )
    )
  }
  yield* claimWrite(row.id, generation, "step = ?", [
    nextStep(row, options, "stop"),
  ])
})

// Creates the copy, stopped, from the exact Brick the old server was built
// from, with its settings, and its limits unless it was given its own.
// Repeating it resumes the same server.
const createDestination = Effect.fnUntraced(function* (
  row: MigrationRow,
  generation: number,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions
) {
  const [source, destination] = yield* Effect.all(
    [relay(row.source_relay_id), relay(row.destination_relay_id)],
    { concurrency: 2 }
  )
  const instance = yield* snapshotInstance(
    source,
    row.source_instance_id,
    actor
  )
  if (!instance?.brickSource) {
    return yield* Effect.fail(
      new Error(`${row.source_name} has no Brick to build its copy from`)
    )
  }
  // Before anything is made or changed: a copy that can't fit stops here.
  // One the Relay already made, before a restart could record it, holds its
  // limits already.
  if (
    !row.destination_created &&
    !(yield* snapshotInstance(destination, row.destination_instance_id, actor))
  ) {
    yield* requireRoom(row, actor, options, true)
  }
  const recipe = yield* promise(() => loadInstanceRecipe(source, instance))
  const diskLimitBytes =
    (options.limits ?? instance.limits).diskBytes ??
    DEFAULT_INSTANCE_DISK_LIMIT_BYTES
  // A Relay that can't take these limits fails the copy, not the worker.
  const create = yield* Effect.try({
    try: () =>
      relayCreateInstanceSchema.parse({
        diskLimitBytes,
        ...relayResourceLimitsRequest(
          destination.id,
          { cpuMillis: null, diskBytes: diskLimitBytes, memoryBytes: null },
          options.limits ?? instance.limits
        ),
        name: row.destination_name,
        recipe: recipe.brickSource,
        recipeDefinition: brickRecipeDefinition(recipe.brick),
        start: false,
        variables: instance.variables ?? {},
      }),
    catch: (cause) => cause,
  })
  // A move takes the old server's domains along, so the copy isn't given
  // one of its own when it's provisioned.
  if (row.mode === "migrate" && options.moveDomain) {
    yield* setInstanceDomainOptOutEffect(
      destination.id,
      row.destination_instance_id,
      true
    )
  }
  // Whoever copies a server owns the copy while it's built, so they may fill
  // it; a finished move hands it to the old server's owner.
  yield* promise(() =>
    provisionServer({
      create,
      idempotencyKey: row.create_key,
      ownerId: actor.id,
      relay: destination,
      requestedBy: actor.id,
    })
  )
  yield* claimWrite(
    row.id,
    generation,
    "destination_created = 1, step = 'provision'",
    []
  )
})

const awaitProvisioned = Effect.fnUntraced(function* (
  row: MigrationRow,
  generation: number,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions
) {
  const destination = yield* relay(row.destination_relay_id)
  yield* waitUntil(
    row.id,
    generation,
    PROVISION_TIMEOUT_MS,
    "the new server to be created",
    () =>
      snapshotInstance(destination, row.destination_instance_id, actor).pipe(
        Effect.flatMap((instance) => {
          if (instance?.provisioning?.phase === "failed") {
            return Effect.fail(
              new Error(
                `The new server couldn't be created: ${instance.provisioning.error ?? "provisioning failed"}`
              )
            )
          }
          return Effect.succeed(
            instance !== null &&
              !instance.provisioning &&
              instance.observedState === "stopped"
          )
        })
      )
  )
  yield* claimWrite(row.id, generation, "step = ?", [
    nextStep(row, options, "provision"),
  ])
})

// Copies the old server's whole folder into the new one's, Relay to Relay.
const copyFiles = Effect.fnUntraced(function* (
  row: MigrationRow,
  generation: number,
  actor: AuthenticatedUser
) {
  const request = transferRequest(row)
  let transferId = row.transfer_id
  if (!transferId) {
    transferId = randomUUID().replaceAll("-", "")
    // Kept before the source is asked, so a retry asks under the same ID.
    yield* claimWrite(row.id, generation, "transfer_id = ?", [transferId])
  }
  yield* beginRelayTransferEffect(actor, request, transferId)
  let publishedAt = 0
  const id = transferId
  yield* waitUntil(row.id, generation, null, "the files to copy", () =>
    Effect.gen(function* () {
      const status = yield* advanceRelayTransferEffect(actor, request, id)
      if (status.phase === "failed" || status.phase === "cancelled") {
        return yield* Effect.fail(
          new Error(`Copying the files failed: ${status.error ?? status.phase}`)
        )
      }
      const now = yield* Clock.currentTimeMillis
      if (now - publishedAt > PROGRESS_INTERVAL_MS) {
        publishedAt = now
        yield* claimWrite(
          row.id,
          generation,
          "received_bytes = ?, total_bytes = ?",
          [status.receivedBytes, status.size]
        )
        publishMigrationChange(row.requested_by)
      }
      return status.phase === "completed"
    })
  )
  yield* claimWrite(row.id, generation, "step = 'finish'", [])
})

// Carries over what the person chose, each part once, then reports the
// copy finished.
const finishMigration = Effect.fnUntraced(function* (
  row: MigrationRow,
  generation: number,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions
) {
  const done = new Set(finishedParts(row))
  const finish = (
    part: FinishedPart,
    run: Effect.Effect<unknown, unknown, AppCache | Database>
  ) =>
    done.has(part)
      ? Effect.void
      : run.pipe(
          Effect.andThen(() => {
            done.add(part)
            return claimWrite(row.id, generation, "finished_parts = ?", [
              JSON.stringify([...done]),
            ])
          })
        )
  const [source, destination] = yield* Effect.all(
    [relay(row.source_relay_id), relay(row.destination_relay_id)],
    { concurrency: 2 }
  )
  const from = { instanceId: row.source_instance_id, relayId: source.id }
  const to = {
    instanceId: row.destination_instance_id,
    relayId: destination.id,
  }
  // Before access is copied, so whoever moved it is given the access they
  // had to the old server rather than skipped as the copy's owner.
  if (row.mode === "migrate") {
    yield* finish("owner", handOverOwnerEffect(row, actor))
  }
  if (options.copyAccess) {
    yield* finish(
      "access",
      copyInstanceAccessEffect({ actorId: actor.id, from, to }).pipe(
        Effect.tap((userIds) =>
          promise(() => publishResourceAccessChange(userIds, [destination.id]))
        )
      )
    )
  }
  if (options.linkBackups) {
    yield* finish(
      "backups",
      linkInstanceBackupsEffect({ from, linkedBy: actor.id, to }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            publishBackupChange(source.id)
            publishBackupChange(destination.id)
          })
        )
      )
    )
  }
  if (row.mode === "migrate" && options.moveDomain) {
    yield* finish(
      "domains",
      snapshotInstance(destination, to.instanceId, actor).pipe(
        Effect.flatMap((instance) =>
          instance
            ? moveInstanceDomainsEffect(from, {
                ...instance,
                relayId: destination.id,
              })
            : Effect.fail(new Error("The new server is gone"))
        )
      )
    )
  }
  if (row.mode === "migrate" && options.moveWebRoutes) {
    yield* finish(
      "routes",
      Effect.gen(function* () {
        const state = relayInstanceWebRouteStateSchema.parse(
          yield* rpc(source, "instance.network.routes.read", actor, {
            instanceId: from.instanceId,
          })
        )
        // A retry after the routes moved finds none, and still hands the
        // hostnames over.
        if (state.routes.length > 0) {
          const routes = yield* Effect.try(() =>
            webRoutesForRelay(
              destination.id,
              state.routes.map(({ id: _id, ...route }) => route)
            )
          )
          yield* rpc(destination, "instance.network.routes.write", actor, {
            instanceId: to.instanceId,
            routes,
          })
          yield* rpc(source, "instance.network.routes.write", actor, {
            instanceId: from.instanceId,
            routes: [],
          })
        }
        // Its hostnames belong to the copy now, and their DNS records
        // point at its Relay.
        yield* moveResourceWebHostnamesEffect(
          {
            relayId: from.relayId,
            resourceId: from.instanceId,
            resourceType: "instance",
          },
          {
            relayId: destination.id,
            resourceId: to.instanceId,
            resourceType: "instance",
          }
        )
      })
    )
  }
  if (row.mode === "duplicate") {
    yield* finish("restart", restartSourceEffect(row, actor))
  }
  // Last, once everything it held belongs to the copy: the old server is
  // backed up in full and then deleted, in the background, as deleting it
  // with a final backup does.
  const deleteSource = row.mode === "migrate" ? options.deleteSource : null
  if (deleteSource && !done.has("delete")) {
    // Cancelled before it got here, as it may be while the parts above run
    // under an older worker: cleaned up, not handed to deletion.
    const current = yield* loadMigration(row.id)
    if (!current || Number(current.claim_generation) !== generation) {
      return yield* Effect.fail(new StaleClaim())
    }
    if (current.state === "cancelling") {
      return yield* Effect.fail(new MigrationCancelled())
    }
  }
  if (deleteSource) {
    yield* finish(
      "delete",
      promise(() =>
        requestResourceDeletion({
          finalBackup: true,
          kind: "instance",
          relayId: source.id,
          resourceId: from.instanceId,
          user: actor,
          ...(deleteSource.storageId === undefined
            ? {}
            : { storageId: deleteSource.storageId }),
        })
      )
    )
  }
  yield* endMigration(row, generation, "completed", null)
})

// A moved server keeps its owner: the copy passes from whoever moved it to
// the old server's owner, and both see their authority change.
const handOverOwnerEffect = Effect.fnUntraced(function* (
  row: MigrationRow,
  actor: AuthenticatedUser
) {
  const ownerId = yield* instanceOwner(
    row.source_relay_id,
    row.source_instance_id
  )
  if (!ownerId || ownerId === actor.id) return
  const database = yield* Database
  yield* database.transaction("serverMigrations.handOverOwner", (transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute(
        `UPDATE ${databaseTable("instance")}
            SET owner_id = ?, owner_provisional = 0
          WHERE relay_id = ? AND instance_id = ?`,
        [ownerId, row.destination_relay_id, row.destination_instance_id]
      )
      for (const userId of [actor.id, ownerId]) {
        yield* advanceAuthorizationRevisionEffect(transaction, {
          targets: [
            {
              relayId: row.destination_relay_id,
              scope: {
                instanceId: row.destination_instance_id,
                kind: "instance",
              },
            },
          ],
          userId,
        })
      }
    })
  )
  yield* promise(() =>
    publishResourceAccessChange([actor.id, ownerId], [row.destination_relay_id])
  )
})

// The old server goes back to running if it ran before the copy stopped it.
const restartSourceEffect = Effect.fnUntraced(function* (
  row: MigrationRow,
  actor: AuthenticatedUser
) {
  if (row.source_was_running !== 1) return
  const source = yield* relay(row.source_relay_id)
  const instance = yield* snapshotInstance(
    source,
    row.source_instance_id,
    actor
  )
  if (!instance || instance.observedState !== "stopped") return
  yield* rpc(source, "instance.action", actor, {
    action: "start",
    instanceId: row.source_instance_id,
  })
  yield* promise(() => provisionInstanceDomainBestEffort(instance, source.id))
})

/**
 * Ends a migration and tells its person. A copy that didn't finish is
 * removed, and the old server is started again if the copy stopped it. One
 * that failed while carrying things over keeps its new server, since it may
 * hold what was already moved to it.
 */
const endMigration = Effect.fnUntraced(function* (
  claimed: MigrationRow,
  generation: number,
  ending: "completed" | "failed" | "cancelled",
  endingError: string | null
) {
  // What the failed step recorded, such as whether it stopped the old
  // server, and only while this worker still holds it: one that took over
  // does its own cleaning up.
  const row = yield* loadMigration(claimed.id)
  if (
    !row ||
    Number(row.claim_generation) !== generation ||
    (row.state !== "running" && row.state !== "cancelling")
  ) {
    return
  }
  // Handing the old server to its deletion is the move's last part, and
  // can't be taken back: once its final backup is planned, the move is
  // done, and the old server stays stopped for it, however the move ended.
  const sourceDeleting =
    ending !== "completed" &&
    row.mode === "migrate" &&
    row.step === "finish" &&
    migrationOptions(row).deleteSource !== null &&
    sourceHandedToDeletion(
      yield* findResourceDeletionEffect(
        row.source_relay_id,
        "instance",
        row.source_instance_id
      )
    )
  const state = sourceDeleting ? "completed" : ending
  const error = sourceDeleting ? null : endingError
  // Recorded as ending before anything is undone, by a write that holds
  // only while this worker does, so a worker that takes over from here
  // finishes the cleanup rather than carrying on the copy it removes.
  if (state !== "completed") {
    const ending = yield* claimWrite(
      row.id,
      generation,
      "state = 'cancelling', error = ?",
      [error?.slice(0, 512) ?? null]
    ).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        cause instanceof StaleClaim ? Effect.succeed(false) : Effect.fail(cause)
      )
    )
    if (!ending) return
  }
  const cleanup: Array<string> = []
  if (state !== "completed") {
    const actor = yield* currentActingUser(row.requested_by, row.actor).pipe(
      Effect.option
    )
    if (actor._tag === "Some") {
      if (row.transfer_id) {
        yield* cancelRelayTransferEffect(actor.value, {
          ...transferRequest(row),
          transferId: row.transfer_id,
        }).pipe(Effect.catch(() => Effect.void))
      }
      if (row.destination_created && row.step !== "finish") {
        // Deleted in the background, as any deletion is; one that stops
        // says so on the copy's page.
        yield* promise(() =>
          requestResourceDeletion({
            finalBackup: false,
            kind: "instance",
            relayId: row.destination_relay_id,
            resourceId: row.destination_instance_id,
            user: actor.value,
          })
        ).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              cleanup.push(
                `The partial copy ${row.destination_name} couldn't be removed: ${errorMessage(cause)}`
              )
            })
          )
        )
      }
      yield* restartSourceEffect(row, actor.value).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            cleanup.push(
              `${row.source_name} couldn't be started again: ${errorMessage(cause)}`
            )
          })
        )
      )
    }
  }
  const message = [error, ...cleanup].filter(Boolean).join(". ") || null
  const now = yield* Clock.currentTimeMillis
  yield* claimWrite(
    row.id,
    generation,
    "state = ?, error = ?, finished_at = ?",
    [state, message?.slice(0, 512) ?? null, now],
    "release"
  )
  yield* notifyUsersEffect([row.requested_by], `server.migration:${row.id}`, {
    destination: {
      id: row.destination_instance_id,
      name: row.destination_name,
      relayId: row.destination_relay_id,
      type: "instance",
    },
    ...(message ? { error: message } : {}),
    ...(state === "completed" &&
    row.mode === "migrate" &&
    migrationOptions(row).deleteSource
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
  })
  publishNotificationChange([row.requested_by])
  publishMigrationChange(row.requested_by)
})

// ---------------------------------------------------------- helpers

// The step after one that finished. A migration started before the copy was
// made first may have backed up or stopped the old server already, so a
// step that's done is passed over whichever order it ran in.
function nextStep(
  row: MigrationRow,
  options: ServerMigrationOptions,
  after: "provision" | "backup" | "stop"
): MigrationStep {
  if (after === "provision" && options.backup && row.backup_id === null) {
    return "backup"
  }
  if (
    after !== "stop" &&
    options.stopSource &&
    row.source_was_running === null
  ) {
    return "stop"
  }
  return row.destination_created ? "copy" : "create"
}

// Fails unless the copy still fits: its limits, before it's created, and
// the disk the move needs on both Relays. A backup already taken is counted
// in what's free, not again.
const requireRoom = Effect.fnUntraced(function* (
  row: MigrationRow,
  actor: AuthenticatedUser,
  options: ServerMigrationOptions,
  limits: boolean
) {
  const [source, destination] = yield* Effect.all(
    [relay(row.source_relay_id), relay(row.destination_relay_id)],
    { concurrency: 2 }
  )
  const problems = yield* promise(() =>
    checkMigrationRoom({
      backup: row.backup_id === null ? options.backup : null,
      copyLimits: options.limits,
      destination,
      instanceId: row.source_instance_id,
      limits,
      source,
      subject: actor.id,
    })
  )
  if (problems.length) {
    return yield* Effect.fail(
      new Error(problems.map((problem) => problem.message).join(". "))
    )
  }
})

// Polls `check` until it holds, renewing the lease and stopping for a
// cancellation; fails once `timeoutMs` passes, unless it's null.
const waitUntil = Effect.fnUntraced(function* (
  id: string,
  generation: number,
  timeoutMs: number | null,
  what: string,
  check: () => Effect.Effect<boolean, unknown, AppCache | Database>
) {
  const startedAt = yield* Clock.currentTimeMillis
  while (true) {
    if (yield* check()) return
    const now = yield* Clock.currentTimeMillis
    if (timeoutMs !== null && now - startedAt > timeoutMs) {
      return yield* Effect.fail(new Error(`Timed out waiting for ${what}`))
    }
    const row = yield* loadMigration(id)
    if (!row || Number(row.claim_generation) !== generation) {
      return yield* Effect.fail(new StaleClaim())
    }
    if (row.state === "cancelling") {
      return yield* Effect.fail(new MigrationCancelled())
    }
    yield* claimWrite(id, generation, "error = error", [])
    yield* Effect.sleep(POLL_MS)
  }
})

// Writes as this claim, failing when a newer one took over.
const claimWrite = Effect.fnUntraced(function* (
  id: string,
  generation: number,
  set: string,
  values: Array<string | number | null>,
  lease: "renew" | "release" = "renew"
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "serverMigrations.claimWrite",
    `UPDATE ${databaseTable("server_migration")}
        SET ${set}, lease_until = ?, updated_at = ?
      WHERE id = ? AND claim_generation = ?
        AND state IN ('running', 'cancelling')`,
    [...values, lease === "renew" ? now + LEASE_MS : 0, now, id, generation]
  )
  if (result.affectedRows === 0) return yield* Effect.fail(new StaleClaim())
})

const loadMigration = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<MigrationRow>(
    "serverMigrations.load",
    `SELECT * FROM ${databaseTable("server_migration")} WHERE id = ? LIMIT 1`,
    [id]
  )
  return rows[0] ?? null
})

const instanceOwner = Effect.fnUntraced(function* (
  relayId: string,
  instanceId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { owner_id: string | null }
  >(
    "serverMigrations.owner",
    `SELECT owner_id FROM ${databaseTable("instance")}
      WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
    [relayId, instanceId]
  )
  return rows[0]?.owner_id ?? null
})

function relay(id: string) {
  return promise(() => activeRelay(id))
}

function snapshotInstance(
  relay: PersistedRelay,
  instanceId: string,
  actor: AuthenticatedUser
): Effect.Effect<RelayInstance | null, unknown> {
  return rpc(relay, "relay.snapshot", actor, {}).pipe(
    Effect.map(
      (value) =>
        relaySnapshotSchema
          .parse(value)
          .instances.find((instance) => instance.id === instanceId) ?? null
    )
  )
}

function rpc(
  relay: PersistedRelay,
  operation:
    | "instance.action"
    | "instance.network.routes.read"
    | "instance.network.routes.write"
    | "relay.snapshot",
  actor: AuthenticatedUser,
  payload: unknown
) {
  return promise(async () => {
    const { relayRpc } = await import("@/lib/relay-connection")
    return relayRpc(
      relay,
      operation,
      payload,
      operation === "instance.action"
        ? relayControlDeadlineMs("instance.action")
        : 30_000,
      actor.id
    )
  })
}

function transferRequest(row: MigrationRow): RelayTransferRequest {
  return {
    destination: {
      path: "",
      relayId: row.destination_relay_id,
      rootId: row.destination_instance_id,
    },
    source: {
      paths: [],
      relayId: row.source_relay_id,
      rootId: row.source_instance_id,
    },
  }
}

function migrationOptions(row: MigrationRow): ServerMigrationOptions {
  return serverMigrationOptionsSchema.parse(
    typeof row.options === "string" ? JSON.parse(row.options) : row.options
  )
}

const FinishedParts = Schema.Array(
  Schema.Literals([
    "access",
    "backups",
    "delete",
    "domains",
    "owner",
    "routes",
    "restart",
  ])
)

function finishedParts(row: MigrationRow): ReadonlyArray<FinishedPart> {
  if (row.finished_parts == null) return []
  const value =
    typeof row.finished_parts === "string"
      ? (JSON.parse(row.finished_parts) as unknown)
      : row.finished_parts
  return Schema.decodeUnknownSync(FinishedParts)(value)
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
    migrationOptions(row).deleteSource !== null
  )
}

function publishMigrationChange(userId: string) {
  publishRealtimeChange({
    audience: { kind: "users", userIds: [userId] },
    topics: ["server-migrations"],
    type: "hearth.invalidate",
  })
}

function promise<A>(run: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
