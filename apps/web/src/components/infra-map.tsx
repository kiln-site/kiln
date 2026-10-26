import * as React from "react"
import { useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"

import { engineLabel } from "@/components/database/database-presentation"
import { DataTableEmptyState } from "@/components/data-table"
import {
  MapViewport,
  type MapViewportHandle,
} from "@/components/infra-map-canvas"
import { RelayKindIcon } from "@/components/instance-kind-icon"
import {
  BackToFleet,
  EmptyCard,
  emptyCardId,
  fleetGroups,
  GroupHeadings,
  layoutFleet,
  layoutRelay,
  overviewWorldClass,
  relayGroups,
  Trunk,
  type OverviewInstance,
  type OverviewKind,
  type OverviewRelay,
  type OverviewServices,
} from "@/components/overview-map-cards"
import {
  LiveFocusRelayCard,
  LiveHearthCard,
  LiveInstanceCard,
  LiveRelayCard,
} from "@/components/overview-map-live"
import {
  AddFirstRelayButton,
  useAwaitingFirstRelay,
} from "@/components/relay/pair-first-relay"
import {
  infraAppsCollectionOptions,
  infraDatabasesCollectionOptions,
  infraServersCollectionOptions,
} from "@/lib/collections/infra-directories"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import { replaceDataTableUrlSearch } from "@/lib/data-table-search"
import type { OverviewRect } from "@/lib/overview-map-layout"
import {
  domainSettingsQueryOptions,
  hearthEdgeQueryOptions,
} from "@/lib/query-options"
import { relayAddress } from "@/lib/relay-route"

/**
 * The infrastructure overview: Hearth and every Relay, or one Relay and its
 * instances. Opening a Relay zooms into its map; its instances open their
 * own pages.
 */
type OverviewScope = { kind: "all" } | { kind: "relay"; relayId: string }

/**
 * The scope's URL form. Older links name an instance; they open its Relay.
 */
function parseScope(value: string | undefined): OverviewScope {
  const [kind, relayId] = value?.split(":") ?? []
  if (
    relayId &&
    (kind === "relay" ||
      kind === "server" ||
      kind === "app" ||
      kind === "database")
  )
    return { kind: "relay", relayId }
  return { kind: "all" }
}

function scopeKey(scope: OverviewScope) {
  return scope.kind === "all" ? "" : `relay:${scope.relayId}:${scope.relayId}`
}

export function InfraOverviewPage({
  includeDomains,
  initialScope,
}: {
  includeDomains: boolean
  initialScope: string | undefined
}) {
  // Read once: the page keeps the scope and writes the URL itself.
  const [scope, setScope] = React.useState(() => parseScope(initialScope))
  const select = React.useCallback((next: OverviewScope) => {
    setScope(next)
    replaceDataTableUrlSearch(scopeKey(next), "scope")
  }, [])
  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-2 pt-3 pb-3 sm:px-5 sm:pb-5">
      <OverviewMap
        includeDomains={includeDomains}
        scope={scope}
        onSelect={select}
      />
    </div>
  )
}

const OverviewMap = React.memo(function OverviewMap({
  includeDomains,
  onSelect,
  scope,
}: {
  includeDomains: boolean
  onSelect: (scope: OverviewScope) => void
  scope: OverviewScope
}) {
  const directory = useDirectory()
  const { data: hearthEdge } = useSuspenseQuery(hearthEdgeQueryOptions())
  const relays = React.useMemo(() => overviewRelays(directory), [directory])
  const instances = React.useMemo(
    () => overviewInstances(directory),
    [directory]
  )
  const services = useServices(includeDomains, instances)
  const focus =
    scope.kind === "relay"
      ? relays.find((relay) => relay.id === scope.relayId)
      : undefined

  // One viewport for both maps, so opening a Relay or going back carries
  // its zoom from one map into the next.
  const viewport = React.useRef<MapViewportHandle>(null)
  const open = React.useCallback(
    (relayId: string, rect: OverviewRect) =>
      viewport.current
        ? viewport.current.leave(rect, () =>
            onSelect({ kind: "relay", relayId })
          )
        : onSelect({ kind: "relay", relayId }),
    [onSelect]
  )
  const back = React.useCallback(
    () =>
      viewport.current
        ? viewport.current.leave(null, () => onSelect({ kind: "all" }))
        : onSelect({ kind: "all" }),
    [onSelect]
  )
  React.useEffect(() => {
    if (!focus) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) back()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [back, focus])

  // Wide screens read left to right; phones scroll down.
  const direction = useIsMobile() ? "down" : "right"
  const fleet = useFleetView(focus ? null : relays, instances, direction)
  const relayView = useRelayView(focus ?? null, instances, direction)

  if (relays.length === 0) return <EmptyOverview />
  const layout = relayView?.layout ?? fleet!.layout
  return (
    <MapViewport
      controller={viewport}
      fitKey={`${focus ? `relay:${focus.id}` : "all"}:${direction}`}
      width={layout.width}
      height={layout.height}
      overlay={focus ? <BackToFleet name={focus.name} onBack={back} /> : null}
    >
      {relayView && focus ? (
        <RelayContent
          key={focus.id}
          relay={focus}
          services={services}
          view={relayView}
        />
      ) : (
        <FleetContent
          hearth={hearthEdge}
          relays={relays}
          services={services}
          view={fleet!}
          onOpen={open}
        />
      )}
    </MapViewport>
  )
})

