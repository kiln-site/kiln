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
  deploymentTriggerLabels,
  shortCommit,
  shortDigest,
} from "@/components/app/app-deployment-presentation"
import {
  appContainers,
  appRelayAvailable,
  sourceTypeLabels,
  type App,
} from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
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
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { RelativeTime } from "@/components/relative-time"
import {
  appDeploymentLogQueryOptions,
  appDeploymentsQueryOptions,
} from "@/lib/query-options"
import type { AppDeploymentView } from "@/server/app-deployments.server"

const SERVICE_PREFIX = "service:"
// What the Relay keeps logs of; older deployments live on in History.
const LISTED_DEPLOYMENTS = 20

type Deployment = AppDeploymentView
type LiveDeployments = ReadonlySet<string>
type Service = {
  container: App["containers"][number]
  name: string
  status: IdentityStatusPresentation
}

// What the page shows: one service's containers, one deployment by its
// record, or (deployment null) whichever the Relay is on, following it to the
// next.
type LogSource =
  | { kind: "deployment"; id: string | null }
  | { kind: "service"; name: string }

function listedDeployments(data: {
  pages: ReadonlyArray<{ items: ReadonlyArray<Deployment> }>
}) {
  return data.pages[0]?.items.slice(0, LISTED_DEPLOYMENTS) ?? []
}

function appLogServices(app: Pick<App, "containers">): Array<Service> {
  const services = new Map<string, Service>()
  for (const container of appContainers(app)) {
    const { running, service } = container
    const known = services.get(service)
    if (known?.status.tone === "success") continue
    services.set(service, {
      container,
      name: service,
      status: {
        label: running ? "Running" : "Stopped",
        tone: running ? "success" : "neutral",
      },
    })
  }
  return [...services.values()]
}

// The deployments whose containers are running, which a failed deployment can
// leave as the one still serving.
function liveDeployments(app: Pick<App, "containers">): LiveDeployments {
  return new Set(
    app.containers.flatMap(({ labels, running }) => {
      const deployment = labels["kiln.app.deployment"]
      return running && deployment ? [deployment] : []
    })
  )
}

// One still deploying isn't live yet, even once its containers have started.
function isLive(deployment: Deployment, live: LiveDeployments) {
  return (
    deployment.status !== "running" &&
    deployment.relayDeploymentId !== null &&
    live.has(deployment.relayDeploymentId)
  )
}

// An app's output in one place: its containers, followed live, and the log of
// each deployment the Relay kept, the latest followed live too.
export function AppLogsPage() {
  const { app } = useAppWorkspace()
  const { deployment: requestedDeployment, stream: requested } = useSearch({
    from: "/_app/app/$appId/logs",
  })
  const { data: deployments, isPending: deploymentsPending } = useInfiniteQuery(
    {
      ...appDeploymentsQueryOptions({ appId: app.id, relayId: app.relayId }),
      select: listedDeployments,
    }
  )
  const services = React.useMemo(() => appLogServices(app), [app])
  const live = React.useMemo(() => liveDeployments(app), [app])
  const source = logSource(
    requestedDeployment,
    requested,
    services,
    app.deployment?.state === "running"
  )
  const picker = (
    <AppLogsPicker
      deployments={deployments ?? []}
      live={live}
      services={services}
      source={source}
    />
  )

  return (
    <div className="flex min-h-0 flex-1">
      <AppLogsRail
        appId={app.id}
        deployments={deployments ?? []}
        live={live}
        relayId={app.relayId}
        services={services}
        source={source}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {source.kind === "service" ? (
          <ResourceLogsSession
            key={`${app.relayId}:${app.id}:${source.name}`}
            header={
              <>
                {picker}
                <ServiceLogHeader
                  service={services.find(({ name }) => name === source.name)}
                  name={source.name}
                />
              </>
            }
            id={app.id}
            kind="app"
            logName={`${app.name}-${source.name}`}
            relayAvailable={appRelayAvailable(app)}
            relayId={app.relayId}
            stream={`${SERVICE_PREFIX}${source.name}`}
          />
        ) : (
          <DeploymentLogs
            deployments={deployments ?? []}
            id={source.id}
            pending={deploymentsPending}
            picker={picker}
          />
        )}
      </div>
    </div>
  )
}

