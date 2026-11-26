// The migration server functions in ./resource-migrations authenticate the
// caller and hand the signed-in user to these handlers.
import type { ResourceLimits } from "@workspace/contracts"
import type { z } from "zod"

import { listResourceAddressesEffect } from "@/effect/addresses"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { requireDeleteConfirmation } from "@/lib/delete-confirmation.server"
import {
  activeRelay,
  listPersistedRelays,
  type PersistedRelay,
} from "@/lib/relay-registry"
import type {
  MigratedKindName,
  resourceMigrationServingInputSchema,
  resourceReferenceSchema,
  startResourceMigrationInputSchema,
} from "@/lib/resource-migration-input"
import {
  migrationHandOvers,
  migrationScope,
  type MigratedDescription,
  type MigratedKind,
  type MigrationHandOver,
  type MigrationHandOverCounts,
  type MigrationWarnings,
} from "@/lib/resource-migration-kinds/kind.server"
import {
  destinationPermissions,
  migratedKind,
  requireMigrationPermissions,
} from "@/lib/resource-migration-kinds/registry.server"
import type {
  MigrationRelayRoom,
  MigrationSourceRoom,
} from "@/lib/resource-migration-room"
import {
  checkMigrationRoom,
  loadRelayRoom,
  measureRoots,
  migrationSourceRoom,
} from "@/lib/resource-migration-room.server"
import {
  cancelResourceMigration,
  listResourceMigrationsEffect,
  startResourceMigrationEffect,
} from "@/lib/resource-migrations.server"
import { resolveScopeAuthorization } from "@/lib/scope-authorization.server"
import { schedulesToMove } from "@/server/schedule-moves.server"
import {
  relayWebServing,
  type RelayWebServing,
} from "@/server/relay-web-serving.server"
import {
  relayTransferProblemsEffect,
  type RelayTransferProblem,
} from "@/server/relay-transfers.server"

/** A Relay the resource could be copied to, and what stands in the way. */
export interface ResourceMigrationDestination {
  readonly current: boolean
  readonly id: string
  readonly name: string
  readonly nodeArch: string | null
  readonly problems: ReadonlyArray<RelayTransferProblem>
  /** What it can give the copy; null when it couldn't say. */
  readonly room: MigrationRelayRoom | null
  /** The schedules a move there leaves on the old one, as `schedules`. */
  readonly schedulesStaying: ReadonlyArray<string | null>
  /** Names of its kind there already, which a copy can't take. */
  readonly takenNames: ReadonlyArray<string>
}

/** What the Move or duplicate dialog offers for one resource. */
export interface ResourceMigrationPreview extends MigrationHandOverCounts {
  readonly allowed: {
    readonly backup: boolean
    readonly copyAccess: boolean
    /** Deleting it after a move, which backs it up first. */
    readonly delete: boolean
    readonly linkBackups: boolean
    readonly network: boolean
    /** Stopping and starting it, as a duplicate that stops it does. */
    readonly power: boolean
    /** Stopping it, as a move does. */
    readonly stop: boolean
  }
  readonly destinations: ReadonlyArray<ResourceMigrationDestination>
  readonly kind: MigratedKindName
  /** What its kind is called, inside a sentence. */
  readonly noun: string
  /** What its kind has, of what the dialog can offer. */
  readonly offers: {
    /** Whether a copy's activity can include the old one's history. */
    readonly activity: boolean
    readonly nameLimit: number
    /** Whether it has to run to be copied, so it's never stopped first. */
    readonly copiedRunning: boolean
    /** Whether a move can deploy its copy before handing anything over. */
    readonly deploy: boolean
    readonly handOvers: ReadonlyArray<MigrationHandOver>
    /** Whether its copy can be given limits of its own. */
    readonly limits: boolean
    /** Whether it is stopped and started at all. */
    readonly power: boolean
  }
  /**
   * What it takes and its Relay has room for, to check a copy fits; null
   * when its Relay couldn't say.
   */
  readonly room: {
    readonly resource: MigrationSourceRoom
    readonly source: MigrationRelayRoom
  } | null
  /** Its hostnames whose DNS Kiln doesn't keep. */
  readonly manualDns: ReadonlyArray<string>
  /**
   * The schedules a move takes to the copy, or would: each by its name, or
   * null for one the person can't see.
   */
  readonly schedules: ReadonlyArray<string | null>
  /** What to know before each way of copying it. */
  readonly warnings: MigrationWarnings
  readonly source: {
    /** Whether a move deploys its copy unless it's asked not to. */
    readonly deploys: boolean
    readonly id: string
    /** The limits its copy takes unless it's given others. */
    readonly limits: ResourceLimits | null
    readonly name: string
    readonly nodeArch: string | null
    readonly provisioning: boolean
    readonly relayId: string
    readonly relayName: string
    readonly running: boolean
  }
}

