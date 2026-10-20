import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  CPU_LIMIT_MILLIS_PER_CORE,
  type AppConfig,
  type ResourceLimits,
} from "@workspace/contracts"
import {
  ChevronLeft,
  ChevronRight,
  Container,
  GitCommitHorizontal,
  History,
  Rocket,
  ScanSearch,
  ScrollText,
} from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { AppContainerDetailsDialog } from "@/components/app/app-container-details-dialog"
import {
  useAppContainerSelection,
  type AppContainerTarget,
} from "@/components/app/app-container-selection"
import {
  deploymentStatusPresentation,
  shortCommit,
} from "@/components/app/app-deployment-presentation"
import {
  appContainers,
  appRelayAvailable,
  sourceTypeLabels,
  type App,
} from "@/components/app/app-presentation"
import { GitHubMark } from "@/components/github-mark"
import {
  InfoCopyValue,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
} from "@/components/info-page"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { OwnerCard } from "@/components/owner-card"
import { RelativeTime } from "@/components/relative-time"
import { InfoRailRelayLink } from "@/components/resource-info-rail"
import { StatusIndicator } from "@/components/status-indicator"
import { UsageBar, percentOf } from "@/components/usage-bar"
import { formatBytes } from "@/lib/format-bytes"
import {
  appConfigQueryOptions,
  appDeploymentSummaryQueryOptions,
  appOwnerMinecraftProfileQueryOptions,
  appOwnerQueryOptions,
  resourceLimitsCapacityQueryOptions,
} from "@/lib/query-options"
import {
  formatCpuLimit,
  formatDiskLimit,
  formatMemoryLimit,
} from "@/lib/resource-limits"

// What the app is at a glance: the Relay it runs on and the databases it
// reaches, who owns it, and its containers, one at a time. Its name and
// status are in the header.
export function AppInfoRail({ app, routeId }: { app: App; routeId: string }) {
  const databases = app.connectedDatabaseIds.length
  return (
    <>
      <InfoRailGroup card>
        <InfoRailRelayLink name={app.relayName} relayId={app.relayId} />
        <InfoRailLink
          to="/app/$appId/network"
          params={{ appId: routeId }}
          leading={<DatabaseKindIcon />}
          detail={
            <span
              className="tabular-nums"
              title={
                databases === 1
                  ? "1 database connected"
                  : `${databases} databases connected`
              }
            >
              {databases}
            </span>
          }
        >
          Databases
        </InfoRailLink>
      </InfoRailGroup>
      <AppOwner appId={app.id} relayId={app.relayId} />
      <AppDeploymentCard app={app} routeId={routeId} />
      <AppContainerCard app={app} routeId={routeId} />
    </>
  )
}

// Shows once the owner loads, so it doesn't stand in for the platform first.
const AppOwner = React.memo(function AppOwner({
  appId,
  relayId,
}: {
  appId: string
  relayId: string
}) {
  const { data: owner } = useQuery(appOwnerQueryOptions(relayId, appId))
  const { data: profileId } = useQuery({
    ...appOwnerMinecraftProfileQueryOptions(relayId, appId, owner?.name ?? ""),
    enabled: Boolean(owner),
  })
  if (owner === undefined) return null
  return (
    <OwnerCard
      email={owner?.email ?? null}
      name={owner?.name ?? null}
      profileId={profileId}
    />
  )
})

