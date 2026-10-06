import {
  relayInstanceWebRouteIdSchema,
  relayInstanceWebRouteSchema,
} from "@workspace/contracts"
import type {
  RelayInstanceWebRoute,
  RelayInstanceWebRoutes,
} from "@workspace/contracts"
import { Result } from "effect"

import type { RelayStoredWebRoute } from "./effect/state.js"

export const WEB_ROUTE_LABEL_PREFIX = "kiln.relay.web-routes."
export const WEB_ROUTE_REVISION_LABEL = `${WEB_ROUTE_LABEL_PREFIX}revision`

const KEEP_PREFIX_OPTION = "keep-prefix"
const NAME_OPTION_PREFIX = "name="
const MAX_INSTANCE_WEB_ROUTES = 16

// One label per route:
// kiln.relay.web-routes.<id>=hostname:port[/path]|name=<encoded>[,keep-prefix]
// A configured path is stripped unless keep-prefix is present.
export interface RelayWebRouteLabelSnapshot {
  readonly instanceId: string
  readonly labels: Readonly<Record<string, string | undefined>>
  readonly service: string
}

export interface RelayWebRouteRecovery {
  readonly instanceId: string
  readonly routes: RelayInstanceWebRoutes
}

export interface RelayWebRouteRecoveryPlan {
  readonly recoveries: ReadonlyArray<RelayWebRouteRecovery>
  readonly warnings: ReadonlyArray<string>
}

export function webRouteRecoveryLabels(
  routes: ReadonlyArray<RelayInstanceWebRoute>
): Record<string, string> {
  return Object.fromEntries(
    routes.map((route) => [
      `${WEB_ROUTE_LABEL_PREFIX}${route.id}`,
      encodeWebRouteRecoveryValue(route),
    ])
  )
}

function decodeWebRouteRecoveryLabels(
  labels: Readonly<Record<string, string | undefined>>
): {
  readonly routes: RelayInstanceWebRoutes
  readonly warnings: ReadonlyArray<string>
} {
  const routes: Array<RelayInstanceWebRoute> = []
  const warnings: Array<string> = []
  const endpoints = new Set<string>()

  for (const [label, value] of Object.entries(labels).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!label.startsWith(WEB_ROUTE_LABEL_PREFIX)) continue
    const id = label.slice(WEB_ROUTE_LABEL_PREFIX.length)
    if (id === "revision") continue

    const parsedId = relayInstanceWebRouteIdSchema.safeParse(id)
    if (!parsedId.success) {
      warnings.push(`${label} has an invalid route ID`)
      continue
    }
    if (value === undefined) {
      warnings.push(`${label} has no route configuration`)
      continue
    }

    const parsed = parseWebRouteRecoveryValue(parsedId.data, value)
    if (!parsed.success) {
      warnings.push(`${label}: ${parsed.message}`)
      continue
    }
    const endpoint = routeEndpoint(parsed.route)
    if (endpoints.has(endpoint)) {
      warnings.push(
        `${label} duplicates ${parsed.route.hostname}${parsed.route.path ?? ""}`
      )
      continue
    }
    if (routes.length === MAX_INSTANCE_WEB_ROUTES) {
      warnings.push(
        `${label} exceeds the ${MAX_INSTANCE_WEB_ROUTES}-route Ember limit`
      )
      continue
    }
    endpoints.add(endpoint)
    routes.push(parsed.route)
  }

  return { routes, warnings }
}

export function planWebRouteRecovery(
  persisted: ReadonlyArray<RelayStoredWebRoute>,
  snapshots: ReadonlyArray<RelayWebRouteLabelSnapshot>
): RelayWebRouteRecoveryPlan {
  const persistedInstances = new Set(persisted.map((route) => route.instanceId))
  const routeIds = new Set(persisted.map((route) => route.id))
  const endpoints = new Set(persisted.map(routeEndpoint))
  const recoveries: Array<RelayWebRouteRecovery> = []
  const warnings: Array<string> = []

  for (const snapshot of [...snapshots].sort((a, b) =>
    a.instanceId.localeCompare(b.instanceId)
  )) {
    if (persistedInstances.has(snapshot.instanceId)) continue
    const decoded = decodeWebRouteRecoveryLabels(snapshot.labels)
    warnings.push(
      ...decoded.warnings.map((warning) => `${snapshot.service}: ${warning}`)
    )

    const routes = decoded.routes.filter((route) => {
      if (routeIds.has(route.id)) {
        warnings.push(
          `${snapshot.service}: route ID ${route.id} is already used on this Relay`
        )
        return false
      }
      const endpoint = routeEndpoint(route)
      if (endpoints.has(endpoint)) {
        warnings.push(
          `${snapshot.service}: ${route.hostname}${route.path ?? ""} is already used on this Relay`
        )
        return false
      }
      routeIds.add(route.id)
      endpoints.add(endpoint)
      return true
    })
    if (routes.length > 0) {
      recoveries.push({ instanceId: snapshot.instanceId, routes })
    }
  }

  return { recoveries, warnings }
}

function encodeWebRouteRecoveryValue(route: RelayInstanceWebRoute): string {
  const endpoint = `${route.hostname}:${route.targetPort}${route.path ?? ""}`
  const options = [`${NAME_OPTION_PREFIX}${encodeURIComponent(route.name)}`]
  if (!route.stripPrefix) options.push(KEEP_PREFIX_OPTION)
  return `${endpoint}|${options.join(",")}`
}

function parseWebRouteRecoveryValue(
  id: string,
  value: string
):
  | { readonly success: true; readonly route: RelayInstanceWebRoute }
  | { readonly success: false; readonly message: string } {
  const segments = value.split("|")
  if (segments.length > 2 || !segments[0]) {
    return { success: false, message: "route configuration is malformed" }
  }

  const endpoint = segments[0]
  const pathStart = endpoint.indexOf("/")
  const authority = pathStart === -1 ? endpoint : endpoint.slice(0, pathStart)
  const path = pathStart === -1 ? null : endpoint.slice(pathStart)
  const portSeparator = authority.lastIndexOf(":")
  if (portSeparator <= 0) {
    return { success: false, message: "route must include a target port" }
  }

  const options =
    segments[1] === undefined
      ? []
      : segments[1].split(",").filter((option) => option.length > 0)
  const nameOptions = options.filter((option) =>
    option.startsWith(NAME_OPTION_PREFIX)
  )
  if (
    segments[1] === "" ||
    options.some(
      (option) =>
        option !== KEEP_PREFIX_OPTION && !option.startsWith(NAME_OPTION_PREFIX)
    ) ||
    nameOptions.length > 1 ||
    new Set(options).size !== options.length
  ) {
    return { success: false, message: "route options are invalid" }
  }

  let name = authority.slice(0, portSeparator).slice(0, 32)
  if (nameOptions[0]) {
    const decodedName = Result.try(() =>
      decodeURIComponent(nameOptions[0]!.slice(NAME_OPTION_PREFIX.length))
    )
    if (Result.isFailure(decodedName)) {
      return { success: false, message: "route name is invalid" }
    }
    name = decodedName.success
  }

  const parsed = relayInstanceWebRouteSchema.safeParse({
    hostname: authority.slice(0, portSeparator),
    id,
    name,
    path,
    stripPrefix: !options.includes(KEEP_PREFIX_OPTION),
    targetPort: Number(authority.slice(portSeparator + 1)),
  })
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "route is invalid",
    }
  }
  return { route: parsed.data, success: true }
}

function routeEndpoint(route: {
  readonly hostname: string
  readonly path: string | null
}): string {
  return `${route.hostname}\n${route.path ?? ""}`
}
