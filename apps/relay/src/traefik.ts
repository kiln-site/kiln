import { createHash } from "node:crypto"
import { isIP } from "node:net"

import { webRouteHosts } from "@workspace/contracts"
import type {
  RelayInstanceWebRoute,
  RelayProxySettings,
  WebRouteRedirect,
} from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import { containerName, type DockerEngine } from "./docker-engine.js"
import { recoverPromise } from "./effect/promise.js"
import type { RelayStoredWebRoute } from "./effect/state.js"
import {
  APP_SERVICE,
  appIdFromRouteOwner,
  relayResourceNames,
} from "./relay-resources.js"
import {
  WEB_ROUTE_LABEL_PREFIX,
  WEB_ROUTE_REVISION_LABEL,
  webRouteRecoveryLabels,
} from "./web-route-labels.js"

/**
 * Traefik edge integration: Docker labels for an external Traefik, file
 * configuration for the bundled one, and discovery of an existing proxy.
 */

export interface TraefikLabelProfile {
  certificateResolver: string
  httpEntryPoint: string
  httpsEntryPoint: string
}

export function traefikRouteLabels(
  routes: ReadonlyArray<RelayInstanceWebRoute>,
  profile: TraefikLabelProfile,
  edgeNetwork = "kiln-edge"
): Record<string, string> {
  const labels: Record<string, string> = {
    ...webRouteRecoveryLabels(routes),
    "traefik.enable": routes.length > 0 ? "true" : "false",
  }
  if (routes.length > 0) labels["traefik.docker.network"] = edgeNetwork

  for (const route of routes) {
    const name = traefikRouteName(route.id)
    const priority = String(traefikRoutePriority(route))
    const router = (
      router: string,
      hosts: ReadonlyArray<string>,
      entryPoint: "http" | "https",
      service: string,
      middlewares: ReadonlyArray<string>
    ) => {
      const key = `traefik.http.routers.${router}`
      labels[`${key}.entrypoints`] =
        entryPoint === "https"
          ? profile.httpsEntryPoint
          : profile.httpEntryPoint
      labels[`${key}.priority`] = priority
      labels[`${key}.rule`] = traefikRouteRule(hosts, route.path)
      labels[`${key}.service`] = service
      if (middlewares.length > 0) {
        labels[`${key}.middlewares`] = middlewares.join(",")
      }
      if (entryPoint === "https") {
        labels[`${key}.tls`] = "true"
        labels[`${key}.tls.certresolver`] = profile.certificateResolver
      }
    }
    const redirectRegex = (middleware: string, redirect: TraefikRedirect) => {
      const key = `traefik.http.middlewares.${middleware}.redirectregex`
      labels[`${key}.regex`] = redirect.regex
      labels[`${key}.replacement`] = redirect.replacement
      labels[`${key}.permanent`] = String(redirect.permanent)
    }
    const { aliases, served } = webRouteHosts(route)

    if (route.redirect) {
      const hosts = [...served, ...aliases]
      router(`${name}-https`, hosts, "https", NOOP_SERVICE, [`${name}-to`])
      router(`${name}-http`, hosts, "http", NOOP_SERVICE, [`${name}-to`])
      redirectRegex(`${name}-to`, traefikRedirect(route.redirect))
      // Unused, but without a service of its own Docker's provider makes one
      // from the container's exposed ports, and drops a container with none.
      labels[`traefik.http.services.${name}.loadbalancer.server.port`] = "80"
      continue
    }

    const strip = route.path && route.stripPrefix ? [`${name}-strip`] : []
    router(`${name}-https`, served, "https", name, strip)
    router(
      `${name}-http`,
      served,
      "http",
      name,
      route.httpsRedirect ? [`${name}-redirect`] : strip
    )
    if (route.httpsRedirect) {
      labels[
        `traefik.http.middlewares.${name}-redirect.redirectscheme.scheme`
      ] = "https"
      labels[
        `traefik.http.middlewares.${name}-redirect.redirectscheme.permanent`
      ] = "true"
    }
    labels[`traefik.http.services.${name}.loadbalancer.server.port`] = String(
      route.targetPort
    )
    if (strip.length > 0 && route.path) {
      labels[`traefik.http.middlewares.${name}-strip.stripprefix.prefixes`] =
        route.path
    }
    if (aliases.length > 0) {
      router(`${name}-www-https`, aliases, "https", name, [`${name}-www`])
      router(`${name}-www-http`, aliases, "http", name, [
        route.httpsRedirect ? `${name}-www` : `${name}-www-plain`,
      ])
      redirectRegex(`${name}-www`, traefikCanonicalRedirect(route, "https"))
      if (!route.httpsRedirect) {
        redirectRegex(
          `${name}-www-plain`,
          traefikCanonicalRedirect(route, "http")
        )
      }
    }
  }

  return withWebRouteRevision(labels)
}

