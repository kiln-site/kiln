import * as React from "react"
import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import type { InstanceInventory, RelayProxyMode } from "@workspace/contracts"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"

import { engineLabel } from "@/components/database/database-presentation"
import { MapLinks, MapViewport } from "@/components/infra-map-canvas"
import {
  MapGroup,
  MapNode,
  type SelectScope,
} from "@/components/infra-map-nodes"
import {
  ServerScopePicker,
  type ServerPickerOption,
} from "@/components/server-scope-picker"
import {
  infraAppsCollectionOptions,
  infraDatabasesCollectionOptions,
  infraServersCollectionOptions,
} from "@/lib/collections/infra-directories"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import { replaceDataTableUrlSearch } from "@/lib/data-table-search"
import {
  buildInfraMapView,
  infraMapScopeKey,
  parseInfraMapScope,
  resourceKey,
  type InfraMapData,
  type InfraMapResource,
  type InfraMapScope,
  type InfraMapService,
} from "@/lib/infra-map-model"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import {
  domainSettingsQueryOptions,
  hearthEdgeQueryOptions,
  relayProxyModesQueryOptions,
  relaySnapshotQueryOptions,
  relayWebRoutesQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { relayAddress } from "@/lib/relay-route"

type ScopeKind = "app" | "database" | "relay" | "server"
type DatabaseLinks = InfraMapData["databaseLinks"]

export function InfraOverviewPage({
  includeDomains,
  initialScope,
}: {
  includeDomains: boolean
  initialScope: string | undefined
}) {
  // Read once: the page keeps the scope and writes the URL itself.
  const [scope, setScope] = React.useState(() =>
    parseInfraMapScope(initialScope)
  )
  const select = React.useCallback<SelectScope>((next) => {
    setScope(next)
    replaceDataTableUrlSearch(infraMapScopeKey(next), "scope")
  }, [])
  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <InfraMap
        includeDomains={includeDomains}
        scope={scope}
        onSelect={select}
      />
    </div>
  )
}

const InfraMap = React.memo(function InfraMap({
  includeDomains,
  onSelect,
  scope,
}: {
  includeDomains: boolean
  onSelect: SelectScope
  scope: InfraMapScope
}) {
  const directory = useDirectory()
  const { data: hearthEdge } = useSuspenseQuery(hearthEdgeQueryOptions())
  const scopedRelayId = scope.kind === "all" ? null : scope.relayId
  const { data: domainSettings } = useQuery({
    ...domainSettingsQueryOptions(),
    enabled: includeDomains,
  })
  const { data: proxyModes } = useQuery({
    ...relayProxyModesQueryOptions(),
    select: selectProxyModes,
  })
  // Links between instances only show inside one Relay, so the fleet view
  // asks no Relay anything.
  const { data: serverDatabaseLinks } = useQuery({
    ...relaySnapshotQueryOptions(),
    enabled: scopedRelayId !== null,
    select: selectServerDatabaseLinks,
  })
  // Routes need the Relay itself to be readable.
  const routesReadable =
    scopedRelayId !== null &&
    directory.relays.some((relay) => relay.id === scopedRelayId)
  const { data: webRoutes } = useQuery({
    ...relayWebRoutesQueryOptions(scopedRelayId ?? ""),
    enabled: routesReadable,
  })
  // Only the apps the scope draws: a Relay's or a database's neighbours,
  // or the one app in view. The fleet and a game server need none.
  const scopedApps = React.useMemo(() => {
    if (scope.kind === "relay" || scope.kind === "database")
      return directory.apps.filter((app) => app.relayId === scope.relayId)
    if (scope.kind === "app")
      return directory.apps.filter(
        (app) => app.relayId === scope.relayId && app.id === scope.id
      )
    return noApps
  }, [directory.apps, scope])
  const appDetails = useAppDetails(scopedApps)

  const data = React.useMemo((): InfraMapData => {
    const integration = domainSettings?.integration?.enabled
      ? domainSettings.integration
      : null
    return {
      hearthHost: hearthEdge.host,
      provider: hearthEdge.provider,
      relays: directory.relays.map((relay) => ({
        id: relay.id,
        name: relay.name,
        enabled: relay.enabled,
        address: relayAddress(relay),
        nodeArch: relay.nodeArch,
      })),
      resources: directoryResources(directory),
      domains: integration
        ? {
            zones: integration.domains.map((domain) => domain.domain),
            assignments: domainSettings?.managedDomains ?? [],
          }
        : null,
      proxyModes: proxyModes ?? noProxyModes,
      databaseLinks: [...(serverDatabaseLinks ?? []), ...appDetails.links],
      appServices: appDetails.services,
      webRoutes:
        scopedRelayId && webRoutes
          ? new Map([
              [
                scopedRelayId,
                webRoutes.map((route) => ({
                  hostname: route.hostname,
                  path: route.path,
                  owner: route.owner,
                })),
              ],
            ])
          : noWebRoutes,
    }
  }, [
    appDetails,
    directory,
    domainSettings,
    hearthEdge,
    proxyModes,
    scopedRelayId,
    serverDatabaseLinks,
    webRoutes,
  ])

  // Wide screens read left to right; phones scroll down.
  const direction = useIsMobile() ? "down" : "right"
  const view = React.useMemo(
    () => buildInfraMapView(data, scope, direction),
    [data, direction, scope]
  )
  const { layout } = view

  return (
    <>
      <InfraMapScopePicker data={data} scope={scope} onSelect={onSelect} />
      <MapViewport
        fitKey={infraMapScopeKey(scope)}
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
              onSelect={onSelect}
            />
          ) : null
        })}
        <MapLinks layout={layout} />
        {[...layout.nodes].map(([id, rect]) => (
          <MapNode
            key={id}
            includeDomains={includeDomains}
            node={view.nodes.get(id)!}
            rect={rect}
            onSelect={onSelect}
          />
        ))}
      </MapViewport>
    </>
  )
})

