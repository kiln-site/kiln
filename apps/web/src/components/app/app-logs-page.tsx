import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { Container, History, LoaderCircle, Rocket } from "lucide-react"

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
  formatDuration,
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
import { ResourceLogsSession } from "@/components/console/resource-logs"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { RelativeTime } from "@/components/relative-time"
import {
  SizedPanelHandle,
  type PanelSize,
} from "@/components/sized-panel-handle"
import { StatusDot, StatusIndicator } from "@/components/status-indicator"
import {
  appDeploymentLogQueryOptions,
  appDeploymentsQueryOptions,
} from "@/lib/query-options"
import type { AppDeploymentView } from "@/server/app-deployments.server"

const DEPLOYMENT_STREAM = "deployment"
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
  const { app, routeId } = useAppWorkspace()
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
      routeId={routeId}
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
        routeId={routeId}
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
  const { app, routeId } = useAppWorkspace()
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
        params: { appId: routeId },
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

function LogMessage({
  header,
  loading = false,
  message,
}: {
  header: React.ReactNode
  loading?: boolean
  message?: string
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-card">
      {header}
      <div className="grid min-h-0 flex-1 place-items-center bg-background p-6 text-center">
        {loading ? (
          <LoaderCircle className="size-4 animate-spin text-primary-ink" />
        ) : (
          <p className="text-sm text-muted-foreground">{message}</p>
        )}
      </div>
    </section>
  )
}

// The bar above any log: what it is on the left, the rest on the right.
function LogHeader({
  children,
  status,
  title,
}: {
  children?: React.ReactNode
  status?: IdentityStatusPresentation
  title: string
}) {
  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 sm:px-4 md:flex-nowrap md:py-0">
      {status ? <StatusIndicator status={status} /> : null}
      <span className="type-control-sm min-w-0 flex-1 basis-48 truncate">
        {title}
      </span>
      {children ? (
        <span className="type-meta flex shrink-0 items-center gap-2 text-muted-foreground">
          {children}
        </span>
      ) : null}
    </div>
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

// A row's second line and the header's right side, separated the same way.
function LogMeta({ children }: { children: React.ReactNode }) {
  return React.Children.toArray(children).flatMap((item, index) =>
    index === 0
      ? [item]
      : [
          <span key={`separator-${index}`} aria-hidden>
            ·
          </span>,
          item,
        ]
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

// Ticks by itself, so a running deployment re-renders nothing else.
function RunningFor({ startedAt }: { startedAt: string }) {
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span className="tabular-nums">
      Running for {formatDuration(now - Date.parse(startedAt))}
    </span>
  )
}

// Laid out like a database's table list, which is the same kind of panel.
const logRailSize: PanelSize = {
  defaultSize: 256,
  label: "Resize log sources",
  maxSize: (panel) => {
    const page = panel.parentElement?.getBoundingClientRect().width
    return page ? Math.min(440, Math.floor(page * 0.4)) : 440
  },
  minSize: 200,
  storageKey: "kiln:app-log-sources-width",
  variable: "--app-log-sources-width",
}

const AppLogsRail = React.memo(function AppLogsRail({
  appId,
  deployments,
  live,
  relayId,
  routeId,
  services,
  source,
}: {
  appId: string
  deployments: ReadonlyArray<Deployment>
  live: LiveDeployments
  relayId: string
  routeId: string
  services: ReadonlyArray<Service>
  source: LogSource
}) {
  const panelRef = React.useRef<HTMLElement>(null)
  const runtime = source.kind === "service"
  const firstService = services[0]?.name
  const newest = deployments[0]?.id
  return (
    <aside
      ref={panelRef}
      className="relative hidden w-[var(--app-log-sources-width,16rem)] shrink-0 flex-col bg-muted/[0.06] md:flex"
    >
      <div className="grid h-12 shrink-0 grid-cols-2 border-b">
        <Link
          replace
          aria-disabled={firstService === undefined}
          className={cn(railTabClassName, runtime && railTabActiveClassName)}
          disabled={firstService === undefined}
          params={{ appId: routeId }}
          search={{ stream: `${SERVICE_PREFIX}${firstService}` }}
          to="/app/$appId/logs"
        >
          <Container />
          Runtime
        </Link>
        <Link
          replace
          className={cn(railTabClassName, !runtime && railTabActiveClassName)}
          params={{ appId: routeId }}
          search={{ stream: DEPLOYMENT_STREAM }}
          to="/app/$appId/logs"
        >
          <Rocket />
          Deployments
        </Link>
      </div>
      <nav
        aria-label="Log source"
        className="min-h-0 flex-1 overflow-y-auto py-1.5"
      >
        {runtime
          ? services.map((service) => (
              <LogRailRow
                key={service.name}
                current={source.name === service.name}
                routeId={routeId}
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
                routeId={routeId}
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
      </nav>
      {runtime ? null : (
        <div className="flex min-h-10 shrink-0 items-center border-t">
          <Link
            className="flex h-10 flex-1 items-center gap-2 px-3 text-xs text-muted-foreground transition-colors outline-none hover:bg-accent/45 hover:text-foreground focus-visible:bg-accent/55 [&_svg]:size-3.5"
            search={{ appId, relayId }}
            to="/infra/deployments"
          >
            <History />
            All deployments
          </Link>
        </div>
      )}
      {/* Same edge as the file tree: a hairline the resize handle overlaps. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-30 w-px bg-border/80"
      />
      <SizedPanelHandle panelRef={panelRef} size={logRailSize} />
    </aside>
  )
})

// Every source the rail lists, whatever it is, in the same two lines.
function LogRailRow({
  children,
  current,
  live = false,
  routeId,
  search,
  status,
  title,
}: {
  children: React.ReactNode
  current: boolean
  live?: boolean
  routeId: string
  search: { deployment: string } | { stream: string }
  status: IdentityStatusPresentation
  title: string
}) {
  return (
    <Link
      replace
      aria-current={current ? "true" : undefined}
      className="flex w-full gap-2 px-3 py-1.5 text-left text-xs text-foreground/85 outline-none hover:bg-accent/45 focus-visible:bg-accent/55 aria-[current]:bg-primary/12 aria-[current]:font-medium aria-[current]:text-primary-ink"
      params={{ appId: routeId }}
      search={search}
      title={title}
      to="/app/$appId/logs"
    >
      <span className="grid h-[1.125rem] w-3.5 shrink-0 place-items-center">
        <StatusDot status={status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 leading-[1.125rem]">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {live ? (
            <span className="type-label shrink-0 border border-emerald-400/40 px-1 text-[0.625rem] leading-3.5 text-emerald-300 light:text-emerald-700">
              Live
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 overflow-hidden text-[0.6875rem] leading-4 font-normal whitespace-nowrap text-muted-foreground">
          {children}
        </span>
      </span>
    </Link>
  )
}

function deploymentTitle(deployment: Deployment): string {
  return (
    deployment.commitMessage ??
    `${sourceTypeLabels[deployment.sourceType]} deployment`
  )
}

// The look of a page's section tabs.
const railTabClassName =
  "relative flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:bg-accent/55 aria-disabled:pointer-events-none aria-disabled:opacity-40 [&_svg]:size-3.5"
const railTabActiveClassName =
  "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"

// The rail, below the width that fits it.
function AppLogsPicker({
  deployments,
  live,
  routeId,
  services,
  source,
}: {
  deployments: ReadonlyArray<Deployment>
  live: LiveDeployments
  routeId: string
  services: ReadonlyArray<Service>
  source: LogSource
}) {
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
      params: { appId: routeId },
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
