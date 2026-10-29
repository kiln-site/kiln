import * as React from "react"
import { ArrowLeft, Globe2, ShieldCheck, Triangle, Users } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { CloudflareLogo, TailscaleLogo } from "@/components/brand-logos"
import { HearthMark } from "@/components/hearth-mark"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { nodeStyle } from "@/components/infra-map-canvas"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import { StatusIndicator } from "@/components/status-indicator"
import {
  layoutOverviewMap,
  type OverviewLayout,
  type OverviewRect,
} from "@/lib/overview-map-layout"

// The overview map's cards, drawn from what they're given: status, readings
// and flags arrive as props. Hearth feeds them live (overview-map-live.tsx);
// the marketing site's demo feeds them a made-up fleet.

export type OverviewKind = "server" | "app" | "database"

export interface OverviewRelay {
  id: string
  name: string
  enabled: boolean
  lastError: string | null
  lastConnectedAt: string | null
  /** Which side opens the control connection. */
  controlDial: "hearth" | "relay"
  address: string
  /**
   * Shown because the user can read an instance on it, not the Relay
   * itself, so it draws with only its name.
   */
  restricted?: boolean
}

export interface OverviewInstance {
  key: string
  kind: OverviewKind
  id: string
  relayId: string
  name: string
  meta: string
  routeId: string
  /** A game server on a tailnet. */
  tailscale?: boolean
}

/** What a Relay or instance leans on outside Kiln, shown as logos. */
export interface OverviewServices {
  cloudflare: boolean
  tailscale: boolean
}

/** A Relay's machine, in percent of each. */
export interface OverviewReadings {
  cpu: number | null
  memory: number | null
  disk: number | null
}

export interface OverviewHeading {
  icon: React.ReactNode
  title: string
  sub?: string
}

export const overviewCardSizes = {
  hearth: { width: 264, height: 96 },
  relay: { width: 320, height: 100 },
  focus: { width: 296, height: 132 },
  instance: { width: 320, height: 64 },
  empty: { width: 320, height: 64 },
} as const

export const kindPresentation: Record<
  OverviewKind,
  { icon: typeof ServerKindIcon; one: string; other: string; label: string }
> = {
  server: {
    icon: ServerKindIcon,
    one: "game server",
    other: "game servers",
    label: "Game servers",
  },
  app: { icon: AppKindIcon, one: "App", other: "Apps", label: "Apps" },
  database: {
    icon: DatabaseKindIcon,
    one: "database",
    other: "databases",
    label: "Databases",
  },
}

export const overviewKinds: ReadonlyArray<OverviewKind> = [
  "server",
  "app",
  "database",
]

/**
 * The fleet's Relays in groups, by whether Hearth can reach the Relay, not
 * by whether what runs on it is public: a Relay with no public address can
 * still serve sites through Cloudflare.
 */
export function fleetGroups(relays: ReadonlyArray<OverviewRelay>) {
  const open = relays.filter(
    (relay) => !relay.restricted && relay.controlDial === "hearth"
  )
  const closed = relays.filter(
    (relay) => !relay.restricted && relay.controlDial === "relay"
  )
  const shared = relays.filter((relay) => relay.restricted)
  return [
    {
      id: "open",
      relays: open,
      count: open.length,
      heading: {
        icon: <Globe2 aria-hidden="true" />,
        title: "Public address",
        sub: "Hearth connects to them at their address.",
      },
    },
    {
      id: "closed",
      relays: closed,
      count: closed.length,
      heading: {
        icon: <ShieldCheck aria-hidden="true" />,
        title: "No public address",
        sub: "They connect out to Hearth instead.",
      },
    },
    {
      id: "shared",
      relays: shared,
      count: shared.length,
      heading: {
        icon: <Users aria-hidden="true" />,
        title: "Shared with you",
        sub: "You can see instances on these Relays.",
      },
    },
  ]
}

export type FleetGroups = ReturnType<typeof fleetGroups>

