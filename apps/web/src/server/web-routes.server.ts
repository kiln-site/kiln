import {
  APP_SERVICE,
  relayInstanceWebRouteStateSchema,
  webRouteHostnames,
  type AppBrickWeb,
  type RelayInstanceWebRouteInput,
} from "@workspace/contracts"
import { Effect } from "effect"

import { promiseEffect, recoverPromise } from "@/effect/promise"
import { loadTunnelNameEffect, tunnelNameOf } from "@/effect/tunnel-names"
import { runAppEffect } from "@/effect/runtime"
import type { WebHostnameResource } from "@/effect/addresses"
import {
  loadPrimaryAddressEffect,
  setPrimaryAddressEffect,
} from "@/effect/primary-addresses"
import { DomainConfigurationError } from "@/effect/errors"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { dnsKey } from "@/lib/dns-operations"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import {
  requireResourcePermission,
  saveClaimingWebRouteHostnames,
  syncWebRouteHostnames,
} from "@/server/web-hostname-access.server"
import {
  generateAppHostnameEffect,
  publishWebHostnameChange,
  type WebHostnameProxyChange,
} from "@/server/addresses.server"

// An instance's web routes: read and saved one way, whatever kind it is.
// Its Relay keeps them and says whether its proxy serves them yet; Hearth
// keeps who holds each hostname, and its DNS record.

/** What saves a game server's routes, or an App's. */
export type SaveWebRoutesInput = WebHostnameResource & {
  proxy?: WebHostnameProxyChange
  routes: ReadonlyArray<RelayInstanceWebRouteInput>
}

/**
 * The web route an instance's primary address names, if it is one, or its
 * tunnel name, whole. Whether that route still serves is for whoever reads
 * the routes with it to say (`primaryWebRoute`); a tunnel name taken away
 * is no one's.
 */
async function primaryOf(resource: WebHostnameResource) {
  const primary = await runAppEffect(
    "primaryAddresses.load",
    loadPrimaryAddressEffect({
      id: resource.resourceId,
      type: resource.resourceType,
    })
  )
  const name =
    primary?.kind === "tunnel"
      ? await runAppEffect(
          "tunnelNames.load",
          loadTunnelNameEffect(primary.ref)
        )
      : null
  return {
    primaryRouteId: primary?.kind === "route" ? primary.ref : null,
    primaryTunnelName: name ? tunnelNameOf(name) : null,
  }
}

/** An instance's web routes, with the address its primary names. */
async function withPrimaryRoute<State>(
  resource: WebHostnameResource,
  state: State
) {
  return { ...state, ...(await primaryOf(resource)) }
}

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
  return withPrimaryRoute(
    resource,
    relayInstanceWebRouteStateSchema.parse(
      await relayRpc(
        relay,
        "instance.network.routes.read",
        relayInstance(resource),
        30_000,
        user.id
      )
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
      relayInstanceWebRouteStateSchema.parse(
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
  return withPrimaryRoute(resource, state)
}

/** Which of an App's web routes is its primary address. */
export interface SetPrimaryWebRouteInput {
  appId: string
  relayId: string
  routeId: string
}

/**
 * Makes one of an App's web routes its primary address: the domain its
 * header and lists show. A game server's is one of its join addresses.
 */
export const setPrimaryWebRoute = operation<SetPrimaryWebRouteInput>()({
  name: "webRoutes.primary",
  doing: "Changing its primary domain",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() =>
          requireResourcePermission(person, appResource(input), true)
        )
      )
    ),
  locks: ({ input }) => [exclusive(dnsKey(appResource(input)))],
  run: ({ context: user, input }) =>
    promiseEffect(() => setPrimaryWebRouteHandler(user, input)),
  audit: ({ input }) => ({
    id: input.appId,
    kind: "app",
    relayId: input.relayId,
  }),
})

const appResource = (input: { appId: string; relayId: string }) =>
  ({
    relayId: input.relayId,
    resourceId: input.appId,
    resourceType: "app",
  }) as const

async function setPrimaryWebRouteHandler(
  user: AuthenticatedUser,
  input: SetPrimaryWebRouteInput
) {
  const resource = appResource(input)
  const relay = await activeRelay(resource.relayId)
  const state = relayInstanceWebRouteStateSchema.parse(
    await relayRpc(
      relay,
      "instance.network.routes.read",
      relayInstance(resource),
      30_000,
      user.id
    )
  )
  const route = state.routes.find((candidate) => candidate.id === input.routeId)
  if (!route) {
    throw new DomainConfigurationError({ message: "That route is gone" })
  }
  if (route.redirect) {
    throw new DomainConfigurationError({
      message: "A route that redirects can't be the primary domain",
    })
  }
  await runAppEffect(
    "primaryAddresses.set",
    setPrimaryAddressEffect(
      { id: input.appId, type: "app" },
      { kind: "route", ref: route.id }
    )
  )
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relay.id] },
    scope: { instanceId: input.appId, relayId: relay.id },
    topics: ["instance-web-routes"],
    type: "hearth.invalidate",
  })
  return withPrimaryRoute(resource, state)
}

/** A new App, and where its Brick says its website answers. */
export interface ServeNewAppInput {
  appId: string
  relayId: string
  web: AppBrickWeb
}

/**
 * Gives a new App its address under a vanity domain, and routes it to the
 * App's website: its first route, made with it. It is part of making the
 * App, so it takes what making one does, not changing a network, and
 * never names a hostname of anyone's choosing. Null when no vanity domain
 * applies: the App then has no address to route.
 */
export const serveNewApp = operation<ServeNewAppInput>()({
  name: "webRoutes.first",
  doing: "Giving this App its address",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() =>
          requireRelayPermission({
            permission: "app.create",
            relayId: input.relayId,
            user: person,
          })
        )
      )
    ),
  locks: ({ input }) => [exclusive(dnsKey(newApp(input)))],
  run: ({ context: user, input }) =>
    promiseEffect(() => serveNewAppHandler(user, input)),
  audit: ({ input }) => ({
    id: input.appId,
    kind: "app",
    relayId: input.relayId,
  }),
})

const newApp = (input: ServeNewAppInput) =>
  ({
    relayId: input.relayId,
    resourceId: input.appId,
    resourceType: "app",
  }) as const

async function serveNewAppHandler(
  user: AuthenticatedUser,
  input: ServeNewAppInput
) {
  const resource = newApp(input)
  const hostname = await runAppEffect(
    "webHostnames.generate",
    generateAppHostnameEffect(resource)
  )
  if (hostname === null) return null
  publishWebHostnameChange([resource.relayId])
  await saveWebRoutesHandler(user, {
    ...resource,
    routes: [
      {
        hostname,
        httpsRedirect: true,
        name: "",
        path: null,
        redirect: null,
        service: input.web.service ?? APP_SERVICE,
        stripPrefix: true,
        targetPort: input.web.port,
        www: "none",
      },
    ],
  })
  return hostname
}

/**
 * Gives a new App its address and routes it to its website. Never fails:
 * an App that couldn't be given one is still made, and says nothing of a
 * route it doesn't have.
 */
export async function serveNewAppBestEffort(
  user: AuthenticatedUser,
  input: ServeNewAppInput
): Promise<void> {
  await recoverPromise(
    () => runOperationPromise(serveNewApp, input, { user }),
    (cause) =>
      console.warn(
        `[Kiln Domains] App ${input.appId} was created, but its address could not be routed to its website:`,
        cause
      )
  )
}