function logSource(
  deployment: string | undefined,
  stream: string | undefined,
  services: ReadonlyArray<Service>,
  deploying: boolean
): LogSource {
  if (deployment) return { id: deployment, kind: "deployment" }
  if (stream?.startsWith(SERVICE_PREFIX)) {
    return { kind: "service", name: stream.slice(SERVICE_PREFIX.length) }
  }
  // Container output by default once there is any, unless a deployment is
  // running or was asked for.
  const service = services[0]
  return stream === DEPLOYMENT_STREAM || deploying || !service
    ? { id: null, kind: "deployment" }
    : { kind: "service", name: service.name }
}

// A deployment the Relay is still on is followed live; any other reads the log
// it saved.
function DeploymentLogs({
  deployments,
  id,
  pending,
  picker,
}: {
  deployments: ReadonlyArray<Deployment>
  id: string | null
  pending: boolean
  picker: React.ReactNode
}) {
  const { app } = useAppWorkspace()
  const router = useRouter()
  const relayDeployment = app.deployment ?? null
  const deployment =
    deployments.find((candidate) =>
      id === null
        ? candidate.relayDeploymentId === relayDeployment?.id
        : candidate.id === id
    ) ?? (id === null ? deployments[0] : undefined)
  const live =
    id === null ||
    (deployment !== undefined &&
      deployment.relayDeploymentId === relayDeployment?.id)
  const logName = deployment?.commitSha
    ? `${app.name}-deployment-${shortCommit(deployment.commitSha)}`
    : `${app.name}-deployment`
  const header = (
    <>
      {picker}
      {deployment ? (
        <DeploymentLogHeader deployment={deployment} />
      ) : (
        <LogHeader title="Deployment" />
      )}
    </>
  )
  const shareHref = deployment
    ? router.buildLocation({
        params: { appId: app.id },
        search: { deployment: deployment.id },
        to: "/app/$appId/logs",
      }).href
    : undefined

  if (live) {
    return (
      <ResourceLogsSession
        key={`${app.relayId}:${app.id}:live:${relayDeployment?.id ?? ""}`}
        elapsedFrom={relayDeployment?.startedAt ?? null}
        header={header}
        id={app.id}
        kind="app"
        logName={logName}
        relayAvailable={appRelayAvailable(app)}
        relayId={app.relayId}
        shareHref={shareHref}
        stream={
          relayDeployment
            ? `${DEPLOYMENT_STREAM}:${relayDeployment.id}`
            : DEPLOYMENT_STREAM
        }
        timeMode="elapsed"
      />
    )
  }
  // Its record tells live from saved, so wait for it unless it's past the
  // list, where only the saved log can be.
  if (pending) return <LogMessage header={header} loading />
  return (
    <SavedDeploymentLog
      key={id}
      deploymentId={id!}
      header={header}
      logName={logName}
      shareHref={shareHref}
    />
  )
}

function SavedDeploymentLog({
  deploymentId,
  header,
  logName,
  shareHref,
}: {
  deploymentId: string
  header: React.ReactNode
  logName: string
  shareHref: string | undefined
}) {
  const { app } = useAppWorkspace()
  const { data, error, isPending } = useQuery(
    appDeploymentLogQueryOptions(app.id, deploymentId)
  )
  const log = data?.log ?? null
  const saved = React.useMemo<ConsoleStreamSnapshot | null>(
    () =>
      log && {
        connection: "live",
        consoleData: {
          instanceId: app.id,
          lifecycle: [],
          lines: log.lines,
          truncated: log.dropped > 0,
        },
        error: null,
        loading: false,
        transport: null,
        transportMessage: null,
      },
    [app.id, log]
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
      header={
        <>
          {header}
          {log.dropped > 0 ? (
            <p className="type-meta shrink-0 border-b px-3 py-1.5 text-muted-foreground sm:px-4">
              {log.dropped.toLocaleString()} earlier lines were dropped once
              this log reached its limit.
            </p>
          ) : null}
        </>
      }
      id={app.id}
      kind="app"
      logName={logName}
      relayAvailable={appRelayAvailable(app)}
      relayId={app.relayId}
      saved={saved}
      shareHref={shareHref}
      timeMode="elapsed"
    />
  )
}