export function layoutFleet(
  groups: FleetGroups,
  direction: "right" | "down"
): OverviewLayout {
  return layoutOverviewMap({
    direction,
    root: overviewCardSizes.hearth,
    cardWidth: overviewCardSizes.relay.width,
    groups: groups.map((group) => ({
      id: group.id,
      cards: group.relays.map((relay) => ({
        id: relay.id,
        height: overviewCardSizes.relay.height,
      })),
    })),
  })
}

/** A Relay's instances, a group for each kind. */
export function relayGroups(
  instances: ReadonlyArray<OverviewInstance>,
  relayId: string
) {
  const own = instances.filter((instance) => instance.relayId === relayId)
  return overviewKinds.map((kind) => {
    const { icon: Icon, label } = kindPresentation[kind]
    const list = own.filter((instance) => instance.kind === kind)
    return {
      id: kind,
      instances: list,
      count: list.length,
      heading: { icon: <Icon aria-hidden="true" />, title: label },
    }
  })
}

export type RelayGroups = ReturnType<typeof relayGroups>

/** An empty Relay's map holds one card that says so. */
export const emptyCardId = "empty"

export function layoutRelay(
  groups: RelayGroups,
  direction: "right" | "down"
): OverviewLayout {
  const empty = groups.every((group) => group.count === 0)
  return layoutOverviewMap({
    direction,
    root: overviewCardSizes.focus,
    cardWidth: overviewCardSizes.instance.width,
    groups: empty
      ? [
          {
            id: emptyCardId,
            cards: [
              { id: emptyCardId, height: overviewCardSizes.empty.height },
            ],
          },
        ]
      : groups.map((group) => ({
          id: group.id,
          cards: group.instances.map((instance) => ({
            id: instance.key,
            height: overviewCardSizes.instance.height,
          })),
        })),
  })
}

const iconTone = {
  kiln: "border-primary/35 bg-primary/10 text-primary-ink",
  relay: "border-orange-400/35 bg-orange-400/10 light:bg-orange-400/20",
  server: "border-emerald-400/35 bg-emerald-400/10 light:bg-emerald-400/20",
  app: "border-red-400/35 bg-red-400/10 light:bg-red-400/20",
  database: "border-blue-400/35 bg-blue-400/10 light:bg-blue-400/20",
} as const

// A wire takes the colour of the status of the card it reaches, in the
// same tones as the status dots.
const wireTone: Record<IdentityStatusPresentation["tone"], string> = {
  success: "text-emerald-400",
  info: "text-sky-400",
  warning: "text-amber-400",
  danger: "text-destructive",
  neutral: "text-muted-foreground/45",
}

const cardClass =
  "absolute border border-border/80 bg-card text-left outline-none transition-[border-color,background-color,opacity] duration-150"
const interactiveClass =
  "cursor-pointer hover:border-muted-foreground/50 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40"

/** Hovering one entry fades the rest; each entry is a wire and its card. */
export const overviewWorldClass =
  "contents [&:has([data-entry]:hover)_[data-entry]:not(:hover)>*]:opacity-35"

/** A card and the wire that reaches it, which fade together. */
export function Entry({
  children,
  status,
  wire,
}: {
  children: React.ReactNode
  status: IdentityStatusPresentation | null
  wire: string | undefined
}) {
  return (
    <div data-entry="" className="contents">
      <Wire path={wire} status={status} />
      {children}
    </div>
  )
}

function Wire({
  path,
  status,
}: {
  path: string | undefined
  status: IdentityStatusPresentation | null
}) {
  if (!path) return null
  return (
    <svg
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-0 left-0 overflow-visible transition-opacity duration-150",
        wireTone[status?.tone ?? "neutral"]
      )}
      width={1}
      height={1}
      fill="none"
    >
      <path
        d={path}
        className="stroke-[color-mix(in_oklab,var(--muted-foreground)_22%,var(--background))]"
        strokeWidth={1.25}
      />
      <path
        d={path}
        className={cn("stroke-current", status?.pulse && "animate-pulse")}
        strokeDasharray="0.1 6"
        strokeLinecap="round"
        strokeWidth={2}
      />
    </svg>
  )
}

/** The shared line a phone's wires branch from. */
export function Trunk({ path }: { path: string | null }) {
  if (!path) return null
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 overflow-visible"
      width={1}
      height={1}
      fill="none"
    >
      <path
        d={path}
        className="stroke-[color-mix(in_oklab,var(--muted-foreground)_30%,var(--background))]"
        strokeWidth={1.25}
      />
    </svg>
  )
}

