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
import {
  appDirectoryQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"

/**
 * Something a tunnel connects, as every page shows it: a game server, an
 * App's service, or a database.
 */
export interface TunnelMemberListing {
  /** Its instance ID. */
  readonly id: string
  readonly identity: InstanceNameInstance
  readonly kind: "app" | "database" | "server"
  /** `instance:<id>`, `app:<id>:<service>`, or `database:<id>`. */
  readonly memberId: string
  /** What it is beyond its name: a release, a service, or an engine. */
  readonly meta: string
  readonly name: string
  readonly relayId: string
  readonly relayName: string
  /** Whether its page is known here, so it can link to it. */
  readonly linked: boolean
}

export const tunnelMemberKey = (relayId: string, memberId: string) =>
  `${relayId}:${memberId}`

const emptyListings: ReadonlyMap<string, TunnelMemberListing> = new Map()

function selectServers(snapshot: RelayFleetSnapshot) {
  return snapshot.instances
    .map((instance) => ({
      brickId: instance.brickId,
      id: instance.id,
      implementation: instance.implementation,
      name: instance.name,
      relayId: instance.relayId,
      relayName: instance.relayName,
      version: instance.version,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Every game server and database a tunnel can connect, by member key, and a
 * listing for any binding, App services' and unknown members' included. App
 * services are listed from their bindings: which services an App runs is
 * known on its own page, where they connect.
 */
export function useTunnelMemberDirectory() {
  const fleet = useQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data", "isPending"],
    select: selectServers,
  })
  const apps = useQuery(appDirectoryQueryOptions())
  const databases = useQuery(managedDatabaseDirectoryQueryOptions())
  const fleetData = fleet.data
  const appData = apps.data
  const databaseData = databases.data
  return React.useMemo(() => {
    const joinable = new Map<string, TunnelMemberListing>()
    for (const server of fleetData ?? []) {
      const memberId = instanceTailscaleMemberId(server.id)
      joinable.set(tunnelMemberKey(server.relayId, memberId), {
        id: server.id,
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
          server.id,
        name: server.name,
        relayId: server.relayId,
        relayName: server.relayName,
        linked: true,
      })
    }
    for (const database of databaseData ?? []) {
      const memberId = databaseTailscaleMemberId(database.id)
      joinable.set(tunnelMemberKey(database.relayId, memberId), {
        id: database.id,
        identity: {
          id: database.id,
          kind: "database",
          relayId: database.relayId,
        },
        kind: "database",
        memberId,
        meta: `${engineLabel(database.engine)} · ${database.id}`,
        name: database.name,
        relayId: database.relayId,
        relayName: database.relayName,
        linked: true,
      })
    }
    const appsById = new Map((appData ?? []).map((app) => [app.id, app]))
    // A binding's member as listed, or as much of it as Hearth knows.
    const listing = (binding: {
      memberId: string
      relayId: string
      relayName: string
    }): TunnelMemberListing => {
      const known = joinable.get(
        tunnelMemberKey(binding.relayId, binding.memberId)
      )
      if (known) return known
      const common = {
        relayId: binding.relayId,
        relayName: binding.relayName,
      }
      const service = appTailscaleMember(binding.memberId)
      if (service) {
        const app = appsById.get(service.appId)
        return {
          ...common,
          id: service.appId,
          identity: {
            id: service.appId,
            kind: "app",
            relayId: binding.relayId,
          },
          kind: "app",
          memberId: binding.memberId,
          meta:
            service.service === "app"
              ? "App"
              : `App service ${service.service}`,
          name: app?.name ?? `App ${service.appId}`,
          linked: app !== undefined,
        }
      }
      const databaseId = databaseTailscaleMember(binding.memberId)
      const id = databaseId ?? instanceTailscaleMember(binding.memberId) ?? ""
      return {
        ...common,
        id,
        identity: databaseId
          ? { id, kind: "database", relayId: binding.relayId }
          : { id, kind: "server", relayId: binding.relayId },
        kind: databaseId ? "database" : "server",
        memberId: binding.memberId,
        meta: "Not visible here",
        name: `${databaseId ? "Database" : "Game server"} ${id}`,
        linked: false,
      }
    }
    return {
      joinable: joinable.size > 0 ? joinable : emptyListings,
      listing,
      pending: fleet.isPending,
    }
  }, [appData, databaseData, fleet.isPending, fleetData])
}
