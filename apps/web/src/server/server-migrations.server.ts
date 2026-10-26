// The server migration server functions in ./server-migrations authenticate
// the caller and hand the signed-in user to these handlers.
import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  relayLinkedBackupsV1Feature,
  relayInstanceWebRouteStateSchema,
  relaySnapshotSchema,
  type RelayInstance,
  type ResourceLimits,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import type { z } from "zod"

import { countLinkableInstanceBackupsEffect } from "@/effect/backups"
import {
  anyDomainConnectionEffect,
  loadInstanceDomainAssignmentsForInstanceEffect,
} from "@/effect/domains"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import type {
  serverReferenceSchema,
  startServerMigrationInputSchema,
} from "@/lib/server-migration-input"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import {
  activeRelay,
  listPersistedRelays,
  type PersistedRelay,
} from "@/lib/relay-registry"
import {
  instanceScope,
  relayScope,
  resolveScopeAuthorization,
} from "@/lib/scope-authorization.server"
import {
  cancelServerMigrationEffect,
  listServerMigrationsEffect,
  startServerMigrationEffect,
} from "@/lib/server-migrations.server"
import { resolveAuthorizedBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { relayResourceLimitsRequest } from "@/lib/resource-limits.server"
import type {
  MigrationRelayRoom,
  MigrationSourceRoom,
} from "@/lib/server-migration-room"
import {
  checkMigrationRoom,
  loadRelayRoom,
  migrationSourceRoom,
} from "@/lib/server-migration-room.server"
import {
  relayTransferProblemsEffect,
  type RelayTransferProblem,
} from "@/server/relay-transfers.server"

/** A Relay the server could be copied to, and what stands in the way. */
export interface ServerMigrationDestination {
  readonly current: boolean
  readonly id: string
  /** Whether it can restore backups linked from another server. */
  readonly linksBackups: boolean
  readonly name: string
  readonly nodeArch: string | null
  readonly problems: ReadonlyArray<RelayTransferProblem>
  /** What it can give the copy; null when it couldn't say. */
  readonly room: MigrationRelayRoom | null
  /** Names of game servers there already, which a copy can't take. */
  readonly takenNames: ReadonlyArray<string>
}

/** What the Move or duplicate dialog offers for one server. */
export interface ServerMigrationPreview {
  /** People with access to the server, besides its owner. */
  readonly accessCount: number
  /**
   * The server's backups: how many there are, how many full archives would
   * link to a copy on its own Relay, and how many to a copy elsewhere.
   */
  readonly backups: {
    readonly anywhere: number
    readonly here: number
    readonly total: number
  }
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
  readonly destinations: ReadonlyArray<ServerMigrationDestination>
  /**
   * What the server takes and its Relay has room for, to check a copy
   * fits; null when its Relay couldn't say.
   */
  readonly room: {
    readonly server: MigrationSourceRoom
    readonly source: MigrationRelayRoom
  } | null
  readonly domains: {
    /** Whether Hearth manages domains through Cloudflare. */
    readonly managed: boolean
    readonly names: ReadonlyArray<string>
  }
  readonly source: {
    readonly instanceId: string
    /** The limits its copy takes unless it's given others. */
    readonly limits: ResourceLimits
    readonly name: string
    readonly nodeArch: string | null
    readonly provisioning: boolean
    readonly relayId: string
    readonly relayName: string
    readonly running: boolean
  }
  readonly webRoutes: ReadonlyArray<string>
}

export async function previewServerMigrationHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof serverReferenceSchema>
): Promise<ServerMigrationPreview> {
  const { authorization, instance, relay } = await authorizeSource(user, data)
  const relays = (await listPersistedRelays()).filter((item) => item.enabled)
  const sourceRoom = await recoverPromise(
    () => loadRelayRoom(relay, { rootId: instance.id, subject: user.id }),
    () => null
  )
  const destinations = await Promise.all(
    relays.map(async (candidate) => {
      const allowed = (
        await resolveScopeAuthorization({
          scope: relayScope(candidate.id),
          user,
        })
      ).allows("instance.create")
      if (!allowed) return null
      const [problems, takenNames, space] = await Promise.all([
        runAppEffect(
          "serverMigrations.preview.problems",
          relayTransferProblemsEffect({
            destination: candidate,
            destinationRootId: instance.id,
            source: relay,
            sourceRootId: instance.id,
          })
        ),
        serverNames(candidate, user),
        candidate.id === relay.id
          ? sourceRoom
          : recoverPromise(
              () => loadRelayRoom(candidate, { subject: user.id }),
              () => null
            ),
      ])
      const { relayConnectionFeatures } = await import("@/lib/relay-connection")
      return {
        current: candidate.id === relay.id,
        id: candidate.id,
        linksBackups: relayConnectionFeatures(candidate.id).has(
          relayLinkedBackupsV1Feature
        ),
        name: candidate.name,
        nodeArch: candidate.nodeArch,
        problems,
        room: space?.room ?? null,
        takenNames,
      } satisfies ServerMigrationDestination
    })
  )
  const allowNetwork = authorization.allows("instance.network.read")
  const [domains, webRoutes, accessCount, backups] = await Promise.all([
    runAppEffect(
      "serverMigrations.preview.domains",
      Effect.all(
        [
          anyDomainConnectionEffect(),
          loadInstanceDomainAssignmentsForInstanceEffect(relay.id, instance.id),
        ],
        { concurrency: 2 }
      )
    ),
    allowNetwork ? webRouteHostnames(relay, instance.id, user) : [],
    countAccess(relay.id, instance.id),
    authorization.allows("backup.read")
      ? runAppEffect(
          "serverMigrations.preview.backups",
          countLinkableInstanceBackupsEffect(relay.id, instance.id)
        )
      : { anywhere: 0, here: 0, total: 0 },
  ])
  const [connected, assignments] = domains
  return {
    accessCount,
    backups,
    allowed: {
      backup: authorization.allows("backup.create"),
      copyAccess: authorization.allows("access.read"),
      delete:
        authorization.allows("instance.delete") &&
        authorization.allows("backup.create"),
      linkBackups: authorization.allows("backup.download"),
      network: authorization.allows("instance.network.write"),
      power:
        authorization.allows("instance.power.stop") &&
        authorization.allows("instance.power.start"),
      stop: authorization.allows("instance.power.stop"),
    },
    destinations: destinations.filter((item) => item !== null),
    room: sourceRoom
      ? {
          server: migrationSourceRoom(instance, sourceRoom.rootBytes),
          source: sourceRoom.room,
        }
      : null,
    domains: {
      managed: connected,
      names: assignments
        .filter((assignment) => assignment.status !== "removing")
        .map((assignment) => `${assignment.vanityLabel}.${assignment.domain}`),
    },
    source: {
      instanceId: instance.id,
      limits: instance.limits,
      name: instance.name,
      nodeArch: relay.nodeArch,
      provisioning: Boolean(instance.provisioning),
      relayId: relay.id,
      relayName: relay.name,
      running: instance.observedState !== "stopped",
    },
    webRoutes,
  }
}