/** Each group's title above its cards, with how many it holds. */
export function GroupHeadings({
  groups,
  layout,
}: {
  groups: ReadonlyArray<{ id: string; count: number; heading: OverviewHeading }>
  layout: OverviewLayout
}) {
  return groups.map((group) => {
    const rect = layout.headings.get(group.id)
    if (!rect) return null
    const { icon, sub, title } = group.heading
    return (
      <div
        key={group.id}
        className="absolute grid grid-cols-[auto_1fr_auto] content-center items-center gap-x-2 gap-y-0.5"
        style={nodeStyle(rect)}
      >
        <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        <span className="type-label truncate text-foreground">{title}</span>
        <span className="type-meta text-muted-foreground tabular-nums">
          {group.count}
        </span>
        {sub ? (
          <span className="type-meta col-start-2 col-end-4 truncate text-muted-foreground">
            {sub}
          </span>
        ) : null}
      </div>
    )
  })
}

function IconBox({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: keyof typeof iconTone
}) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center border",
        iconTone[tone]
      )}
    >
      {children}
    </span>
  )
}

function Title({
  meta,
  metaMono = true,
  name,
}: {
  meta: React.ReactNode
  metaMono?: boolean
  name: React.ReactNode
}) {
  return (
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
  )
}

/** Cloudflare and Tailscale logos, when something uses them. */
function ServiceMarks({
  services,
}: {
  services: OverviewServices | undefined
}) {
  if (!services?.cloudflare && !services?.tailscale) return null
  return (
    <span className="flex items-center gap-2">
      {services.cloudflare ? (
        <Mark label="Cloudflare">
          <CloudflareLogo className="size-3.5 text-[#f38020]" />
        </Mark>
      ) : null}
      {services.tailscale ? (
        <Mark label="Tailscale">
          <TailscaleLogo className="size-3 text-foreground/85" />
        </Mark>
      ) : null}
    </span>
  )
}

