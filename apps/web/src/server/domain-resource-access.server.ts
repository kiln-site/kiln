import { Effect } from "effect"

import {
  DomainConfigurationError,
  type HostnameInUseError,
} from "@/effect/errors"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import type { HostnameOwner } from "@/effect/hostname-claims"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { listInstanceDirectoryEffect } from "@/lib/instance-directory"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import { hasAppPermission } from "@/server/app-access"

// Changing an instance's addresses, web routes and their hostnames takes
// one permission, whatever kind of instance they belong to. Reading a game
// server's goes with its network; where an App is served is read with the
// App itself.
function permissionFor(
  resource: Pick<HostnameOwner, "resourceType">,
  change: boolean
) {
  if (change) return "instance.network.write" as const
  return resource.resourceType === "app"
    ? ("app.read" as const)
    : ("instance.network.read" as const)
}

/**
 * Refuses someone who may not read, or change, an instance's addresses, web
 * routes and their hostnames.
 */
export function requireResourcePermission(
  user: AuthenticatedUser,
  resource: HostnameOwner,
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

/** What a person can do on the game servers and apps they reach. */
export async function resourceAccess(user: AuthenticatedUser) {
  if (isPlatformAdmin(user)) {
    return {
      app: (_relayId: string, _appId: string, _manage: boolean) => true,
      instance: (_relayId: string, _instanceId: string, _write: boolean) =>
        true,
    }
  }
  const grants = await listUserGrants(user.id)
  return {
    app: (relayId: string, appId: string, manage: boolean) =>
      hasAppPermission(
        user,
        grants,
        { appId, relayId },
        // Changing web routes takes the same of every kind.
        manage ? "instance.network.write" : "app.read"
      ),
    instance: (relayId: string, instanceId: string, write: boolean) =>
      effectiveScopePermissions(grants, {
        relayId,
        resourceId: instanceId,
        resourceType: "instance",
      }).has(write ? "instance.network.write" : "instance.network.read"),
  }
}

/**
 * Says which game server or app holds a taken hostname, when the person can
 * see it; otherwise only that it's taken.
 */
export const explainHostnameInUseEffect = Effect.fnUntraced(function* (
  user: AuthenticatedUser,
  error: HostnameInUseError
) {
  const name = yield* holderNameEffect(user, error.holder)
  return yield* DomainConfigurationError.make({
    message: name
      ? `${error.hostname} is already in use by ${name}`
      : error.message,
  })
})

const holderNameEffect = Effect.fnUntraced(function* (
  user: AuthenticatedUser,
  holder: HostnameInUseError["holder"]
) {
  if (!holder) return null
  const access = yield* Effect.promise(() => resourceAccess(user))
  if (holder.resourceType === "app") {
    if (!access.app(holder.relayId, holder.resourceId, false)) return null
    const apps = yield* listAppRecordsEffect()
    return (
      apps.find(
        (app) =>
          app.appId === holder.resourceId && app.relayId === holder.relayId
      )?.name ?? null
    )
  }
  if (!access.instance(holder.relayId, holder.resourceId, false)) return null
  const directory = yield* listInstanceDirectoryEffect()
  return (
    directory.find(
      (record) =>
        record.id === holder.resourceId && record.relayId === holder.relayId
    )?.name ?? null
  )
})
