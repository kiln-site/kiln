import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Boxes,
  Cloud,
  Container,
  Database,
  Globe2,
  RadioTower,
  Router,
  Server,
  Triangle,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { nodeStyle } from "@/components/infra-map-canvas"
import { HearthMark } from "@/components/hearth-mark"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InstanceCard } from "@/components/instance-card"
import {
  proxyModeLabels,
  useRelayPauseState,
} from "@/components/relay/relay-presentation"
import { StatusIndicator } from "@/components/status-indicator"
import type { InfraMapRect } from "@/lib/infra-map-layout"
import type {
  InfraMapGroupLabel,
  InfraMapNode,
  InfraMapRelay,
  InfraMapResource,
  InfraMapResourceKind,
  InfraMapScope,
} from "@/lib/infra-map-model"
import { useInstanceState, type InstanceState } from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import {
  relayNodeReadingsQueryOptions,
  relayReachabilityQueryOptions,
  type RelayNodeReading,
} from "@/lib/query-options"

export type SelectScope = (scope: InfraMapScope) => void

export const kindPresentation: Record<
  InfraMapResourceKind,
  { icon: LucideIcon; one: string; other: string }
> = {
  server: { icon: Server, one: "game server", other: "game servers" },
  app: { icon: Boxes, one: "app", other: "apps" },
  database: { icon: Database, one: "database", other: "databases" },
}

/**
 * Each kind keeps one colour across the map: Kiln's own parts take the
 * accent, Traefik violet, game servers green, apps red, databases blue.
 */
export const kindTone = {
  kiln: "border-primary/35 bg-primary/10 text-primary",
  server: "border-emerald-400/35 bg-emerald-400/10 text-emerald-300",
  app: "border-red-400/35 bg-red-400/10 text-red-300",
  database: "border-blue-400/35 bg-blue-400/10 text-blue-300",
  proxy: "border-violet-400/35 bg-violet-400/10 text-violet-300",
  cloudflare: "border-orange-400/35 bg-orange-400/10 text-orange-300",
} as const

/** The box around a kind's lane, and a Compose app's box. */
const laneTone = {
  server: "border-emerald-400/50 bg-emerald-400/[0.05]",
  app: "border-red-400/50 bg-red-400/[0.05]",
  database: "border-blue-400/50 bg-blue-400/[0.05]",
} as const

const kindText = {
  server: "text-emerald-300",
  app: "text-red-300",
  database: "text-blue-300",
} as const

const nodeClass =
  "absolute rounded-xl border border-border/80 bg-card shadow-sm outline-none"
const interactiveClass =
  "cursor-pointer text-left transition-colors hover:border-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring/40"