type FleetView = NonNullable<ReturnType<typeof useFleetView>>

function useFleetView(
  relays: ReadonlyArray<OverviewRelay> | null,
  instances: ReadonlyArray<OverviewInstance>,
  direction: "right" | "down"
) {
  const counts = React.useMemo(() => countByRelay(instances), [instances])
  const groups = React.useMemo(
    () => (relays ? fleetGroups(relays) : null),
    [relays]
  )
  return React.useMemo(
    () => groups && { counts, groups, layout: layoutFleet(groups, direction) },
    [counts, direction, groups]
  )
}

const FleetContent = React.memo(function FleetContent({
  hearth,
  onOpen,
  relays,
  services,
  view,
}: {
  hearth: { host: string; provider: "cloudflare" | "vercel" | null }
  onOpen: (relayId: string, rect: OverviewRect) => void
  relays: ReadonlyArray<OverviewRelay>
  services: ServiceIndex
  view: FleetView
}) {
  const { counts, groups, layout } = view
  return (
    <div className={overviewWorldClass}>
      <Trunk path={layout.trunk} />
      <LiveHearthCard
        host={hearth.host}
        provider={hearth.provider}
        rect={layout.root}
        relays={relays}
      />
      <GroupHeadings groups={groups} layout={layout} />
      {groups.flatMap((group) =>
        group.relays.map((relay) => (
          <LiveRelayCard
            key={relay.id}
            counts={counts.get(relay.id) ?? noCounts}
            rect={layout.cards.get(relay.id)!}
            relay={relay}
            services={services.relays.get(relay.id)}
            wire={layout.wires.get(relay.id)}
            onOpen={onOpen}
          />
        ))
      )}
    </div>
  )
})

type RelayView = NonNullable<ReturnType<typeof useRelayView>>

function useRelayView(
  relay: OverviewRelay | null,
  instances: ReadonlyArray<OverviewInstance>,
  direction: "right" | "down"
) {
  const relayId = relay?.id ?? null
  const groups = React.useMemo(
    () => (relayId ? relayGroups(instances, relayId) : null),
    [instances, relayId]
  )
  return React.useMemo(
    () => groups && { groups, layout: layoutRelay(groups, direction) },
    [direction, groups]
  )
}

const RelayContent = React.memo(function RelayContent({
  relay,
  services,
  view,
}: {
  relay: OverviewRelay
  services: ServiceIndex
  view: RelayView
}) {
  const { groups, layout } = view
  const empty = layout.cards.get(emptyCardId)
  return (
    <div className={overviewWorldClass}>
      <Trunk path={layout.trunk} />
      <LiveFocusRelayCard
        rect={layout.root}
        relay={relay}
        services={services.relays.get(relay.id)}
      />
      {empty ? (
        <EmptyCard rect={empty}>No instances on this Relay yet.</EmptyCard>
      ) : (
        <>
          <GroupHeadings groups={groups} layout={layout} />
          {groups.flatMap((group) =>
            group.instances.map((instance) => (
              <LiveInstanceCard
                key={instance.key}
                instance={instance}
                rect={layout.cards.get(instance.key)!}
                services={services.instances.get(instance.key)}
                wire={layout.wires.get(instance.key)}
              />
            ))
          )}
        </>
      )}
    </div>
  )
})

function EmptyOverview() {
  const awaitingFirstRelay = useAwaitingFirstRelay()
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center border border-border/75 bg-card/25">
      <DataTableEmptyState
        action={awaitingFirstRelay ? <AddFirstRelayButton /> : null}
        description={
          <span className="block max-w-sm">
            {awaitingFirstRelay
              ? "Pair a Relay to see its game servers, databases, and apps mapped here."
              : "No instances have been assigned to your account yet."}
          </span>
        }
        icon={<RelayKindIcon className="size-6" />}
        title="Nothing to map yet"
      />
    </div>
  )
}

function useDirectory() {
  const { data: relays } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .orderBy(({ relay }) => relay.name)
        .orderBy(({ relay }) => relay.createdAt)
        .select(({ relay }) => ({
          controlDial: relay.controlDial,
          enabled: relay.enabled,
          hostname: relay.hostname,
          id: relay.id,
          lastConnectedAt: relay.lastConnectedAt,
          lastError: relay.lastError,
          name: relay.name,
          port: relay.port,
          useTls: relay.useTls,
        })),
  })
  const { data: servers } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ server: infraServersCollectionOptions })
        .orderBy(({ server }) => server.name),
  })
  const { data: apps } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ app: infraAppsCollectionOptions })
        .orderBy(({ app }) => app.name),
  })
  const { data: databases } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ database: infraDatabasesCollectionOptions })
        .orderBy(({ database }) => database.name),
  })
  return React.useMemo(
    () => ({ relays, servers, apps, databases }),
    [relays, servers, apps, databases]
  )
}

