import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Link,
  useNavigate,
  useRouter,
  type LinkProps,
} from "@tanstack/react-router"
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
import { SavedLogSession } from "@/components/console/resource-logs"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { RelativeTime } from "@/components/relative-time"
import type { AppDeploymentStatus } from "@/effect/app-deployments"
import { serverDeploymentLogQueryOptions } from "@/lib/query-options"

// The Logs page every kind of instance has: what it has output from, its
// containers and each deployment the Relay kept a log of, in a rail beside
// whichever one is shown. Each kind says what its sources and deployments
// are and how one's log is read; the page is the same.

// What the Relay keeps logs of; older deployments live on in History.
export const LISTED_DEPLOYMENTS = 20

/** A container whose output is followed live. */
export interface LogSource {
  /** What heads its log, when that isn't its row's title and second line. */
  heading?: { meta?: React.ReactNode; title: string }
  id: string
  /** Its row's second line. */
  meta: React.ReactNode
  status: IdentityStatusPresentation
  title: string
}

/** A deployment as the page lists it, whatever kind it is of. */
export interface LoggedDeployment {
  id: string
  /** Its containers are the ones running. */
  live?: boolean
  /** Its row's second line. */
  meta: React.ReactNode
  /** The right side of the bar above its log. */
  headingMeta: React.ReactNode
  status: IdentityStatusPresentation
  /** What it was, such as "Redeploy". */
  title: string
}

/** Where the page's sources are, on the instance's own Logs route. */
export interface InstanceLogsLinks {
  /** Every deployment, on the Deployments page. */
  all: LinkProps
  deployment: (id: string) => LinkProps
  /** The latest deployment. */
  latest: LinkProps
  /** A container's output. */
  source: (id: string) => LinkProps
}

/** What is shown: a container's output, or a deployment, null the latest. */
export type ShownLog =
  | { kind: "deployment"; id: string | null }
  | { kind: "source"; id: string }

export function InstanceLogsPage({
  deployments,
  latestId,
  links,
  renderDeployment,
  renderSource,
  showing,
  sources,
}: {
  deployments: ReadonlyArray<LoggedDeployment>
  /** The deployment the latest one is, which heads its log. */
  latestId: string | undefined
  links: InstanceLogsLinks
  /** A deployment's log, under `header`; `id` is null for the latest. */
  renderDeployment: (
    id: string | null,
    header: React.ReactNode
  ) => React.ReactNode
  /** A container's output, under `header`. */
  renderSource: (id: string, header: React.ReactNode) => React.ReactNode
  showing: ShownLog
  /**
   * The containers whose output is listed, or null for a kind whose output
   * isn't here: a game server's is its console.
   */
  sources: ReadonlyArray<LogSource> | null
}) {
  const picker = (
    <LogsPicker
      deployments={deployments}
      links={links}
      showing={showing}
      sources={sources ?? []}
    />
  )
  const source =
    showing.kind === "source"
      ? sources?.find(({ id }) => id === showing.id)
      : undefined
  const deployment =
    showing.kind === "deployment"
      ? deployments.find(({ id }) => id === (showing.id ?? latestId))
      : undefined
  return (
    <div className="flex min-h-0 flex-1">
      <LogsRail
        deployments={deployments}
        latestId={latestId}
        links={links}
        showing={showing}
        sources={sources}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {showing.kind === "source"
          ? renderSource(
              showing.id,
              <>
                {picker}
                <LogHeader
                  title={source?.heading?.title ?? source?.title ?? showing.id}
                  {...(source && { status: source.status })}
                >
                  {source?.heading ? source.heading.meta : source?.meta}
                </LogHeader>
              </>
            )
          : renderDeployment(
              showing.id,
              <>
                {picker}
                {deployment ? (
                  <LogHeader
                    status={deployment.status}
                    title={deployment.title}
                  >
                    {deployment.headingMeta}
                  </LogHeader>
                ) : (
                  <LogHeader title="Deployment" />
                )}
              </>
            )}
      </div>
    </div>
  )
}

const LogsRail = React.memo(function LogsRail({
  deployments,
  latestId,
  links,
  showing,
  sources,
}: {
  deployments: ReadonlyArray<LoggedDeployment>
  latestId: string | undefined
  links: InstanceLogsLinks
  showing: ShownLog
  sources: ReadonlyArray<LogSource> | null
}) {
  const runtime = showing.kind === "source"
  const first = sources?.[0]?.id
  return (
    <LogSourcesRail
      footer={
        runtime ? undefined : (
          <Link {...links.all} className={logRailFooterLinkClassName}>
            <History />
            All deployments
          </Link>
        )
      }
      tabs={
        <>
          {sources ? (
            <Link
              {...links.source(first ?? "")}
              replace
              aria-disabled={first === undefined}
              className={cn(
                logRailTabClassName,
                runtime && logRailTabActiveClassName
              )}
              disabled={first === undefined}
            >
              <Container />
              Runtime
            </Link>
          ) : null}
          <Link
            {...links.latest}
            replace
            className={cn(
              logRailTabClassName,
              !runtime && logRailTabActiveClassName
            )}
          >
            <Rocket />
            Deployments
          </Link>
        </>
      }
    >
      {runtime
        ? (sources ?? []).map((source) => (
            <Link
              key={source.id}
              {...links.source(source.id)}
              replace
              aria-current={showing.id === source.id ? "true" : undefined}
              className={logRailRowClassName}
              title={source.title}
            >
              <LogRailRowContent status={source.status} title={source.title}>
                {source.meta}
              </LogRailRowContent>
            </Link>
          ))
        : deployments.map((deployment) => (
            <Link
              key={deployment.id}
              {...links.deployment(deployment.id)}
              replace
              aria-current={
                (showing.id ?? latestId) === deployment.id ? "true" : undefined
              }
              className={logRailRowClassName}
              title={deployment.title}
            >
              <LogRailRowContent
                live={deployment.live === true}
                status={deployment.status}
                title={deployment.title}
              >
                {deployment.meta}
              </LogRailRowContent>
            </Link>
          ))}
      {!runtime && deployments.length === 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          No deployments yet
        </p>
      ) : null}
    </LogSourcesRail>
  )
})

