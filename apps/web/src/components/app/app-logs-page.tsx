import * as React from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { Container, Rocket } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"

import {
  appRelayAvailable,
  appServices,
} from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import { ConsoleCopyContext } from "@/components/console/console-copy-context"
import {
  ConsoleLevelMenu,
  ConsoleSearchControl,
} from "@/components/console/console-filters"
import { ConsoleLogViewportController } from "@/components/console/console-log-viewport"
import { ConsoleRetryButton } from "@/components/console/console-retry-button"
import {
  createConsoleStreamStore,
  createConsoleUiStore,
  type ConsoleStreamStore,
  type ConsoleUiStore,
} from "@/components/console/console-stores"
import {
  useRelayBrowserOrigin,
  useRelayConsoleTransport,
} from "@/components/console/console-stream-controller"
import {
  ConsoleRedactButton,
  ConsoleSelectionControl,
  ConsoleTimestampButton,
  ConsoleWrapButton,
} from "@/components/console/console-toolbar-actions"
import { useRelayConsoleStream } from "@/components/console/use-relay-console-stream"
import { consoleCopy } from "@/lib/console-copy"

const DEPLOYMENT_STREAM = "deployment"
const SERVICE_PREFIX = "service:"

// An app's output: the log of its latest deployment, or one service's
// container, each followed live like a database's logs.
export function AppLogsPage() {
  const { app, routeId } = useAppWorkspace()
  const navigate = useNavigate()
  const requested = useSearch({
    from: "/_app/app/$appId/logs",
    select: (search) => search.stream,
  })
  const services = appServices(app)
  const requestedService = requested?.startsWith(SERVICE_PREFIX)
    ? requested.slice(SERVICE_PREFIX.length)
    : null
  // Container output by default once there is any, unless a deployment is
  // running or was asked for.
  const service =
    requestedService ??
    (requested === DEPLOYMENT_STREAM || app.deployment?.state === "running"
      ? null
      : (services[0] ?? null))
  const stream = service ? `${SERVICE_PREFIX}${service}` : DEPLOYMENT_STREAM
  const select = React.useCallback(
    (next: string) =>
      void navigate({
        params: { appId: routeId },
        replace: true,
        search: { stream: next },
        to: "/app/$appId/logs",
      }),
    [navigate, routeId]
  )

  return (
    <AppLogsSession
      key={`${app.relayId}:${app.id}:${stream}`}
      appId={app.id}
      relayAvailable={appRelayAvailable(app)}
      relayId={app.relayId}
      service={service}
      services={services}
      stream={stream}
      onSelect={select}
    />
  )
}

function AppLogsSession({
  appId,
  onSelect,
  relayAvailable,
  relayId,
  service,
  services,
  stream,
}: {
  appId: string
  onSelect: (stream: string) => void
  relayAvailable: boolean
  relayId: string
  service: string | null
  services: ReadonlyArray<string>
  stream: string
}) {
  const [uiStore] = React.useState(createConsoleUiStore)
  const [streamStore] = React.useState(createConsoleStreamStore)

  return (
    <ConsoleCopyContext.Provider value={consoleCopy.app}>
      <section className="flex min-h-0 flex-1 flex-col bg-card">
        <AppLogsStreamController
          appId={appId}
          relayAvailable={relayAvailable}
          relayId={relayId}
          stream={stream}
          streamStore={streamStore}
        />
        <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <div
            role="tablist"
            aria-label="Log source"
            className="flex rounded-lg border bg-background/60 p-0.5"
          >
            <LogSourceTab
              active={service === null}
              icon={<Rocket />}
              label="Deployment"
              onSelect={() => onSelect(DEPLOYMENT_STREAM)}
            />
            <LogSourceTab
              active={service !== null}
              disabled={services.length === 0}
              icon={<Container />}
              label="Containers"
              onSelect={() =>
                onSelect(`${SERVICE_PREFIX}${service ?? services[0]}`)
              }
            />
          </div>
          {service !== null && services.length > 1 ? (
            <Select
              value={service}
              onValueChange={(next) => onSelect(`${SERVICE_PREFIX}${next}`)}
            >
              <SelectTrigger
                aria-label="Service"
                className="h-8 w-auto min-w-36 px-3 font-mono text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {services.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <AppLogsToolbar streamStore={streamStore} uiStore={uiStore} />
        <ConsoleLogViewportController
          active
          streamStore={streamStore}
          uiStore={uiStore}
        />
      </section>
    </ConsoleCopyContext.Provider>
  )
}

function LogSourceTab({
  active,
  disabled = false,
  icon,
  label,
  onSelect,
}: {
  active: boolean
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      disabled={disabled}
      type="button"
      className={cn(
        "type-control-sm flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors disabled:cursor-default disabled:opacity-40 [&_svg]:size-3.5",
        active
          ? "bg-primary/15 text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
      onClick={onSelect}
    >
      {icon}
      {label}
    </button>
  )
}

const AppLogsToolbar = React.memo(function AppLogsToolbar({
  streamStore,
  uiStore,
}: {
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  return (
    <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
      <ConsoleSearchControl uiStore={uiStore} />
      <ConsoleLevelMenu uiStore={uiStore} />
      <ConsoleRetryButton streamStore={streamStore} />
      <div className="ml-auto flex items-center gap-1.5">
        <ConsoleSelectionControl active uiStore={uiStore} />
        <ConsoleRedactButton uiStore={uiStore} />
        <ConsoleWrapButton uiStore={uiStore} />
        <ConsoleTimestampButton uiStore={uiStore} />
      </div>
    </div>
  )
})

const AppLogsStreamController = React.memo(function AppLogsStreamController({
  appId,
  relayAvailable,
  relayId,
  stream,
  streamStore,
}: {
  appId: string
  relayAvailable: boolean
  relayId: string
  stream: string
  streamStore: ConsoleStreamStore
}) {
  const retryVersion = React.useSyncExternalStore(
    streamStore.subscribeRetry,
    streamStore.getRetrySnapshot,
    streamStore.getRetrySnapshot
  )
  const resource = React.useMemo(
    () => ({ id: appId, kind: "app" as const, stream }),
    [appId, stream]
  )
  const snapshot = useRelayConsoleStream(
    relayId,
    resource,
    relayAvailable,
    useRelayBrowserOrigin(relayId),
    useRelayConsoleTransport(relayId),
    // Apps have no server runtime, so no server state lines.
    null,
    undefined,
    false,
    retryVersion
  )
  React.useLayoutEffect(
    () => streamStore.setSnapshot(snapshot),
    [snapshot, streamStore]
  )
  return null
})
