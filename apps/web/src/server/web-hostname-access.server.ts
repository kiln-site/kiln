import { Effect } from "effect"

import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  listResourceWebHostnamesEffect,
  loadWebHostnameEffect,
  type WebHostnameResource,
} from "@/effect/web-hostnames"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireEligibleResourceUser } from "@/server/auth"
import { domainActor } from "@/server/domain-access.server"
import type {
  ReleaseWebHostnameInput,
  ResourceWebHostname,
  ResourceWebHostnamesInput,
} from "@/server/domains"
import {
  deleteResourceWebHostnamesEffect,
  generateAppHostnameEffect,
  publishWebHostnameChange,
  releaseWebHostnameEffect,
  syncResourceWebHostnamesEffect,
} from "@/server/web-hostnames.server"

function permissionFor(
  resource: Pick<WebHostnameResource, "resourceType">,
  change: boolean
) {
  return resource.resourceType === "app"
    ? change
      ? ("app.manage" as const)
      : ("app.read" as const)
    : change
      ? ("instance.network.write" as const)
      : ("instance.network.read" as const)
}

function requireResourcePermission(
  user: AuthenticatedUser,
  resource: WebHostnameResource,
  change: boolean
) {
  return requireRelayPermission({
    ...(resource.resourceType === "app"
      ? { appId: resource.resourceId }
      : { instanceId: resource.resourceId }),
    permission: permissionFor(resource, change),
    relayId: resource.relayId,
    user,
  })
}

/** A game server's or app's web hostnames, for its network page. */
export async function getResourceWebHostnamesHandler(
  data: ResourceWebHostnamesInput
): Promise<Array<ResourceWebHostname>> {
  const user = await requireEligibleResourceUser()
  await requireResourcePermission(user, data, false)
  const canRelease = await recoverPromise(
    () => requireResourcePermission(user, data, true).then(() => true),
    () => false
  )
  const rows = await runAppEffect(
    "webHostnames.resource",
    listResourceWebHostnamesEffect(data)
  )
  return rows.map((row) => ({
    canRelease,
    generated: row.generated,
    hostname: row.hostname,
    id: row.id,
    lastError: row.lastError,
    status: row.status,
  }))
}

/** Deletes a hostname's record, such as an app's generated address. */
export async function releaseWebHostnameHandler(data: ReleaseWebHostnameInput) {
  // Signed in before the lookup, so an ID's existence isn't revealed.
  const user = await requireEligibleResourceUser()
  const row = await runAppEffect(
    "webHostnames.load",
    loadWebHostnameEffect(data.id)
  )
  if (!row) return
  await requireResourcePermission(user, row, true)
  await runAppEffect("webHostnames.release", releaseWebHostnameEffect(row))
  publishWebHostnameChange([row.relayId])
}

/**
 * Brings a resource's DNS records in line with the web routes just saved.
 * Never fails the save: a hostname Kiln can't manage shows why on its row.
 */
export async function syncWebRouteHostnames(
  user: AuthenticatedUser,
  resource: WebHostnameResource,
  hostnames: ReadonlyArray<string>
): Promise<void> {
  const changed = await runAppEffect(
    "webHostnames.sync",
    syncResourceWebHostnamesEffect({
      actor: domainActor(user),
      hostnames,
      resource,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] Web routes for ${resource.resourceType} ${resource.resourceId} were saved, but their DNS records could not be synced:`,
            cause
          )
          return true
        })
      )
    )
  )
  if (changed) publishWebHostnameChange([resource.relayId])
}

/** Gives a new app its address, when a vanity domain applies. */
export async function generateAppHostnameBestEffort(
  resource: WebHostnameResource
): Promise<void> {
  const hostname = await runAppEffect(
    "webHostnames.generate",
    generateAppHostnameEffect(resource).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] App ${resource.resourceId} was created, but its address could not be generated:`,
            cause
          )
          return null
        })
      )
    )
  )
  if (hostname) publishWebHostnameChange([resource.relayId])
}

/** Deletes the records a deleted app or game server had. */
export async function deleteResourceWebHostnamesBestEffort(
  resource: WebHostnameResource
): Promise<void> {
  const removed = await runAppEffect(
    "webHostnames.deleteResource",
    deleteResourceWebHostnamesEffect(resource).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] Could not delete every DNS record for ${resource.resourceType} ${resource.resourceId}:`,
            cause
          )
          return 1
        })
      )
    )
  )
  if (removed > 0) publishWebHostnameChange([resource.relayId])
}