export async function previewResourceMigrationHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof resourceReferenceSchema>
): Promise<ResourceMigrationPreview> {
  const { authorization, description, kind, relay } = await authorizeSource(
    user,
    data
  )
  const relays = (await listPersistedRelays()).filter((item) => item.enabled)
  // Asked once: the same for every Relay it could go to.
  const creates = destinationPermissions(kind, {
    id: data.id,
    relayId: relay.id,
  })
  const roots = await runAppEffect(
    "resourceMigrations.preview.roots",
    kind.sourceRoots(relay.id, data.id)
  )
  const [sourceRoom, measured] = await Promise.all([
    recoverPromise(
      () => loadRelayRoom(relay, { subject: user.id }),
      () => null
    ),
    recoverPromise(
      () => measureRoots(relay, roots, user.id),
      () => null
    ),
  ])
  const reference = { id: data.id, kind: kind.kind, relayId: relay.id }
  const schedules = await schedulesOf(user, kind, reference)
  const destinations = await Promise.all(
    relays.map(async (candidate) => {
      const there = await resolveScopeAuthorization({
        scope: {
          relayId: candidate.id,
          resourceId: candidate.id,
          resourceType: "relay",
        },
        user,
      })
      if (!(await creates).every(there.allows)) return null
      const [problems, takenNames, space, staying] = await Promise.all([
        transferProblems(relay, candidate, roots),
        kind.takenNames(candidate, user.id),
        candidate.id === relay.id
          ? sourceRoom
          : recoverPromise(
              () => loadRelayRoom(candidate, { subject: user.id }),
              () => null
            ),
        candidate.id === relay.id ? [] : schedules.staying(candidate.id),
      ])
      return {
        current: candidate.id === relay.id,
        id: candidate.id,
        name: candidate.name,
        nodeArch: candidate.nodeArch,
        problems,
        room: space?.room ?? null,
        schedulesStaying: staying,
        takenNames,
      } satisfies ResourceMigrationDestination
    })
  )
  const { network } = kind.permissions
  const allowed = {
    backup: authorization.allows("backup.create"),
    copyAccess: authorization.allows("access.read"),
    delete:
      authorization.allows(kind.permissions.delete) &&
      (kind.finalBackup === false || authorization.allows("backup.create")),
    linkBackups: authorization.allows("backup.download"),
    network: network !== undefined && authorization.allows(network),
    power:
      authorization.allows("instance.power.stop") &&
      authorization.allows("instance.power.start"),
    stop: authorization.allows("instance.power.stop"),
  }
  const [counts, manualDns] = await Promise.all([
    kind.handOverCounts(relay, data.id, user, {
      backups: authorization.allows("backup.read"),
      network: allowed.network,
    }),
    allowed.network ? manualHostnames(reference) : [],
  ])
  return {
    ...counts,
    manualDns,
    schedules: schedules.names,
    allowed,
    destinations: destinations.filter((item) => item !== null),
    kind: kind.kind,
    noun: kind.noun,
    offers: {
      // History is read from a game server's own records so far.
      activity: kind.kind === "instance",
      copiedRunning: kind.copiedRunning,
      deploy: Boolean(kind.deploy),
      nameLimit: kind.nameLimit,
      handOvers: migrationHandOvers.filter((name) => kind.handOver[name]),
      limits: description.limits !== null,
      power: kind.powered,
    },
    room: sourceRoom
      ? {
          resource: migrationSourceRoom(description, measured),
          source: sourceRoom.room,
        }
      : null,
    warnings: (await kind.warnings?.(relay, data.id, user.id)) ?? {
      duplicate: [],
      migrate: [],
    },
    source: {
      deploys: description.deploys ?? false,
      id: data.id,
      limits: description.limits,
      name: description.name,
      nodeArch: relay.nodeArch,
      provisioning: description.provisioning,
      relayId: relay.id,
      relayName: relay.name,
      running: description.running,
    },
  }
}

