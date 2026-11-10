import * as React from "react"
import { Link } from "@tanstack/react-router"
import { APP_SERVICE, type AppConfig } from "@workspace/contracts"
import { Container, Gauge, ScrollText, Tags } from "lucide-react"

import { buttonVariants } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { AppContainerLabelsDialog } from "@/components/app/app-container-labels-dialog"
import {
  useSelectedAppContainer,
  type AppContainerTarget,
} from "@/components/app/app-container-selection"
import {
  AppLimitsDialog,
  appLimitsPendingDeploy,
} from "@/components/app/app-limits-dialog"
import {
  appContainers,
  appRelayAvailable,
  appServiceAddress,
  appServices,
  type App,
} from "@/components/app/app-presentation"
import {
  DeployToApplyButton,
  useAppRunsCompose,
} from "@/components/app/app-settings"
import {
  InfoCopyValue,
  InfoFact,
  InfoFactPair,
  InfoPager,
  InfoSection,
} from "@/components/info-page"
import { StatusIndicator } from "@/components/status-indicator"
import {
  ContainerUsageMeters,
  SectionIconButton,
} from "@/components/instance-container-section"

type AppContainer = App["containers"][number]

const PENDING_DEPLOY = {
  detail: "Deploy this app to remove the limits taken off its services.",
  label: "Pending deploy",
  tone: "warning",
} as const

// One service's container at a time, chosen from the tabs in its header:
// its live usage against its limits, then what it runs and where it's
// reached. Limits, labels, and logs open from the header.
export function AppContainerSection({
  app,
  config,
}: {
  app: App
  // Until it loads, limits can't open.
  config: AppConfig | undefined
}) {
  const containers = React.useMemo(() => appContainers(app), [app])
  const services = appServices(app)
  const { select, selected } = useSelectedAppContainer()
  const [dialog, setDialog] = React.useState<"labels" | "limits" | null>(null)
  const compose = useAppRunsCompose(app)
  const available = appRelayAvailable(app)
  const index = selectedIndex(containers, selected)
  const container = containers[index]
  // A service runs more than one container while a deploy replaces it.
  const serviceContainers = container
    ? containers.filter((candidate) => candidate.service === container.service)
    : []
  const step = (offset: number) => {
    const at = serviceContainers.findIndex(
      (candidate) => candidate.id === container?.id
    )
    const next =
      serviceContainers[
        (at + offset + serviceContainers.length) % serviceContainers.length
      ]
    if (next) select({ containerId: next.id, service: next.service })
  }
  // Limits and deploying are each a permission of their own.
  const canChangeLimits = app.permissions.includes("instance.limits.write")
  const canDeploy = app.permissions.includes("instance.deploy")
  const pending = config ? appLimitsPendingDeploy(app, config) : false
  // Opens on the service shown. Before the first deploy, an app running one
  // service limits that one, and a Compose app every service it has limits
  // saved for.
  const limitService = container?.service ?? (compose ? null : APP_SERVICE)
  const canLimit =
    config !== undefined &&
    (limitService !== null || Object.keys(config.serviceLimits).length > 0)
  const close = React.useCallback(() => setDialog(null), [])

  const actions = (
    <>
      {pending && canDeploy && available ? (
        <DeployToApplyButton app={app} />
      ) : null}
      {canLimit ? (
        <SectionIconButton
          label={canChangeLimits ? "Resource limits" : "View resource limits"}
          onClick={() => setDialog("limits")}
        >
          <Gauge />
        </SectionIconButton>
      ) : null}
      {container ? (
        <SectionIconButton
          label="Container labels"
          onClick={() => setDialog("labels")}
        >
          <Tags />
        </SectionIconButton>
      ) : null}
      {container && app.permissions.includes("app.logs.read") ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              aria-label={`${container.service} logs`}
              to="/app/$appId/logs"
              params={{ appId: app.id }}
              search={{ stream: `service:${container.service}` }}
              className={cn(
                buttonVariants({ size: "icon-sm", variant: "ghost" }),
                "text-muted-foreground hover:text-foreground"
              )}
            >
              <ScrollText />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom">Logs</TooltipContent>
        </Tooltip>
      ) : null}
      {dialog === "labels" && container ? (
        <AppContainerLabelsDialog container={container} onOpenChange={close} />
      ) : null}
      {dialog === "limits" && config && canLimit ? (
        <AppLimitsDialog
          app={app}
          config={config}
          service={limitService}
          onOpenChange={close}
        />
      ) : null}
    </>
  )

  return (
    <InfoSection
      icon={<Container />}
      title={services.length > 1 ? "Containers" : "Container"}
      status={
        <>
          {services.length > 1 && available ? (
            <ServiceTabs
              containers={containers}
              selected={container?.service ?? null}
              services={services}
              onSelect={(service) => select({ service })}
            />
          ) : null}
          {serviceContainers.length > 1 && container ? (
            <InfoPager
              count={serviceContainers.length}
              index={Math.max(
                0,
                serviceContainers.findIndex(
                  (candidate) => candidate.id === container.id
                )
              )}
              noun={`${container.service} container`}
              onStep={step}
            />
          ) : null}
          {pending ? <StatusIndicator status={PENDING_DEPLOY} /> : null}
        </>
      }
      action={actions}
      content={!available || !container ? true : "flush"}
    >
      {!available || !container ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          {available
            ? "Deploy the app to create its containers."
            : app.runtimeStatus?.phase === "checking"
              ? "Checking containers…"
              : "Container state is unavailable"}
        </p>
      ) : (
        <>
          <dl className="@container px-4">
            <ContainerFacts app={app} container={container} />
          </dl>
          <ContainerUsage
            app={app}
            container={container}
            serviceContainers={serviceContainers}
          />
        </>
      )}
    </InfoSection>
  )
}

