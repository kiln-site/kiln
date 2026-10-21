import * as React from "react"
import {
  ArrowLeftRight,
  CloudDownload,
  FolderGit2,
  Globe2,
  Layers,
  LayoutDashboard,
  Rocket,
  Waypoints,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { MapLinks, MapViewport } from "@/components/infra-map-canvas"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import {
  buildInfraMapView,
  infraMapScopeKey,
  type InfraMapScope,
} from "@/lib/infra-map-model"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"

import { demoFleet } from "~/components/demos/overview-data"
import {
  MapGroup,
  MapNode,
  type SelectScope,
} from "~/components/demos/overview-nodes"

const tabs = [
  { icon: LayoutDashboard, label: "Overview" },
  { icon: RelayKindIcon, label: "Relays", divider: true },
  { icon: DatabaseKindIcon, label: "Databases" },
  { icon: ServerKindIcon, label: "Game Servers" },
  { icon: AppKindIcon, label: "Apps" },
  { icon: Waypoints, label: "Tailscale", divider: true },
  { icon: Globe2, label: "Domains" },
  { icon: FolderGit2, label: "Sources" },
  { icon: Rocket, label: "Deployments" },
]

const kindIcons = {
  app: AppKindIcon,
  database: DatabaseKindIcon,
  relay: RelayKindIcon,
  server: ServerKindIcon,
}

// Hearth's infrastructure overview for a small fleet: Hearth, each Relay,
// and what runs on it. Choosing a Relay or an instance scopes the map, as it
// does in Hearth.
export default function OverviewDemo() {
  const [scope, setScope] = React.useState<InfraMapScope>({ kind: "all" })
  const frameRef = React.useRef<HTMLDivElement>(null)
  // The fleet stays left to right even when narrow: down, Hearth sets its
  // Relays side by side, too small to read in a phone-sized window.
  const narrow = useNarrow(frameRef)
  const direction = narrow && scope.kind !== "all" ? "down" : "right"
  const view = React.useMemo(
    () => buildInfraMapView(demoFleet, scope, direction),
    [direction, scope]
  )
  const { layout } = view

  // Hearth's map pans on every wheel event. On this page a plain scroll
  // should move the page, so only a pinch (ctrl + wheel) reaches the map.
  React.useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const passScroll = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation()
    }
    frame.addEventListener("wheel", passScroll, { capture: true })
    return () => frame.removeEventListener("wheel", passScroll, true)
  }, [])

  return (
    <TooltipProvider delayDuration={250}>
      <div className="@container/window flex h-[34rem] flex-col overflow-hidden border border-border bg-background text-left shadow-2xl shadow-black/40 sm:h-[44rem]">
        <header className="flex shrink-0 items-center gap-3 border-b bg-background/90 px-4 py-3 sm:px-5 @[64rem]/window:min-h-20">
          <p className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="type-page-title shrink-0 text-foreground">
              Infrastructure
            </span>
            <span className="truncate text-sm font-medium text-muted-foreground sm:text-base">
              <span className="text-border">/ </span>
              Overview
            </span>
          </p>
          <span
            inert
            className="hidden h-9 items-center gap-1.5 border border-border bg-card px-3 text-xs opacity-40 @[40rem]/window:flex"
          >
            <CloudDownload className="size-4" />
            Updates
          </span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-3 sm:px-5 sm:pb-5">
          <nav
            aria-label="Infrastructure sections"
            className="mb-4 no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b"
          >
            {tabs.map((tab) => (
              <React.Fragment key={tab.label}>
                {tab.divider ? (
                  <span
                    aria-hidden
                    className="mx-1 h-4 w-px shrink-0 self-center bg-border"
                  />
                ) : null}
                <span
                  inert={tab.label !== "Overview"}
                  className={cn(
                    "relative flex h-10 shrink-0 items-center gap-2 px-3 text-xs font-medium text-muted-foreground",
                    tab.label === "Overview"
                      ? "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"
                      : "opacity-40"
                  )}
                >
                  <tab.icon className="size-3.5" />
                  {tab.label}
                </span>
              </React.Fragment>
            ))}
          </nav>
          <ScopeCard scope={scope} onSelect={setScope} />
          <div
            ref={frameRef}
            className="flex min-h-0 flex-1 flex-col [&_[role=region]]:touch-pan-y"
          >
            <MapViewport
              fitKey={`${infraMapScopeKey(scope)}:${direction}`}
              width={layout.width}
              height={layout.height}
            >
              {layout.groups.map((group) => {
                const label = view.groupLabels.get(group.id)
                return group.labelled && label ? (
                  <MapGroup
                    key={group.id}
                    label={label}
                    rect={group.rect}
                    onSelect={setScope}
                  />
                ) : null
              })}
              <MapLinks layout={layout} />
              {[...layout.nodes].map(([id, rect]) => (
                <MapNode
                  key={id}
                  node={view.nodes.get(id)!}
                  rect={rect}
                  onSelect={setScope}
                />
              ))}
            </MapViewport>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

// Whether the map is phone-sized, where Hearth draws it top to bottom.
function useNarrow(ref: React.RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = React.useState(false)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setNarrow((entry?.contentRect.width ?? 0) < 640)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

function ScopeCard({
  onSelect,
  scope,
}: {
  onSelect: SelectScope
  scope: InfraMapScope
}) {
  const [open, setOpen] = React.useState(false)
  const selected =
    scope.kind === "all"
      ? null
      : scope.kind === "relay"
        ? demoFleet.relays.find((relay) => relay.id === scope.relayId)
        : demoFleet.resources.find(
            (resource) =>
              resource.kind === scope.kind && resource.id === scope.id
          )
  const Icon = scope.kind === "all" ? Layers : kindIcons[scope.kind]
  const relayName =
    scope.kind === "all"
      ? "All Relays"
      : scope.kind === "relay"
        ? "Relay"
        : (demoFleet.relays.find((relay) => relay.id === scope.relayId)?.name ??
          "")

  function choose(next: InfraMapScope) {
    onSelect(next)
    setOpen(false)
  }

  return (
    <div className="mb-3 shrink-0">
      <WorkspaceSummaryCard
        className="flex-row items-center gap-3 p-3 sm:p-4"
        action={
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
              >
                <ArrowLeftRight />
                <span className="hidden @[32rem]/window:inline">
                  {selected ? "Change scope" : "Choose scope"}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="max-h-80 w-64 overflow-y-auto p-1"
            >
              <ScopeOption
                icon={Layers}
                label="All instances"
                active={scope.kind === "all"}
                onClick={() => choose({ kind: "all" })}
              />
              <p className="type-technical-label px-2 pt-2.5 pb-1 text-muted-foreground">
                Relays
              </p>
              {demoFleet.relays.map((relay) => (
                <ScopeOption
                  key={relay.id}
                  icon={RelayKindIcon}
                  label={relay.name}
                  active={scope.kind === "relay" && scope.relayId === relay.id}
                  onClick={() => choose({ kind: "relay", relayId: relay.id })}
                />
              ))}
              <p className="type-technical-label px-2 pt-2.5 pb-1 text-muted-foreground">
                Instances
              </p>
              {demoFleet.resources.map((resource) => (
                <ScopeOption
                  key={resource.key}
                  icon={kindIcons[resource.kind]}
                  label={resource.name}
                  meta={resource.relayName}
                  active={
                    scope.kind !== "all" &&
                    scope.kind !== "relay" &&
                    scope.id === resource.id
                  }
                  onClick={() =>
                    choose({
                      kind: resource.kind,
                      relayId: resource.relayId,
                      id: resource.id,
                    })
                  }
                />
              ))}
            </PopoverContent>
          </Popover>
        }
        icon={<Icon className="size-5" />}
        title={selected?.name ?? "All instances"}
        titleAccessory={
          <Badge variant="outline" className="type-meta font-mono">
            {relayName}
          </Badge>
        }
      >
        <p className="type-meta mt-1 truncate font-mono text-muted-foreground">
          {selected
            ? selected.id
            : `${demoFleet.resources.length} accessible instances`}
        </p>
      </WorkspaceSummaryCard>
    </div>
  )
}

function ScopeOption({
  active,
  icon: Icon,
  label,
  meta,
  onClick,
}: {
  active: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  meta?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-popover-accent focus-visible:bg-popover-accent focus-visible:outline-none aria-pressed:text-primary"
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? (
        <span className="type-meta shrink-0 text-muted-foreground">{meta}</span>
      ) : null}
    </button>
  )
}