const InfraMapScopePicker = React.memo(function InfraMapScopePicker({
  data,
  onSelect,
  scope,
}: {
  data: InfraMapData
  onSelect: SelectScope
  scope: InfraMapScope
}) {
  const options = React.useMemo(() => {
    return [
      ...data.relays.map(
        (relay): ServerPickerOption<ScopeKind> => ({
          id: relay.id,
          kind: "relay",
          name: relay.name,
          relayId: relay.id,
          relayName: relay.name,
        })
      ),
      ...data.resources.map(
        (resource): ServerPickerOption<ScopeKind> => ({
          id: resource.id,
          kind: resource.kind,
          name: resource.name,
          relayId: resource.relayId,
          relayName: resource.relayName,
        })
      ),
    ]
  }, [data.relays, data.resources])
  const selected = React.useMemo(() => {
    if (scope.kind === "all") return null
    const id = scope.kind === "relay" ? scope.relayId : scope.id
    return (
      options.find(
        (option) =>
          option.kind === scope.kind &&
          option.relayId === scope.relayId &&
          option.id === id
      ) ?? null
    )
  }, [options, scope])
  const select = React.useCallback(
    (option: ServerPickerOption<ScopeKind> | null) => {
      if (!option?.kind) return onSelect({ kind: "all" })
      onSelect(
        option.kind === "relay"
          ? { kind: "relay", relayId: option.relayId }
          : { kind: option.kind, relayId: option.relayId, id: option.id }
      )
    },
    [onSelect]
  )
  return (
    <ServerScopePicker<ScopeKind>
      allLabel="All instances"
      ariaLabel="Accessible instances"
      changeLabel="Change scope"
      chooseLabel="Choose scope"
      emptyMessage="No accessible instances found."
      selectedServer={selected}
      servers={options}
      onSelect={select}
    />
  )
})