export function recoveryRouteLabels(
  routes: ReadonlyArray<RelayInstanceWebRoute>
): Record<string, string> {
  return withWebRouteRevision({
    ...webRouteRecoveryLabels(routes),
    "traefik.enable": "false",
  })
}

export function routeLabelsRequireRestart(
  current: Readonly<Record<string, string>>,
  routes: ReadonlyArray<RelayInstanceWebRoute>,
  desired: Readonly<Record<string, string>>
): boolean {
  if (routes.length > 0) {
    return (
      current[WEB_ROUTE_REVISION_LABEL] !== desired[WEB_ROUTE_REVISION_LABEL]
    )
  }
  const hasManagedRouteLabels =
    current[WEB_ROUTE_REVISION_LABEL] !== undefined ||
    current["traefik.enable"] === "true" ||
    Object.keys(current).some(
      (label) =>
        label.startsWith("traefik.http.") ||
        (label.startsWith(WEB_ROUTE_LABEL_PREFIX) &&
          label !== WEB_ROUTE_REVISION_LABEL)
    )
  return (
    hasManagedRouteLabels &&
    current[WEB_ROUTE_REVISION_LABEL] !== desired[WEB_ROUTE_REVISION_LABEL]
  )
}

function withWebRouteRevision(
  labels: Readonly<Record<string, string>>
): Record<string, string> {
  return {
    ...labels,
    [WEB_ROUTE_REVISION_LABEL]: createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
        )
      )
      .digest("hex"),
  }
}

export function traefikStaticConfiguration(
  settings: RelayProxySettings,
  config: Pick<
    RelayConfig,
    "advertisedHost" | "platformEdge" | "proxyMode" | "traefikAcmeCaServer"
  >
): string {
  const email = settings.acmeEmail
    ? `      email: ${JSON.stringify(settings.acmeEmail)}\n`
    : ""
  const directory = config.traefikAcmeCaServer
    ? `      caServer: ${JSON.stringify(config.traefikAcmeCaServer)}\n`
    : ""
  // Let's Encrypt issues certificates for an IP address only from its
  // six-day profile, and without the address as the Common Name. Only a
  // Traefik serving an address gets the resolver, and only one that can
  // load it.
  const ipResolver = traefikIpHost(config, settings.traefikImage)
    ? `  kiln-ip:
    acme:
${email}${directory}      profile: shortlived
      disableCommonName: true
      certificatesDuration: 160
      storage: /var/lib/traefik/acme.json
      httpChallenge:
        entryPoint: web
`
    : ""
  return `entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
          # Below every route's own router, so a route can serve plain HTTP.
          priority: 1
  websecure:
    address: ":443"

providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true

certificatesResolvers:
  kiln:
    acme:
${email}${directory}      storage: /var/lib/traefik/acme.json
      httpChallenge:
        entryPoint: web
${ipResolver}
api:
  dashboard: false
log:
  level: INFO
accessLog: {}
`
}

// A server's container, or the network alias of an app's service.
function routeUpstreamHost(
  resources: ReturnType<typeof relayResourceNames>,
  route: RelayStoredWebRoute
): string {
  const appId = appIdFromRouteOwner(route.instanceId)
  return appId
    ? resources.appAlias(appId, route.service ?? APP_SERVICE)
    : resources.instanceContainer(route.instanceId)
}

// Where a route's requests go, as Traefik reaches it.
export function traefikRouteUpstream(
  config: RelayConfig,
  route: RelayStoredWebRoute
): string {
  return route.redirect
    ? route.redirect.to
    : `http://${routeUpstreamHost(relayResourceNames(config), route)}:${route.targetPort}`
}

