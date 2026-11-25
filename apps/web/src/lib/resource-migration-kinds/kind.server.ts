import {
  relayControlDeadlineMs,
  relayInstanceWebRoutesCheckSchema,
  relayInstanceWebRouteStateSchema,
  webRouteHostnames as routeHostnames,
  type AccessPermission,
  type RelayInstanceWebRouteInput,
  type ResourceLimits,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { WorkflowEngine } from "effect/workflow"
import type { RowDataPacket } from "mysql2/promise"

import { listResourceAddressesEffect } from "@/effect/addresses"
import type { AppCache } from "@/effect/cache"
import { Database } from "@/effect/database"
import {
  forgetPrimaryAddressEffect,
  loadPrimaryAddressEffect,
  setPrimaryAddressEffect,
} from "@/effect/primary-addresses"
import { promiseEffect } from "@/effect/promise"
import {
  copyResourceAccessEffect,
  publishResourceAccessChange,
} from "@/lib/access-policy-mutations"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { advanceAuthorizationRevisionEffect } from "@/lib/authorization-revision"
import { databaseTable } from "@/lib/database-config"
import { activeRelay, type PersistedRelay } from "@/lib/relay-registry"
import type {
  MigratedKindName,
  ResourceMigrationOptions,
} from "@/lib/resource-migration-input"
import type { ResourceScope } from "@/lib/resource-permissions"
import { releaseWebCertificatesEffect } from "@/lib/web-certificates.server"
import { moveResourceWebHostnamesEffect } from "@/server/addresses.server"

// Moving and duplicating is one operation for every kind of resource
// (`resource-migrations.server.ts`): holding both, carrying it on across
// restarts, checking the person may and the copy fits, stopping and
// starting, copying the data, handing things over, cancelling and undoing.
// A kind says only what is its own: how its copy is made, where its data
// is, what it is called and which permissions name it, and which of the
// things a copy can be handed it has at all.

/** The old resource or its copy, and the Relay each is on. */
export interface MigrationSide {
  readonly id: string
  readonly name: string
  readonly relayId: string
}

/** A migration as a kind is told of it. */
export interface Migration {
  /** Where a backup first goes, settled when it was asked for. */
  readonly backupStorageIds: ReadonlyArray<string | null>
  /** The key the copy is made under, however often it's asked. */
  readonly createKey: string
  readonly destination: MigrationSide
  readonly kind: MigratedKindName
  readonly mode: "duplicate" | "migrate"
  readonly source: MigrationSide
}

/** A resource as its Relay has it now. */
export interface MigratedState {
  /** Set while it's being created; `failed` once creating it failed. */
  readonly provisioning: {
    readonly error: string | null
    readonly failed: boolean
  } | null
  readonly stopped: boolean
  /** Whether it is as a new one of its kind is once made, to be filled. */
  readonly ready: boolean
}

/** A resource as the dialog shows it before anything is asked. */
export interface MigratedDescription {
  readonly name: string
  readonly provisioning: boolean
  readonly running: boolean
  /** Why no copy can be made of it, when none can. */
  readonly unbuildable: string | null
  /** The limits its copy takes unless it's given others; null without any. */
  readonly limits: ResourceLimits | null
  /**
   * Whether its copy is deployed unless it's asked not to be, for a kind
   * whose copy can be: not when it would start without what it runs on.
   */
  readonly deploys?: boolean
  /**
   * How much it holds when its Relay can't measure it: a running one's
   * live figure, else its disk limit.
   */
  readonly usedBytes: number | null
  readonly usedFrom: "running" | "limit"
}

/** One thing a copy is filled from: a root on each Relay. */
export interface MigrationPart {
  readonly source: string
  readonly destination: string
}

/** What a finished copy can be handed of the old one's. */
export const migrationHandOvers = [
  "owner",
  "access",
  "backups",
  "domains",
  "routes",
  "deploys",
] as const
export type MigrationHandOver = (typeof migrationHandOvers)[number]

export type HandOverEffect = (
  migration: Migration,
  actor: AuthenticatedUser
) => Effect.Effect<void, unknown, AppCache | Database>

export interface MigratedKind {
  /** As lanes, deletions, permissions and notifications name it. */
  readonly kind: MigratedKindName
  /** What copy calls one, inside a sentence. */
  readonly noun: string
  /** How long a copy's name may be. */
  readonly nameLimit: number
  /** Whether one is stopped and started. */
  readonly powered: boolean
  /**
   * Whether one has to run to be copied. It then isn't stopped while it's
   * copied, and a move stops the old one only once its copy is in.
   */
  readonly copiedRunning: boolean
  /**
   * Whether one is backed up before it's deleted: not one that keeps
   * nothing of its own. Left out, it is.
   */
  readonly finalBackup?: boolean
  /** The permissions that name what copying one takes. */
  readonly permissions: {
    /** On the old one, to copy it at all. */
    readonly copy: ReadonlyArray<AccessPermission>
    /** On the Relay its copy goes to, to make it there and fill it. */
    readonly create: ReadonlyArray<AccessPermission>
    readonly delete: AccessPermission
    /** To run a move's copy, on the Relay it goes to. */
    readonly deploy?: AccessPermission
    /** To hand its domains and web routes over, for a kind with either. */
    readonly network?: AccessPermission
    /**
     * Whether handing them over takes it on the Relay the copy goes to too:
     * for a kind whose owner can't change its network by owning it.
     */
    readonly networkThere?: boolean
  }
  /**
   * What the Relay its copy goes to takes besides `permissions.create`, for
   * what this one's copy would carry there, as making one with it would
   * take. Left out for a kind whose copy carries nothing more.
   */
  readonly createNeeds?: (source: {
    readonly id: string
    readonly relayId: string
  }) => Effect.Effect<ReadonlyArray<AccessPermission>, unknown, Database>
  /** Reserves the copy's ID, under the key it is made with. */
  readonly reserveId: (
    createKey: string
  ) => Effect.Effect<string, unknown, Database>
  /** One as the dialog shows it, or null when its Relay has none. */
  readonly describe: (
    relay: PersistedRelay,
    id: string,
    subject: string
  ) => Promise<MigratedDescription | null>
  /** The names a copy on a Relay can't take. */
  readonly takenNames: (
    relay: PersistedRelay,
    subject: string
  ) => Promise<ReadonlyArray<string>>
  /** One on a Relay as it is now, or null when the Relay has none. */
  readonly state: (
    relay: PersistedRelay,
    id: string,
    subject: string | undefined
  ) => Effect.Effect<MigratedState | null, unknown>
  /**
   * Whether Hearth recorded one, as making it does before it asks the
   * Relay, and keeps when it can't tell whether the Relay made it.
   */
  readonly recorded: (
    relayId: string,
    id: string
  ) => Effect.Effect<boolean, unknown, Database>
  /**
   * Reads what the copy is built from, failing when the old one has nothing
   * to build one from, and answers with making the copy from exactly that:
   * what changes on the old one afterwards, as while the copy's room is
   * checked, isn't taken. Making it again resumes the same copy, under the
   * migration's key. A copy is made stopped where its kind can be.
   */
  readonly prepare: (
    relays: {
      readonly destination: PersistedRelay
      readonly source: PersistedRelay
    },
    migration: Migration,
    actor: AuthenticatedUser,
    options: ResourceMigrationOptions
  ) => Effect.Effect<Effect.Effect<void, unknown, Database>, unknown, Database>
  /**
   * The roots one's data is under on its Relay, which a copy's room is
   * measured from: none for one whose data isn't carried.
   */
  readonly sourceRoots: (
    relayId: string,
    id: string
  ) => Effect.Effect<ReadonlyArray<string>, unknown, Database>
  /**
   * What its copy is filled from, in the order it's copied: each of the old
   * one's roots, and the root of the copy it goes into.
   */
  readonly parts: (
    migration: Migration
  ) => Effect.Effect<ReadonlyArray<MigrationPart>, unknown, Database>
  /**
   * Reserves a full backup of the old one under `backupId`, once however
   * often it's asked, and queues it on its Relay. Left out for a kind a
   * copy can't back up first.
   */
  readonly backupFirst?: (
    migration: Migration,
    actor: AuthenticatedUser,
    backupId: string
  ) => Effect.Effect<void, unknown, Database>
  /**
   * What its copy takes of the old one once it is made, before it's filled,
   * that making it couldn't give it. Asked again, it changes nothing more.
   */
  readonly settled?: (
    migration: Migration,
    actor: AuthenticatedUser,
    options: ResourceMigrationOptions
  ) => Effect.Effect<void, unknown, Database>
  /**
   * The volumes made for its copy, to delete with a copy that's undone:
   * those whoever undoes it may delete. Left out for a kind whose copy has
   * none of its own.
   */
  readonly copyVolumes?: (
    migration: Migration,
    actor: AuthenticatedUser
  ) => Effect.Effect<ReadonlyArray<string>, unknown, Database>
  /**
   * Runs a move's copy once it's filled, as the old one ran, before anything
   * is handed to it: for a kind whose copy is made without running. Its
   * steps are its own, named by `named`, under an ID chosen for it.
   */
  readonly deploy?: {
    readonly start: (
      migration: Migration,
      actorId: string,
      id: string,
      named: (step: string) => string
    ) => Effect.Effect<
      void,
      unknown,
      Database | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >
    /** Whether it's still under way, or why it failed, if it did. */
    readonly state: (
      id: string
    ) => Effect.Effect<
      "running" | "ready" | { readonly failed: string },
      unknown,
      Database
    >
    /**
     * Gives it what it serves on its own Relay, once it's ready, and whether
     * that Relay serves it yet, before anyone is sent there.
     */
    readonly serve: (
      migration: Migration,
      actor: AuthenticatedUser
    ) => Effect.Effect<unknown, unknown, Database>
    readonly served: (
      migration: Migration
    ) => Effect.Effect<
      "down" | "served" | "unknown" | "unrouted",
      unknown,
      Database
    >
    /** What follows one that's ready. */
    readonly after: (
      id: string,
      named: (step: string) => string
    ) => Effect.Effect<
      void,
      never,
      Database | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >
  }
  /** What one that was started again needs besides, of its own. */
  readonly started?: (
    relay: PersistedRelay,
    id: string,
    subject: string | undefined
  ) => Effect.Effect<void, unknown>
  /**
   * What a finished copy is handed, each asked for on its own and safe to
   * ask again. A kind lists what it has; what it lacks is never offered.
   */
  readonly handOver: Partial<Record<MigrationHandOver, HandOverEffect>>
  /**
   * What someone should know before copying this one, by what they ask
   * for: what a copy leaves behind, or what stops working. Left out for a
   * kind with nothing to say.
   */
  readonly warnings?: (
    relay: PersistedRelay,
    id: string,
    subject: string
  ) => Promise<MigrationWarnings>
  /** What the dialog says a copy would be handed, for those it has. */
  readonly handOverCounts: (
    relay: PersistedRelay,
    id: string,
    user: AuthenticatedUser,
    allowed: { readonly backups: boolean; readonly network: boolean }
  ) => Promise<MigrationHandOverCounts>
}

/** What to know before each way of copying one. */
export interface MigrationWarnings {
  readonly duplicate: ReadonlyArray<string>
  readonly migrate: ReadonlyArray<string>
}

/** How much there is of each thing a copy could be handed. */
export interface MigrationHandOverCounts {
  /** People with access, besides its owner. */
  readonly access: number
  /**
   * Its backups: how many there are, how many would link to a copy on its
   * own Relay, and how many to a copy elsewhere.
   */
  readonly backups: {
    readonly anywhere: number
    readonly here: number
    readonly total: number
  }
  readonly domains: {
    /** Whether Hearth manages domains through Cloudflare. */
    readonly managed: boolean
    readonly names: ReadonlyArray<string>
  }
  /** The hostnames it answers on; null when its Relay couldn't say. */
  readonly webRoutes: ReadonlyArray<string> | null
}

/** The scope a kind's permissions are held on: its own, or its Relay's. */
export function migrationScope(
  kind: MigratedKindName,
  side: { readonly id: string; readonly relayId: string }
): ResourceScope {
  return kind === "volume"
    ? { relayId: side.relayId, resourceId: side.relayId, resourceType: "relay" }
    : { relayId: side.relayId, resourceId: side.id, resourceType: kind }
}

/** People with access to a game server or database, besides its owner. */
export async function countAccess(
  resourceType: "database" | "instance",
  relayId: string,
  id: string
): Promise<number> {
  const { databasePool } = await import("@/lib/database")
  const record = recordOf(resourceType)
  const [rows] = await databasePool.query<
    Array<RowDataPacket & { count: number }>
  >(
    `SELECT COUNT(*) AS count FROM ${databaseTable("access_grant")} AS grant_row
       JOIN ${databaseTable(record.table)} AS record
         ON record.relay_id = grant_row.relay_id
        AND record.${record.id} = grant_row.resource_id
      WHERE grant_row.relay_id = ? AND grant_row.resource_type = ?
        AND grant_row.resource_id = ? AND grant_row.state = 'active'
        AND grant_row.user_id <> COALESCE(record.owner_id, '')`,
    [relayId, resourceType, id]
  )
  return Number(rows[0]?.count ?? 0)
}

// Hearth's own row for each kind that has one, which says who owns it.
export function recordOf(kind: "app" | "database" | "instance") {
  return {
    app: { id: "app_id", table: "app" },
    database: { id: "database_id", table: "database" },
    instance: { id: "instance_id", table: "instance" },
  }[kind]
}

/** Whether Hearth has a row for one of a kind it keeps rows of. */
export const recordedIn = (kind: "app" | "database" | "instance") =>
  Effect.fnUntraced(function* (relayId: string, id: string) {
    const database = yield* Database
    const record = recordOf(kind)
    const rows = yield* database.queryRows<RowDataPacket>(
      "resourceMigrations.recorded",
      `SELECT 1 FROM ${databaseTable(record.table)}
        WHERE relay_id = ? AND ${record.id} = ? LIMIT 1`,
      [relayId, id]
    )
    return rows.length > 0
  })

/**
 * A moved resource keeps its owner: the copy passes from whoever moved it
 * to the old one's owner, and both see their authority change.
 */
export const ownerHandOver =
  (kind: "app" | "database" | "instance"): HandOverEffect =>
  (migration, actor) =>
    Effect.gen(function* () {
      const database = yield* Database
      const record = recordOf(kind)
      const [owner] = yield* database.queryRows<
        RowDataPacket & { owner_id: string | null }
      >(
        "resourceMigrations.owner",
        `SELECT owner_id FROM ${databaseTable(record.table)}
          WHERE relay_id = ? AND ${record.id} = ? LIMIT 1`,
        [migration.source.relayId, migration.source.id]
      )
      const ownerId = owner?.owner_id
      if (!ownerId || ownerId === actor.id) return
      const { destination } = migration
      yield* database.transaction(
        "resourceMigrations.handOverOwner",
        (transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute(
              `UPDATE ${databaseTable(record.table)}
                  SET owner_id = ?${kind === "instance" ? ", owner_provisional = 0" : ""}
                WHERE relay_id = ? AND ${record.id} = ?`,
              [ownerId, destination.relayId, destination.id]
            )
            for (const userId of [actor.id, ownerId]) {
              yield* advanceAuthorizationRevisionEffect(transaction, {
                targets: [
                  {
                    relayId: destination.relayId,
                    // Only a game server's authority is delivered by
                    // itself; any other's goes with its Relay's.
                    scope:
                      kind === "instance"
                        ? { instanceId: destination.id, kind }
                        : { kind: "subject_relay" },
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
    })

/** The old one's people get the same access to the copy. */
export const accessHandOver =
  (resourceType: "database" | "instance"): HandOverEffect =>
  (migration, actor) =>
    copyResourceAccessEffect({
      actorId: actor.id,
      from: migration.source,
      resourceType,
      to: migration.destination,
    }).pipe(
      Effect.flatMap((userIds) =>
        promiseEffect(() =>
          publishResourceAccessChange(userIds, [migration.destination.relayId])
        )
      )
    )

/**
 * A Relay request as the person, whose permissions the Relay checks too, or
 * as Hearth's own, with no subject.
 */
export function relayRequest(
  relay: PersistedRelay,
  operation:
    | "instance.action"
    | "instance.network.routes.check"
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

// Asks a Relay for an instance's web routes, or to keep these, as the
// person, and answers with those it keeps.
const webRoutes = (
  relay: PersistedRelay,
  operation: "instance.network.routes.read" | "instance.network.routes.write",
  subject: string,
  payload: {
    readonly holdCertificates?: boolean
    readonly id: string
    readonly kind: "app" | "instance"
    readonly routes?: ReadonlyArray<RelayInstanceWebRouteInput>
  }
) =>
  relayRequest(relay, operation, subject, payload).pipe(
    Effect.flatMap((state) =>
      Effect.try({
        try: () => relayInstanceWebRouteStateSchema.parse(state).routes,
        catch: (cause) =>
          new Error(`${relay.name}'s web routes couldn't be read`, { cause }),
      })
    )
  )

/**
 * Gives a move's copy the old one's web routes on its own Relay, while the
 * old one keeps serving them: nothing sends anyone there until their names
 * move too (`moveWebRoutes`), so no certificate is asked for until then.
 * Asked again, the copy keeps those it was given.
 */
export const copyWebRoutes = Effect.fnUntraced(function* (
  kind: "app" | "instance",
  migration: Migration,
  actor: AuthenticatedUser
) {
  const [source, destination] = yield* relays(migration)
  const read = "instance.network.routes.read"
  const old = yield* webRoutes(source, read, actor.id, {
    id: migration.source.id,
    kind,
  })
  const copy = yield* webRoutes(destination, read, actor.id, {
    id: migration.destination.id,
    kind,
  })
  if (old.length === 0 || copy.length > 0) return { copy, old }
  return {
    copy: yield* webRoutes(
      destination,
      "instance.network.routes.write",
      actor.id,
      {
        holdCertificates: true,
        id: migration.destination.id,
        kind,
        routes: old.map(({ id: _id, ...route }) => route),
      }
    ),
    old,
  }
})

/**
 * Whether a copy's Relay serves its routes yet: `unknown` where another proxy
 * does, which can't be asked, and `down` only when none of them reaches it,
 * since one that never did needn't now.
 */
export const webRoutesServed = Effect.fnUntraced(function* (
  kind: "app" | "instance",
  migration: Migration
) {
  const [, destination] = yield* relays(migration)
  const { answers } = relayInstanceWebRoutesCheckSchema.parse(
    yield* relayRequest(
      destination,
      "instance.network.routes.check",
      undefined,
      { id: migration.destination.id, kind }
    )
  )
  if (answers === null || answers.length === 0) return "unknown" as const
  if (answers.some(({ state }) => state === "served")) return "served" as const
  return answers.some(({ state }) => state === "down")
    ? ("down" as const)
    : ("unrouted" as const)
})

/**
 * A move's copy takes the old one's web routes and their hostnames, for a
 * kind whose routes its Relay keeps under its own name. The one that is the
 * old one's primary address is the copy's. The names point at the copy's
 * Relay only once it has the routes, and their certificates are asked for
 * only once they point there.
 */
export function moveWebRoutes(
  kind: "app" | "instance",
  migration: Migration,
  actor: AuthenticatedUser
) {
  return Effect.gen(function* () {
    const [source, destination] = yield* relays(migration)
    const from = { id: migration.source.id, type: kind }
    const to = { id: migration.destination.id, type: kind }
    const primary = yield* loadPrimaryAddressEffect(from)
    // Run again after the old one's were taken from it, it finds none there,
    // and still hands their names over.
    const { copy, old } = yield* copyWebRoutes(kind, migration, actor)
    if (old.length > 0) {
      // Each route has an ID of its own on the new Relay. Named before the
      // old one's go, so a run cut short still finds which it was.
      const was =
        primary?.kind === "route"
          ? old.find((route) => route.id === primary.ref)
          : undefined
      const chosen = was
        ? copy.find(
            (route) =>
              route.hostname === was.hostname && route.path === was.path
          )
        : undefined
      if (chosen) {
        yield* setPrimaryAddressEffect(to, { kind: "route", ref: chosen.id })
      }
      yield* webRoutes(source, "instance.network.routes.write", actor.id, {
        id: from.id,
        kind,
        routes: [],
      })
    }
    // A name in a tunnel stays the old one's: it isn't handed over.
    if (primary?.kind === "route") yield* forgetPrimaryAddressEffect(from)
    // Its hostnames belong to the copy now, and their DNS records point at
    // its Relay.
    yield* moveResourceWebHostnamesEffect(
      {
        relayId: source.id,
        resourceId: from.id,
        resourceType: kind,
      },
      {
        relayId: destination.id,
        resourceId: to.id,
        resourceType: kind,
      }
    )
    // Their certificates are asked for once they point there: those Kiln
    // doesn't point are up to whoever does, and one whose record couldn't be
    // changed yet is released when it is.
    const addresses = yield* listResourceAddressesEffect({
      relayId: destination.id,
      resourceId: to.id,
      resourceType: kind,
    })
    const waiting = new Set(
      addresses.flatMap((row) =>
        row.recordId !== null && row.lastError !== null ? [row.hostname] : []
      )
    )
    yield* releaseWebCertificatesEffect(
      destination.id,
      copy.flatMap(routeHostnames).filter((name) => !waiting.has(name))
    )
  })
}

/**
 * The hostnames its web routes answer on, or null when they couldn't be
 * read, which is never the same as having none: a move would leave them.
 */
export async function webRouteHostnames(
  kind: "app" | "instance",
  relay: PersistedRelay,
  id: string,
  subject: string
): Promise<Array<string> | null> {
  const { reportAppError, runAppEffect } = await import("@/effect/runtime")
  return runAppEffect(
    "resourceMigrations.webRoutes",
    webRoutes(relay, "instance.network.routes.read", subject, {
      id,
      kind,
    }).pipe(
      Effect.map((routes) => [
        ...new Set(routes.map((route) => route.hostname)),
      ]),
      Effect.catch((cause) =>
        Effect.sync(() => {
          reportAppError(cause, {
            attributes: { "relay.id": relay.id },
            operation: "resourceMigrations.webRoutes",
          })
          return null
        })
      )
    )
  )
}

export function relay(id: string) {
  return promiseEffect(() => activeRelay(id))
}

export function relays(migration: Migration) {
  return Effect.all(
    [relay(migration.source.relayId), relay(migration.destination.relayId)],
    { concurrency: 2 }
  )
}

export function fail(message: string) {
  return Effect.fail(new Error(message))
}
