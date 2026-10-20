import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ChevronLeft,
  ChevronRight,
  Container,
  GitCommitHorizontal,
  History,
  Rocket,
  ScrollText,
} from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

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
  InfoDetails,
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
import {
  appDeploymentSummaryQueryOptions,
  appOwnerMinecraftProfileQueryOptions,
  appOwnerQueryOptions,
} from "@/lib/query-options"

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
      <AppContainerCard app={app} />
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
            Deployments
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
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {source.branch}
            </span>
          </a>
        ) : (
          <span className="text-muted-foreground">
            {summary ? sourceTypeLabels[summary.sourceType] : "…"}
          </span>
        )}
      </InfoFact>
      {runningCommit ? (
        <InfoFact label="Running">
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
        </InfoFact>
      ) : null}
      {latest ? (
        <InfoFact label={latest.status === "running" ? "Started" : "Last deploy"}>
          <RelativeTime timestamp={Date.parse(latest.startedAt)} />
        </InfoFact>
      ) : null}
    </InfoRailCard>
  )
})

const railFooterLinkClassName =
  "flex h-9 items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-3.5"

// One container at a time, paged through in its title row. The page's
// service tags select one too.
function AppContainerCard({ app }: { app: App }) {
  const containers = React.useMemo(() => appContainers(app), [app])
  const selection = useAppContainerSelection()
  const selected = React.useSyncExternalStore(
    selection?.subscribe ?? subscribeNever,
    selection?.get ?? getNone,
    getNone
  )
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
    >
      <ContainerFacts app={app} container={container} />
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

function ContainerFacts({
  app,
  container,
}: {
  app: App
  container: App["containers"][number]
}) {
  const labels = Object.entries(container.labels).sort(([left], [right]) =>
    left.localeCompare(right)
  )
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
      <InfoFact label="Name">
        <InfoCopyValue label="container name" value={container.name} />
      </InfoFact>
      <InfoFact label="ID">
        {/* Shortened as Docker shows it; the full ID is what's copied. */}
        <InfoCopyValue
          display={container.id.slice(0, 12)}
          label="container ID"
          value={container.id}
        />
      </InfoFact>
      <InfoFact label="Image">
        <InfoCopyValue label="image" value={container.image} />
      </InfoFact>
      <InfoFact label="State">
        <span
          className={cn(
            "truncate",
            !container.running && "text-muted-foreground"
          )}
          title={container.status}
        >
          {containerState(container)}
        </span>
      </InfoFact>
      {container.running && container.startedAt ? (
        <InfoFact label="Started">
          <RelativeTime timestamp={Date.parse(container.startedAt)} />
        </InfoFact>
      ) : null}
      <InfoFact label="Ports">
        {container.ports.length === 0 ? (
          <span className="text-muted-foreground">None published</span>
        ) : (
          <span className="truncate font-mono text-xs">
            {container.ports
              .map(
                (port) =>
                  `${port.hostPort}→${port.containerPort}/${port.protocol}`
              )
              .join(", ")}
          </span>
        )}
      </InfoFact>
      <InfoFact label="Labels">
        {labels.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <InfoDetails
            title="Docker labels"
            trigger={
              <span className="tabular-nums">
                {labels.length === 1 ? "1 label" : `${labels.length} labels`}
              </span>
            }
          >
            <dl className="flex max-h-72 flex-col gap-1.5 overflow-y-auto font-mono text-[11px]">
              {labels.map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <dt className="truncate" title={key}>
                    {key}
                  </dt>
                  <dd className="break-all text-foreground">{value || "—"}</dd>
                </div>
              ))}
            </dl>
          </InfoDetails>
        )}
      </InfoFact>
      {app.dataDirectory ? (
        <InfoFact label="Data">
          <InfoCopyValue
            display="Copy path"
            label="data path"
            mono={false}
            value={app.dataDirectory}
          />
        </InfoFact>
      ) : null}
    </>
  )
}

// "Running", or how it stopped, as Docker reports it.
function containerState(container: App["containers"][number]): string {
  if (container.running) return "Running"
  if (container.exitCode !== null && container.state === "exited") {
    return `Exited (${container.exitCode})`
  }
  return container.state
    ? `${container.state.charAt(0).toUpperCase()}${container.state.slice(1)}`
    : "Stopped"
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
