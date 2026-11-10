import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { linkOptions, useRouter, useSearch } from "@tanstack/react-router"

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
  InstanceLogsPage,
  LISTED_DEPLOYMENTS,
  type InstanceLogsLinks,
  type LogSource,
  type LoggedDeployment,
} from "@/components/console/instance-logs-page"
import {
  DEPLOYMENT_STREAM,
  LogMessage,
  LogMeta,
  RunningFor,
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
type RequestedLog =
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
  const { data: records = emptyDeployments, isPending } = useInfiniteQuery({
    ...appDeploymentsQueryOptions({ appId: app.id, relayId: app.relayId }),
    select: listedDeployments,
  })
  const services = React.useMemo(() => appLogServices(app), [app])
  const source = logSource(
    requestedDeployment,
    requested,
    services,
    app.deployment?.state === "running"
  )
  const sources = React.useMemo(
    () =>
      services.map(
        (service): LogSource => ({
          id: service.name,
          meta: <ServiceMeta service={service} />,
          status: service.status,
          title: service.name,
        })
      ),
    [services]
  )
  const deployments = React.useMemo(() => {
    const live = liveDeployments(app)
    return records.map(
      (deployment): LoggedDeployment => ({
        headingMeta: <DeploymentMeta deployment={deployment} full />,
        id: deployment.id,
        live: isLive(deployment, live),
        meta: <DeploymentMeta deployment={deployment} />,
        status: deploymentStatusPresentation(deployment),
        title: deploymentTitle(deployment),
      })
    )
  }, [app, records])
  const links = React.useMemo((): InstanceLogsLinks => {
    const here = {
      params: { appId: app.id },
      to: "/app/$appId/logs",
    } as const
    return {
      all: linkOptions({
        search: { appId: app.id, relayId: app.relayId },
        to: "/infra/deployments",
      }),
      deployment: (id) => linkOptions({ ...here, search: { deployment: id } }),
      latest: linkOptions({ ...here, search: { stream: DEPLOYMENT_STREAM } }),
      source: (name) =>
        linkOptions({
          ...here,
          search: { stream: `${SERVICE_PREFIX}${name}` },
        }),
    }
  }, [app.id, app.relayId])
  // The one the Relay is on, or the newest.
  const latest =
    records.find(
      ({ relayDeploymentId }) => relayDeploymentId === app.deployment?.id
    ) ?? records[0]
  return (
    <InstanceLogsPage
      deployments={deployments}
      latestId={latest?.id}
      links={links}
      renderDeployment={(id, header) => (
        <DeploymentLogs
          deployments={records}
          header={header}
          id={id}
          pending={isPending}
        />
      )}
      renderSource={(name, header) => (
        <ResourceLogsSession
          key={`${app.relayId}:${app.id}:${name}`}
          header={header}
          id={app.id}
          kind="app"
          logName={`${app.name}-${name}`}
          relayAvailable={appRelayAvailable(app)}
          relayId={app.relayId}
          stream={`${SERVICE_PREFIX}${name}`}
        />
      )}
      showing={
        source.kind === "service"
          ? { id: source.name, kind: "source" }
          : { id: source.id, kind: "deployment" }
      }
      sources={sources}
    />
  )
}

const emptyDeployments: ReadonlyArray<Deployment> = []

function logSource(
  deployment: string | undefined,
  stream: string | undefined,
  services: ReadonlyArray<Service>,
  deploying: boolean
): RequestedLog {
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
  header,
  id,
  pending,
}: {
  deployments: ReadonlyArray<Deployment>
  header: React.ReactNode
  id: string | null
  pending: boolean
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

function deploymentTitle(deployment: Deployment): string {
  return (
    deployment.commitMessage ??
    `${sourceTypeLabels[deployment.sourceType]} deployment`
  )
}