export const MapNode = React.memo(function MapNode({
  includeDomains,
  node,
  onSelect,
  rect,
}: {
  includeDomains: boolean
  node: InfraMapNode
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  switch (node.type) {
    case "edge":
      return <EdgeNode includeDomains={includeDomains} node={node} rect={rect} />
    case "hearth":
      return <HearthNode node={node} rect={rect} />
    case "relay-summary":
      return <RelaySummaryNode node={node} rect={rect} onSelect={onSelect} />
    case "relay":
      return node.relay.restricted ? (
        <RestrictedRelayNode node={node} rect={rect} />
      ) : (
        <LiveRelayNode node={node} rect={rect} onSelect={onSelect} />
      )
    case "proxy":
      return <ProxyNode node={node} rect={rect} />
    case "resource":
      return <ResourceNode node={node} rect={rect} onSelect={onSelect} />
    case "service":
      return <ServiceNode node={node} rect={rect} />
  }
})

export const MapGroup = React.memo(function MapGroup({
  label,
  onSelect,
  rect,
}: {
  label: InfraMapGroupLabel
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  if (label.type === "stack")
    return <StackGroup label={label} rect={rect} onSelect={onSelect} />
  const { icon: Icon } = kindPresentation[label.kind]
  return (
    <div
      className={cn("absolute rounded-xl border", laneTone[label.kind])}
      style={nodeStyle(rect)}
    >
      <div className="flex h-9 items-center gap-1.5 px-5 text-muted-foreground">
        <Icon
          className={cn("size-3.5", kindText[label.kind])}
          aria-hidden="true"
        />
        <span className="type-label">{label.label}</span>
        <span className="type-meta tabular-nums">{label.count}</span>
      </div>
    </div>
  )
})

/**
 * A Compose app: a box around its services, titled with the app. In the
 * app's own view the title opens its page; elsewhere it shows the app.
 */
function StackGroup({
  label,
  onSelect,
  rect,
}: {
  label: Extract<InfraMapGroupLabel, { type: "stack" }>
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  const { app } = label
  const titleClass =
    "group/stack flex h-9 w-full items-center gap-1.5 rounded-t-xl px-5 text-left text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
  const title = (
    <>
      <Boxes className="size-3.5 shrink-0 text-red-300" aria-hidden="true" />
      <span className="type-label min-w-0 truncate text-foreground transition-colors group-hover/stack:text-primary">
        {app.name}
      </span>
      <span className="type-meta shrink-0 tabular-nums">
        {label.count} services
      </span>
      <span className="ml-auto shrink-0">
        <LiveStatus app={app} />
      </span>
    </>
  )
  return (
    <div
      className={cn(
        "absolute rounded-xl border border-dashed",
        laneTone.app,
        label.focus && "border-red-400/70 ring-2 ring-red-400/15"
      )}
      data-node-id={`stack:${app.key}`}
      style={nodeStyle(rect)}
    >
      {label.focus ? (
        <Link
          to="/app/$appId"
          params={{ appId: app.routeId }}
          preload="intent"
          className={titleClass}
        >
          {title}
        </Link>
      ) : (
        <button
          type="button"
          className={titleClass}
          onClick={() =>
            onSelect({ kind: "app", relayId: app.relayId, id: app.id })
          }
        >
          {title}
        </button>
      )}
    </div>
  )
}

function LiveStatus({ app }: { app: InfraMapResource }) {
  const state = useInstanceState({
    kind: "app",
    id: app.id,
    relayId: app.relayId,
  })
  return <StatusIndicator status={instanceStatePresentation(state)} />
}

/** One Compose service, with how many of its containers run. */
function ServiceNode({
  node,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "service" }>
  rect: InfraMapRect
}) {
  const { service } = node
  const status: IdentityStatusPresentation =
    service.running === service.containers
      ? { label: "Running", tone: "success" }
      : service.running === 0
        ? { label: "Stopped", tone: "neutral" }
        : { label: "Degraded", tone: "warning" }
  return (
    <div
      className={cn(nodeClass, "flex items-center rounded-lg px-2.5")}
      data-node-id={node.id}
      style={nodeStyle(rect)}
    >
      <NodeTitle
        icon={
          <span className="relative">
            <NodeIcon tone="app">
              <Container className="size-4" aria-hidden="true" />
            </NodeIcon>
          </span>
        }
        meta={service.image}
        metaMono
        name={
          <span className="flex items-center justify-between gap-2">
            <span className="truncate">
              {service.name}
              {service.containers > 1 ? (
                <span className="type-meta ml-1.5 font-normal text-muted-foreground">
                  ×{service.containers}
                </span>
              ) : null}
            </span>
            <StatusIndicator status={status} />
          </span>
        }
      />
    </div>
  )
}

function NodeIcon({
  children,
  tone,
}: {
  children: React.ReactNode
  tone?: keyof typeof kindTone
}) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md border",
        tone
          ? kindTone[tone]
          : "border-border/70 bg-background/35 text-muted-foreground"
      )}
    >
      {children}
    </span>
  )
}

function NodeTitle({
  icon,
  meta,
  metaMono = false,
  name,
}: {
  icon: React.ReactNode
  meta: React.ReactNode
  metaMono?: boolean
  name: React.ReactNode
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground">
          {name}
        </span>
        <span
          className={cn(
            "type-meta block truncate text-muted-foreground",
            metaMono && "font-mono"
          )}
        >
          {meta}
        </span>
      </span>
    </span>
  )
}

function NodeFooter({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-2.5 flex min-w-0 items-center gap-1.5 border-t border-border/60 pt-2 text-muted-foreground">
      {children}
    </span>
  )
}

