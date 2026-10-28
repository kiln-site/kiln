import { Effect } from "effect"

import { HostnameInUseError } from "@/effect/errors"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  listResourceWebHostnamesEffect,
  loadWebHostnameEffect,
  markResourceWebHostnamesRemovingEffect,
  type WebHostnameResource,
} from "@/effect/web-hostnames"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireEligibleResourceUser } from "@/server/auth"
import { domainActor } from "@/server/domain-access.server"
import { explainHostnameInUseEffect } from "@/server/domain-resource-access.server"
import type {
  ReleaseWebHostnameInput,
  ResourceWebHostname,
  ResourceWebHostnamesInput,
} from "@/server/domains"
import {
  deleteResourceWebHostnamesEffect,
  generateAppHostnameEffect,
  publishWebHostnameChange,
  reconcileResourceWebHostnamesEffect,
  releaseWebHostnameEffect,
  saveWebRouteHostnamesEffect,
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
    // Only an app's generated address no route uses.
    canRelease: canRelease && row.generated && !row.routed,
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
 * Saves a resource's web routes with `save`, holding the hostnames they use
 * first so no other game server or app takes them meanwhile. Refuses
 * hostnames the resource may not take, naming the game server or app that
 * holds one when the person can see it, and lets go of its claims if the
 * save fails. Hostnames the routes stop using are marked for removal.
 */
export async function saveClaimingWebRouteHostnames<T>(
  user: AuthenticatedUser,
  resource: WebHostnameResource,
  hostnames: ReadonlyArray<string>,
  save: () => Promise<T>
): Promise<T> {
  return runAppEffect(
    "webHostnames.claimAndSave",
    saveWebRouteHostnamesEffect(
      { actor: domainActor(user), hostnames, resource },
      promiseEffect(save)
    ).pipe(
      // The save's own failure passes through as it was thrown.
      Effect.catchIf(
        (error): error is HostnameInUseError =>
          error instanceof HostnameInUseError,
        (error) => explainHostnameInUseEffect(user, error)
      )
    )
  )
}

/**
 * Brings a resource's DNS records in line with the web routes just saved.
 * Never fails the save: a hostname Kiln can't manage shows why on its row,
 * and the DNS worker retries it.
 */
export async function syncWebRouteHostnames(
  resource: WebHostnameResource
): Promise<void> {
  const changed = await runAppEffect(
    "webHostnames.sync",
    reconcileResourceWebHostnamesEffect(resource).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] Web routes for ${resource.resourceType} ${resource.resourceId} were saved, but their DNS records could not be synced yet:`,
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
  // Marked for certain first: a delete that fails after is the DNS
  // worker's to finish, not lost with the resource.
  await runAppEffect(
    "webHostnames.markResourceRemoving",
    markResourceWebHostnamesRemovingEffect(resource)
  )
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