function Mark({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={label} className="inline-flex" role="img">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

/** Status above, logos below, on the card's right. */
function Side({
  services,
  status,
}: {
  services: OverviewServices | undefined
  status: IdentityStatusPresentation | null
}) {
  return (
    <span className="flex shrink-0 flex-col items-end gap-1.5 self-start">
      {status ? <StatusIndicator status={status} /> : null}
      <ServiceMarks services={services} />
    </span>
  )
}

function relayMeta(relay: OverviewRelay) {
  if (relay.restricted) return "Shared with you"
  if (relay.controlDial === "relay")
    return (
      <span className="flex items-center gap-1 font-sans">
        <ShieldCheck className="size-3 shrink-0" aria-hidden="true" />
        No open ports
      </span>
    )
  return relay.address
}

/** Hearth on the left of the fleet, with a dot for each Relay's status. */
export function HearthCard({
  children,
  host,
  provider,
  rect,
  relayCount,
}: {
  /** The Relays' status dots. */
  children: React.ReactNode
  host: string
  provider: "cloudflare" | "vercel" | null
  rect: OverviewRect
  relayCount: number
}) {
  return (
    <div
      className={cn(cardClass, "flex flex-col border-primary/45 p-3")}
      style={nodeStyle(rect)}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <IconBox tone="kiln">
          <HearthMark className="size-4" />
        </IconBox>
        <Title meta={host} name="Hearth" />
        {provider === "cloudflare" ? (
          <Mark label="Behind Cloudflare">
            <span className="grid size-6 place-items-center border border-orange-400/35 bg-orange-400/5">
              <CloudflareLogo className="size-4 text-[#f38020]" />
            </span>
          </Mark>
        ) : provider === "vercel" ? (
          <Mark label="Behind Vercel">
            <span className="grid size-6 place-items-center border border-border">
              <Triangle className="size-3" aria-hidden="true" />
            </span>
          </Mark>
        ) : null}
      </span>
      <span className="mt-auto flex items-center gap-2 border-t border-border/60 pt-2.5">
        <span className="flex flex-wrap items-center gap-1">{children}</span>
        <span className="type-meta ml-auto text-muted-foreground tabular-nums">
          {relayCount} {relayCount === 1 ? "Relay" : "Relays"}
        </span>
      </span>
    </div>
  )
}

const dotTone: Record<IdentityStatusPresentation["tone"], string> = {
  success: "bg-emerald-400",
  info: "bg-sky-400",
  warning: "bg-amber-400",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/50",
}

export function StatusDot({
  name,
  status,
}: {
  name: string
  status: IdentityStatusPresentation
}) {
  return (
    <span
      aria-label={`${name}: ${status.label}`}
      title={`${name}: ${status.label}`}
      className={cn(
        "size-1.5 rounded-full",
        dotTone[status.tone],
        status.pulse && "animate-pulse"
      )}
    />
  )
}

function Counts({ counts }: { counts: Record<OverviewKind, number> }) {
  const total = counts.server + counts.app + counts.database
  if (total === 0)
    return (
      <span className="type-meta text-muted-foreground">No instances yet</span>
    )
  return overviewKinds.map((kind) => {
    const { icon: Icon, one, other } = kindPresentation[kind]
    const count = counts[kind]
    return (
      <span
        key={kind}
        className={cn(
          "type-meta flex items-center gap-1 tabular-nums",
          count === 0
            ? "text-muted-foreground/70 [&_svg]:opacity-45"
            : "text-foreground"
        )}
        title={`${count} ${count === 1 ? one : other}`}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {count}
      </span>
    )
  })
}

/**
 * A Relay in the fleet. Opening it zooms into its own map. A Relay the user
 * can't read has no status, logos or flag.
 */
export function RelayCard({
  counts,
  flag,
  onOpen,
  rect,
  relay,
  services,
  status,
  wire,
}: {
  counts: Record<OverviewKind, number>
  /** Shown only when something needs attention. */
  flag?: React.ReactNode
  onOpen: (relayId: string, rect: OverviewRect) => void
  rect: OverviewRect
  relay: OverviewRelay
  services: OverviewServices | undefined
  status: IdentityStatusPresentation | null
  wire: string | undefined
}) {
  return (
    <Entry status={status} wire={wire}>
      <button
        type="button"
        aria-label={`Open Relay ${relay.name}`}
        className={cn(
          cardClass,
          interactiveClass,
          "flex flex-col px-3 pt-3 pb-2.5",
          !relay.enabled && "border-dashed"
        )}
        style={nodeStyle(rect)}
        onClick={() => onOpen(relay.id, rect)}
      >
        <span className="flex w-full min-w-0 items-center gap-2.5">
          <IconBox tone="relay">
            <RelayKindIcon className="size-4" aria-hidden="true" />
          </IconBox>
          <Title
            meta={relayMeta(relay)}
            metaMono={!relay.restricted}
            name={relay.name}
          />
          {relay.restricted ? null : (
            <Side services={services} status={status} />
          )}
        </span>
        <span className="mt-auto flex w-full items-center gap-3 border-t border-border/60 pt-2">
          <Counts counts={counts} />
          {flag}
        </span>
      </button>
    </Entry>
  )
}

const flagTone = {
  danger:
    "border-destructive/30 bg-destructive/10 text-red-300 light:text-red-700",
  warning:
    "border-amber-400/30 bg-amber-400/10 text-amber-300 light:text-amber-700",
} as const

export function Flag({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: keyof typeof flagTone
}) {
  return (
    <span
      className={cn(
        "type-meta ml-auto flex min-w-0 items-center gap-1 border px-1.5 whitespace-nowrap",
        flagTone[tone]
      )}
    >
      {children}
    </span>
  )
}

export const usageLimit = 90

/** The fullest of a machine's readings at or past the limit, if any. */
export function usageWarning(readings: OverviewReadings): string | null {
  let worst: readonly [string, number] | null = null
  for (const [label, percent] of [
    ["CPU", readings.cpu],
    ["Memory", readings.memory],
    ["Disk", readings.disk],
  ] as const)
    if (
      percent !== null &&
      percent >= usageLimit &&
      (!worst || percent > worst[1])
    )
      worst = [label, percent]
  return worst ? `${worst[0]} ${Math.round(worst[1])}%` : null
}

export const focusCardClass = cn(
  cardClass,
  interactiveClass,
  "group/focus flex flex-col border-orange-400/45 px-3 pt-3 pb-2.5 data-[paused]:border-dashed"
)

/**
 * The Relay a Relay map is about, on its left: what's inside the card. The
 * caller draws the card itself, as a link to the Relay's page or not.
 */
export function FocusRelayContent({
  readings,
  relay,
  services,
  status,
}: {
  readings: OverviewReadings | null
  relay: OverviewRelay
  services: OverviewServices | undefined
  status: IdentityStatusPresentation
}) {
  return (
    <>
      <span className="flex w-full min-w-0 items-center gap-2.5">
        <IconBox tone="relay">
          <RelayKindIcon className="size-4" aria-hidden="true" />
        </IconBox>
        <Title
          meta={relayMeta(relay)}
          name={
            <span className="transition-colors group-hover/focus:text-primary-ink">
              {relay.name}
            </span>
          }
        />
        <Side services={services} status={status} />
      </span>
      <span className="mt-auto grid w-full grid-cols-3 gap-3 border-t border-border/60 pt-2.5">
        <Meter label="CPU" value={readings?.cpu ?? null} />
        <Meter label="Memory" value={readings?.memory ?? null} />
        <Meter label="Disk" value={readings?.disk ?? null} />
      </span>
    </>
  )
}

/** A Relay the user can't read, as the subject of its own map. */
export function RestrictedFocusRelayCard({
  rect,
  relay,
}: {
  rect: OverviewRect
  relay: OverviewRelay
}) {
  return (
    <div
      className={cn(
        cardClass,
        "flex flex-col justify-center border-orange-400/45 p-3"
      )}
      style={nodeStyle(rect)}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <IconBox tone="relay">
          <RelayKindIcon className="size-4" aria-hidden="true" />
        </IconBox>
        <Title
          meta="You can't view this Relay"
          metaMono={false}
          name={relay.name}
        />
      </span>
    </div>
  )
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
      <span className="mt-1 block h-1 overflow-hidden bg-muted">
        <span
          className={cn(
            "block h-full",
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

export const instanceCardClass = cn(
  cardClass,
  interactiveClass,
  "group/instance flex items-center gap-2.5 px-3"
)

/**
 * A game server, app or database on the Relay in view: what's inside the
 * card. The caller draws the card, as a link to its page or not.
 */
export function InstanceContent({
  instance,
  services,
  status,
}: {
  instance: OverviewInstance
  services: OverviewServices | undefined
  status: IdentityStatusPresentation
}) {
  const { icon: Icon } = kindPresentation[instance.kind]
  return (
    <>
      <IconBox tone={instance.kind}>
        <Icon className="size-4" aria-hidden="true" />
      </IconBox>
      <Title
        meta={instance.meta}
        name={
          <span className="transition-colors group-hover/instance:text-primary-ink">
            {instance.name}
          </span>
        }
      />
      <Side services={services} status={status} />
    </>
  )
}

export function EmptyCard({
  children,
  rect,
}: {
  children: React.ReactNode
  rect: OverviewRect
}) {
  return (
    <div
      className={cn(
        cardClass,
        "type-meta flex items-center border-dashed px-3 text-muted-foreground"
      )}
      style={nodeStyle(rect)}
    >
      {children}
    </div>
  )
}

/** Over a Relay's map: back to the fleet, and which Relay this is. */
export function BackToFleet({
  name,
  onBack,
}: {
  name: string
  onBack: () => void
}) {
  return (
    <nav
      aria-label="Map"
      className="type-meta flex h-8 items-center border border-border/80 bg-card shadow-sm"
    >
      <button
        type="button"
        className="flex h-full items-center gap-1.5 px-2.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        onClick={onBack}
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        All Relays
      </button>
      <span className="h-4 w-px bg-border" aria-hidden="true" />
      <span className="flex items-center gap-1.5 px-2.5 text-foreground">
        <RelayKindIcon className="size-3.5" aria-hidden="true" />
        {name}
      </span>
    </nav>
  )
}