function EdgeNode({
  includeDomains,
  node,
  rect,
}: {
  includeDomains: boolean
  node: Extract<InfraMapNode, { type: "edge" }>
  rect: InfraMapRect
}) {
  const Icon = node.provider === "cloudflare" ? Cloud : Triangle
  const role =
    node.frontsHearth && node.domainCount > 0
      ? "Proxy and DNS"
      : node.frontsHearth
        ? "Proxies Hearth"
        : `DNS for ${node.domainCount} ${node.domainCount === 1 ? "game server" : "game servers"}`
  const shown = node.zones.slice(0, 2)
  const content = (
    <>
      <NodeTitle
        icon={
          <NodeIcon
            tone={node.provider === "cloudflare" ? "cloudflare" : undefined}
          >
            <Icon className="size-4" aria-hidden="true" />
          </NodeIcon>
        }
        meta={role}
        name={node.provider === "cloudflare" ? "Cloudflare" : "Vercel"}
      />
      {shown.length > 0 ? (
        <NodeFooter>
          <Globe2 className="size-3 shrink-0" aria-hidden="true" />
          <span className="type-meta truncate font-mono">
            {shown.join(", ")}
            {node.zones.length > shown.length
              ? ` and ${node.zones.length - shown.length} more`
              : null}
          </span>
        </NodeFooter>
      ) : null}
    </>
  )
  const className = cn(nodeClass, "flex flex-col justify-center px-3 py-2.5")
  return includeDomains && node.provider === "cloudflare" ? (
    <Link
      to="/infra/domains"
      className={cn(className, interactiveClass)}
      data-node-id={node.id}
      style={nodeStyle(rect)}
    >
      {content}
    </Link>
  ) : (
    <div className={className} data-node-id={node.id}
      style={nodeStyle(rect)}>
      {content}
    </div>
  )
}

function HearthNode({
  node,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "hearth" }>
  rect: InfraMapRect
}) {
  return (
    <div
      className={cn(
        nodeClass,
        "flex flex-col justify-center border-primary/45 px-3 py-2.5"
      )}
      data-node-id={node.id}
      style={nodeStyle(rect)}
    >
      <NodeTitle
        icon={
          <NodeIcon tone="kiln">
            <HearthMark className="size-4" />
          </NodeIcon>
        }
        meta={node.host}
        metaMono
        name="Hearth"
      />
      <NodeFooter>
        <span className="type-meta flex-1">Panel</span>
        <RelayConnections total={node.relayCount} />
      </NodeFooter>
    </div>
  )
}

const selectConnectedCount = (
  relays: ReadonlyArray<{ status: "connected" | "unreachable" }>
) => relays.filter((relay) => relay.status === "connected").length

function RelayConnections({ total }: { total: number }) {
  const { data: connected } = useQuery({
    ...relayReachabilityQueryOptions(),
    select: selectConnectedCount,
  })
  if (total === 0) return <span className="type-meta">No Relays</span>
  return (
    <span className="type-meta">
      {connected ?? "—"} of {total} {total === 1 ? "Relay" : "Relays"}{" "}
      connected
    </span>
  )
}

/** A Relay in the fleet: its health, load, and what it holds. */
const RelaySummaryNode = React.memo(function RelaySummaryNode({
  node,
  onSelect,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "relay-summary" }>
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  const { relay } = node
  const status = useRelayStatus(relay)
  const proxy =
    node.proxyMode && node.proxyMode !== "hearth"
      ? proxyModeLabels[node.proxyMode]
      : null
  return (
    <button
      type="button"
      aria-label={`Show Relay ${relay.name}`}
      className={cn(
        nodeClass,
        interactiveClass,
        "flex flex-col px-3 pt-3 pb-2.5",
        !relay.enabled && "border-dashed"
      )}
      data-node-id={node.id}
      style={nodeStyle(rect)}
      onClick={() => onSelect({ kind: "relay", relayId: relay.id })}
    >
      <NodeTitle
        icon={
          <NodeIcon tone="kiln">
            <RadioTower className="size-4" aria-hidden="true" />
          </NodeIcon>
        }
        meta={relay.address}
        metaMono
        name={
          <span className="flex items-center justify-between gap-2">
            <span className="truncate">{relay.name}</span>
            <StatusIndicator status={status} />
          </span>
        }
      />
      <RelayMeters
        connected={status.tone === "success"}
        relayId={relay.id}
      />
      <span className="mt-auto flex items-center gap-3 border-t border-border/60 pt-2 text-muted-foreground">
        {(["server", "app", "database"] as const).map((kind) => {
          const { icon: Icon, one, other } = kindPresentation[kind]
          const count = node.counts[kind]
          return (
            <span
              key={kind}
              className="type-meta flex items-center gap-1 tabular-nums"
              title={`${count} ${count === 1 ? one : other}`}
            >
              <Icon
                className={cn("size-3.5", kindText[kind])}
                aria-hidden="true"
              />
              {count}
            </span>
          )
        })}
        {proxy ? (
          <span
            className="type-meta ml-auto flex min-w-0 items-center gap-1 rounded-md border border-violet-400/30 bg-violet-400/10 px-1.5 text-violet-300"
            title={proxy}
          >
            <Router className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">Traefik</span>
          </span>
        ) : null}
      </span>
    </button>
  )
})

