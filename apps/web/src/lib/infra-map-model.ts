import type { RelayProxyMode } from "@workspace/contracts"

import {
  layoutInfraMap,
  type InfraMapGroupInput,
  type InfraMapLayout,
  type InfraMapLinkInput,
} from "@/lib/infra-map-layout"

/**
 * What the infrastructure map draws for each scope. All instances shows
 * Hearth and a summary of every Relay; a Relay shows its instances and how
 * they connect; an instance shows only what it connects to.
 */

export type InfraMapResourceKind = "server" | "app" | "database"

export type InfraMapScope =
  | { kind: "all" }
  | { kind: "relay"; relayId: string }
  | { kind: InfraMapResourceKind; relayId: string; id: string }

export interface InfraMapRelay {
  id: string
  name: string
  enabled: boolean
  address: string
  nodeArch: string | null
  /**
   * Shown because the user can read an instance on it, not the Relay
   * itself, so it draws with only its name.
   */
  restricted?: boolean
}

export interface InfraMapResource {
  key: string
  kind: InfraMapResourceKind
  id: string
  relayId: string
  relayName: string
  name: string
  meta: string
  routeId: string
  brickId?: string
  implementation?: string
}

export interface InfraMapWebRoute {
  hostname: string
  path: string | null
  /** An app route names the Compose service it reaches. */
  owner: { kind: "app" | "server"; id: string; service?: string | null }
}

/** One Compose service of an app, from its containers on the Relay. */
export interface InfraMapService {
  name: string
  image: string
  running: number
  containers: number
  /** Databases whose networks its containers join. */
  databaseIds: ReadonlyArray<string>
}

export interface InfraMapData {
  hearthHost: string
  provider: "cloudflare" | "vercel" | null
  relays: ReadonlyArray<InfraMapRelay>
  resources: ReadonlyArray<InfraMapResource>
  /** Cloudflare DNS, when the domain integration is on. */
  domains: {
    zones: ReadonlyArray<string>
    assignments: ReadonlyArray<{ relayId: string; instanceId: string }>
  } | null
  proxyModes: ReadonlyMap<string, RelayProxyMode | null>
  /** Game servers and apps joined to a database's network. */
  databaseLinks: ReadonlyArray<{
    relayId: string
    consumer: { kind: "app" | "server"; id: string }
    databaseId: string
  }>
  /** Per Relay, once loaded. */
  webRoutes: ReadonlyMap<string, ReadonlyArray<InfraMapWebRoute>>
  /** Per app key, once its containers are read. */
  appServices: ReadonlyMap<string, ReadonlyArray<InfraMapService>>
}

export type InfraMapNode =
  | {
      type: "edge"
      id: string
      provider: "cloudflare" | "vercel"
      frontsHearth: boolean
      zones: ReadonlyArray<string>
      domainCount: number
    }
  | { type: "hearth"; id: string; host: string; relayCount: number }
  | {
      type: "relay-summary"
      id: string
      relay: InfraMapRelay
      counts: Record<InfraMapResourceKind, number>
      proxyMode: RelayProxyMode | null
    }
  | { type: "relay"; id: string; relay: InfraMapRelay; focus: boolean }
  | {
      type: "proxy"
      id: string
      relayId: string
      mode: RelayProxyMode
      hostnames: ReadonlyArray<string>
      routeCount: number
    }
  | {
      type: "resource"
      id: string
      resource: InfraMapResource
      focus: boolean
      hasDomain: boolean
    }
  | { type: "service"; id: string; app: InfraMapResource; service: InfraMapService }

export type InfraMapGroupLabel =
  | { type: "lane"; kind: InfraMapResourceKind; label: string; count: number }
  /**
   * A Compose app drawn as a box around its services. In the app's own view
   * the box is the app, and its title opens the app's page.
   */
  | { type: "stack"; app: InfraMapResource; count: number; focus: boolean }

export interface InfraMapView {
  layout: InfraMapLayout
  nodes: ReadonlyMap<string, InfraMapNode>
  groupLabels: ReadonlyMap<string, InfraMapGroupLabel>
}

export const infraMapNodeSizes = {
  edge: { width: 288, height: 92 },
  hearth: { width: 288, height: 92 },
  "relay-summary": { width: 296, height: 152 },
  relay: { width: 300, height: 116 },
  proxy: { width: 264, height: 92 },
  resource: { width: 248, height: 56 },
  service: { width: 248, height: 56 },
} satisfies Record<InfraMapNode["type"], { width: number; height: number }>