export async function startServerMigrationHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof startServerMigrationInputSchema>
): Promise<{ id: string }> {
  const { authorization, instance, relay } = await authorizeSource(user, data)
  if (instance.provisioning) {
    throw new Error("Wait for this server to finish being created first")
  }
  if (!instance.brickSource) {
    throw new Error("This server has no Brick to build a copy from")
  }
  const destination = await activeRelay(data.destinationRelayId)
  if (data.mode === "migrate" && destination.id === relay.id) {
    throw new Error("Choose another Relay to move this server to")
  }
  ;(
    await resolveScopeAuthorization({ scope: relayScope(destination.id), user })
  ).require("instance.create")
  // A move always stops the server: the copy must be the last of it.
  const options = {
    ...data.options,
    moveDomain: data.mode === "migrate" && data.options.moveDomain,
    moveWebRoutes: data.mode === "migrate" && data.options.moveWebRoutes,
    stopSource: data.mode === "migrate" || data.options.stopSource,
    deleteSource: data.mode === "migrate" ? data.options.deleteSource : null,
  }
  // Checked whether or not it runs now: it may be started before the copy
  // reaches the step that stops it, and starts again after a duplicate.
  if (options.stopSource) {
    authorization.require("instance.power.stop")
    if (data.mode === "duplicate") authorization.require("instance.power.start")
  }
  if (options.copyAccess) authorization.require("access.read")
  // A linked backup is the copy's to download and restore, so linking needs
  // what downloading this server's backups does.
  if (options.linkBackups) {
    authorization.require("backup.download")
    const { relayConnectionFeatures } = await import("@/lib/relay-connection")
    if (
      !relayConnectionFeatures(destination.id).has(relayLinkedBackupsV1Feature)
    ) {
      throw new Error(
        `Update ${destination.name} to the latest Kiln release to link backups to a copy there`
      )
    }
  }
  if (options.backup) authorization.require("backup.create")
  // Deleting the old server backs it up first, to a destination they may use.
  if (options.deleteSource) {
    authorization.require("instance.delete")
    authorization.require("backup.create")
    await resolveAuthorizedBackupStorageSelection({
      relayId: relay.id,
      targetId: instance.id,
      targetKind: "instance",
      user,
      ...(options.deleteSource.storageId === undefined
        ? {}
        : { storageId: options.deleteSource.storageId }),
    })
  }
  if (options.moveDomain || options.moveWebRoutes) {
    authorization.require("instance.network.write")
  }
  const problems = await runAppEffect(
    "serverMigrations.start.problems",
    relayTransferProblemsEffect({
      destination,
      destinationRootId: instance.id,
      source: relay,
      sourceRootId: instance.id,
    })
  )
  if (problems.length) {
    throw new Error(problems.map((problem) => problem.message).join(". "))
  }
  if ((await serverNames(destination, user)).includes(data.name)) {
    throw new Error(
      `A server on ${destination.name} is already named ${data.name}`
    )
  }
  // Limits a Relay can't take are refused here, not partway through.
  if (options.limits) {
    const diskBytes =
      options.limits.diskBytes ?? DEFAULT_INSTANCE_DISK_LIMIT_BYTES
    relayResourceLimitsRequest(
      destination.id,
      { cpuMillis: null, diskBytes, memoryBytes: null },
      options.limits
    )
  }
  const room = await checkMigrationRoom({
    backup: options.backup,
    copyLimits: options.limits,
    destination,
    instanceId: instance.id,
    limits: true,
    source: relay,
    subject: user.id,
  })
  if (room.length) {
    throw new Error(room.map((problem) => problem.message).join(". "))
  }
  const id = await runAppEffect(
    "serverMigrations.start",
    startServerMigrationEffect({
      actor: user,
      destinationName: data.name,
      destinationRelayId: destination.id,
      mode: data.mode,
      options,
      source: {
        instanceId: instance.id,
        name: instance.name,
        relayId: relay.id,
      },
    })
  )
  return { id }
}

