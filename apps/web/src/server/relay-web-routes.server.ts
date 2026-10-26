import {
  relayProxyConfigurationSchema,
  relayProxyConfigurationV1Feature,
} from "@workspace/contracts"

import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import {
  relayScope,
  resolveScopeAuthorization,
} from "@/lib/scope-authorization.server"
import { hasAppPermission } from "@/server/app-access"

export interface RelayWebRoute {
  hostname: string
  id: string
  owner: { id: string; kind: "app" | "server"; service: string | null }
  path: string | null
  primary: boolean
  // Where a redirect sends visitors; null for a route that serves.
  redirectTo: string | null
}

/**
 * Every web route a Relay's proxy serves that the user may see, for the
 * infrastructure map. Each route needs the permission its resource's own
 * routes need: `instance.network.read` on a game server, `app.read` on the
 * Relay's apps. Null from Relays that predate the read.
 */
export async function relayWebRoutesHandler(
  user: AuthenticatedUser,
  relayId: string
): Promise<Array<RelayWebRoute> | null> {
  const authorization = await resolveScopeAuthorization({
    scope: relayScope(relayId),
    user,
  })
  authorization.require("relay.read")
  const relay = await activeRelay(relayId)
  if (!relayConnectionFeatures(relay.id).has(relayProxyConfigurationV1Feature))
    return null
  const { routes } = relayProxyConfigurationSchema.parse(
    await relayRpc(relay, "relay.proxy.config.read", {}, 15_000)
  )
  const grants = isPlatformAdmin(user)
    ? []
    : await listUserGrants(user.id, relayId)
  const canRead = (owner: RelayWebRoute["owner"]) =>
    isPlatformAdmin(user) ||
    (owner.kind === "app"
      ? hasAppPermission(user, grants, { appId: owner.id, relayId }, "app.read")
      : effectiveScopePermissions(grants, {
          relayId,
          resourceType: "instance",
          resourceId: owner.id,
        }).has("instance.network.read"))
  return routes.flatMap(({ hostname, id, owner, path, primary, redirect }) =>
    canRead(owner)
      ? [
          {
            hostname,
            id,
            owner,
            path,
            primary,
            redirectTo: redirect?.to ?? null,
          },
        ]
      : []
  )
}