export async function startResourceMigrationHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof startResourceMigrationInputSchema>
): Promise<{ id: string }> {
  const { description, kind, relay } = await authorizeSource(user, data)
  if (description.provisioning) {
    throw new Error(`Wait for this ${kind.noun} to finish being created first`)
  }
  if (description.unbuildable) throw new Error(description.unbuildable)
  const destination = await activeRelay(data.destinationRelayId)
  if (data.mode === "migrate" && destination.id === relay.id) {
    throw new Error(`Choose another Relay to move this ${kind.noun} to`)
  }
  // A move always stops what can be stopped: the copy must be the last of
  // it. Only what its kind has is handed over.
  const moved = data.mode === "migrate"
  const options = {
    ...data.options,
    backup: kind.backupFirst ? data.options.backup : null,
    copyAccess: Boolean(kind.handOver.access) && data.options.copyAccess,
    deleteSource: moved ? data.options.deleteSource : null,
    deployCopy: moved && Boolean(kind.deploy) && data.options.deployCopy,
    limits: description.limits ? data.options.limits : null,
    linkBackups: Boolean(kind.handOver.backups) && data.options.linkBackups,
    moveDomain:
      moved && Boolean(kind.handOver.domains) && data.options.moveDomain,
    moveWebRoutes:
      moved && Boolean(kind.handOver.routes) && data.options.moveWebRoutes,
    stopSource:
      kind.powered &&
      (moved || (!kind.copiedRunning && data.options.stopSource)),
  }
  // Each option needs its own permission, checked again as the copy goes.
  await requireMigrationPermissions(user, {
    destination: { relayId: destination.id },
    kind: kind.kind,
    mode: data.mode,
    options,
    source: { id: data.id, relayId: relay.id },
  })
  // Read now, before anything is made or stopped: a move that couldn't hand
  // them over would stop the old one first and fail at its end.
  if (options.moveWebRoutes) {
    const { webRoutes } = await kind.handOverCounts(relay, data.id, user, {
      backups: false,
      network: true,
    })
    if (webRoutes === null) {
      throw new Error(
        `${relay.name} couldn't say which domains ${description.name} has`
      )
    }
  }
  // A backup first goes where they chose: the copy holds that while it runs.
  const backupStorageIds = options.backup ? [options.backup.storageId] : []
  if (kind.kind !== "app") {
    await requireBackupStorageSelection({
      relayId: relay.id,
      storageIds: backupStorageIds,
      targetId: data.id,
      targetKind: kind.kind,
      user,
    })
  }
  // Deleting the old one backs it up first, to a destination they may use.
  if (options.deleteSource) {
    await requireDeleteConfirmation({
      confirmation: data.confirmation?.confirmation ?? "",
      name: description.name,
      password: data.confirmation?.password ?? "",
      user,
    })
    if (kind.kind !== "app" && kind.finalBackup !== false) {
      await requireBackupStorageSelection({
        relayId: relay.id,
        storageIds: [options.deleteSource.storageId],
        targetId: data.id,
        targetKind: kind.kind,
        user,
      })
    }
  }
  const roots = await runAppEffect(
    "resourceMigrations.start.roots",
    kind.sourceRoots(relay.id, data.id)
  )
  const problems = await transferProblems(relay, destination, roots)
  if (problems.length) {
    throw new Error(problems.map((problem) => problem.message).join(". "))
  }
  if ((await kind.takenNames(destination, user.id)).includes(data.name)) {
    throw new Error(
      `${destination.name} already has ${/^[aeiou]/iu.test(kind.noun) ? "an" : "a"} ${kind.noun} named ${data.name}`
    )
  }
  const room = await checkMigrationRoom({
    backup: options.backup,
    copyLimits: options.limits,
    destination,
    kind: kind.kind,
    limits: true,
    source: relay,
    sourceId: data.id,
    subject: user.id,
  })
  if (room.length) {
    throw new Error(room.map((problem) => problem.message).join(". "))
  }
  const id = await runAppEffect(
    "resourceMigrations.start",
    startResourceMigrationEffect({
      actor: user,
      backupStorageIds,
      destinationName: data.name,
      destinationRelayId: destination.id,
      kind: kind.kind,
      mode: data.mode,
      options,
      source: { id: data.id, name: description.name, relayId: relay.id },
    })
  )
  return { id }
}