// Traefik's built-in service for routers whose middleware answers every
// request, such as a redirect.
const NOOP_SERVICE = "noop@internal"

interface TraefikRedirect {
  readonly permanent: boolean
  readonly regex: string
  readonly replacement: string
}

// Matches a request's whole URL, capturing its path and query.
const REQUEST_URL_PATTERN = "^https?://[^/]+(/.*)?$"

function traefikRedirect(redirect: WebRouteRedirect): TraefikRedirect {
  return redirect.preservePath
    ? {
        permanent: redirect.permanent,
        regex: REQUEST_URL_PATTERN,
        replacement: `${literalReplacement(redirect.to.replace(/\/$/u, ""))}\${1}`,
      }
    : {
        permanent: redirect.permanent,
        regex: "^.*$",
        replacement: literalReplacement(redirect.to),
      }
}

// Sends a route's www counterpart to its hostname, keeping the path.
function traefikCanonicalRedirect(
  route: RelayInstanceWebRoute,
  scheme: "http" | "https"
): TraefikRedirect {
  return {
    permanent: true,
    regex: REQUEST_URL_PATTERN,
    replacement: `${scheme}://${route.hostname}\${1}`,
  }
}

// Go's regexp expands $ in a replacement; $$ is a literal one.
function literalReplacement(value: string): string {
  return value.split("$").join("$$")
}

function traefikRouteRule(
  hosts: ReadonlyArray<string>,
  path: string | null
): string {
  const host = hosts.map((hostname) => `Host(\`${hostname}\`)`).join(" || ")
  if (!path) return host
  return `${hosts.length > 1 ? `(${host})` : host} && PathPrefix(\`${path}\`)`
}

// Longer paths win over shorter ones and over a whole hostname.
function traefikRoutePriority(route: { readonly path: string | null }): number {
  return route.path ? 100 + route.path.length : 10
}