const DeploymentLogHeader = React.memo(function DeploymentLogHeader({
  deployment,
}: {
  deployment: Deployment
}) {
  return (
    <LogHeader
      status={deploymentStatusPresentation(deployment)}
      title={deploymentTitle(deployment)}
    >
      <DeploymentMeta deployment={deployment} full />
    </LogHeader>
  )
})

const ServiceLogHeader = React.memo(function ServiceLogHeader({
  name,
  service,
}: {
  name: string
  service: Service | undefined
}) {
  return (
    <LogHeader title={name} {...(service && { status: service.status })}>
      {service ? <ServiceMeta service={service} /> : null}
    </LogHeader>
  )
})

function DeploymentMeta({
  deployment,
  full = false,
}: {
  deployment: Deployment
  /** With who started it and a running clock, where there's room for them. */
  full?: boolean
}) {
  const duration = deploymentDuration(deployment)
  const by = deployment.triggeredByName ?? deployment.commitAuthor
  return (
    <LogMeta>
      <RelativeTime timestamp={Date.parse(deployment.startedAt)} />
      {deployment.commitSha || deployment.imageDigest ? (
        <DeploymentReference deployment={deployment} linked={full} />
      ) : null}
      {full ? (
        <span>
          {deploymentTriggerLabels[deployment.trigger]}
          {by ? ` by ${by}` : ""}
        </span>
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

function ServiceMeta({ service }: { service: Service }) {
  const { exitCode, id, running, startedAt } = service.container
  return (
    <LogMeta>
      {startedAt ? <RelativeTime timestamp={Date.parse(startedAt)} /> : null}
      <span className="font-mono">{id.slice(0, 7)}</span>
      {!running && exitCode !== null ? <span>Exited {exitCode}</span> : null}
    </LogMeta>
  )
}

function DeploymentReference({
  deployment,
  linked,
}: {
  deployment: Deployment
  linked: boolean
}) {
  const { commitSha, commitUrl, imageDigest } = deployment
  if (commitSha && commitUrl && linked) {
    return (
      <a
        className="font-mono text-primary-ink hover:underline"
        href={commitUrl}
        rel="noreferrer"
        target="_blank"
      >
        {shortCommit(commitSha)}
      </a>
    )
  }
  return (
    <span className="font-mono">
      {commitSha ? shortCommit(commitSha) : shortDigest(imageDigest ?? "")}
    </span>
  )
}

const AppLogsRail = React.memo(function AppLogsRail({
  appId,
  deployments,
  live,
  relayId,
  services,
  source,
}: {
  appId: string
  deployments: ReadonlyArray<Deployment>
  live: LiveDeployments
  relayId: string
  services: ReadonlyArray<Service>
  source: LogSource
}) {
  const { app } = useAppWorkspace()
  const runtime = source.kind === "service"
  const firstService = services[0]?.name
  const newest = deployments[0]?.id
  return (
    <LogSourcesRail
      footer={
        runtime ? undefined : (
          <Link
            className={logRailFooterLinkClassName}
            search={{ appId, relayId }}
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
            aria-disabled={firstService === undefined}
            className={cn(
              logRailTabClassName,
              runtime && logRailTabActiveClassName
            )}
            disabled={firstService === undefined}
            params={{ appId: app.id }}
            search={{ stream: `${SERVICE_PREFIX}${firstService}` }}
            to="/app/$appId/logs"
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
            params={{ appId: app.id }}
            search={{ stream: DEPLOYMENT_STREAM }}
            to="/app/$appId/logs"
          >
            <Rocket />
            Deployments
          </Link>
        </>
      }
    >
      {runtime
        ? services.map((service) => (
            <LogRailRow
              key={service.name}
              current={source.name === service.name}
              search={{ stream: `${SERVICE_PREFIX}${service.name}` }}
              status={service.status}
              title={service.name}
            >
              <ServiceMeta service={service} />
            </LogRailRow>
          ))
        : deployments.map((deployment) => (
            <LogRailRow
              key={deployment.id}
              current={
                source.id === deployment.id ||
                (source.id === null && deployment.id === newest)
              }
              live={isLive(deployment, live)}
              search={{ deployment: deployment.id }}
              status={deploymentStatusPresentation(deployment)}
              title={deploymentTitle(deployment)}
            >
              <DeploymentMeta deployment={deployment} />
            </LogRailRow>
          ))}
      {!runtime && deployments.length === 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          No deployments yet
        </p>
      ) : null}
    </LogSourcesRail>
  )
})

// A source in the rail, which opens it on this App's Logs page.
function LogRailRow({
  children,
  current,
  live = false,
  search,
  status,
  title,
}: {
  children: React.ReactNode
  current: boolean
  live?: boolean
  search: { deployment: string } | { stream: string }
  status: IdentityStatusPresentation
  title: string
}) {
  const { app } = useAppWorkspace()
  return (
    <Link
      replace
      aria-current={current ? "true" : undefined}
      className={logRailRowClassName}
      params={{ appId: app.id }}
      search={search}
      title={title}
      to="/app/$appId/logs"
    >
      <LogRailRowContent live={live} status={status} title={title}>
        {children}
      </LogRailRowContent>
    </Link>
  )
}

function deploymentTitle(deployment: Deployment): string {
  return (
    deployment.commitMessage ??
    `${sourceTypeLabels[deployment.sourceType]} deployment`
  )
}

// The rail, below the width that fits it.
function AppLogsPicker({
  deployments,
  live,
  services,
  source,
}: {
  deployments: ReadonlyArray<Deployment>
  live: LiveDeployments
  services: ReadonlyArray<Service>
  source: LogSource
}) {
  const { app } = useAppWorkspace()
  const navigate = useNavigate()
  const value =
    source.kind === "service"
      ? `${SERVICE_PREFIX}${source.name}`
      : (source.id ?? DEPLOYMENT_STREAM)
  // One opened by its link, past the ones listed.
  const unlisted =
    source.kind === "deployment" &&
    source.id !== null &&
    !deployments.some(({ id }) => id === source.id)
      ? source.id
      : null
  function select(next: string) {
    void navigate({
      params: { appId: app.id },
      replace: true,
      search: next.startsWith(SERVICE_PREFIX)
        ? { stream: next }
        : next === DEPLOYMENT_STREAM
          ? { stream: DEPLOYMENT_STREAM }
          : { deployment: next },
      to: "/app/$appId/logs",
    })
  }
  return (
    <div className="shrink-0 border-b px-3 py-2 md:hidden">
      <Select value={value} onValueChange={select}>
        <SelectTrigger aria-label="Log source" className="h-9 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {services.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Containers</SelectLabel>
              {services.map(({ name }) => (
                <SelectItem
                  key={name}
                  className="font-mono"
                  value={`${SERVICE_PREFIX}${name}`}
                >
                  {name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          <SelectGroup>
            <SelectLabel>Deployments</SelectLabel>
            <SelectItem value={DEPLOYMENT_STREAM}>Latest</SelectItem>
            {unlisted ? (
              <SelectItem value={unlisted}>Older deployment</SelectItem>
            ) : null}
            {deployments.map((deployment) => (
              <SelectItem key={deployment.id} value={deployment.id}>
                {deploymentTitle(deployment)}
                {" · "}
                {deploymentStatusPresentation(deployment).label}
                {isLive(deployment, live) ? " · Live" : ""}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}
