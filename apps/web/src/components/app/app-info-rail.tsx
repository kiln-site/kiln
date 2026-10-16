import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Container, Database } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import {
  useAppContainerSelection,
  type AppContainerTarget,
} from "@/components/app/app-container-selection"
import { appContainers, type App } from "@/components/app/app-presentation"
import {
  InfoCopyValue,
  InfoDetails,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
} from "@/components/info-page"
import { OwnerCard } from "@/components/owner-card"
import { RelativeTime } from "@/components/relative-time"
import { InfoRailRelayLink } from "@/components/resource-info-rail"
import {
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
          leading={<Database />}
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
