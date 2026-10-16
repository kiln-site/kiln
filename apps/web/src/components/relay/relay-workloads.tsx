import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { InfoRailGroup, InfoRailLink } from "@/components/info-page"
import {
  canAccessInfrastructureDestination,
  infrastructureDestinations,
} from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { selectRelayServerCount } from "@/lib/relay-selectors"

type WorkloadList = "/infra/apps" | "/infra/databases" | "/infra/servers"

// What runs on a Relay, a row for each kind. Each opens its list, searched to
// this Relay.
export function RelayWorkloads({
  relayId,
  routeId,
}: {
  relayId: string
  // The Relay's short ID; every list searches Relay IDs.
  routeId: string
}) {
  const { data: access } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectWorkloadAccess,
  })
  if (!access || (!access.servers && !access.databases && !access.apps)) {
    return null
  }
  return (
    <InfoRailGroup card>
      {access.servers ? (
        <ServerCount relayId={relayId} search={routeId} />
      ) : null}
      {access.databases ? (
        <DatabaseCount relayId={relayId} search={routeId} />
      ) : null}
      {access.apps ? <AppCount relayId={relayId} search={routeId} /> : null}
    </InfoRailGroup>
  )
}

const ServerCount = React.memo(function ServerCount({
  relayId,
  search,
}: {
  relayId: string
  search: string
}) {
  const select = React.useMemo(() => selectRelayServerCount(relayId), [relayId])
  const { data } = useQuery({ ...relaySnapshotQueryOptions(), select })
  return (
    <WorkloadLink
      count={data}
      icon={<serversDestination.icon />}
      noun={{ one: "Game Server", other: "Game Servers" }}
      search={search}
      to="/infra/servers"
    />
  )
})

const DatabaseCount = React.memo(function DatabaseCount({
  relayId,
  search,
}: {
  relayId: string
  search: string
}) {
  const select = React.useMemo(() => countOnRelay(relayId), [relayId])
  const { data } = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    select,
  })
  return (
    <WorkloadLink
      count={data}
      icon={<databasesDestination.icon />}
      noun={{ one: "Database", other: "Databases" }}
      search={search}
      to="/infra/databases"
    />
  )
})

const AppCount = React.memo(function AppCount({
  relayId,
  search,
}: {
  relayId: string
  search: string
}) {
  const select = React.useMemo(() => countOnRelay(relayId), [relayId])
  const { data } = useQuery({ ...appDirectoryQueryOptions(), select })
  return (
    <WorkloadLink
      count={data}
      icon={<appsDestination.icon />}
      noun={{ one: "App", other: "Apps" }}
      search={search}
      to="/infra/apps"
    />
  )
})

function WorkloadLink({
  count,
  icon,
  noun,
  search,
  to,
}: {
  count: number | undefined
  icon: React.ReactNode
  noun: { one: string; other: string }
  search: string
  to: WorkloadList
}) {
  return (
    <InfoRailLink
      to={to}
      search={{ search }}
      leading={icon}
      detail={count ?? "—"}
    >
      {count === 1 ? noun.one : noun.other}
    </InfoRailLink>
  )
}

function countOnRelay(relayId: string) {
  return (resources: ReadonlyArray<{ relayId: string }>) =>
    resources.filter((resource) => resource.relayId === relayId).length
}

function workloadDestination(to: WorkloadList) {
  const destination = infrastructureDestinations.find(
    (candidate) => candidate.to === to
  )
  if (!destination) throw new Error(`Missing destination ${to}`)
  return destination
}

const serversDestination = workloadDestination("/infra/servers")
const databasesDestination = workloadDestination("/infra/databases")
const appsDestination = workloadDestination("/infra/apps")

function selectWorkloadAccess(
  capabilities: Parameters<typeof canAccessInfrastructureDestination>[0]
) {
  return {
    apps: canAccessInfrastructureDestination(capabilities, appsDestination),
    databases: canAccessInfrastructureDestination(
      capabilities,
      databasesDestination
    ),
    servers: canAccessInfrastructureDestination(
      capabilities,
      serversDestination
    ),
  }
}