const groupLabels: Record<InfraMapResourceKind, string> = {
  server: "Game servers",
  app: "Apps",
  database: "Databases",
}


/** The proxies that publish web routes. Hearth mode publishes none. */
const routingModes = new Set<RelayProxyMode>(["traefik", "coolify", "none"])

export function buildInfraMapView(
  data: InfraMapData,
  scope: InfraMapScope,
  direction: "down" | "right"
): InfraMapView {
  const builder = new ViewBuilder(direction)
  if (scope.kind === "all") fleetView(builder, data)
  else if (scope.kind === "relay") relayView(builder, data, scope.relayId)
  else instanceView(builder, data, scope)
  return builder.finish()
}

function fleetView(builder: ViewBuilder, data: InfraMapData) {
  const counts = new Map<string, Record<InfraMapResourceKind, number>>()
  for (const resource of data.resources) {
    let relayCounts = counts.get(resource.relayId)
    if (!relayCounts) {
      relayCounts = { server: 0, app: 0, database: 0 }
      counts.set(resource.relayId, relayCounts)
    }
    relayCounts[resource.kind] += 1
  }
  const dnsRelays = new Set(
    (data.domains?.assignments ?? []).map((domain) => domain.relayId)
  )
  // What fronts Hearth and what serves game server domains are separate;
  // one Cloudflare node draws both when Cloudflare does both.
  const front = frontNode(data)
  const dns = dnsNode(data, data.domains?.assignments.length ?? 0)
  const edge = dns && front?.provider === "cloudflare" ? null : dns
  const hearth = hearthNode(data)
  builder.rank([
    ...(edge ? [builder.lone(edge)] : []),
    ...(front ? [builder.lone(front)] : []),
    builder.lone(hearth),
  ])
  if (front)
    builder.link(
      front.id,
      hearth.id,
      front.provider === "cloudflare" ? "dns" : "uplink"
    )
  const dnsSource = dns ? (edge ?? front) : null

  const relayNodes = data.relays.map((relay) =>
    builder.add({
      type: "relay-summary",
      id: relayNodeId(relay.id),
      relay,
      counts: counts.get(relay.id) ?? { server: 0, app: 0, database: 0 },
      proxyMode: data.proxyModes.get(relay.id) ?? null,
    })
  )
  builder.rank([
    {
      id: "relays",
      labelled: false,
      columns: builder.relayGridAcross(relayNodes.length),
      nodes: relayNodes.map(builder.sized),
    },
  ])
  for (const relay of data.relays) {
    builder.link(hearth.id, relayNodeId(relay.id), "uplink", !relay.enabled)
    if (dnsSource && dnsRelays.has(relay.id))
      builder.link(dnsSource.id, relayNodeId(relay.id), "dns")
  }
}

function relayView(builder: ViewBuilder, data: InfraMapData, relayId: string) {
  const relay = data.relays.find((candidate) => candidate.id === relayId)
  if (!relay) return fleetView(builder, data)
  const resources = data.resources.filter(
    (resource) => resource.relayId === relayId
  )
  const domainKeys = domainKeySet(data, relayId)
  const routes = data.webRoutes.get(relayId) ?? []

  const hearth = hearthNode(data)
  builder.rank([builder.lone(hearth)])
  const relayNode = builder.add({
    type: "relay",
    id: relayNodeId(relay.id),
    relay,
    focus: true,
  })
  builder.rank([builder.lone(relayNode)])
  builder.link(hearth.id, relayNode.id, "uplink", !relay.enabled)

  // Ingress: Cloudflare for game server domains, the proxy for web routes.
  const edge = dnsNode(data, domainKeys.size)
  const proxy = proxyNode(data, relayId, routes)
  builder.rank([
    ...(edge ? [builder.lone(edge)] : []),
    ...(proxy ? [builder.lone(proxy)] : []),
  ])
  if (proxy) builder.link(relayNode.id, proxy.id, "uplink")

  const nodesByKind = new Map<InfraMapResourceKind, Array<InfraMapNode>>()
  const stacks: Array<InfraMapGroupInput> = []
  for (const resource of resources) {
    const services = stackServices(data, resource)
    if (services) {
      stacks.push(builder.stack(resource, services))
      continue
    }
    const node = builder.add({
      type: "resource",
      id: resource.key,
      resource,
      focus: false,
      hasDomain: domainKeys.has(resource.id),
    })
    const list = nodesByKind.get(resource.kind)
    if (list) list.push(node)
    else nodesByKind.set(resource.kind, [node])
  }
  builder.rank([
    builder.lane("server", nodesByKind.get("server") ?? []),
    builder.lane("app", nodesByKind.get("app") ?? []),
    ...stacks,
  ])
  builder.rank([builder.lane("database", nodesByKind.get("database") ?? [])])

  if (edge)
    for (const resource of resources)
      if (domainKeys.has(resource.id))
        builder.link(edge.id, resource.key, "dns")
  if (proxy)
    for (const route of routes)
      builder.link(proxy.id, routeTarget(data, relayId, route.owner), "route")
  for (const link of data.databaseLinks) {
    if (link.relayId !== relayId) continue
    for (const consumer of consumerNodes(data, relayId, link))
      builder.link(
        consumer,
        resourceKey("database", relayId, link.databaseId),
        "database"
      )
  }
}

