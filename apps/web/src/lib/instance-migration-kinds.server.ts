import { randomUUID } from "node:crypto"

import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  relayControlDeadlineMs,
  relayCreateInstanceSchema,
  relayInstanceWebRouteStateSchema,
  relaySnapshotSchema,
  type InstanceKind,
  type RelayInstance,
  type ResourceLimits,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { setInstanceDomainOptOutEffect } from "@/effect/addresses"
import {
  getBackupCatalogRecordEffect,
  linkInstanceBackupsEffect,
  reserveInstanceBackupEffect,
} from "@/effect/backups"
import type { AppCache } from "@/effect/cache"
import { Database } from "@/effect/database"
import { promiseEffect } from "@/effect/promise"
import {
  copyInstanceAccessEffect,
  publishResourceAccessChange,
} from "@/lib/access-policy-mutations"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { advanceAuthorizationRevisionEffect } from "@/lib/authorization-revision"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { requireBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { databaseTable } from "@/lib/database-config"
import { reserveServerInstanceIdEffect } from "@/lib/provisioning.server"
import { activeRelay, type PersistedRelay } from "@/lib/relay-registry"
import { relayResourceLimitsRequest } from "@/lib/resource-limits.server"
import {
  instanceScope,
  relayScope,
  resolveScopeAuthorization,
} from "@/lib/scope-authorization.server"
import type { ServerMigrationOptions } from "@/lib/server-migration-input"
import type { MigrationRoomProblem } from "@/lib/server-migration-room"
import { checkMigrationRoom } from "@/lib/server-migration-room.server"
import { provisionServer } from "@/lib/server-provisioning.server"
import { brickRecipeDefinition } from "@/server/bricks"
import { loadInstanceRecipe } from "@/server/bricks.server"
import {
  moveInstanceDomainsEffect,
  moveResourceWebHostnamesEffect,
  provisionInstanceDomainBestEffort,
} from "@/server/addresses.server"

// What differs by kind about moving and duplicating an instance: what its
// copy is built from, how the copy is made, where its files are, how it's
// backed up first, and what a finished copy is handed. Holding both
// instances, carrying the migration on across restarts, waiting, cancelling
// and undoing are the same for every kind (`instance-migrations.server.ts`).

/** The old instance or its copy, and the Relay each is on. */
export interface MigrationSide {
  readonly instanceId: string
  readonly name: string
  readonly relayId: string
}

/** A migration as a kind is told of it. */
export interface Migration {
  /** Where a backup first goes, settled when it was asked for. */
  readonly backupStorageIds: ReadonlyArray<string | null>
  /** The key the copy is provisioned under, however often it's asked. */
  readonly createKey: string
  readonly destination: MigrationSide
  readonly mode: "duplicate" | "migrate"
  readonly source: MigrationSide
}

/** An instance as its Relay has it now. */
export interface MigratedState {
  /** Set while it's being created; `failed` once creating it failed. */
  readonly provisioning: {
    readonly error: string | null
    readonly failed: boolean
  } | null
  readonly stopped: boolean
}

export interface MigratedKind {
  kind: InstanceKind
  /** The kind as a Relay request names it. */
  relayKind: "app" | "database" | "instance"
  /** The kind as lanes, deletions and notifications name it. */
  resourceType: "app" | "database" | "instance"
  /**
   * Fails unless the person may copy one as they asked: reading what its
   * copy is built from, creating one where the copy goes, and each option's
   * own permission on the old one.
   */
  authorize: (
    user: AuthenticatedUser,
    asked: {
      readonly destination: { readonly relayId: string }
      readonly mode: Migration["mode"]
      readonly options: ServerMigrationOptions
      readonly source: {
        readonly instanceId: string
        readonly relayId: string
      }
    }
  ) => Promise<void>
  /**
   * What would keep its copy from fitting, as the Relays report it now.
   * With `limits`, the copy's limits are checked too, as before it's made.
   */
  roomProblems: (
    migration: Migration,
    asked: {
      readonly backup: ServerMigrationOptions["backup"]
      /** The copy's limits, when it's given its own. */
      readonly copyLimits: ResourceLimits | null
      readonly limits: boolean
    },
    subject: string
  ) => Promise<ReadonlyArray<MigrationRoomProblem>>
  /** One on a Relay as it is now, or null when the Relay has none. */
  state: (
    relay: PersistedRelay,
    instanceId: string,
    subject: string | undefined
  ) => Effect.Effect<MigratedState | null, unknown>
  /**
   * Whether Hearth recorded one, as provisioning does before it asks the
   * Relay, and keeps when it can't tell whether the Relay made it.
   */
  recorded: (
    relayId: string,
    instanceId: string
  ) => Effect.Effect<boolean, unknown, Database>
  /**
   * Reserves the copy's ID under the key it's provisioned with, before the
   * migration starts, so every run of it makes the same copy.
   */
  reserveId: (createKey: string) => Effect.Effect<string, unknown, Database>
  /**
   * Reads what the copy is built from, failing when the old one has nothing
   * to build one from, and answers with making the copy, stopped, from
   * exactly that: what changes on the old one afterwards, as while the
   * copy's room is checked, isn't taken. Making it again resumes the same
   * copy, under the migration's key.
   */
  prepare: (
    relays: {
      readonly destination: PersistedRelay
      readonly source: PersistedRelay
    },
    migration: Migration,
    actor: AuthenticatedUser,
    options: ServerMigrationOptions
  ) => Effect.Effect<Effect.Effect<void, unknown, Database>, unknown>
  /** The file root one's files are under, which its Relay packs or fills. */
  root: (instanceId: string) => string
  /**
   * Reserves a full backup of the old one under `backupId`, once however
   * often it's asked, and queues it on its Relay.
   */
  backupFirst: (
    migration: Migration,
    actor: AuthenticatedUser,
    backupId: string
  ) => Effect.Effect<void, unknown, Database>
  /**
   * Starts one again if it's stopped: as the person, or as Hearth, with no
   * subject.
   */
  restart: (
    relay: PersistedRelay,
    instanceId: string,
    subject: string | undefined
  ) => Effect.Effect<void, unknown>
  /**
   * What a finished copy is handed of the old one's, each asked for on its
   * own and safe to ask again.
   */
  handOver: {
    /** A move's copy passes to the old one's owner. */
    owner: (
      migration: Migration,
      actor: AuthenticatedUser
    ) => Effect.Effect<void, unknown, Database>
    /** The old one's people get the same access to the copy. */
    access: (
      migration: Migration,
      actor: AuthenticatedUser
    ) => Effect.Effect<void, unknown, Database>
    /** The old one's backups restore to the copy too. */
    backups: (
      migration: Migration,
      actor: AuthenticatedUser
    ) => Effect.Effect<void, unknown, Database>
    /** A move's copy takes the old one's managed domains. */
    domains: (
      migration: Migration,
      actor: AuthenticatedUser
    ) => Effect.Effect<void, unknown, AppCache | Database>
    /** A move's copy takes the old one's web routes and their hostnames. */
    routes: (
      migration: Migration,
      actor: AuthenticatedUser
    ) => Effect.Effect<void, unknown, AppCache | Database>
  }
}

// A game server is copied from the Brick snapshot, variables and limits its
// Relay lists for it, and its files are its one folder.
const servers: MigratedKind = {
  kind: "server",
  relayKind: "instance",
  resourceType: "instance",
  authorize: async (user, asked) => {
    const { options } = asked
    const authorization = await resolveScopeAuthorization({
      scope: instanceScope(asked.source.relayId, asked.source.instanceId),
      user,
    })
    authorization.require("instance.files.read")
    authorization.require("instance.configuration.read")
    ;(
      await resolveScopeAuthorization({
        scope: relayScope(asked.destination.relayId),
        user,
      })
    ).require("instance.create")
    // Whether or not it runs now: it may be started before the copy stops
    // it, and starts again after a duplicate.
    if (options.stopSource) {
      authorization.require("instance.power.stop")
      if (asked.mode === "duplicate") {
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
  },
  roomProblems: async (migration, asked, subject) => {
    const [source, destination] = await Promise.all([
      activeRelay(migration.source.relayId),
      activeRelay(migration.destination.relayId),
    ])
    return checkMigrationRoom({
      backup: asked.backup,
      copyLimits: asked.copyLimits,
      destination,
      instanceId: migration.source.instanceId,
      limits: asked.limits,
      source,
      subject,
    })
  },
  state: (relay, instanceId, subject) =>
    snapshotInstance(relay, instanceId, subject).pipe(
      Effect.map(
        (instance) =>
          instance && {
            provisioning: instance.provisioning
              ? {
                  error: instance.provisioning.error ?? null,
                  failed: instance.provisioning.phase === "failed",
                }
              : null,
            stopped: instance.observedState === "stopped",
          }
      )
    ),
  recorded: Effect.fnUntraced(function* (relayId, instanceId) {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket>(
      "serverMigrations.destination",
      `SELECT 1 FROM ${databaseTable("instance")}
        WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
      [relayId, instanceId]
    )
    return rows.length > 0
  }),
  reserveId: reserveServerInstanceIdEffect,
  // From the exact Brick the old server was built from, with its settings,
  // and its limits unless the copy was given its own.
  prepare: Effect.fnUntraced(function* (
    { destination, source },
    migration,
    actor,
    options
  ) {
    const instance = yield* snapshotInstance(
      source,
      migration.source.instanceId,
      actor.id
    )
    if (!instance?.brickSource) {
      return yield* fail(
        `${migration.source.name} has no Brick to build its copy from`
      )
    }
    return Effect.gen(function* () {
      const recipe = yield* promiseEffect(() =>
        loadInstanceRecipe(source, instance)
      )
      const diskLimitBytes =
        (options.limits ?? instance.pendingLimits ?? instance.limits)
          .diskBytes ?? DEFAULT_INSTANCE_DISK_LIMIT_BYTES
      const create = yield* Effect.try({
        try: () =>
          relayCreateInstanceSchema.parse({
            diskLimitBytes,
            ...relayResourceLimitsRequest(
              options.limits ?? instance.pendingLimits ?? instance.limits
            ),
            name: migration.destination.name,
            recipe: recipe.brickSource,
            recipeDefinition: brickRecipeDefinition(recipe.brick),
            start: false,
            variables: instance.variables ?? {},
          }),
        catch: (cause) => cause,
      })
      // A move takes the old server's domains along, so the copy isn't
      // given one of its own when it's provisioned.
      if (migration.mode === "migrate" && options.moveDomain) {
        yield* setInstanceDomainOptOutEffect(
          destination.id,
          migration.destination.instanceId,
          true
        )
      }
      // Whoever copies a server owns the copy while it's built, so they may
      // fill it; a finished move hands it to the old server's owner.
      yield* promiseEffect(() =>
        provisionServer({
          create,
          idempotencyKey: migration.createKey,
          instanceId: migration.destination.instanceId,
          ownerId: actor.id,
          relay: destination,
          requestedBy: actor.id,
        })
      )
    })
  }),
  root: (instanceId) => instanceId,
  // A full archive, to the destinations settled when it was asked for.
  // Under the copy's backup ID, a step cut off once it's reserved finds it,
  // so it's reserved once.
  backupFirst: Effect.fnUntraced(function* (migration, actor, backupId) {
    yield* promiseEffect(() =>
      requireBackupStorageSelection({
        relayId: migration.source.relayId,
        storageIds: migration.backupStorageIds,
        targetId: migration.source.instanceId,
        targetKind: "instance",
        user: actor,
      })
    )
    if (yield* getBackupCatalogRecordEffect(backupId)) return
    const [source, destination] = yield* relays(migration)
    const dispatch = yield* reserveInstanceBackupEffect({
      backupId,
      createdBy: actor.id,
      mode: "full",
      name: `Before ${migration.mode === "migrate" ? "moving" : "copying"} to ${destination.name}`.slice(
        0,
        120
      ),
      relayId: source.id,
      requestedMaxBytes: null,
      storageIds: migration.backupStorageIds,
      targetId: migration.source.instanceId,
      taskId: randomUUID(),
    })
    publishBackupChange(source.id, backupId)
    // Queued on the Relay now if it answers; otherwise reconciling the
    // Relay's backups, as each check does, queues it.
    yield* promiseEffect(async () => {
      const { dispatchBackupTask } = await import("@/lib/backup-reconciliation")
      await dispatchBackupTask(source, dispatch, actor.id)
    }).pipe(Effect.ignore)
  }),
  // Starting it provisions its domain again, as any start of it does.
  restart: Effect.fnUntraced(function* (relay, instanceId, subject) {
    const instance = yield* snapshotInstance(relay, instanceId, subject)
    if (!instance || instance.observedState !== "stopped") return
    yield* relayRequest(relay, "instance.action", subject, {
      action: "start",
      id: instanceId,
      kind: "instance",
    })
    yield* promiseEffect(() =>
      provisionInstanceDomainBestEffort(instance, relay.id)
    )
  }),
  handOver: {
    // A moved server keeps its owner: the copy passes from whoever moved it
    // to the old server's owner, and both see their authority change.
    owner: Effect.fnUntraced(function* (migration, actor) {
      const database = yield* Database
      const [owner] = yield* database.queryRows<
        RowDataPacket & { owner_id: string | null }
      >(
        "serverMigrations.owner",
        `SELECT owner_id FROM ${databaseTable("instance")}
          WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
        [migration.source.relayId, migration.source.instanceId]
      )
      const ownerId = owner?.owner_id
      if (!ownerId || ownerId === actor.id) return
      const { destination } = migration
      yield* database.transaction(
        "serverMigrations.handOverOwner",
        (transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute(
              `UPDATE ${databaseTable("instance")}
                  SET owner_id = ?, owner_provisional = 0
                WHERE relay_id = ? AND instance_id = ?`,
              [ownerId, destination.relayId, destination.instanceId]
            )
            for (const userId of [actor.id, ownerId]) {
              yield* advanceAuthorizationRevisionEffect(transaction, {
                targets: [
                  {
                    relayId: destination.relayId,
                    scope: {
                      instanceId: destination.instanceId,
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
        publishResourceAccessChange([actor.id, ownerId], [destination.relayId])
      )
    }),
    access: (migration, actor) =>
      copyInstanceAccessEffect({
        actorId: actor.id,
        from: sideOf(migration.source),
        to: sideOf(migration.destination),
      }).pipe(
        Effect.flatMap((userIds) =>
          promiseEffect(() =>
            publishResourceAccessChange(userIds, [
              migration.destination.relayId,
            ])
          )
        )
      ),
    backups: (migration, actor) =>
      linkInstanceBackupsEffect({
        from: sideOf(migration.source),
        linkedBy: actor.id,
        to: sideOf(migration.destination),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            publishBackupChange(migration.source.relayId)
            publishBackupChange(migration.destination.relayId)
          })
        ),
        Effect.asVoid
      ),
    domains: Effect.fnUntraced(function* (migration, actor) {
      const destination = yield* relay(migration.destination.relayId)
      const instance = yield* snapshotInstance(
        destination,
        migration.destination.instanceId,
        actor.id
      )
      if (!instance) return yield* fail("The new server is gone")
      yield* moveInstanceDomainsEffect(sideOf(migration.source), {
        ...instance,
        relayId: destination.id,
      })
    }),
    routes: Effect.fnUntraced(function* (migration, actor) {
      const [source, destination] = yield* relays(migration)
      const state = relayInstanceWebRouteStateSchema.parse(
        yield* relayRequest(source, "instance.network.routes.read", actor.id, {
          id: migration.source.instanceId,
          kind: "instance",
        })
      )
      // Run again after the routes moved, it finds none, and still hands
      // the hostnames over.
      if (state.routes.length > 0) {
        const routes = state.routes.map(({ id: _id, ...route }) => route)
        yield* relayRequest(
          destination,
          "instance.network.routes.write",
          actor.id,
          {
            id: migration.destination.instanceId,
            kind: "instance",
            routes,
          }
        )
        yield* relayRequest(
          source,
          "instance.network.routes.write",
          actor.id,
          {
            id: migration.source.instanceId,
            kind: "instance",
            routes: [],
          }
        )
      }
      // Its hostnames belong to the copy now, and their DNS records point
      // at its Relay.
      yield* moveResourceWebHostnamesEffect(
        {
          relayId: migration.source.relayId,
          resourceId: migration.source.instanceId,
          resourceType: "instance",
        },
        {
          relayId: destination.id,
          resourceId: migration.destination.instanceId,
          resourceType: "instance",
        }
      )
    }),
  },
}

/** Every kind that can be moved or duplicated. */
export const migratedKinds: ReadonlyArray<MigratedKind> = [servers]

export function migratedKind(kind: InstanceKind): MigratedKind {
  const found = migratedKinds.find((candidate) => candidate.kind === kind)
  if (!found) throw new Error(`A ${kind} can't be moved or duplicated yet`)
  return found
}

/**
 * A Relay request as the person, whose permissions the Relay checks too, or
 * as Hearth's own, with no subject.
 */
export function relayRequest(
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

function relay(id: string) {
  return promiseEffect(() => activeRelay(id))
}

function relays(migration: Migration) {
  return Effect.all(
    [relay(migration.source.relayId), relay(migration.destination.relayId)],
    { concurrency: 2 }
  )
}

function snapshotInstance(
  relay: PersistedRelay,
  instanceId: string,
  subject: string | undefined
): Effect.Effect<RelayInstance | null, unknown> {
  return relayRequest(relay, "relay.snapshot", subject, {}).pipe(
    Effect.map(
      (value) =>
        relaySnapshotSchema
          .parse(value)
          .instances.find((instance) => instance.id === instanceId) ?? null
    )
  )
}

function sideOf(side: MigrationSide) {
  return { instanceId: side.instanceId, relayId: side.relayId }
}

function fail(message: string) {
  return Effect.fail(new Error(message))
}
