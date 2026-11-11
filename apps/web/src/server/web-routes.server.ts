import {
  relayAppWebRouteStateSchema,
  relayInstanceWebRouteStateSchema,
  webRouteHostnames,
  type RelayAppWebRouteInput,
  type RelayInstanceWebRouteInput,
} from "@workspace/contracts"
import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import type { WebHostnameResource } from "@/effect/web-hostnames"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { dnsKey } from "@/lib/dns-operations"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"
import { exclusive } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"
import {
  requireResourcePermission,
  saveClaimingWebRouteHostnames,
  syncWebRouteHostnames,
} from "@/server/web-hostname-access.server"
import type { WebHostnameProxyChange } from "@/server/web-hostnames.server"

// An instance's web routes: read and saved one way, whatever kind it is.
// Its Relay keeps them and says whether its proxy serves them yet; Hearth
// keeps who holds each hostname, and its DNS record.

/** What saves a game server's routes, or an App's. */
export type SaveWebRoutesInput = WebHostnameResource & {
  proxy?: WebHostnameProxyChange
} & (
    | { resourceType: "app"; routes: ReadonlyArray<RelayAppWebRouteInput> }
    | {
        resourceType: "instance"
        routes: ReadonlyArray<RelayInstanceWebRouteInput>
      }
  )

// The routes as their Relay has them. An App's each name the service they
// reach.
const stateOf = (resource: WebHostnameResource, state: unknown) =>
  resource.resourceType === "app"
    ? relayAppWebRouteStateSchema.parse(state)
    : relayInstanceWebRouteStateSchema.parse(state)

// Its Relay's name for it: the ID, and the kind as the Relay calls it.
const relayInstance = (resource: WebHostnameResource) => ({
  id: resource.resourceId,
  kind: resource.resourceType,
})

/** An instance's web routes, and whether its Relay's proxy serves them. */
export async function getWebRoutesHandler(
  user: AuthenticatedUser,
  resource: WebHostnameResource
) {
  await requireResourcePermission(user, resource, false)
  const relay = await activeRelay(resource.relayId)
  return stateOf(
    resource,
    await relayRpc(
      relay,
      "instance.network.routes.read",
      relayInstance(resource),
      30_000,
      user.id
    )
  )
}

/**
 * Saves an instance's web routes. Holds its DNS, so its hostnames are
 * claimed, saved on its Relay and given their records as one change.
 */
export const saveWebRoutes = operation<SaveWebRoutesInput>()({
  name: "webRoutes.save",
  doing: "Changing its web routes",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() => requireResourcePermission(person, input, true))
      )
    ),
  locks: ({ input }) => [exclusive(dnsKey(input))],
  run: ({ context: user, input }) =>
    promiseEffect(() => saveWebRoutesHandler(user, input)),
  audit: ({ input }) => ({
    id: input.resourceId,
    kind: input.resourceType,
    relayId: input.relayId,
  }),
})

async function saveWebRoutesHandler(
  user: AuthenticatedUser,
  { proxy, routes, ...resource }: SaveWebRoutesInput
) {
  const relay = await activeRelay(resource.relayId)
  const state = await saveClaimingWebRouteHostnames(
    user,
    resource,
    routes.flatMap(webRouteHostnames),
    async () =>
      stateOf(
        resource,
        await relayRpc(
          relay,
          "instance.network.routes.write",
          { ...relayInstance(resource), routes },
          240_000,
          user.id
        )
      ),
    proxy
  )
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relay.id] },
    scope: { instanceId: resource.resourceId, relayId: relay.id },
    topics: ["instance-web-routes"],
    type: "hearth.invalidate",
  })
  // Kiln keeps the DNS records of hostnames in zones it manages.
  await syncWebRouteHostnames(resource)
  return state
}