// Where the app deploys from, what it runs now, and the way to its
// deployments and their logs.
const AppDeploymentCard = React.memo(function AppDeploymentCard({
  app,
  routeId,
}: {
  app: App
  routeId: string
}) {
  const { data: summary } = useQuery(
    appDeploymentSummaryQueryOptions(app.relayId, app.id)
  )
  // What the running containers were built from, as the Relay labels them.
  const runningCommit =
    appContainers(app).find((container) => container.running)?.labels[
      "kiln.app.commit"
    ] ?? null
  const current =
    summary?.current?.commitSha === runningCommit ? summary?.current : null
  const latest = summary?.latest ?? null
  const source = summary?.source ?? null
  const canReadLogs = app.permissions.includes("app.logs.read")
  return (
    <InfoRailCard
      icon={<Rocket />}
      title="Deployment"
      action={
        latest ? (
          <StatusIndicator status={deploymentStatusPresentation(latest)} />
        ) : null
      }
      sections={
        <div className="grid grid-cols-2 divide-x divide-border/60 border-t">
          <Link
            to="/infra/deployments"
            search={{ appId: app.id, relayId: app.relayId }}
            className={railFooterLinkClassName}
          >
            <History />
            History
          </Link>
          {canReadLogs ? (
            <Link
              to="/app/$appId/logs"
              params={{ appId: routeId }}
              search={{ stream: "deployment" }}
              className={railFooterLinkClassName}
            >
              <ScrollText />
              Logs
            </Link>
          ) : (
            <span
              className={cn(railFooterLinkClassName, "pointer-events-none opacity-50")}
            >
              <ScrollText />
              Logs
            </span>
          )}
        </div>
      }
    >
      <InfoFact label="Source">
        {source ? (
          <a
            className="flex min-w-0 items-center gap-1.5 hover:text-primary"
            href={source.repositoryUrl}
            rel="noreferrer"
            target="_blank"
            title={`${source.repository} on ${source.branch}`}
          >
            <GitHubMark className="size-3.5 shrink-0" />
            <span className="truncate font-mono text-xs">
              {source.repository}
            </span>
          </a>
        ) : (
          <span className="text-muted-foreground">
            {summary ? sourceTypeLabels[summary.sourceType] : "…"}
          </span>
        )}
      </InfoFact>
      {/* Held in place for GitHub apps, so a deploy finishing in the
          background doesn't move the card. */}
      {summary?.sourceType === "github" ? (
        <InfoFact label="Running">
          {runningCommit ? (
          <a
            className="flex min-w-0 items-center gap-1.5 hover:text-primary"
            href={
              current?.commitUrl ??
              (source ? `${source.repositoryUrl}/commit/${runningCommit}` : undefined)
            }
            rel="noreferrer"
            target="_blank"
            title={current?.commitMessage ?? runningCommit}
          >
            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono text-xs">
              {shortCommit(runningCommit)}
            </span>
            {current?.commitMessage ? (
              <span className="truncate text-xs text-muted-foreground">
                {current.commitMessage}
              </span>
            ) : null}
          </a>
          ) : (
            <span className="text-muted-foreground">Not running</span>
          )}
        </InfoFact>
      ) : null}
      <InfoFact label={latest?.status === "running" ? "Started" : "Last deploy"}>
        {latest ? (
          <RelativeTime timestamp={Date.parse(latest.startedAt)} />
        ) : (
          <span className="text-muted-foreground">
            {summary ? "Never" : "…"}
          </span>
        )}
      </InfoFact>
    </InfoRailCard>
  )
})

const railFooterLinkClassName =
  "flex h-9 items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-3.5"

// One container at a time, paged through in its title row. The page's
// service tags select one too.
function AppContainerCard({ app, routeId }: { app: App; routeId: string }) {
  const containers = React.useMemo(() => appContainers(app), [app])
  const selection = useAppContainerSelection()
  const selected = React.useSyncExternalStore(
    selection?.subscribe ?? subscribeNever,
    selection?.get ?? getNone,
    getNone
  )
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const index = selectedIndex(containers, selected)
  const container = containers[index]
  const step = (offset: number) => {
    const next =
      containers[(index + offset + containers.length) % containers.length]
    if (next) selection?.select({ containerId: next.id, service: next.service })
  }

  if (!appRelayAvailable(app))
    return (
      <InfoRailCard icon={<Container />} title="Container">
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {app.runtimeStatus?.phase === "checking"
            ? "Checking containers…"
            : "Container state is unavailable"}
        </p>
      </InfoRailCard>
    )
  if (!container) {
    return (
      <InfoRailCard icon={<Container />} title="Container">
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          Deploy the app to create its containers.
        </p>
      </InfoRailCard>
    )
  }
  return (
    <InfoRailCard
      icon={<Container />}
      title="Container"
      action={
        containers.length > 1 ? (
          <ContainerPager
            count={containers.length}
            index={index}
            onStep={step}
          />
        ) : null
      }
      sections={
        <>
          <div className="border-t border-border/60 px-3">
            <ContainerLimits app={app} service={container.service} />
          </div>
          <div className="grid grid-cols-2 divide-x divide-border/60 border-t">
            <button
              type="button"
              className={railFooterLinkClassName}
              onClick={() => setDetailsOpen(true)}
            >
              <ScanSearch />
              Details
            </button>
            {app.permissions.includes("app.logs.read") ? (
              <Link
                to="/app/$appId/logs"
                params={{ appId: routeId }}
                search={{ stream: `service:${container.service}` }}
                className={railFooterLinkClassName}
              >
                <ScrollText />
                Logs
              </Link>
            ) : (
              <span
                className={cn(
                  railFooterLinkClassName,
                  "pointer-events-none opacity-50"
                )}
              >
                <ScrollText />
                Logs
              </span>
            )}
          </div>
        </>
      }
    >
      <ContainerFacts container={container} />
      {detailsOpen ? (
        <AppContainerDetailsDialog
          container={container}
          onOpenChange={setDetailsOpen}
        />
      ) : null}
    </InfoRailCard>
  )
}

