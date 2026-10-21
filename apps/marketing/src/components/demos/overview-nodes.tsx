import * as React from "react"
import { Container, Globe2, Router } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { nodeStyle } from "@/components/infra-map-canvas"
import { HearthMark } from "@/components/hearth-mark"
import {
  IdentityName,
  type IdentityStatusPresentation,
} from "@/components/identity-name"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import { StatusIndicator } from "@/components/status-indicator"
import type { InfraMapRect } from "@/lib/infra-map-layout"
import type {
  InfraMapGroupLabel,
  InfraMapNode,
  InfraMapResourceKind,
  InfraMapScope,
} from "@/lib/infra-map-model"

import { BrickMark, officialBricks } from "~/components/brick-mark"
import {
  relayReadings,
  stoppedResources,
} from "~/components/demos/overview-data"

// Hearth's infrastructure map cards, drawn from the demo's fleet instead of
// Hearth's live queries. The markup follows apps/web's infra-map-nodes.

export type SelectScope = (scope: InfraMapScope) => void

const kindPresentation: Record<
  InfraMapResourceKind,
  { icon: typeof ServerKindIcon; one: string; other: string }
> = {
  server: { icon: ServerKindIcon, one: "game server", other: "game servers" },
  app: { icon: AppKindIcon, one: "app", other: "apps" },
  database: { icon: DatabaseKindIcon, one: "database", other: "databases" },
}

const kindTone = {
  kiln: "border-primary/35 bg-primary/10 text-primary",
  relay: "border-orange-400/35 bg-orange-400/10",
  server: "border-emerald-400/35 bg-emerald-400/10 text-emerald-300",
  app: "border-red-400/35 bg-red-400/10 text-red-300",
  database: "border-blue-400/35 bg-blue-400/10 text-blue-300",
  proxy: "border-violet-400/35 bg-violet-400/10 text-violet-300",
} as const

const laneTone = {
  server: "border-emerald-400/50 bg-emerald-400/[0.05]",
  app: "border-red-400/50 bg-red-400/[0.05]",
  database: "border-blue-400/50 bg-blue-400/[0.05]",
} as const

const focusRing = {
  server: "border-emerald-400/60 ring-2 ring-emerald-400/15",
  app: "border-red-400/60 ring-2 ring-red-400/15",
  database: "border-blue-400/60 ring-2 ring-blue-400/15",
} as const

const nodeClass =
  "absolute rounded-xl border border-border/80 bg-card shadow-sm outline-none"
const interactiveClass =
  "cursor-pointer text-left transition-colors hover:border-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring/40"

const online: IdentityStatusPresentation = { label: "Online", tone: "success" }
const running: IdentityStatusPresentation = {
  label: "Running",
  tone: "success",
}
const stopped: IdentityStatusPresentation = {
  label: "Stopped",
  tone: "neutral",
}

const brickColors: Record<string, string> = {
  Palworld: "#55b9d1",
  Paper: "#e67e7e",
  Velocity: "#4b98b0",
}

export const MapNode = React.memo(function MapNode({
  node,
  onSelect,
  rect,
}: {
  node: InfraMapNode
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  switch (node.type) {
    case "hearth":
      return <HearthNode node={node} rect={rect} />
    case "relay-summary":
      return <RelaySummaryNode node={node} rect={rect} onSelect={onSelect} />
    case "relay":
      return <RelayNode node={node} rect={rect} onSelect={onSelect} />
    case "proxy":
      return <ProxyNode node={node} rect={rect} />
    case "resource":
      return <ResourceNode node={node} rect={rect} onSelect={onSelect} />
    case "service":
      return <ServiceNode node={node} rect={rect} />
    case "edge":
      return null
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
  if (label.type === "stack") {
    const { app } = label
    const title = (
      <>
        <AppKindIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="type-label min-w-0 truncate text-foreground transition-colors group-hover/stack:text-primary">
          {app.name}
        </span>
        <span className="type-meta shrink-0 tabular-nums">
          {label.count} services
        </span>
        <span className="ml-auto shrink-0">
          <StatusIndicator status={running} />
        </span>
      </>
    )
    const titleClass =
      "group/stack flex h-9 w-full items-center gap-1.5 rounded-t-xl px-5 text-left text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
          <div className={titleClass}>{title}</div>
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
  const { icon: Icon } = kindPresentation[label.kind]
  return (
    <div
      className={cn("absolute rounded-xl border", laneTone[label.kind])}
      style={nodeStyle(rect)}
    >
      <div className="flex h-9 items-center gap-1.5 px-5 text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        <span className="type-label">{label.label}</span>
        <span className="type-meta tabular-nums">{label.count}</span>
      </div>
    </div>
  )
})

function NodeIcon({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: keyof typeof kindTone
}) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md border",
        kindTone[tone]
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
        <span className="type-meta">
          {node.relayCount} of {node.relayCount} Relays connected
        </span>
      </NodeFooter>
    </div>
  )
}

function RelaySummaryNode({
  node,
  onSelect,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "relay-summary" }>
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  const { relay } = node
  return (
    <button
      type="button"
      aria-label={`Show Relay ${relay.name}`}
      className={cn(
        nodeClass,
        interactiveClass,
        "flex flex-col px-3 pt-3 pb-2.5"
      )}
      data-node-id={node.id}
      style={nodeStyle(rect)}
      onClick={() => onSelect({ kind: "relay", relayId: relay.id })}
    >
      <NodeTitle
        icon={
          <NodeIcon tone="relay">
            <RelayKindIcon className="size-4" aria-hidden="true" />
          </NodeIcon>
        }
        meta={relay.address}
        metaMono
        name={
          <span className="flex items-center justify-between gap-2">
            <span className="truncate">{relay.name}</span>
            <StatusIndicator status={online} />
          </span>
        }
      />
      <RelayMeters relayId={relay.id} />
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
              <Icon className="size-3.5" aria-hidden="true" />
              {count}
            </span>
          )
        })}
        {node.proxyMode && node.proxyMode !== "hearth" ? (
          <span className="type-meta ml-auto flex min-w-0 items-center gap-1 rounded-md border border-violet-400/30 bg-violet-400/10 px-1.5 text-violet-300">
            <Router className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">Traefik</span>
          </span>
        ) : null}
      </span>
    </button>
  )
}