export function traefikDynamicConfiguration(
  config: RelayConfig,
  routes: ReadonlyArray<RelayStoredWebRoute>,
  settings: RelayProxySettings
): string {
  const resources = relayResourceNames(config)
  // Only a Relay in Traefik mode is itself reached through Traefik, and only
  // its routes are; Hearth's, in platform mode, is the edge's own.
  const relayRouted =
    config.proxyMode === "traefik" && isTraefikHostname(config.advertisedHost)
  const served = config.proxyMode === "traefik" ? routes : []
  const ipHost = traefikIpHost(config, settings.traefikImage)
  const relayTls =
    relayRouted && ipHost === config.advertisedHost
      ? [
          "      tls:",
          "        certResolver: kiln-ip",
          "        domains:",
          `          - main: ${JSON.stringify(ipHost)}`,
        ]
      : ["      tls:", "        certResolver: kiln"]
  const lines = ["http:", "  routers:"]
  if (relayRouted) {
    lines.push(
      "    kiln-relay:",
      `      rule: ${JSON.stringify(`Host(\`${config.advertisedHost}\`)`)}`,
      "      entryPoints:",
      "        - websecure",
      "      service: kiln-relay",
      ...relayTls,
      "    kiln-relay-browser:",
      `      rule: ${JSON.stringify(
        `Host(\`${config.advertisedHost}\`) && Path(\`/v1/browser\`)`
      )}`,
      "      priority: 100",
      "      entryPoints:",
      "        - websecure",
      "      service: kiln-relay",
      "      middlewares:",
      "        - kiln-relay-browser-admission",
      ...relayTls
    )
  }
  const edge = config.platformEdge
  const ipEdge = edge !== null && ipHost === edge.host
  if (edge) {
    lines.push(
      "    kiln-hearth:",
      `      rule: ${JSON.stringify(`Host(\`${edge.host}\`)`)}`,
      "      entryPoints:",
      "        - websecure",
      "      service: kiln-hearth",
      "      tls:",
      `        certResolver: ${ipEdge ? "kiln-ip" : "kiln"}`,
      ...(ipEdge
        ? ["        domains:", `          - main: ${JSON.stringify(edge.host)}`]
        : [])
    )
  }
  const routeConfiguration = traefikFileRoutes(resources, served)
  lines.push(...routeConfiguration.routers)

  lines.push("  services:")
  if (edge) {
    lines.push(
      "    kiln-hearth:",
      "      loadBalancer:",
      "        servers:",
      `          - url: ${JSON.stringify(edge.upstream)}`
    )
  }
  if (relayRouted) {
    lines.push(
      "    kiln-relay:",
      "      loadBalancer:",
      "        servers:",
      `          - url: ${JSON.stringify(`http://${resources.relayEdgeAlias}:${config.port}`)}`
    )
  }
  lines.push(...routeConfiguration.services)

  lines.push("  middlewares:")
  if (relayRouted) {
    lines.push(
      "    kiln-relay-browser-admission:",
      "      rateLimit:",
      "        average: 2",
      "        period: 1s",
      `        burst: ${config.browserLimits.pendingHandshakesPerIp}`,
      "        sourceCriterion:",
      "          ipStrategy:",
      "            ipv6Subnet: 64"
    )
  }
  lines.push(...routeConfiguration.middlewares)
  // Clients send no server name for an address, so its certificate has to
  // be the one Traefik answers with by default.
  if (ipHost) {
    lines.push(
      "tls:",
      "  stores:",
      "    default:",
      "      defaultGeneratedCert:",
      "        resolver: kiln-ip",
      "        domain:",
      `          main: ${JSON.stringify(ipHost)}`
    )
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

// Routers, services, and middlewares for routes the bundled Traefik serves.
// Plain HTTP falls through to the entry point's redirect to HTTPS unless a
// route serves it, redirects it in one hop, or sends it elsewhere.
function traefikFileRoutes(
  resources: ReturnType<typeof relayResourceNames>,
  routes: ReadonlyArray<RelayStoredWebRoute>
): {
  readonly middlewares: ReadonlyArray<string>
  readonly routers: ReadonlyArray<string>
  readonly services: ReadonlyArray<string>
} {
  const routers: Array<string> = []
  const services: Array<string> = []
  const middlewares: Array<string> = []
  for (const route of routes) {
    const name = traefikRouteName(route.id)
    const router = (
      router: string,
      hosts: ReadonlyArray<string>,
      entryPoint: "web" | "websecure",
      service: string,
      routeMiddlewares: ReadonlyArray<string>
    ) => {
      routers.push(
        `    ${router}:`,
        `      rule: ${JSON.stringify(traefikRouteRule(hosts, route.path))}`,
        `      priority: ${traefikRoutePriority(route)}`,
        "      entryPoints:",
        `        - ${entryPoint}`,
        `      service: ${service}`
      )
      if (entryPoint === "websecure") {
        routers.push("      tls:", "        certResolver: kiln")
      }
      if (routeMiddlewares.length > 0) {
        routers.push(
          "      middlewares:",
          ...routeMiddlewares.map((middleware) => `        - ${middleware}`)
        )
      }
    }
    const redirectRegex = (middleware: string, redirect: TraefikRedirect) => {
      middlewares.push(
        `    ${middleware}:`,
        "      redirectRegex:",
        `        regex: ${JSON.stringify(redirect.regex)}`,
        `        replacement: ${JSON.stringify(redirect.replacement)}`,
        `        permanent: ${redirect.permanent}`
      )
    }
    const { aliases, served } = webRouteHosts(route)

    if (route.redirect) {
      const hosts = [...served, ...aliases]
      router(name, hosts, "websecure", NOOP_SERVICE, [`${name}-to`])
      router(`${name}-http`, hosts, "web", NOOP_SERVICE, [`${name}-to`])
      redirectRegex(`${name}-to`, traefikRedirect(route.redirect))
      continue
    }

    const strip = route.path && route.stripPrefix ? [`${name}-strip`] : []
    router(name, served, "websecure", name, strip)
    // Its own HTTP router, so plain HTTP can't fall through to a shorter
    // path's route that serves HTTP.
    router(
      `${name}-http`,
      served,
      "web",
      name,
      route.httpsRedirect ? [`${name}-redirect`] : strip
    )
    if (route.httpsRedirect) {
      middlewares.push(
        `    ${name}-redirect:`,
        "      redirectScheme:",
        "        scheme: https",
        "        permanent: true"
      )
    }
    services.push(
      `    ${name}:`,
      "      loadBalancer:",
      "        servers:",
      `          - url: ${JSON.stringify(`http://${routeUpstreamHost(resources, route)}:${route.targetPort}`)}`
    )
    if (strip.length > 0) {
      middlewares.push(
        `    ${name}-strip:`,
        "      stripPrefix:",
        "        prefixes:",
        `          - ${JSON.stringify(route.path)}`
      )
    }
    if (aliases.length > 0) {
      router(`${name}-www`, aliases, "websecure", NOOP_SERVICE, [`${name}-www`])
      router(`${name}-www-http`, aliases, "web", NOOP_SERVICE, [
        route.httpsRedirect ? `${name}-www` : `${name}-www-plain`,
      ])
      redirectRegex(`${name}-www`, traefikCanonicalRedirect(route, "https"))
      if (!route.httpsRedirect) {
        redirectRegex(
          `${name}-www-plain`,
          traefikCanonicalRedirect(route, "http")
        )
      }
    }
  }
  return { middlewares, routers, services }
}

// The address Traefik serves by IP rather than by name, if any: Hearth's in
// platform mode, or the Relay's own when it's in Traefik mode at an address.
// None for a Traefik too old to load the IP resolver, which then keeps
// serving everything else.
function traefikIpHost(
  config: Pick<RelayConfig, "advertisedHost" | "platformEdge" | "proxyMode">,
  image: string
): string | null {
  if (!traefikLoadsIpResolver(image)) return null
  if (config.platformEdge) {
    return isIP(config.platformEdge.host) !== 0
      ? config.platformEdge.host
      : null
  }
  return config.proxyMode === "traefik" && isIP(config.advertisedHost) !== 0
    ? config.advertisedHost
    : null
}

// The IP resolver's settings load from Traefik v3.6: `profile` came in
// v3.5 and `disableCommonName` in v3.6. An image counts only when its tag
// names v3.6 or later, or it has no tag or `latest`, which is current. A
// digest or other tag could be any version, so it doesn't.
function traefikLoadsIpResolver(image: string): boolean {
  const name = image.slice(image.lastIndexOf("/") + 1)
  const [reference = "", digest] = name.split("@")
  const colon = reference.indexOf(":")
  const tag = colon === -1 ? null : reference.slice(colon + 1)
  if (tag === null) return digest === undefined
  if (tag === "latest") return true
  const version = /^v?(\d+)\.(\d+)(?:\.|-|$)/u.exec(tag)
  if (!version) return false
  const major = Number(version[1])
  const minor = Number(version[2])
  return major > 3 || (major === 3 && minor >= 6)
}

function traefikRouteName(id: string): string {
  return `kiln-route-${id.replaceAll("-", "")}`
}

function isTraefikHostname(value: string): boolean {
  return /^[A-Za-z0-9.:[\]-]+$/u.test(value)
}

export async function discoverExternalTraefikContainer(input: {
  docker: DockerEngine
  edgeNetwork: string
  resourceNamespace: string | null
  settings: RelayProxySettings
}): Promise<string | null> {
  const { docker } = input
  if (input.settings.mode === "coolify") {
    return firstTraefikContainer(docker, ["coolify-proxy"])
  }
  if (input.resourceNamespace) {
    const attached = await recoverPromise(
      async () =>
        Object.values(
          (await Effect.runPromise(docker.inspectNetwork(input.edgeNetwork)))
            .Containers ?? {}
        ).map((container) => container.Name),
      () => []
    )
    return firstTraefikContainer(docker, attached)
  }

  const candidates = ["coolify-proxy"]
  const ports = await Promise.all(
    [80, 443].map((port) =>
      recoverPromise(
        async () =>
          (
            await Effect.runPromise(
              docker.listContainers({ filters: { publish: [String(port)] } })
            )
          ).map(containerName),
        () => []
      )
    )
  )
  for (const names of ports) candidates.push(...names)
  return firstTraefikContainer(docker, Array.from(new Set(candidates)))
}

async function firstTraefikContainer(
  docker: DockerEngine,
  names: ReadonlyArray<string>
): Promise<string | null> {
  for (const name of names) {
    const inspected = await recoverPromise(
      async () => {
        const container = await Effect.runPromise(docker.inspectContainer(name))
        return `${container.State.Running} ${container.Config.Image}`.toLowerCase()
      },
      () => ""
    )
    if (
      inspected.startsWith("true traefik:") ||
      inspected.startsWith("true traefik@")
    ) {
      return name
    }
  }
  return null
}
