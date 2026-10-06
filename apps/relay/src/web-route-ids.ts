import { randomBytes } from "node:crypto"

import { relayInstanceWebRouteShortIdSchema } from "@workspace/contracts"
import type {
  RelayInstanceWebRoute,
  RelayInstanceWebRouteInput,
} from "@workspace/contracts"

import type { RelayStoredWebRoute } from "./effect/state.js"

const ROUTE_ID_ATTEMPTS = 32

export function assignRelayWebRouteIds(
  instanceId: string,
  routes: ReadonlyArray<RelayInstanceWebRouteInput>,
  configuredRoutes: ReadonlyArray<RelayStoredWebRoute>
): Array<RelayInstanceWebRoute> {
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
