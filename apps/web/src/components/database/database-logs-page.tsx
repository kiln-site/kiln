import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { Container, History, Rocket } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"

import {
  deploymentDuration,
  deploymentStatusPresentation,
} from "@/components/app/app-deployment-presentation"
import type { ConsoleStreamSnapshot } from "@/components/console/console-stores"
import {
  DEPLOYMENT_STREAM,
  LogHeader,
  LogMessage,
  LogMeta,
  LogRailRowContent,
  LogSourcesRail,
  RunningFor,
  logRailFooterLinkClassName,
  logRailRowClassName,
  logRailTabActiveClassName,
  logRailTabClassName,
} from "@/components/console/log-sources"
import { ResourceLogsSession } from "@/components/console/resource-logs"
import {
  databaseRelayAvailable,
  engineProductLabel,
} from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import { RelativeTime } from "@/components/relative-time"
import {
  deploymentsQueryOptions,
  serverDeploymentLogQueryOptions,
} from "@/lib/query-options"
import type {
  DatabaseDeploymentView,
  DeploymentView,
} from "@/server/app-deployments.server"

// What the Relay keeps logs of; older deployments live on in History.
const LISTED_DEPLOYMENTS = 20

type Deployment = DatabaseDeploymentView

function listedDeployments(data: {
  pages: ReadonlyArray<{ items: ReadonlyArray<DeploymentView> }>
}) {
  return (data.pages[0]?.items ?? [])
    .flatMap((item) => (item.kind === "database" ? [item] : []))
    .slice(0, LISTED_DEPLOYMENTS)
}

const statusOf = (deployment: Deployment) =>
  deploymentStatusPresentation({ ...deployment, rolling: null })

// A database's output in one place, as an App's is: its container, followed
// live, and the log of each deployment the Relay kept.
export function DatabaseLogsPage() {
  const { database } = useDatabaseWorkspace()
  const { deployment: requested, stream } = useSearch({
    from: "/_app/db/$databaseId/logs",
  })
  const { data: deployments = [], isPending } = useInfiniteQuery({
    ...deploymentsQueryOptions({
      instance: { id: database.id, kind: "database" },
      relayId: database.relayId,
    }),
    select: listedDeployments,
  })
  // One deployment by its record, the latest, or the container's output.
  const showing =
    requested !== undefined
      ? requested
      : stream === DEPLOYMENT_STREAM
        ? (deployments[0]?.id ?? null)
        : undefined
  const deployment =
    typeof showing === "string"
      ? deployments.find(({ id }) => id === showing)
      : undefined
  const picker = <DatabaseLogsPicker deployments={deployments} id={showing} />
  return (
    <div className="flex min-h-0 flex-1">
      <DatabaseLogsRail deployments={deployments} id={showing} />
      <div className="flex min-w-0 flex-1 flex-col">
        {showing === undefined ? (
          <ResourceLogsSession
            key={`${database.relayId}:${database.id}`}
            header={
              <>
                {picker}
                <LogHeader
                  status={containerStatus(database.observedState)}
                  title={engineProductLabel(database)}
                />
              </>
            }
            id={database.id}
            kind="database"
            logName={database.name}
            relayAvailable={databaseRelayAvailable(database)}
            relayId={database.relayId}
          />
        ) : showing === null ? (
          <LogMessage
            header={
              <>
                {picker}
                <LogHeader title="Deployment" />
              </>
            }
            loading={isPending}
            message="No deployments yet"
          />
        ) : (
          <DeploymentLog
            key={showing}
            deployment={deployment}
            id={showing}
            picker={picker}
          />
        )}
      </div>
    </div>
  )
}

function containerStatus(observedState: string | undefined) {
  const running = observedState === "running" || observedState === "starting"
  return {
    label: running ? "Running" : "Stopped",
    tone: running ? ("success" as const) : ("neutral" as const),
  }
}

// The log the Relay saved of one deployment, read again while it runs.
function DeploymentLog({
  deployment,
  id,
  picker,
}: {
  /** Its record, when it is one of those listed. */
  deployment: Deployment | undefined
  id: string
  picker: React.ReactNode
}) {
  const { database } = useDatabaseWorkspace()
  const router = useRouter()
  const running = deployment?.status === "running"
  const { data, error, isPending } = useQuery({
    ...serverDeploymentLogQueryOptions(database.id, id),
    refetchInterval: running ? 1_000 : false,
  })
  const log = data?.log ?? null
  const saved = React.useMemo<ConsoleStreamSnapshot | null>(
    () =>
      log && {
        connection: "live",
        consoleData: {
          instanceId: database.id,
          lifecycle: [],
          lines: log.lines,
          truncated: false,
        },
        error: null,
        loading: false,
        transport: null,
        transportMessage: null,
      },
    [database.id, log]
  )
  const header = (
    <>
      {picker}
      {deployment ? (
        <LogHeader status={statusOf(deployment)} title="Redeploy">
          <DeploymentMeta deployment={deployment} full />
        </LogHeader>
      ) : (
        <LogHeader title="Deployment" />
      )}
    </>
  )
  if (isPending) return <LogMessage header={header} loading />
  if (!log || !saved) {
    return (
      <LogMessage
        header={header}
        message={error?.message ?? data?.reason ?? "This log is no longer kept"}
      />
    )
  }
  return (
    <ResourceLogsSession
      elapsedFrom={log.deployment.startedAt}
      header={header}
      id={database.id}
      kind="database"
      logName={`${database.name}-deployment`}
      relayAvailable={databaseRelayAvailable(database)}
      relayId={database.relayId}
      saved={saved}
      shareHref={
        router.buildLocation({
          params: { databaseId: database.id },
          search: { deployment: id },
          to: "/db/$databaseId/logs",
        }).href
      }
      timeMode="elapsed"
    />
  )
}