/** A Compose app with more than one service, drawn as a box around them. */
function stackServices(data: InfraMapData, resource: InfraMapResource) {
  if (resource.kind !== "app") return null
  const services = data.appServices.get(resource.key)
  return services && services.length > 1 ? services : null
}

function stackGroupId(appKey: string) {
  return `stack:${appKey}`
}

function serviceNodeId(appKey: string, service: string) {
  return `service:${appKey}:${service}`
}

/** A route reaches its service when the app is drawn as a stack. */
function routeTarget(
  data: InfraMapData,
  relayId: string,
  owner: InfraMapWebRoute["owner"]
) {
  const key = resourceKey(owner.kind, relayId, owner.id)
  const services = data.appServices.get(key)
  return owner.service && services && services.length > 1
    ? serviceNodeId(key, owner.service)
    : key
}

/**
 * The nodes a database link starts from: for a stack, the services joined
 * to the database's network, or its first service when none says so.
 */
function consumerNodes(
  data: InfraMapData,
  relayId: string,
  link: InfraMapData["databaseLinks"][number]
): Array<string> {
  const key = resourceKey(link.consumer.kind, relayId, link.consumer.id)
  const services = data.appServices.get(key)
  if (!services || services.length < 2) return [key]
  const joined = services.filter((service) =>
    service.databaseIds.includes(link.databaseId)
  )
  return (joined.length > 0 ? joined : services.slice(0, 1)).map((service) =>
    serviceNodeId(key, service.name)
  )
}