const SOURCE_PREFIX = "source:"

// The rail, below the width that fits it.
function LogsPicker({
  deployments,
  links,
  showing,
  sources,
}: {
  deployments: ReadonlyArray<LoggedDeployment>
  links: InstanceLogsLinks
  showing: ShownLog
  sources: ReadonlyArray<LogSource>
}) {
  const navigate = useNavigate()
  // One opened by its link, past the ones listed.
  const unlisted =
    showing.kind === "deployment" &&
    showing.id !== null &&
    !deployments.some(({ id }) => id === showing.id)
      ? showing.id
      : null
  function select(next: string) {
    void navigate({
      ...(next.startsWith(SOURCE_PREFIX)
        ? links.source(next.slice(SOURCE_PREFIX.length))
        : next === DEPLOYMENT_STREAM
          ? links.latest
          : links.deployment(next)),
      replace: true,
    })
  }
  return (
    <div className="shrink-0 border-b px-3 py-2 md:hidden">
      <Select
        value={
          showing.kind === "source"
            ? `${SOURCE_PREFIX}${showing.id}`
            : (showing.id ?? DEPLOYMENT_STREAM)
        }
        onValueChange={select}
      >
        <SelectTrigger aria-label="Log source" className="h-9 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sources.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Containers</SelectLabel>
              {sources.map(({ id, title }) => (
                <SelectItem
                  key={id}
                  className="font-mono"
                  value={`${SOURCE_PREFIX}${id}`}
                >
                  {title}
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
                {deployment.title}
                {" · "}
                {deployment.status.label}
                {deployment.live ? " · Live" : ""}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

/** A game server's or a database's deployment, as its record has it. */
export interface RequestDeploymentRecord {
  error: string | null
  finishedAt: string | null
  id: string
  startedAt: string
  status: AppDeploymentStatus
  triggeredByName: string | null
}

/** How a game server's or a database's deployment is listed. */
export function requestDeploymentEntry(
  record: RequestDeploymentRecord,
  title: string
): LoggedDeployment {
  return {
    headingMeta: <RequestDeploymentMeta deployment={record} full />,
    id: record.id,
    meta: <RequestDeploymentMeta deployment={record} />,
    status: deploymentStatusPresentation({ ...record, rolling: null }),
    title,
  }
}

function RequestDeploymentMeta({
  deployment,
  full = false,
}: {
  deployment: RequestDeploymentRecord
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

/**
 * The log the Relay saved of a game server's or a database's deployment,
 * read again while it runs. With no deployment, there is none yet.
 */
export function RequestDeploymentLog({
  header,
  instance,
  pending,
  record,
  shareLink,
}: {
  header: React.ReactNode
  instance: { id: string; name: string }
  /** Its deployments are still loading. */
  pending: boolean
  /** The deployment shown: its record when listed, or only its ID. */
  record: Pick<RequestDeploymentRecord, "error" | "id" | "status"> | undefined
  shareLink: (id: string) => LinkProps
}) {
  const id = record?.id
  if (id === undefined) {
    return (
      <LogMessage
        header={header}
        loading={pending}
        message="No deployments yet"
      />
    )
  }
  return (
    <SavedRequestDeploymentLog
      key={id}
      failure={record?.error ?? null}
      header={header}
      id={id}
      instance={instance}
      running={record?.status === "running"}
      shareLink={shareLink(id)}
    />
  )
}

function SavedRequestDeploymentLog({
  failure,
  header,
  id,
  instance,
  running,
  shareLink,
}: {
  /** Why it failed, which is all there is of one the Relay never began. */
  failure: string | null
  header: React.ReactNode
  id: string
  instance: { id: string; name: string }
  running: boolean
  shareLink: LinkProps
}) {
  const router = useRouter()
  const { data, error, isPending } = useQuery({
    ...serverDeploymentLogQueryOptions(instance.id, id),
    refetchInterval: running ? 1_000 : false,
  })
  const log = data?.log ?? null
  const saved = React.useMemo<ConsoleStreamSnapshot | null>(
    () =>
      log && {
        connection: "live",
        consoleData: {
          instanceId: instance.id,
          lifecycle: [],
          lines: log.lines,
          truncated: false,
        },
        error: null,
        loading: false,
        transport: null,
        transportMessage: null,
      },
    [instance.id, log]
  )
  if (isPending) return <LogMessage header={header} loading />
  if (!log || !saved) {
    return (
      <LogMessage
        header={header}
        message={
          error?.message ??
          failure ??
          data?.reason ??
          "This log is no longer kept"
        }
      />
    )
  }
  return (
    <SavedLogSession
      elapsedFrom={log.deployment.startedAt}
      header={header}
      logName={`${instance.name}-deployment`}
      saved={saved}
      shareHref={router.buildLocation(shareLink).href}
      timeMode="elapsed"
    />
  )
}