function DeploymentMeta({
  deployment,
  full = false,
}: {
  deployment: Deployment
  /** With who started it and a running clock, where there's room for them. */
  full?: boolean
}) {
  const duration = deploymentDuration(deployment)
  return (
    <LogMeta>
      <RelativeTime timestamp={Date.parse(deployment.startedAt)} />
      {full && deployment.triggeredByName ? (
        <span>by {deployment.triggeredByName}</span>
      ) : null}
      {duration ? (
        <span className="tabular-nums">
          {full ? `Took ${duration}` : duration}
        </span>
      ) : full ? (
        <RunningFor startedAt={deployment.startedAt} />
      ) : null}
    </LogMeta>
  )
}

const DatabaseLogsRail = React.memo(function DatabaseLogsRail({
  deployments,
  id,
}: {
  deployments: ReadonlyArray<Deployment>
  /** The deployment shown, null for none yet, undefined for the container. */
  id: string | null | undefined
}) {
  const { database } = useDatabaseWorkspace()
  const runtime = id === undefined
  const params = { databaseId: database.id }
  return (
    <LogSourcesRail
      footer={
        runtime ? undefined : (
          <Link
            className={logRailFooterLinkClassName}
            search={{ relayId: database.relayId }}
            to="/infra/deployments"
          >
            <History />
            All deployments
          </Link>
        )
      }
      tabs={
        <>
          <Link
            replace
            className={cn(
              logRailTabClassName,
              runtime && logRailTabActiveClassName
            )}
            params={params}
            search={{}}
            to="/db/$databaseId/logs"
          >
            <Container />
            Runtime
          </Link>
          <Link
            replace
            className={cn(
              logRailTabClassName,
              !runtime && logRailTabActiveClassName
            )}
            params={params}
            search={{ stream: DEPLOYMENT_STREAM }}
            to="/db/$databaseId/logs"
          >
            <Rocket />
            Deployments
          </Link>
        </>
      }
    >
      {runtime ? (
        <Link
          replace
          aria-current="true"
          className={logRailRowClassName}
          params={params}
          search={{}}
          to="/db/$databaseId/logs"
        >
          <LogRailRowContent
            status={containerStatus(database.observedState)}
            title={database.name}
          >
            {engineProductLabel(database)}
          </LogRailRowContent>
        </Link>
      ) : (
        deployments.map((deployment) => (
          <Link
            key={deployment.id}
            replace
            aria-current={id === deployment.id ? "true" : undefined}
            className={logRailRowClassName}
            params={params}
            search={{ deployment: deployment.id }}
            to="/db/$databaseId/logs"
          >
            <LogRailRowContent status={statusOf(deployment)} title="Redeploy">
              <DeploymentMeta deployment={deployment} />
            </LogRailRowContent>
          </Link>
        ))
      )}
      {!runtime && deployments.length === 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          No deployments yet
        </p>
      ) : null}
    </LogSourcesRail>
  )
})

const RUNTIME = "runtime"

// The rail, below the width that fits it.
function DatabaseLogsPicker({
  deployments,
  id,
}: {
  deployments: ReadonlyArray<Deployment>
  id: string | null | undefined
}) {
  const { database } = useDatabaseWorkspace()
  const navigate = useNavigate()
  // One opened by its link, past the ones listed.
  const unlisted =
    typeof id === "string" && !deployments.some((item) => item.id === id)
      ? id
      : null
  function select(next: string) {
    void navigate({
      params: { databaseId: database.id },
      replace: true,
      search:
        next === RUNTIME
          ? {}
          : next === DEPLOYMENT_STREAM
            ? { stream: DEPLOYMENT_STREAM }
            : { deployment: next },
      to: "/db/$databaseId/logs",
    })
  }
  return (
    <div className="shrink-0 border-b px-3 py-2 md:hidden">
      <Select
        value={id === undefined ? RUNTIME : (id ?? DEPLOYMENT_STREAM)}
        onValueChange={select}
      >
        <SelectTrigger aria-label="Log source" className="h-9 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Container</SelectLabel>
            <SelectItem value={RUNTIME}>{database.name}</SelectItem>
          </SelectGroup>
          <SelectGroup>
            <SelectLabel>Deployments</SelectLabel>
            {deployments.length === 0 ? (
              <SelectItem value={DEPLOYMENT_STREAM}>Latest</SelectItem>
            ) : null}
            {unlisted ? (
              <SelectItem value={unlisted}>Older deployment</SelectItem>
            ) : null}
            {deployments.map((deployment) => (
              <SelectItem key={deployment.id} value={deployment.id}>
                Redeploy · {statusOf(deployment).label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}