function ContainerPager({
  count,
  index,
  onStep,
}: {
  count: number
  index: number
  onStep: (offset: number) => void
}) {
  return (
    <div className="-mr-1.5 flex items-center gap-0.5">
      <span
        aria-live="polite"
        className="mr-1 text-xs text-muted-foreground tabular-nums"
      >
        <span className="text-foreground">{index + 1}</span>/{count}
      </span>
      <PagerButton label="Previous container" onClick={() => onStep(-1)}>
        <ChevronLeft />
      </PagerButton>
      <PagerButton label="Next container" onClick={() => onStep(1)}>
        <ChevronRight />
      </PagerButton>
    </div>
  )
}

function PagerButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-6 place-items-center text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:text-primary focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3.5!"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

// The container's limits against the node: its service's CPU and memory,
// and the disk the app's data may take.
const ContainerLimits = React.memo(function ContainerLimits({
  app,
  service,
}: {
  app: App
  service: string
}) {
  const select = React.useCallback(
    ({ config }: { config: AppConfig }): ResourceLimits => ({
      cpuMillis: config.serviceLimits[service]?.cpuMillis ?? null,
      diskBytes: config.diskLimitBytes,
      memoryBytes: config.serviceLimits[service]?.memoryBytes ?? null,
    }),
    [service]
  )
  const { data: limits } = useQuery({
    ...appConfigQueryOptions(app.relayId, app.id),
    select,
  })
  const { data: capacity } = useQuery({
    ...resourceLimitsCapacityQueryOptions(app.relayId, "app", app.id),
    enabled: appRelayAvailable(app),
  })
  const cores = capacity?.cpu.nodeCores
  const memoryTotal = capacity?.memory.nodeTotalBytes
  const diskTotal = capacity?.storage.nodeTotalBytes

  return (
    <div className="flex flex-col gap-3 py-3">
      <LimitBar
        indicatorClassName="[&_[data-slot=progress-indicator]]:bg-sky-400/85"
        label="CPU"
        limit={limits?.cpuMillis}
        total={cores === undefined ? undefined : cores * CPU_LIMIT_MILLIS_PER_CORE}
        value={formatCpuLimit}
        detail={
          cores === undefined
            ? undefined
            : `of ${cores} ${cores === 1 ? "core" : "cores"}`
        }
      />
      <LimitBar
        indicatorClassName="[&_[data-slot=progress-indicator]]:bg-violet-400/85"
        label="Memory"
        limit={limits?.memoryBytes}
        total={memoryTotal}
        value={formatMemoryLimit}
        detail={
          memoryTotal === undefined ? undefined : `of ${formatBytes(memoryTotal)}`
        }
      />
      <LimitBar
        indicatorClassName="[&_[data-slot=progress-indicator]]:bg-emerald-400/80"
        label="Disk"
        limit={limits?.diskBytes}
        title="The app's data, shared by its containers"
        total={diskTotal}
        value={formatDiskLimit}
        detail={
          diskTotal === undefined ? undefined : `of ${formatBytes(diskTotal)}`
        }
      />
    </div>
  )
})

// A limit's share of the node; no limit leaves the bar empty.
function LimitBar({
  detail,
  indicatorClassName,
  label,
  limit,
  title,
  total,
  value,
}: {
  detail: string | undefined
  indicatorClassName: string
  label: string
  // `null` for no limit, `undefined` while the config loads.
  limit: number | null | undefined
  title?: string
  total: number | undefined
  value: (limit: number | null) => string
}) {
  return (
    <UsageBar
      detail={limit === null ? undefined : detail}
      indicatorClassName={indicatorClassName}
      label={label}
      percent={
        limit === null || limit === undefined || total === undefined
          ? undefined
          : percentOf(limit, total)
      }
      title={title}
      value={limit === undefined ? "—" : value(limit)}
    />
  )
}

// What the container runs. Its name, ID, and the rest are in its details
// dialog.
function ContainerFacts({
  container,
}: {
  container: App["containers"][number]
}) {
  return (
    <>
      <InfoFact label="Service">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              container.running ? "bg-emerald-400" : "bg-muted-foreground/50"
            )}
          />
          <span className="truncate font-mono text-xs">
            {container.service}
          </span>
        </span>
      </InfoFact>
      <InfoFact label="Image">
        <InfoCopyValue label="image" value={container.image} />
      </InfoFact>
    </>
  )
}

// The selected container, or, once a redeploy replaces it, its service's
// newest container, so the card stays on the same service.
function selectedIndex(
  containers: ReadonlyArray<App["containers"][number]>,
  selected: AppContainerTarget | null
): number {
  if (!selected) return 0
  const byId = selected.containerId
    ? containers.findIndex((container) => container.id === selected.containerId)
    : -1
  if (byId !== -1) return byId
  return Math.max(
    0,
    containers.findIndex((container) => container.service === selected.service)
  )
}

function subscribeNever() {
  return () => undefined
}

function getNone(): AppContainerTarget | null {
  return null
}
