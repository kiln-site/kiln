import { randomBytes } from "node:crypto"

import {
  relayInstanceWebRouteShortIdSchema,
  webRouteEndpoints,
} from "@workspace/contracts"
import type {
  RelayInstanceWebRoute,
  RelayInstanceWebRouteInput,
} from "@workspace/contracts"

import type { RelayStoredWebRoute } from "./effect/state.js"

const ROUTE_ID_ATTEMPTS = 32

export function assignRelayWebRouteIds<
  Route extends RelayInstanceWebRouteInput,
>(
  instanceId: string,
  routes: ReadonlyArray<Route>,
  configuredRoutes: ReadonlyArray<RelayStoredWebRoute>
): Array<Route & Pick<RelayInstanceWebRoute, "id">> {
  const owners = new Map(
    configuredRoutes.map((route) => [route.id, route.instanceId])
  )
  const used = new Set(owners.keys())
  const claimed = new Set<string>()

  return routes.map((route) => {
    const id = route.id ?? availableRouteId(used)
    const owner = owners.get(id)
    if (owner && owner !== instanceId) {
      throw new Error(`Another Ember already uses web route ID ${id}`)
    }
    if (claimed.has(id)) {
      throw new Error(`Web route ID ${id} is duplicated`)
    }
    claimed.add(id)
    used.add(id)
    return { ...route, id }
  })
}

// The first hostname and path one of an owner's routes would take from
// another server's or app's, counting www counterparts.
export function webRouteCollision(
  owner: string,
  routes: ReadonlyArray<RelayInstanceWebRoute>,
  configuredRoutes: ReadonlyArray<RelayStoredWebRoute>
): string | undefined {
  const taken = new Set(
    configuredRoutes
      .filter((configured) => configured.instanceId !== owner)
      .flatMap(webRouteEndpoints)
  )
  return routes
    .flatMap(webRouteEndpoints)
    .find((endpoint) => taken.has(endpoint))
}

function availableRouteId(used: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < ROUTE_ID_ATTEMPTS; attempt += 1) {
    const id = relayInstanceWebRouteShortIdSchema.parse(randomRouteId())
    if (!used.has(id)) return id
  }
  throw new Error("Relay could not allocate a unique web route ID")
}

function randomRouteId(): string {
  return randomBytes(4).toString("hex")
}
