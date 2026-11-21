import type { AuthenticatedUser } from "@/lib/auth-session"
import type {
  MigratedKindName,
  ResourceMigrationOptions,
} from "@/lib/resource-migration-input"
import {
  migrationScope,
  type MigratedKind,
  type Migration,
} from "@/lib/resource-migration-kinds/kind.server"
import { databases } from "@/lib/resource-migration-kinds/databases.server"
import { servers } from "@/lib/resource-migration-kinds/servers.server"
import { volumes } from "@/lib/resource-migration-kinds/volumes.server"
import { resolveScopeAuthorization } from "@/lib/scope-authorization.server"

/** Every kind that can be moved or duplicated. */
export const migratedKinds: ReadonlyArray<MigratedKind> = [
  servers,
  databases,
  volumes,
]

export function migratedKind(kind: MigratedKindName): MigratedKind {
  const found = migratedKinds.find((candidate) => candidate.kind === kind)
  if (!found) throw new Error(`A ${kind} can't be moved or duplicated yet`)
  return found
}

/**
 * Fails unless the person may copy a resource as they asked: what copying
 * its kind takes on the old one, creating one where the copy goes, and each
 * option's own permission on the old one.
 */
export async function requireMigrationPermissions(
  user: AuthenticatedUser,
  asked: {
    readonly destination: { readonly relayId: string }
    readonly kind: MigratedKindName
    readonly mode: Migration["mode"]
    readonly options: ResourceMigrationOptions
    readonly source: { readonly id: string; readonly relayId: string }
  }
): Promise<void> {
  const kind = migratedKind(asked.kind)
  const { options } = asked
  const source = await resolveScopeAuthorization({
    scope: migrationScope(asked.kind, asked.source),
    user,
  })
  for (const permission of kind.permissions.copy) source.require(permission)
  const destination = await resolveScopeAuthorization({
    scope: {
      relayId: asked.destination.relayId,
      resourceId: asked.destination.relayId,
      resourceType: "relay",
    },
    user,
  })
  for (const permission of kind.permissions.create) {
    destination.require(permission)
  }
  // Whether or not it runs now: it may be started before the copy stops
  // it, and starts again after a duplicate.
  if (options.stopSource && kind.powered) {
    source.require("instance.power.stop")
    if (asked.mode === "duplicate") source.require("instance.power.start")
  }
  if (options.copyAccess && kind.handOver.access) source.require("access.read")
  // A linked backup is the copy's to download and restore.
  if (options.linkBackups && kind.handOver.backups) {
    source.require("backup.download")
  }
  if (options.backup) source.require("backup.create")
  if (options.deleteSource) {
    source.require(kind.permissions.delete)
    source.require("backup.create")
  }
  if (
    kind.permissions.network &&
    ((options.moveDomain && kind.handOver.domains) ||
      (options.moveWebRoutes && kind.handOver.routes))
  ) {
    source.require(kind.permissions.network)
  }
}