type Directory = ReturnType<typeof useDirectory>

/**
 * Every Relay the user can read, then any they can't but hold instances
 * they can, drawn with only their name.
 */
function overviewRelays(directory: Directory): Array<OverviewRelay> {
  const readable = directory.relays.map((relay): OverviewRelay => ({
    id: relay.id,
    name: relay.name,
    enabled: relay.enabled,
    lastError: relay.lastError,
    lastConnectedAt: relay.lastConnectedAt,
    controlDial: relay.controlDial,
    address: relayAddress(relay),
  }))
  const known = new Set(readable.map((relay) => relay.id))
  const shared = new Map<string, OverviewRelay>()
  for (const entry of [
    ...directory.servers,
    ...directory.apps,
    ...directory.databases,
  ]) {
    if (known.has(entry.relayId) || shared.has(entry.relayId)) continue
    shared.set(entry.relayId, {
      id: entry.relayId,
      name: entry.relayName,
      enabled: true,
      lastError: null,
      lastConnectedAt: null,
      controlDial: "hearth",
      address: "",
      restricted: true,
    })
  }
  return [
    ...readable,
    ...[...shared.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ]
}

function overviewInstances(directory: Directory): Array<OverviewInstance> {
  return [
    ...directory.servers.map((server): OverviewInstance => ({
      key: instanceKey("server", server.relayId, server.id),
      kind: "server",
      id: server.id,
      relayId: server.relayId,
      name: server.name,
      meta: server.connectAddress || server.game,
      routeId: server.routeId,
      tailscale: server.tailscale,
    })),
    ...directory.apps.map((app): OverviewInstance => ({
      key: instanceKey("app", app.relayId, app.id),
      kind: "app",
      id: app.id,
      relayId: app.relayId,
      name: app.name,
      meta: app.shortId,
      routeId: app.id,
    })),
    ...directory.databases.map((database): OverviewInstance => ({
      key: instanceKey("database", database.relayId, database.id),
      kind: "database",
      id: database.id,
      relayId: database.relayId,
      name: database.name,
      meta: `${engineLabel(database.engine)} · ${database.shortId}`,
      routeId: database.id,
    })),
  ]
}

function instanceKey(kind: OverviewKind, relayId: string, id: string) {
  return `${kind}:${relayId}:${id}`
}

const noCounts: Record<OverviewKind, number> = {
  server: 0,
  app: 0,
  database: 0,
}

function countByRelay(instances: ReadonlyArray<OverviewInstance>) {
  const counts = new Map<string, Record<OverviewKind, number>>()
  for (const instance of instances) {
    const relayCounts = counts.get(instance.relayId) ?? {
      server: 0,
      app: 0,
      database: 0,
    }
    relayCounts[instance.kind] += 1
    counts.set(instance.relayId, relayCounts)
  }
  return counts
}

interface ServiceIndex {
  relays: ReadonlyMap<string, OverviewServices>
  instances: ReadonlyMap<string, OverviewServices>
}

const noServices: ServiceIndex = { relays: new Map(), instances: new Map() }

/**
 * Which Relays and instances use Cloudflare (a managed domain) or Tailscale
 * (a game server on a tailnet). People without the Domains page see only
 * Tailscale. The map never waits for them: the logos appear once the domains
 * arrive.
 */
function useServices(
  includeDomains: boolean,
  instances: ReadonlyArray<OverviewInstance>
): ServiceIndex {
  const { data: domains } = useQuery({
    ...domainSettingsQueryOptions(),
    enabled: includeDomains,
    select: selectDomainAssignments,
  })
  return React.useMemo(() => {
    const relays = new Map<string, OverviewServices>()
    const marked = new Map<string, OverviewServices>()
    const mark = (
      relayId: string,
      key: string,
      service: keyof OverviewServices
    ) => {
      relays.set(relayId, {
        ...(relays.get(relayId) ?? noService),
        [service]: true,
      })
      marked.set(key, { ...(marked.get(key) ?? noService), [service]: true })
    }
    // A managed domain names a game server.
    for (const domain of domains ?? [])
      mark(
        domain.relayId,
        instanceKey("server", domain.relayId, domain.instanceId),
        "cloudflare"
      )
    for (const instance of instances)
      if (instance.tailscale) mark(instance.relayId, instance.key, "tailscale")
    return relays.size === 0 ? noServices : { relays, instances: marked }
  }, [domains, instances])
}

const noService: OverviewServices = { cloudflare: false, tailscale: false }

function selectDomainAssignments(settings: {
  managedDomains: ReadonlyArray<{ relayId: string; instanceId: string }>
}) {
  return settings.managedDomains
}