export function listServerMigrationsHandler(user: AuthenticatedUser) {
  return runAppEffect(
    "serverMigrations.list",
    listServerMigrationsEffect(user.id)
  )
}

export async function cancelServerMigrationHandler(
  user: AuthenticatedUser,
  id: string
) {
  await runAppEffect(
    "serverMigrations.cancel",
    cancelServerMigrationEffect(user.id, id)
  )
}

// Copying a server needs its files and settings.
async function authorizeSource(
  user: AuthenticatedUser,
  data: z.infer<typeof serverReferenceSchema>
) {
  const relay = await activeRelay(data.relayId)
  const authorization = await resolveScopeAuthorization({
    scope: instanceScope(relay.id, data.instanceId),
    user,
  })
  authorization.require("instance.files.read")
  authorization.require("instance.configuration.read")
  const instance = await sourceInstance(relay, data.instanceId, user)
  return { authorization, instance, relay }
}

async function sourceInstance(
  relay: PersistedRelay,
  instanceId: string,
  user: AuthenticatedUser
): Promise<RelayInstance> {
  const { relayRpc } = await import("@/lib/relay-connection")
  const snapshot = relaySnapshotSchema.parse(
    await relayRpc(relay, "relay.snapshot", {}, 15_000, user.id)
  )
  const instance = snapshot.instances.find((item) => item.id === instanceId)
  if (!instance) throw new Error("Server not found on this Relay")
  return instance
}

async function webRouteHostnames(
  relay: PersistedRelay,
  instanceId: string,
  user: AuthenticatedUser
): Promise<Array<string>> {
  const { relayRpc } = await import("@/lib/relay-connection")
  const state = await recoverPromise(
    () =>
      relayRpc(
        relay,
        "instance.network.routes.read",
        { instanceId },
        15_000,
        user.id
      ),
    () => null
  )
  const parsed = relayInstanceWebRouteStateSchema.safeParse(state)
  return parsed.success
    ? [...new Set(parsed.data.routes.map((route) => route.hostname))]
    : []
}

// The names of game servers on a Relay, as it reports them and as Hearth
// renamed them, which a copy there can't take.
async function serverNames(
  relay: PersistedRelay,
  user: AuthenticatedUser
): Promise<Array<string>> {
  const { relayRpc } = await import("@/lib/relay-connection")
  const [snapshot, [rows]] = await Promise.all([
    recoverPromise(
      async () =>
        relaySnapshotSchema.parse(
          await relayRpc(relay, "relay.snapshot", {}, 15_000, user.id)
        ).instances,
      () => []
    ),
    databasePool.query<Array<RowDataPacket & { display_name: string }>>(
      `SELECT display_name FROM ${databaseTable("instance")}
        WHERE relay_id = ? AND display_name IS NOT NULL`,
      [relay.id]
    ),
  ])
  return [
    ...new Set([
      ...snapshot.map((instance) => instance.name),
      ...rows.map((row) => row.display_name),
    ]),
  ]
}

async function countAccess(relayId: string, instanceId: string) {
  const [rows] = await databasePool.query<
    Array<RowDataPacket & { count: number }>
  >(
    `SELECT COUNT(*) AS count FROM ${databaseTable("access_grant")} AS grant_row
       JOIN ${databaseTable("instance")} AS instance_row
         ON instance_row.relay_id = grant_row.relay_id
        AND instance_row.instance_id = grant_row.resource_id
      WHERE grant_row.relay_id = ? AND grant_row.resource_type = 'instance'
        AND grant_row.resource_id = ? AND grant_row.state = 'active'
        AND grant_row.user_id <> COALESCE(instance_row.owner_id, '')`,
    [relayId, instanceId]
  )
  return Number(rows[0]?.count ?? 0)
}
