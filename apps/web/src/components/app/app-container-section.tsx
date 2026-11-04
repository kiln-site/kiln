import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Container, ScrollText, Tags } from "lucide-react"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { AppContainerLabelsDialog } from "@/components/app/app-container-labels-dialog"
import {
  useSelectedAppContainer,
  type AppContainerTarget,
} from "@/components/app/app-container-selection"
import {
  appContainers,
  appRelayAvailable,
  appServiceAddress,
  type App,
} from "@/components/app/app-presentation"
import {
  InfoCopyValue,
  InfoFact,
  InfoFactPair,
  InfoPager,
  InfoSection,
} from "@/components/info-page"
import { useUptime } from "@/components/resource-meters"

type AppContainer = App["containers"][number]

const startedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
})

// One container at a time, paged through in its header: what it runs. The
// page's service tags select one too.
export function AppContainerSection({
  app,
  routeId,
}: {
  app: App
  routeId: string
}) {
  const containers = React.useMemo(() => appContainers(app), [app])
  const { select, selected } = useSelectedAppContainer()
  const [labelsOpen, setLabelsOpen] = React.useState(false)
  const index = selectedIndex(containers, selected)
  const container = containers[index]
  const step = (offset: number) => {
    const next =
      containers[(index + offset + containers.length) % containers.length]
    if (next) select({ containerId: next.id, service: next.service })
  }

  if (!appRelayAvailable(app) || !container) {
    return (
      <InfoSection icon={<Container />} title="Container" content>
        <p className="text-[0.8125rem] text-muted-foreground">
          {appRelayAvailable(app)
            ? "Deploy the app to create its containers."
            : app.runtimeStatus?.phase === "checking"
              ? "Checking containers…"
              : "Container state is unavailable"}
        </p>
      </InfoSection>
    )
  }
  return (
    <InfoSection
      icon={<Container />}
      title="Container"
      status={
        containers.length > 1 ? (
          <InfoPager
            count={containers.length}
            index={index}
            noun="container"
            onStep={step}
          />
        ) : null
      }
      action={
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLabelsOpen(true)}
          >
            <Tags />
            Labels
          </Button>
          {app.permissions.includes("app.logs.read") ? (
            <Link
              to="/app/$appId/logs"
              params={{ appId: routeId }}
              search={{ stream: `service:${container.service}` }}
              className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            >
              <ScrollText />
              Logs
            </Link>
          ) : null}
          {labelsOpen ? (
            <AppContainerLabelsDialog
              container={container}
              onOpenChange={setLabelsOpen}
            />
          ) : null}
        </>
      }
    >
      <ContainerFacts app={app} container={container} />
    </InfoSection>
  )
}

function ContainerFacts({
  app,
  container,
}: {
  app: App
  container: AppContainer
}) {
  const address = appServiceAddress(app, container.service)
  return (
    <>
      <InfoFactPair>
        <InfoFact label="Service">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              container.running ? "bg-emerald-400" : "bg-muted-foreground/50"
            )}
          />
          <InfoCopyValue label="service" value={container.service} />
        </InfoFact>
        <InfoFact label="Image">
          <InfoCopyValue label="image" value={container.image} />
        </InfoFact>
      </InfoFactPair>
      <InfoFactPair>
        <InfoFact label="Address">
          <InfoCopyValue
            label={`${container.service} address`}
            value={address}
          />
        </InfoFact>
        <InfoFact label="Ports">
          {container.ports.length === 0 ? (
            <span className="text-muted-foreground">None published</span>
          ) : (
            <span className="flex min-w-0 flex-wrap justify-end gap-x-3 gap-y-1 font-mono text-xs">
              {container.ports.map((port) => (
                <span key={`${port.hostPort}/${port.protocol}`}>
                  {port.hostPort}
                  <span className="text-muted-foreground">
                    {" → "}
                    {port.containerPort}/{port.protocol}
                  </span>
                </span>
              ))}
            </span>
          )}
        </InfoFact>
      </InfoFactPair>
      <InfoFactPair>
        <InfoFact label="Container name">
          <InfoCopyValue label="container name" value={container.name} />
        </InfoFact>
        <InfoFact label="Container ID">
          <InfoCopyValue
            label="container ID"
            value={container.id.slice(0, 12)}
          />
        </InfoFact>
      </InfoFactPair>
      <InfoFactPair>
        <InfoFact label="Started at">
          {container.running && container.startedAt ? (
            <InfoCopyValue
              label="start time"
              mono={false}
              display={startedAtFormatter.format(new Date(container.startedAt))}
              value={container.startedAt}
            />
          ) : (
            <span className="text-muted-foreground">Not running</span>
          )}
        </InfoFact>
        <InfoFact label="Uptime">
          <ContainerUptime container={container} />
        </InfoFact>
      </InfoFactPair>
    </>
  )
}

// Ticks on its own, so the rest of the section doesn't re-render.
function ContainerUptime({ container }: { container: AppContainer }) {
  const uptime = useUptime(container.startedAt, container.running)
  return (
    <span
      className={cn("tabular-nums", uptime === null && "text-muted-foreground")}
    >
      {uptime ?? (container.running ? "—" : "Stopped")}
    </span>
  )
}

// The selected container, or, once a redeploy replaces it, its service's
// newest container, so the section stays on the same service.
function selectedIndex(
  containers: ReadonlyArray<AppContainer>,
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