function instanceView(
  builder: ViewBuilder,
  data: InfraMapData,
  scope: { kind: InfraMapResourceKind; relayId: string; id: string }
) {
  const focus = data.resources.find(
    (resource) =>
      resource.kind === scope.kind &&
      resource.relayId === scope.relayId &&
      resource.id === scope.id
  )
  if (!focus) return fleetView(builder, data)
  const relay = data.relays.find((candidate) => candidate.id === scope.relayId) ?? {
    id: focus.relayId,
    name: focus.relayName,
    enabled: true,
    address: "",
    nodeArch: null,
    restricted: true,
  }

  const hearth = hearthNode(data)
  builder.rank([builder.lone(hearth)])
  const relayNode = builder.add({
    type: "relay",
    id: relayNodeId(relay.id),
    relay,
    focus: false,
  })

  // What reaches the instance from outside sits beside its Relay: Cloudflare
  // for its domain, the Relay's proxy for its web routes.
  const hasDomain = domainKeySet(data, relay.id).has(focus.id)
  const routes = (data.webRoutes.get(relay.id) ?? []).filter(
    (route) => route.owner.kind === focus.kind && route.owner.id === focus.id
  )
  const edge = hasDomain ? dnsNode(data, 1) : null
  const proxy = routes.length > 0 ? proxyNode(data, relay.id, routes) : null
  builder.rank([
    ...(edge ? [builder.lone(edge)] : []),
    builder.lone(relayNode),
    ...(proxy ? [builder.lone(proxy)] : []),
  ])
  builder.link(hearth.id, relayNode.id, "uplink", !relay.enabled)
  if (proxy) builder.link(relayNode.id, proxy.id, "uplink")

  // A Compose app is its box of services; anything else is one card.
  const services = stackServices(data, focus)
  const focusId = services ? stackGroupId(focus.key) : focus.key
  builder.rank([
    services
      ? builder.stack(focus, services, true)
      : builder.lone({
          type: "resource",
          id: focus.key,
          resource: focus,
          focus: true,
          hasDomain,
        }),
  ])
  builder.link(relayNode.id, focusId, "uplink")
  if (edge) builder.link(edge.id, focusId, "dns")
  if (proxy)
    for (const route of routes)
      builder.link(proxy.id, routeTarget(data, relay.id, route.owner), "route")

  // What it uses, or for a database, what uses it.
  const related = data.databaseLinks.flatMap((link) => {
    if (link.relayId !== relay.id) return []
    if (focus.kind === "database")
      return link.databaseId === focus.id
        ? [resourceKey(link.consumer.kind, relay.id, link.consumer.id)]
        : []
    return link.consumer.kind === focus.kind && link.consumer.id === focus.id
      ? [resourceKey("database", relay.id, link.databaseId)]
      : []
  })
  const byKey = new Map(data.resources.map((resource) => [resource.key, resource]))
  const relatedNodes = [...new Set(related)].flatMap((key) => {
    const resource = byKey.get(key)
    return resource
      ? [
          builder.add({
            type: "resource",
            id: resource.key,
            resource,
            focus: false,
            hasDomain: false,
          }),
        ]
      : []
  })
  if (focus.kind === "database") {
    builder.rank(
      (["server", "app"] as const).map((kind) =>
        builder.lane(
          kind,
          relatedNodes.filter(
            (node) => node.type === "resource" && node.resource.kind === kind
          )
        )
      )
    )
  } else {
    builder.rank([builder.lane("database", relatedNodes)])
  }
  if (services) {
    for (const link of data.databaseLinks)
      if (
        link.relayId === relay.id &&
        link.consumer.kind === "app" &&
        link.consumer.id === focus.id
      )
        for (const consumer of consumerNodes(data, relay.id, link))
          builder.link(
            consumer,
            resourceKey("database", relay.id, link.databaseId),
            "database"
          )
  } else {
    for (const node of relatedNodes)
      builder.link(focusId, node.id, "database")
  }
}

class ViewBuilder {
  constructor(readonly direction: "down" | "right") {}

  // A group's columns count nodes across the flow: sideways when the map
  // flows down, downwards when it flows right. Long chains run along the
  // flow, and what a group holds stacks down the screen either way.

  /** A few Relays line up; more fill a grid shaped like a wide canvas. */
  relayGridAcross(count: number) {
    if (count <= 4) return count
    return this.direction === "right"
      ? Math.ceil(Math.sqrt(count * 1.2))
      : Math.ceil(Math.sqrt(count * 0.85))
  }

  /** Lanes are wider than tall: five across, or eight down beside them. */
  laneAcross(count: number) {
    return this.direction === "right"
      ? count <= 6
        ? count
        : Math.min(8, Math.ceil(Math.sqrt(count * 3)))
      : Math.min(5, Math.max(1, Math.ceil(Math.sqrt(count * 1.5))))
  }

  /** A stack reads top to bottom, as in a Compose file. */
  stackAcross(count: number) {
    return this.direction === "right" ? Math.min(8, count) : count > 3 ? 2 : 1
  }

  readonly nodes = new Map<string, InfraMapNode>()
  readonly labels = new Map<string, InfraMapGroupLabel>()
  readonly ranks: Array<Array<InfraMapGroupInput>> = []
  readonly links: Array<InfraMapLinkInput> = []

  add<T extends InfraMapNode>(node: T): T {
    this.nodes.set(node.id, node)
    return node
  }

  sized = (node: InfraMapNode) => ({
    id: node.id,
    ...infraMapNodeSizes[node.type],
  })

  lone(node: InfraMapNode): InfraMapGroupInput {
    this.add(node)
    return {
      id: `group:${node.id}`,
      labelled: false,
      columns: 1,
      nodes: [this.sized(node)],
    }
  }

  lane(
    kind: InfraMapResourceKind,
    nodes: ReadonlyArray<InfraMapNode>
  ): InfraMapGroupInput {
    const id = `lane:${kind}`
    this.labels.set(id, {
      type: "lane",
      kind,
      label: groupLabels[kind],
      count: nodes.length,
    })
    return {
      id,
      labelled: true,
      columns: this.laneAcross(nodes.length),
      nodes: nodes.map(this.sized),
    }
  }