function useDirectory() {
  const { data: relays } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .orderBy(({ relay }) => relay.name)
        .orderBy(({ relay }) => relay.createdAt)
        .select(({ relay }) => ({
          enabled: relay.enabled,
          hostname: relay.hostname,
          id: relay.id,
          name: relay.name,
          nodeArch: relay.nodeArch,
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

function directoryResources(
  directory: ReturnType<typeof useDirectory>
): Array<InfraMapResource> {
  return [
    ...directory.servers.map(
      (server): InfraMapResource => ({
        key: resourceKey("server", server.relayId, server.id),
        kind: "server",
        id: server.id,
        relayId: server.relayId,
        relayName: server.relayName,
        name: server.name,
        meta: server.connectAddress || server.game,
        routeId: server.routeId,
        brickId: server.brickId,
        implementation: server.implementation,
      })
    ),
    ...directory.apps.map(
      (app): InfraMapResource => ({
        key: resourceKey("app", app.relayId, app.id),
        kind: "app",
        id: app.id,
        relayId: app.relayId,
        relayName: app.relayName,
        name: app.name,
        meta: app.shortId,
        routeId: app.id,
      })
    ),
    ...directory.databases.map(
      (database): InfraMapResource => ({
        key: resourceKey("database", database.relayId, database.id),
        kind: "database",
        id: database.id,
        relayId: database.relayId,
        relayName: database.relayName,
        name: database.name,
        meta: `${engineLabel(database.engine)} · ${database.shortId}`,
        routeId: database.id,
      })
    ),
  ]
}

const noApps: ReadonlyArray<{ id: string; relayId: string }> = []
const noLinks: DatabaseLinks = []
const noProxyModes: InfraMapData["proxyModes"] = new Map()
const noWebRoutes: InfraMapData["webRoutes"] = new Map()

function selectProxyModes(
  modes: ReadonlyArray<{ relayId: string; mode: RelayProxyMode | null }>
) {
  return new Map(modes.map(({ mode, relayId }) => [relayId, mode]))
}

function selectServerDatabaseLinks(snapshot: RelayFleetSnapshot) {
  return snapshot.instances.flatMap((instance): DatabaseLinks =>
    (instance.savedDatabaseConnections ?? []).flatMap((connection) =>
      connection.relayId === instance.relayId
        ? [
            {
              relayId: instance.relayId,
              consumer: { kind: "server" as const, id: instance.id },
              databaseId: connection.databaseId,
            },
          ]
        : []
    )
  )
}

interface AppDetails {
  links: DatabaseLinks
  services: InfraMapData["appServices"]
}

const noAppDetails: AppDetails = { links: noLinks, services: new Map() }

// Docker names a database's network `…db-<database ID>-network`.
const databaseNetwork = /db-([a-f0-9]{40})-network$/u

const combineAppDetails = (
  results: ReadonlyArray<{ data: InstanceInventory | undefined }>
): AppDetails => {
  const links: Array<DatabaseLinks[number]> = []
  const services = new Map<string, Array<InfraMapService>>()
  for (const { data } of results) {
    if (data?.kind !== "app" || data.view !== "detail" || !data.data) continue
    const { relayId, id } = data.observation
    for (const databaseId of data.data.connectedDatabaseIds)
      links.push({ relayId, consumer: { kind: "app", id }, databaseId })
    const byName = new Map<string, InfraMapService>()
    for (const container of data.data.containers) {
      const service = byName.get(container.service) ?? {
        name: container.service,
        image: container.image,
        running: 0,
        containers: 0,
        databaseIds: [],
      }
      byName.set(container.service, {
        ...service,
        containers: service.containers + 1,
        running: service.running + (container.running ? 1 : 0),
        databaseIds: [
          ...new Set([
            ...service.databaseIds,
            ...container.networks.flatMap(
              (network) => databaseNetwork.exec(network)?.[1] ?? []
            ),
          ]),
        ],
      })
    }
    if (byName.size > 0)
      services.set(resourceKey("app", relayId, id), [...byName.values()])
  }
  return links.length === 0 && services.size === 0
    ? noAppDetails
    : { links, services }
}

/**
 * Each app's containers and the databases it joins, read from its Relay.
 * Lookups for one Relay share a request, so a Relay's apps cost one round
 * trip.
 */
function useAppDetails(
  apps: ReadonlyArray<{ id: string; relayId: string }>
): AppDetails {
  const details = useQueries({
    queries: apps.map((app) =>
      instanceInventoryQueryOptions(
        { kind: "app", id: app.id, relayId: app.relayId },
        "detail"
      )
    ),
    combine: combineAppDetails,
  })
  // Apps poll; keep unchanged details identical so the map holds still.
  const stable = React.useRef(noAppDetails)
  if (JSON.stringify(stable.current, mapReplacer) !== JSON.stringify(details, mapReplacer))
    stable.current = details
  return stable.current
}

function mapReplacer(_key: string, value: unknown) {
  return value instanceof Map ? [...value] : value
}