const relayStatusPresentation = {
  connected: { label: "Online", tone: "success" },
  unreachable: { label: "Unreachable", tone: "danger" },
  paused: { label: "Paused", tone: "neutral" },
  pausing: {
    detail: "Waiting for the Relay to confirm it's paused",
    label: "Pausing",
    pulse: true,
    tone: "warning",
  },
  checking: { label: "Checking", tone: "neutral", pending: true, pulse: true },
} satisfies Record<string, IdentityStatusPresentation>

/** One shared poll answers every Relay, so a fleet costs one request. */
function useRelayStatus(relay: InfraMapRelay): IdentityStatusPresentation {
  const select = React.useCallback(
    (relays: ReadonlyArray<{ id: string; status: "connected" | "unreachable" }>) =>
      relays.find((candidate) => candidate.id === relay.id)?.status,
    [relay.id]
  )
  const { data: reachability } = useQuery({
    ...relayReachabilityQueryOptions(),
    enabled: relay.enabled,
    select,
  })
  // Paused once the Relay has it, whichever Hearth asked.
  const pause = useRelayPauseState(relay.id)
  if (pause === "paused") return relayStatusPresentation.paused
  if (!relay.enabled) return relayStatusPresentation[pause ?? "checking"]
  return relayStatusPresentation[reachability ?? "checking"]
}

/** A Relay the user cannot read: its name, and nothing it would reveal. */
function RestrictedRelayNode({
  node,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "relay" }>
  rect: InfraMapRect
}) {
  return (
    <div
      className={cn(nodeClass, "flex flex-col justify-center px-3 py-2.5")}
      data-node-id={node.id}
      style={nodeStyle(rect)}
    >
      <NodeTitle
        icon={
          <NodeIcon tone="kiln">
            <RadioTower className="size-4" aria-hidden="true" />
          </NodeIcon>
        }
        meta="You can't view this Relay"
        name={node.relay.name}
      />
    </div>
  )
}

function LiveRelayNode(props: {
  node: Extract<InfraMapNode, { type: "relay" }>
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  const relayId = props.node.relay.id
  const state = useInstanceState({ kind: "relay", id: relayId, relayId })
  return <RelayNode {...props} state={state} />
}

const RelayNode = React.memo(function RelayNode({
  node,
  onSelect,
  rect,
  state,
}: {
  node: Extract<InfraMapNode, { type: "relay" }>
  onSelect: SelectScope
  rect: InfraMapRect
  state: InstanceState
}) {
  const { relay } = node
  const card = (
    <InstanceCard
      className="min-w-0 flex-1"
      iconClassName={kindTone.kiln}
      instance={{ id: relay.id, kind: "relay", relayId: relay.id }}
      meta={relay.address}
      metaClassName="font-mono"
      name={relay.name}
      nameClassName="transition-colors group-hover/node:text-primary"
      showFavorite={false}
      state={state}
    />
  )
  const meters = (
    <RelayMeters
      connected={
        state.phase === "ready" &&
        state.observation.reachability === "connected"
      }
      relayId={relay.id}
    />
  )
  const className = cn(
    nodeClass,
    interactiveClass,
    "group/node flex flex-col px-3 pt-3 pb-2.5",
    node.focus && "border-primary/45",
    !relay.enabled && "border-dashed"
  )
  // The scope's own subject opens its page; anything else becomes the scope.
  return node.focus ? (
    <Link
      to="/relay/$relayId"
      params={{ relayId: relay.id }}
      preload="intent"
      className={className}
      data-node-id={node.id}
      style={nodeStyle(rect)}
    >
      {card}
      {meters}
    </Link>
  ) : (
    <button
      type="button"
      className={className}
      data-node-id={node.id}
      style={nodeStyle(rect)}
      onClick={() => onSelect({ kind: "relay", relayId: relay.id })}
    >
      {card}
      {meters}
    </button>
  )
})

function ProxyNode({
  node,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "proxy" }>
  rect: InfraMapRect
}) {
  const shown = node.hostnames.slice(0, 2)
  return (
    <div
      className={cn(
        nodeClass,
        "flex flex-col justify-center border-violet-400/40 px-3 py-2.5"
      )}
      data-node-id={node.id}
      style={nodeStyle(rect)}
    >
      <NodeTitle
        icon={
          <NodeIcon tone="proxy">
            <Router className="size-4" aria-hidden="true" />
          </NodeIcon>
        }
        meta={`${proxyModeLabels[node.mode]} · ${node.routeCount} ${node.routeCount === 1 ? "web route" : "web routes"}`}
        name="Traefik"
      />
      {shown.length > 0 ? (
        <NodeFooter>
          <Globe2 className="size-3 shrink-0" aria-hidden="true" />
          <span className="type-meta truncate font-mono">
            {shown.join(", ")}
            {node.hostnames.length > shown.length
              ? ` and ${node.hostnames.length - shown.length} more`
              : null}
          </span>
        </NodeFooter>
      ) : null}
    </div>
  )
}