function RelayNode({
  node,
  onSelect,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "relay" }>
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  const { relay } = node
  const content = (
    <>
      <IdentityName
        className="min-w-0 flex-1"
        icon={<RelayKindIcon className="size-4" aria-hidden="true" />}
        iconClassName={kindTone.relay}
        meta={relay.address}
        metaClassName="font-mono"
        name={relay.name}
        nameClassName="transition-colors group-hover/node:text-primary"
        status={online}
      />
      <RelayMeters relayId={relay.id} />
    </>
  )
  const className = cn(
    nodeClass,
    "group/node flex flex-col px-3 pt-3 pb-2.5",
    node.focus ? "border-primary/45" : interactiveClass
  )
  // The scope's own Relay would open its page in Hearth; here it stays put.
  return node.focus ? (
    <div className={className} data-node-id={node.id} style={nodeStyle(rect)}>
      {content}
    </div>
  ) : (
    <button
      type="button"
      className={className}
      data-node-id={node.id}
      style={nodeStyle(rect)}
      onClick={() => onSelect({ kind: "relay", relayId: relay.id })}
    >
      {content}
    </button>
  )
}

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
        meta={`Bundled Traefik · ${node.routeCount} ${node.routeCount === 1 ? "web route" : "web routes"}`}
        name="Traefik"
      />
      {shown.length > 0 ? (
        <NodeFooter>
          <Globe2 className="size-3 shrink-0" aria-hidden="true" />
          <span className="type-meta truncate font-mono">
            {shown.join(", ")}
          </span>
        </NodeFooter>
      ) : null}
    </div>
  )
}

function ResourceNode({
  node,
  onSelect,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "resource" }>
  onSelect: SelectScope
  rect: InfraMapRect
}) {
  const { resource } = node
  const Icon = kindPresentation[resource.kind].icon
  const brick = officialBricks.find(
    (candidate) => candidate.name === resource.implementation
  )
  const card = (
    <IdentityName
      className="min-w-0 flex-1"
      icon={
        brick ? (
          <span
            className="grid size-4 place-items-center"
            style={{ color: brickColors[brick.name] }}
          >
            <BrickMark icon={brick.icon} />
          </span>
        ) : (
          <Icon className="size-4" aria-hidden="true" />
        )
      }
      iconClassName={kindTone[resource.kind]}
      meta={resource.meta}
      metaClassName="font-mono"
      name={resource.name}
      nameClassName="transition-colors group-hover/node:text-primary"
      status={stoppedResources.has(resource.id) ? stopped : running}
    />
  )
  const className = cn(
    nodeClass,
    "group/node flex items-center rounded-lg px-2.5",
    node.focus ? focusRing[resource.kind] : interactiveClass
  )
  return node.focus ? (
    <div className={className} data-node-id={node.id} style={nodeStyle(rect)}>
      {card}
    </div>
  ) : (
    <button
      type="button"
      className={className}
      data-node-id={node.id}
      style={nodeStyle(rect)}
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

function ServiceNode({
  node,
  rect,
}: {
  node: Extract<InfraMapNode, { type: "service" }>
  rect: InfraMapRect
}) {
  const { service } = node
  return (
    <div
      className={cn(nodeClass, "flex items-center rounded-lg px-2.5")}
      data-node-id={node.id}
      style={nodeStyle(rect)}
    >
      <NodeTitle
        icon={
          <NodeIcon tone="app">
            <Container className="size-4" aria-hidden="true" />
          </NodeIcon>
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
            <StatusIndicator status={running} />
          </span>
        }
      />
    </div>
  )
}

function RelayMeters({ relayId }: { relayId: string }) {
  const reading = relayReadings[relayId]
  return (
    <span className="mt-2.5 grid w-full grid-cols-3 gap-3">
      <Meter label="CPU" value={reading?.cpu ?? null} />
      <Meter label="Memory" value={reading?.memory ?? null} />
      <Meter label="Disk" value={reading?.disk ?? null} />
    </span>
  )
}

function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="block min-w-0">
      <span className="type-meta flex items-baseline justify-between gap-1 text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="font-mono tabular-nums">
          {value === null ? "—" : `${Math.round(value)}%`}
        </span>
      </span>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            value !== null && value >= 90
              ? "bg-destructive"
              : value !== null && value >= 75
                ? "bg-amber-400"
                : "bg-primary/70"
          )}
          style={{ width: `${value ?? 0}%` }}
        />
      </span>
    </span>
  )
}
