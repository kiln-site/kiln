import { createHash } from "node:crypto"
import { isIP } from "node:net"

import type {
  RelayInstanceWebRoute,
  RelayProxySettings,
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
    const httpRouter = `${name}-http`
    const httpsRouter = `${name}-https`
    const rule = route.path
      ? `Host(\`${route.hostname}\`) && PathPrefix(\`${route.path}\`)`
      : `Host(\`${route.hostname}\`)`
    labels[`traefik.http.routers.${httpRouter}.entrypoints`] =
      profile.httpEntryPoint
    labels[`traefik.http.routers.${httpRouter}.middlewares`] =
      `${name}-redirect`
    labels[`traefik.http.routers.${httpRouter}.priority`] = String(
      route.path ? 100 + route.path.length : 10
    )
    labels[`traefik.http.routers.${httpRouter}.rule`] = rule
    labels[`traefik.http.routers.${httpRouter}.service`] = name
    labels[`traefik.http.middlewares.${name}-redirect.redirectscheme.scheme`] =
      "https"
    labels[
      `traefik.http.middlewares.${name}-redirect.redirectscheme.permanent`
    ] = "true"
    labels[`traefik.http.routers.${httpsRouter}.entrypoints`] =
      profile.httpsEntryPoint
    labels[`traefik.http.routers.${httpsRouter}.priority`] = String(
      route.path ? 100 + route.path.length : 10
    )
    labels[`traefik.http.routers.${httpsRouter}.rule`] = rule
    labels[`traefik.http.routers.${httpsRouter}.service`] = name
    labels[`traefik.http.routers.${httpsRouter}.tls`] = "true"
    labels[`traefik.http.routers.${httpsRouter}.tls.certresolver`] =
      profile.certificateResolver
    labels[`traefik.http.services.${name}.loadbalancer.server.port`] = String(
      route.targetPort
    )
    if (route.path && route.stripPrefix) {
      labels[`traefik.http.routers.${httpsRouter}.middlewares`] =
        `${name}-strip`
      labels[`traefik.http.middlewares.${name}-strip.stripprefix.prefixes`] =
        route.path
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
  config: Pick<RelayConfig, "platformEdge" | "traefikAcmeCaServer">
): string {
  const email = settings.acmeEmail
    ? `      email: ${JSON.stringify(settings.acmeEmail)}\n`
    : ""
  const directory = config.traefikAcmeCaServer
    ? `      caServer: ${JSON.stringify(config.traefikAcmeCaServer)}\n`
    : ""
  // Let's Encrypt issues certificates for an IP address only from its
  // six-day profile, and without the address as the Common Name. Only a
  // platform Relay serving Hearth at an address gets the resolver: older
  // Traefik versions a Relay may be pinned to can't load it.
  const ipResolver = isPlatformIpEdge(config)
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
  return `http://${routeUpstreamHost(relayResourceNames(config), route)}:${route.targetPort}`
}

export function traefikDynamicConfiguration(
  config: RelayConfig,
  routes: ReadonlyArray<RelayStoredWebRoute>,
  _settings: RelayProxySettings
): string {
  const resources = relayResourceNames(config)
  // Only a Relay in Traefik mode is itself reached through Traefik, and only
  // its routes are; Hearth's, in platform mode, is the edge's own.
  const relayRouted =
    config.proxyMode === "traefik" && isTraefikHostname(config.advertisedHost)
  const served = config.proxyMode === "traefik" ? routes : []
  const lines = ["http:", "  routers:"]
  if (relayRouted) {
    lines.push(
      "    kiln-relay:",
      `      rule: ${JSON.stringify(`Host(\`${config.advertisedHost}\`)`)}`,
      "      entryPoints:",
      "        - websecure",
      "      service: kiln-relay",
      "      tls:",
      "        certResolver: kiln",
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
      "      tls:",
      "        certResolver: kiln"
    )
  }
  const edge = config.platformEdge
  const ipEdge = isPlatformIpEdge(config)
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
  for (const route of served) {
    const name = traefikRouteName(route.id)
    const rule = route.path
      ? `Host(\`${route.hostname}\`) && PathPrefix(\`${route.path}\`)`
      : `Host(\`${route.hostname}\`)`
    lines.push(
      `    ${name}:`,
      `      rule: ${JSON.stringify(rule)}`,
      `      priority: ${route.path ? 100 + route.path.length : 10}`,
      "      entryPoints:",
      "        - websecure",
      `      service: ${name}`,
      "      tls:",
      "        certResolver: kiln"
    )
    if (route.path && route.stripPrefix) {
      lines.push("      middlewares:", `        - ${name}-strip`)
    }
  }

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
  for (const route of served) {
    const name = traefikRouteName(route.id)
    lines.push(
      `    ${name}:`,
      "      loadBalancer:",
      "        servers:",
      `          - url: ${JSON.stringify(`http://${routeUpstreamHost(resources, route)}:${route.targetPort}`)}`
    )
  }

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
  for (const route of served) {
    if (!route.path || !route.stripPrefix) continue
    const name = traefikRouteName(route.id)
    lines.push(
      `    ${name}-strip:`,
      "      stripPrefix:",
      "        prefixes:",
      `          - ${JSON.stringify(route.path)}`
    )
  }
  // Browsers send no server name for an address, so its certificate has to
  // be the one Traefik answers with by default.
  if (edge && ipEdge) {
    lines.push(
      "tls:",
      "  stores:",
      "    default:",
      "      defaultGeneratedCert:",
      "        resolver: kiln-ip",
      "        domain:",
      `          main: ${JSON.stringify(edge.host)}`
    )
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

function isPlatformIpEdge(config: Pick<RelayConfig, "platformEdge">): boolean {
  return config.platformEdge !== null && isIP(config.platformEdge.host) !== 0
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