  stack(
    app: InfraMapResource,
    services: ReadonlyArray<InfraMapService>,
    focus = false
  ): InfraMapGroupInput {
    const id = stackGroupId(app.key)
    this.labels.set(id, { type: "stack", app, count: services.length, focus })
    const nodes = services.map((service) =>
      this.add({
        type: "service",
        id: serviceNodeId(app.key, service.name),
        app,
        service,
      })
    )
    return {
      id,
      labelled: true,
      columns: this.stackAcross(nodes.length),
      nodes: nodes.map(this.sized),
    }
  }

  rank(groups: Array<InfraMapGroupInput>) {
    this.ranks.push(groups.filter((group) => group.nodes.length > 0))
  }

  link(
    from: string,
    to: string,
    kind: InfraMapLinkInput["kind"],
    muted = false
  ) {
    this.links.push({ id: `${kind}:${from}:${to}`, from, to, kind, muted })
  }

  finish(): InfraMapView {
    // Ranks left empty would leave a gap, and links only join neighbours.
    const ranks = this.ranks.filter((rank) => rank.length > 0)
    return {
      layout: layoutInfraMap({
        direction: this.direction,
        ranks,
        links: dedupe(this.links),
      }),
      nodes: this.nodes,
      groupLabels: this.labels,
    }
  }
}

function dedupe(links: ReadonlyArray<InfraMapLinkInput>) {
  const seen = new Set<string>()
  return links.filter((link) =>
    seen.has(link.id) ? false : (seen.add(link.id), true)
  )
}

function hearthNode(data: InfraMapData): InfraMapNode {
  return {
    type: "hearth",
    id: "hearth",
    host: data.hearthHost,
    relayCount: data.relays.length,
  }
}

/** The edge network a request to Hearth came through. */
function frontNode(
  data: InfraMapData
): Extract<InfraMapNode, { type: "edge" }> | null {
  if (!data.provider) return null
  const cloudflare = data.provider === "cloudflare"
  return {
    type: "edge",
    id: `edge:${data.provider}`,
    provider: data.provider,
    frontsHearth: true,
    zones: cloudflare ? (data.domains?.zones ?? []) : [],
    domainCount: cloudflare ? (data.domains?.assignments.length ?? 0) : 0,
  }
}

/** Cloudflare, serving managed domains for this many game servers. */
function dnsNode(
  data: InfraMapData,
  domainCount: number
): Extract<InfraMapNode, { type: "edge" }> | null {
  if (!data.domains || domainCount === 0) return null
  return {
    type: "edge",
    id: "edge:cloudflare",
    provider: "cloudflare",
    frontsHearth: data.provider === "cloudflare",
    zones: data.domains.zones,
    domainCount,
  }
}

function proxyNode(
  data: InfraMapData,
  relayId: string,
  routes: ReadonlyArray<InfraMapWebRoute>
): Extract<InfraMapNode, { type: "proxy" }> | null {
  const mode = data.proxyModes.get(relayId) ?? null
  if (!mode || !routingModes.has(mode)) return null
  // Without its own Traefik, a Relay only shows a proxy it actually uses.
  if (mode === "none" && routes.length === 0) return null
  return {
    type: "proxy",
    id: `proxy:${relayId}`,
    relayId,
    mode,
    hostnames: [...new Set(routes.map((route) => route.hostname))],
    routeCount: routes.length,
  }
}

function domainKeySet(data: InfraMapData, relayId: string) {
  return new Set(
    (data.domains?.assignments ?? [])
      .filter((domain) => domain.relayId === relayId)
      .map((domain) => domain.instanceId)
  )
}

export function relayNodeId(relayId: string) {
  return `relay:${relayId}`
}

export function resourceKey(
  kind: InfraMapResourceKind,
  relayId: string,
  id: string
) {
  return `${kind}:${relayId}:${id}`
}

/** The scope's URL form, matching the scope picker's option keys. */
export function infraMapScopeKey(scope: InfraMapScope): string {
  if (scope.kind === "all") return ""
  if (scope.kind === "relay")
    return `relay:${scope.relayId}:${scope.relayId}`
  return resourceKey(scope.kind, scope.relayId, scope.id)
}

export function parseInfraMapScope(value: string | undefined): InfraMapScope {
  const [kind, relayId, id] = value?.split(":") ?? []
  if (!kind || !relayId) return { kind: "all" }
  if (kind === "relay") return { kind: "relay", relayId }
  if ((kind === "server" || kind === "app" || kind === "database") && id)
    return { kind, relayId, id }
  return { kind: "all" }
}
