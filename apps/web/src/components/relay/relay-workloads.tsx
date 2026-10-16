import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"

import { InfoRailGroup } from "@/components/info-page"
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
import { selectRelayServerCounts } from "@/lib/relay-selectors"

type WorkloadList = "/infra/apps" | "/infra/databases" | "/infra/servers"

// What runs on a Relay. Each count opens its list, searched to this Relay.
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
    <InfoRailGroup title="Runs">
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
  const select = React.useMemo(
    () => selectRelayServerCounts(relayId),
    [relayId]
  )
  const { data } = useQuery({ ...relaySnapshotQueryOptions(), select })
  return (
    <WorkloadLink
      count={data?.total}
      detail={data && data.total > 0 ? `${data.running} running` : undefined}
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
      noun={{ one: "App", other: "Apps" }}
      search={search}
      to="/infra/apps"
    />
  )
})

function WorkloadLink({
  count,
  detail,
  noun,
  search,
  to,
}: {
  count: number | undefined
  detail?: string
  noun: { one: string; other: string }
  search: string
  to: WorkloadList
}) {
  return (
    <Link
      to={to}
      search={{ search }}
      className="group -mx-2 flex min-w-0 items-center gap-2.5 px-2 py-1.5 text-[0.8125rem] transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="w-6 shrink-0 font-semibold tabular-nums">
        {count ?? "—"}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground transition-colors group-hover:text-foreground">
        {count === 1 ? noun.one : noun.other}
      </span>
      {detail ? (
        <span className="shrink-0 text-xs text-muted-foreground/80">
          {detail}
        </span>
      ) : null}
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5" />
    </Link>
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
