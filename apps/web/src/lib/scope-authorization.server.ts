import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { PermissionDeniedError } from "@/effect/errors"
import {
  effectiveScopePermissions,
  type ResourceScope,
} from "@/lib/resource-permissions"
import type { AccessPermission } from "@/lib/permissions"

export interface ScopeAuthorization {
  /** True when the caller holds the permission on the resolved scope. */
  allows: (permission: AccessPermission) => boolean
  /** Throws the shared denial used by the per-permission access helpers. */
  require: (permission: AccessPermission) => void
}

/**
 * Resolve a caller's authority for one scope once, then answer every later
 * check from the local set. Handlers that weigh several permissions would
 * otherwise reload the full grant set for each one.
 */
export async function resolveScopeAuthorization(input: {
  scope: ResourceScope
  user: AuthenticatedUser
}): Promise<ScopeAuthorization> {
  if (!isAccountEnabled(input.user) || !isAccountVerified(input.user)) {
    throw PermissionDeniedError.make({
      message: "Your account cannot access resources",
    })
  }
  const platformAdmin = isPlatformAdmin(input.user)
  const permissions = platformAdmin
    ? new Set<AccessPermission>()
    : effectiveScopePermissions(
        await listUserGrants(input.user.id, input.scope.relayId),
        input.scope
      )
  const allows = (permission: AccessPermission) =>
    platformAdmin || permissions.has(permission)
  return {
    allows,
    require: (permission: AccessPermission) => {
      if (allows(permission)) return
      throw PermissionDeniedError.make({
        message: "You do not have permission to perform this action",
      })
    },
  }
}

export function instanceScope(
  relayId: string,
  instanceId: string
): ResourceScope {
  return { relayId, resourceId: instanceId, resourceType: "instance" }
}

export function relayScope(relayId: string): ResourceScope {
  return { relayId, resourceId: relayId, resourceType: "relay" }
}