// A Compose app's services, each with whether its container runs; the
// chosen one fills the section.
function ServiceTabs({
  containers,
  onSelect,
  selected,
  services,
}: {
  containers: ReadonlyArray<AppContainer>
  onSelect: (service: string) => void
  selected: string | null
  services: ReadonlyArray<string>
}) {
  return (
    <div
      role="group"
      aria-label="Services"
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      {services.map((service) => {
        const container = containers.find(
          (candidate) => candidate.service === service
        )
        const active = service === selected
        return (
          <button
            key={service}
            type="button"
            aria-pressed={active}
            title={`${service}: ${container?.running ? "Running" : "Stopped"}`}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 border px-2 font-mono text-[11px] transition-colors outline-none focus-visible:border-primary",
              active
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
            )}
            onClick={() => onSelect(service)}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                container?.running ? "bg-emerald-400" : "bg-amber-400"
              )}
            />
            {service}
          </button>
        )
      })}
    </div>
  )
}

// CPU and memory side by side. The Relay measures a service's containers
// together, so they're against the limits of its running containers added
// up, which is one container's own outside a deploy.
const ContainerUsage = React.memo(function ContainerUsage({
  app,
  container,
  serviceContainers,
}: {
  app: App
  container: AppContainer
  serviceContainers: ReadonlyArray<AppContainer>
}) {
  const running = serviceContainers.filter((candidate) => candidate.running)
  const measured = running.length > 0 ? running : [container]
  return (
    <ContainerUsageMeters
      cpuMillis={combinedLimit(measured, (limits) => limits.cpuMillis)}
      id={app.id}
      kind="app"
      memoryBytes={combinedLimit(measured, (limits) => limits.memoryBytes)}
      relayId={app.relayId}
      running={running.length > 0}
      service={container.service}
    />
  )
})

// Null when any of them runs without one, since they then share the node.
function combinedLimit(
  containers: ReadonlyArray<AppContainer>,
  read: (limits: NonNullable<AppContainer["limits"]>) => number | null
): number | null {
  let total = 0
  for (const container of containers) {
    const limit = container.limits ? read(container.limits) : null
    if (limit === null) return null
    total += limit
  }
  return total
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
        <InfoFact label="Container">
          <InfoCopyValue label="container name" value={container.name} />
        </InfoFact>
        <InfoFact label="Container ID">
          <InfoCopyValue
            label="container ID"
            display={container.id.slice(0, 12)}
            value={container.id}
          />
        </InfoFact>
      </InfoFactPair>
      <InfoFactPair>
        <InfoFact label="Image">
          <InfoCopyValue label="image" value={container.image} />
        </InfoFact>
        <InfoFact label="Health">
          <ContainerHealth container={container} />
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
    </>
  )
}

// What Docker says of the container's health check, or how it stopped.
function ContainerHealth({ container }: { container: AppContainer }) {
  if (!container.running) {
    return (
      <span className="text-muted-foreground">
        {container.exitCode === null
          ? "Stopped"
          : `Exited with ${container.exitCode}`}
      </span>
    )
  }
  // The Relay reports a health check's state as "running (healthy)".
  if (container.status.endsWith("(unhealthy)")) {
    return <span className="text-destructive">Unhealthy</span>
  }
  if (container.status.endsWith("(healthy)")) {
    return (
      <span className="text-emerald-400 light:text-emerald-700">Healthy</span>
    )
  }
  if (container.status.endsWith("(starting)")) {
    return <span className="text-amber-400 light:text-amber-700">Starting</span>
  }
  return <span className="text-muted-foreground">No health check</span>
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