/** Whether domains moved with it to a Relay would work there. */
export async function resourceMigrationServingHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof resourceMigrationServingInputSchema>
): Promise<RelayWebServing> {
  const { kind, relay } = await authorizeSource(user, data)
  const destination = await activeRelay(data.destinationRelayId)
  const there = await resolveScopeAuthorization({
    scope: {
      relayId: destination.id,
      resourceId: destination.id,
      resourceType: "relay",
    },
    user,
  })
  for (const permission of await destinationPermissions(kind, {
    id: data.id,
    relayId: relay.id,
  })) {
    there.require(permission)
  }
  return relayWebServing(destination, relay)
}

// Its hostnames whose DNS someone keeps themselves, or that Cloudflare had
// before Kiln: each is theirs to point at the new Relay.
async function manualHostnames(reference: {
  readonly id: string
  readonly kind: MigratedKindName
  readonly relayId: string
}): Promise<Array<string>> {
  if (reference.kind !== "app" && reference.kind !== "instance") return []
  const rows = await runAppEffect(
    "resourceMigrations.preview.addresses",
    listResourceAddressesEffect({
      relayId: reference.relayId,
      resourceId: reference.id,
      resourceType: reference.kind,
    })
  )
  return rows
    .filter((row) => row.connectionId === null || row.status === "external")
    .map((row) => row.hostname)
}

// A volume's stay with it: nothing that uses it moves to its copy.
async function schedulesOf(
  user: AuthenticatedUser,
  kind: MigratedKind,
  reference: { readonly id: string; readonly relayId: string }
): ReturnType<typeof schedulesToMove> {
  return kind.kind === "volume" || !kind.handOver.schedules
    ? { names: [], staying: async () => [] }
    : schedulesToMove(user, { ...reference, kind: kind.kind })
}

export function listResourceMigrationsHandler(user: AuthenticatedUser) {
  return runAppEffect(
    "resourceMigrations.list",
    listResourceMigrationsEffect(user.id)
  )
}

export async function cancelResourceMigrationHandler(
  user: AuthenticatedUser,
  id: string
) {
  await cancelResourceMigration(user, id)
}

// Copying a resource needs what its kind says copying one takes, and for it
// to be on its Relay.
async function authorizeSource(
  user: AuthenticatedUser,
  data: z.infer<typeof resourceReferenceSchema>
): Promise<{
  authorization: Awaited<ReturnType<typeof resolveScopeAuthorization>>
  description: MigratedDescription
  kind: MigratedKind
  relay: PersistedRelay
}> {
  const kind = migratedKind(data.kind)
  const relay = await activeRelay(data.relayId)
  const authorization = await resolveScopeAuthorization({
    scope: migrationScope(kind.kind, { id: data.id, relayId: relay.id }),
    user,
  })
  for (const permission of kind.permissions.copy) {
    authorization.require(permission)
  }
  const description = await kind.describe(relay, data.id, user.id)
  if (!description) {
    throw new Error(`This ${kind.noun} isn't on this Relay`)
  }
  return { authorization, description, kind, relay }
}

// What would keep any of its roots from being copied between two Relays,
// each problem once.
async function transferProblems(
  source: PersistedRelay,
  destination: PersistedRelay,
  roots: ReadonlyArray<string>
): Promise<Array<RelayTransferProblem>> {
  const found = await Promise.all(
    roots.map((rootId) =>
      runAppEffect(
        "resourceMigrations.transferProblems",
        relayTransferProblemsEffect({
          destination,
          destinationRootId: rootId,
          source,
          sourceRootId: rootId,
        })
      )
    )
  )
  const seen = new Set<string>()
  return found.flat().filter((problem) => {
    const key = `${problem.code}:${problem.relayId}:${problem.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