const focusRing = {
  server: "border-emerald-400/60 ring-2 ring-emerald-400/15",
  app: "border-red-400/60 ring-2 ring-red-400/15",
  database: "border-blue-400/60 ring-2 ring-blue-400/15",
} as const

const ResourceNode = React.memo(function ResourceNode({
  node,
  onSelect,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "resource" }>
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  const { resource } = node
  const card = (
    <InstanceCard
      className="min-w-0 flex-1"
      iconClassName={kindTone[resource.kind]}
      instance={{
        brickId: resource.brickId,
        id: resource.id,
        implementation: resource.implementation,
        kind: resource.kind,
        relayId: resource.relayId,
      }}
      meta={resource.meta}
      metaClassName="font-mono"
      name={resource.name}
      nameAccessory={
        node.hasDomain ? (
          <Globe2
            className="size-3 shrink-0 text-orange-400"
            aria-label="Has a managed domain"
          />
        ) : null
      }
      nameClassName="transition-colors group-hover/node:text-primary"
      showFavorite={false}
    />
  )
  const className = cn(
    nodeClass,
    interactiveClass,
    "group/node flex items-center rounded-lg px-2.5",
    node.focus && focusRing[resource.kind]
  )
  const style = nodeStyle(rect)
  if (!node.focus) {
    return (
      <button
        type="button"
        className={className}
        data-node-id={node.id}
        style={style}
        onClick={() =>
          onSelect({
            kind: resource.kind,
            relayId: resource.relayId,
            id: resource.id,
          })
        }
      >
        {card}
      </button>
    )
  }
  if (resource.kind === "server")
    return (
      <Link
        to="/server/$serverId"
        params={{ serverId: resource.routeId }}
        preload="intent"
        className={className}
        data-node-id={node.id}
        style={style}
      >
        {card}
      </Link>
    )
  if (resource.kind === "app")
    return (
      <Link
        to="/app/$appId"
        params={{ appId: resource.routeId }}
        preload="intent"
        className={className}
        data-node-id={node.id}
        style={style}
      >
        {card}
      </Link>
    )
  return (
    <Link
      to="/db/$databaseId"
      params={{ databaseId: resource.routeId }}
      preload="intent"
      className={className}
      data-node-id={node.id}
      style={style}
    >
      {card}
    </Link>
  )
})

function RelayMeters({
  connected,
  relayId,
}: {
  connected: boolean
  relayId: string
}) {
  const select = React.useCallback(
    (readings: ReadonlyArray<RelayNodeReading>) =>
      readings.find((reading) => reading.relayId === relayId),
    [relayId]
  )
  const { data: reading } = useQuery({
    ...relayNodeReadingsQueryOptions(),
    enabled: connected,
    notifyOnChangeProps: ["data"],
    select,
  })
  const live = connected ? reading : undefined
  return (
    <span className="mt-2.5 grid w-full grid-cols-3 gap-3">
      <Meter label="CPU" value={live ? live.cpu.loadPercent : null} />
      <Meter label="Memory" value={live ? usage(live.memory) : null} />
      <Meter label="Disk" value={live ? usage(live.storage) : null} />
    </span>
  )
}

function usage(reading: { totalBytes: number; usedBytes: number }) {
  return reading.totalBytes > 0
    ? (reading.usedBytes / reading.totalBytes) * 100
    : null
}

function Meter({ label, value }: { label: string; value: number | null }) {
  const percent = value === null ? null : Math.min(100, Math.max(0, value))
  return (
    <span className="block min-w-0">
      <span className="type-meta flex items-baseline justify-between gap-1 text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="font-mono tabular-nums">
          {percent === null ? "—" : `${Math.round(percent)}%`}
        </span>
      </span>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            percent !== null && percent >= 90
              ? "bg-destructive"
              : percent !== null && percent >= 75
                ? "bg-amber-400"
                : "bg-primary/70"
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </span>
    </span>
  )
}
