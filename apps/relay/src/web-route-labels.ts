import {
  relayInstanceWebRouteIdSchema,
  relayInstanceWebRouteSchema,
  relayInstanceWebRoutesSchema,
  webRouteEndpoints,
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
const WWW_OPTION_PREFIX = "www="
const HTTP_OPTION = "http"
const PRIMARY_OPTION = "primary"
const REDIRECT_OPTION_PREFIX = "redirect="
const REDIRECT_TEMPORARY_OPTION = "redirect-temporary"
const REDIRECT_DROP_PATH_OPTION = "redirect-drop-path"
const FLAG_OPTIONS = new Set([
  HTTP_OPTION,
  KEEP_PREFIX_OPTION,
  PRIMARY_OPTION,
  REDIRECT_DROP_PATH_OPTION,
  REDIRECT_TEMPORARY_OPTION,
])
const VALUE_OPTION_PREFIXES = [
  NAME_OPTION_PREFIX,
  REDIRECT_OPTION_PREFIX,
  WWW_OPTION_PREFIX,
]
const MAX_INSTANCE_WEB_ROUTES = 16

// One label per route:
// kiln.relay.web-routes.<id>=hostname[:port][/path]|name=<encoded>[,options]
// A configured path is stripped unless keep-prefix is present. The other
// options are www=redirect|serve, http (plain HTTP is served rather than
// redirected), primary, and, for a route without a port,
// redirect=<encoded URL> with redirect-temporary and redirect-drop-path.
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
    // The checks a saved route passes, such as a redirect having no port,
    // so a hand-edited label can't stop the Relay from storing it.
    const checked = relayInstanceWebRoutesSchema.safeParse([parsed.route])
    if (!checked.success) {
      warnings.push(
        `${label}: ${checked.error.issues[0]?.message ?? "route is invalid"}`
      )
      continue
    }
    const route = routes.some((recovered) => recovered.primary)
      ? { ...parsed.route, primary: false }
      : parsed.route
    const claimed = webRouteEndpoints(route)
    const duplicate = claimed.find((endpoint) => endpoints.has(endpoint))
    if (duplicate) {
      warnings.push(`${label} duplicates ${duplicate}`)
      continue
    }
    if (routes.length === MAX_INSTANCE_WEB_ROUTES) {
      warnings.push(
        `${label} exceeds the ${MAX_INSTANCE_WEB_ROUTES}-route Ember limit`
      )
      continue
    }
    for (const endpoint of claimed) endpoints.add(endpoint)
    routes.push(route)
  }

  return { routes, warnings }
}

export function planWebRouteRecovery(
  persisted: ReadonlyArray<RelayStoredWebRoute>,
  snapshots: ReadonlyArray<RelayWebRouteLabelSnapshot>
): RelayWebRouteRecoveryPlan {
  const persistedInstances = new Set(persisted.map((route) => route.instanceId))
  const routeIds = new Set(persisted.map((route) => route.id))
  const endpoints = new Set(persisted.flatMap(webRouteEndpoints))
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
      const claimed = webRouteEndpoints(route)
      const duplicate = claimed.find((endpoint) => endpoints.has(endpoint))
      if (duplicate) {
        warnings.push(
          `${snapshot.service}: ${duplicate} is already used on this Relay`
        )
        return false
      }
      routeIds.add(route.id)
      for (const endpoint of claimed) endpoints.add(endpoint)
      return true
    })
    if (routes.length > 0) {
      recoveries.push({ instanceId: snapshot.instanceId, routes })
    }
  }

  return { recoveries, warnings }
}

function encodeWebRouteRecoveryValue(route: RelayInstanceWebRoute): string {
  const authority =
    route.targetPort === null
      ? route.hostname
      : `${route.hostname}:${route.targetPort}`
  const options = [`${NAME_OPTION_PREFIX}${encodeURIComponent(route.name)}`]
  if (!route.stripPrefix) options.push(KEEP_PREFIX_OPTION)
  if (route.www !== "none") options.push(`${WWW_OPTION_PREFIX}${route.www}`)
  if (!route.httpsRedirect) options.push(HTTP_OPTION)
  if (route.primary) options.push(PRIMARY_OPTION)
  if (route.redirect) {
    options.push(
      `${REDIRECT_OPTION_PREFIX}${encodeURIComponent(route.redirect.to)}`
    )
    if (!route.redirect.permanent) options.push(REDIRECT_TEMPORARY_OPTION)
    if (!route.redirect.preservePath) options.push(REDIRECT_DROP_PATH_OPTION)
  }
  return `${authority}${route.path ?? ""}|${options.join(",")}`
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

  const options =
    segments[1] === undefined
      ? []
      : segments[1].split(",").filter((option) => option.length > 0)
  const optionsWith = (prefix: string) =>
    options.filter((option) => option.startsWith(prefix))
  if (
    segments[1] === "" ||
    options.some(
      (option) =>
        !FLAG_OPTIONS.has(option) &&
        !VALUE_OPTION_PREFIXES.some((prefix) => option.startsWith(prefix))
    ) ||
    VALUE_OPTION_PREFIXES.some((prefix) => optionsWith(prefix).length > 1) ||
    new Set(options).size !== options.length
  ) {
    return { success: false, message: "route options are invalid" }
  }
  const decode = (option: string | undefined, prefix: string) =>
    option === undefined
      ? Result.succeed(undefined)
      : Result.try(() => decodeURIComponent(option.slice(prefix.length)))

  const redirectTo = decode(
    optionsWith(REDIRECT_OPTION_PREFIX)[0],
    REDIRECT_OPTION_PREFIX
  )
  if (Result.isFailure(redirectTo)) {
    return { success: false, message: "route redirect is invalid" }
  }
  // A route reaches a port, or redirects without one.
  if (redirectTo.success === undefined && portSeparator <= 0) {
    return { success: false, message: "route must include a target port" }
  }
  const hostname =
    portSeparator <= 0 ? authority : authority.slice(0, portSeparator)

  let name = hostname.slice(0, 32)
  const decodedName = decode(
    optionsWith(NAME_OPTION_PREFIX)[0],
    NAME_OPTION_PREFIX
  )
  if (Result.isFailure(decodedName)) {
    return { success: false, message: "route name is invalid" }
  }
  if (decodedName.success !== undefined) name = decodedName.success

  const parsed = relayInstanceWebRouteSchema.safeParse({
    hostname,
    httpsRedirect: !options.includes(HTTP_OPTION),
    id,
    name,
    path,
    primary: options.includes(PRIMARY_OPTION),
    redirect:
      redirectTo.success === undefined
        ? null
        : {
            permanent: !options.includes(REDIRECT_TEMPORARY_OPTION),
            preservePath: !options.includes(REDIRECT_DROP_PATH_OPTION),
            to: redirectTo.success,
          },
    stripPrefix: !options.includes(KEEP_PREFIX_OPTION),
    targetPort:
      portSeparator <= 0 ? null : Number(authority.slice(portSeparator + 1)),
    www:
      optionsWith(WWW_OPTION_PREFIX)[0]?.slice(WWW_OPTION_PREFIX.length) ??
      "none",
  })
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "route is invalid",
    }
  }
  return { route: parsed.data, success: true }
}
