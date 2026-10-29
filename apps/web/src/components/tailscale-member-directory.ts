import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  appTailscaleMember,
  databaseTailscaleMember,
  databaseTailscaleMemberId,
  instanceTailscaleMember,
  instanceTailscaleMemberId,
} from "@workspace/contracts"

import { engineLabel } from "@/components/database/database-presentation"
import type { InstanceNameInstance } from "@/components/instance-name-presentation"
import { appRouteIdentifier } from "@/lib/app-route"
import { databaseRouteIdentifier } from "@/lib/database-route"
import {
  appDirectoryQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import {
  selectTailscaleServers,
  tailscaleSupportedRelayIds,
} from "@/lib/tailscale-selectors"

/**
 * Something that joins a Tailscale network, as every membership view shows
 * it: a game server, an App's service, or a database.
 */
export interface TailscaleMemberListing {
  readonly identity: InstanceNameInstance
  readonly kind: "app" | "database" | "server"
  /** `instance:<id>`, `app:<id>:<service>`, or `database:<id>`. */
  readonly memberId: string
  /** What it is beyond its name: a release, a service, or an engine. */
  readonly meta: string
  readonly name: string
  readonly relayId: string
  readonly relayName: string
  /** Its page's route ID, when it's known here. */
  readonly routeId: string | null
  readonly shortId: string
  /** Whether its Relay can change its Tailscale memberships. */
  readonly tailscaleSupported: boolean
}

export const tailscaleMemberKey = (relayId: string, memberId: string) =>
  `${relayId}:${memberId}`

const emptyListings: ReadonlyMap<string, TailscaleMemberListing> = new Map()

function selectTailscaleFleet(snapshot: RelayFleetSnapshot) {
  return {
    servers: selectTailscaleServers(snapshot),
    supportedRelayIds: tailscaleSupportedRelayIds(snapshot),
  }
}

/**
 * Every game server and database that can join a network, by member key,
 * and a listing for any binding, App services' and unknown members'
 * included. App services are listed from their bindings: which services an
 * App runs is known on its own page, where they join.
 */
export function useTailscaleMemberDirectory() {
  const fleet = useQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data", "isPending"],
    select: selectTailscaleFleet,
  })
  const apps = useQuery(appDirectoryQueryOptions())
  const databases = useQuery(managedDatabaseDirectoryQueryOptions())
  const fleetData = fleet.data
  const appData = apps.data
  const databaseData = databases.data
  return React.useMemo(() => {
    const supported = new Set(fleetData?.supportedRelayIds ?? [])
    const joinable = new Map<string, TailscaleMemberListing>()
    for (const server of fleetData?.servers ?? []) {
      const memberId = instanceTailscaleMemberId(server.id)
      joinable.set(tailscaleMemberKey(server.relayId, memberId), {
        identity: {
          brickId: server.brickId,
          id: server.id,
          implementation: server.implementation,
          kind: "server",
          relayId: server.relayId,
        },
        kind: "server",
        memberId,
        meta:
          [server.implementation, server.version].filter(Boolean).join(" ") ||
          server.shortId,
        name: server.name,
        relayId: server.relayId,
        relayName: server.relayName,
        routeId: server.routeId,
        shortId: server.shortId,
        tailscaleSupported: server.tailscaleSupported,
      })
    }
    for (const database of databaseData ?? []) {
      const memberId = databaseTailscaleMemberId(database.id)
      joinable.set(tailscaleMemberKey(database.relayId, memberId), {
        identity: {
          id: database.id,
          kind: "database",
          relayId: database.relayId,
        },
        kind: "database",
        memberId,
        meta: `${engineLabel(database.engine)} · ${database.shortId}`,
        name: database.name,
        relayId: database.relayId,
        relayName: database.relayName,
        routeId: databaseRouteIdentifier(databaseData ?? [], database),
        shortId: database.shortId,
        tailscaleSupported: supported.has(database.relayId),
      })
    }
    const appsById = new Map((appData ?? []).map((app) => [app.id, app]))
    // A binding's member as listed, or as much of it as Hearth knows.
    const listing = (binding: {
      memberId: string
      relayId: string
      relayName: string
    }): TailscaleMemberListing => {
      const known = joinable.get(
        tailscaleMemberKey(binding.relayId, binding.memberId)
      )
      if (known) return known
      const common = {
        relayId: binding.relayId,
        relayName: binding.relayName,
        tailscaleSupported: supported.has(binding.relayId),
      }
      const service = appTailscaleMember(binding.memberId)
      if (service) {
        const app = appsById.get(service.appId)
        return {
          ...common,
          identity: {
            id: service.appId,
            kind: "app",
            relayId: binding.relayId,
          },
          kind: "app",
          memberId: binding.memberId,
          meta: `App service ${service.service}`,
          name: app?.name ?? `App ${service.appId.slice(0, 8)}`,
          routeId: app ? appRouteIdentifier(appData ?? [], app) : null,
          shortId: service.appId.slice(0, 8),
        }
      }
      const databaseId = databaseTailscaleMember(binding.memberId)
      const id = databaseId ?? instanceTailscaleMember(binding.memberId) ?? ""
      return {
        ...common,
        identity: databaseId
          ? { id, kind: "database", relayId: binding.relayId }
          : { id, kind: "server", relayId: binding.relayId },
        kind: databaseId ? "database" : "server",
        memberId: binding.memberId,
        meta: "Not visible here",
        name: `${databaseId ? "Database" : "Game server"} ${id.slice(0, 8)}`,
        routeId: null,
        shortId: id.slice(0, 8),
      }
    }
    return {
      joinable: joinable.size > 0 ? joinable : emptyListings,
      listing,
      pending: fleet.isPending,
    }
  }, [appData, databaseData, fleet.isPending, fleetData])
}
