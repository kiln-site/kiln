import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Activity,
  Boxes,
  Container,
  FileCode2,
  Globe2,
  LoaderCircle,
  Mail,
  Network,
  Route,
  Server,
  Settings2,
  TriangleAlert,
  Waypoints,
} from "lucide-react"
import type { RelayProxyConfiguration } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { CodeDocumentPanel } from "@/components/code-document-panel"
import { InfoCard, InfoCardHeader, MetaRow } from "@/components/info-card"
import type { InstanceStatusPresentation } from "@/components/instance-name-presentation"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { StatusIndicator } from "@/components/status-indicator"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  relayProxyConfigurationQueryOptions,
  relayProxyQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { RelayDirectoryEntry } from "@/lib/relay-route"
import type { getRelayProxy } from "@/server/relays"

// Only loaded when someone opens it, so the Relays page stays out of this
// route.
const EditRelayDialog = React.lazy(async () => {
  const module = await import("@/components/relays-page")
  return { default: module.EditRelayDialog }
})

type ProxyDiagnostics = Awaited<ReturnType<typeof getRelayProxy>>

const proxyModeLabels = {
  coolify: "Coolify Traefik",
  hearth: "Hearth proxy",
  none: "None / existing Traefik",
  traefik: "Bundled Traefik",
} as const

// How the Relay publishes web routes: its proxy settings and health, the
// routes it serves, and the Traefik configuration it generates for them.
export function RelayProxyPage() {
  const { relay } = useRelayWorkspace()
  const { connected } = useRelayLiveStatus(relay)

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        {connected ? (
          <>
            <RelayProxyStatusCard relay={relay} />
            <RelayProxyRoutes relayId={relay.id} />
          </>
        ) : (
          <InfoCard>
            <InfoCardHeader icon={<Waypoints />} title="Proxy" />
            <p className="px-4 py-5 text-sm text-muted-foreground">
              {relay.enabled
                ? "The proxy configuration appears once Hearth reaches the Relay."
                : "Resume this Relay to see its proxy configuration."}
            </p>
          </InfoCard>
        )}
      </div>
    </section>
  )
}

function RelayProxyStatusCard({ relay }: { relay: RelayDirectoryEntry }) {
  const proxy = useQuery(relayProxyQueryOptions(relay.id))
  const { data: canConfigure = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relay.id, "relay.configure"),
  })
  const [editing, setEditing] = React.useState(false)

  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Waypoints />}
        title="Proxy"
        action={
          <div className="flex items-center gap-2">
            {proxy.data ? (
              <StatusIndicator
                status={proxyStatusPresentation(proxy.data.diagnostics)}
              />
            ) : null}
            {canConfigure ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
              >
                <Settings2 />
                Configure
              </Button>
            ) : null}
          </div>
        }
      />
      {proxy.data ? (
        <RelayProxyDetails proxy={proxy.data} />
      ) : (
        <QueryState
          error={proxy.error}
          errorFallback="Could not read the proxy configuration"
          pendingLabel="Reading proxy configuration…"
        />
      )}
      {editing ? (
        <React.Suspense fallback={null}>
          <EditRelayDialog relay={relay} open onOpenChange={setEditing} />
        </React.Suspense>
      ) : null}
    </InfoCard>
  )
}

function RelayProxyDetails({ proxy }: { proxy: ProxyDiagnostics }) {
  const { diagnostics, settings } = proxy
  const bundled = settings.mode === "traefik"
  return (
    <>
      <div className="grid sm:grid-cols-2">
        <MetaRow
          icon={Waypoints}
          label="Mode"
          value={proxyModeLabels[settings.mode]}
        />
        <MetaRow
          icon={Globe2}
          label="Browser origin"
          value={diagnostics.browserOrigin}
          mono
        />
        {bundled ? (
          <>
            <MetaRow
              icon={Container}
              label="Traefik image"
              value={settings.traefikImage}
              mono
            />
            <MetaRow
              icon={Activity}
              label="Traefik container"
              value={diagnostics.containerRunning ? "Running" : "Not running"}
            />
            <MetaRow
              icon={Mail}
              label="Certificate email"
              value={settings.acmeEmail ?? "None"}
            />
            <MetaRow
              icon={Globe2}
              label="Public reachability"
              value={
                diagnostics.publicReachability === "reachable"
                  ? "Reachable"
                  : diagnostics.publicReachability === "unreachable"
                    ? "Unreachable"
                    : "Unknown"
              }
            />
          </>
        ) : null}
        {diagnostics.ports.map((port) => (
          <MetaRow
            key={port.port}
            icon={Network}
            label={`Port ${port.port}`}
            value={
              port.available
                ? "Available"
                : port.owner
                  ? `In use by ${port.owner}`
                  : "In use"
            }
          />
        ))}
      </div>
      {diagnostics.warnings.length > 0 ? (
        <ul className="space-y-2 border-t px-4 py-3">
          {diagnostics.warnings.map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-2 text-xs text-amber-300"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

function proxyStatusPresentation(
  diagnostics: ProxyDiagnostics["diagnostics"]
): InstanceStatusPresentation {
  switch (diagnostics.status) {
    case "ready":
      return { label: "Ready", tone: "success" }
    case "starting":
      return { label: "Starting", pulse: true, tone: "info" }
    case "blocked":
      return { label: "Blocked", tone: "danger" }
    case "hearth":
      return { label: "Through Hearth", tone: "info" }
    case "disabled":
      return { label: "Disabled", tone: "neutral" }
  }
}

function RelayProxyRoutes({ relayId }: { relayId: string }) {
  const configuration = useQuery(relayProxyConfigurationQueryOptions(relayId))

  if (!configuration.data) {
    return (
      <InfoCard className="mt-4">
        <InfoCardHeader icon={<Route />} title="Routes" />
        <QueryState
          error={configuration.error}
          errorFallback="Could not read the proxy configuration."
          pendingLabel="Reading routes…"
        />
      </InfoCard>
    )
  }
  return (
    <>
      <RelayRoutesCard relayId={relayId} routes={configuration.data.routes} />
      {configuration.data.dynamicConfiguration !== null &&
      configuration.data.staticConfiguration !== null ? (
        <TraefikConfigurationCard
          dynamicConfiguration={configuration.data.dynamicConfiguration}
          staticConfiguration={configuration.data.staticConfiguration}
        />
      ) : null}
    </>
  )
}

type ProxyRoute = RelayProxyConfiguration["routes"][number]

// Plain objects, so structural sharing keeps them stable while names don't
// change.
function selectRelayServers(relayId: string) {
  return (snapshot: RelayFleetSnapshot) =>
    Object.fromEntries(
      snapshot.instances
        .filter((instance) => instance.relayId === relayId)
        .map((instance) => [
          instance.id,
          { name: instance.name, routeId: instance.routeId },
        ])
    )
}

function selectAppNames(apps: Array<{ id: string; name: string }>) {
  return Object.fromEntries(apps.map((app) => [app.id, app.name]))
}

function RelayRoutesCard({
  relayId,
  routes,
}: {
  relayId: string
  routes: ReadonlyArray<ProxyRoute>
}) {
  const selectServers = React.useMemo(
    () => selectRelayServers(relayId),
    [relayId]
  )
  const { data: servers = {} } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectServers,
  })
  const { data: appNames = {} } = useQuery({
    ...appDirectoryQueryOptions(),
    select: selectAppNames,
  })

  return (
    <InfoCard className="mt-4">
      <InfoCardHeader
        icon={<Route />}
        title="Routes"
        action={
          <span className="type-meta text-muted-foreground">
            {routes.length} {routes.length === 1 ? "route" : "routes"}
          </span>
        }
      />
      {routes.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground">
          No servers or apps on this Relay publish a web route yet.
        </p>
      ) : (
        <ul>
          {routes.map((route) => (
            <li
              key={route.id}
              className="grid gap-1 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4"
            >
              <a
                href={`https://${route.hostname}${route.path ?? ""}`}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-xs text-foreground hover:text-primary"
              >
                {route.hostname}
                {route.path ?? ""}
              </a>
              {route.owner.kind === "app" ? (
                <Link
                  to="/app/$appId/network"
                  params={{ appId: route.owner.id }}
                  className="flex min-w-0 items-center gap-1.5 text-xs hover:text-primary"
                >
                  <Boxes className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {appNames[route.owner.id] ?? route.owner.id.slice(0, 8)}
                  </span>
                  {route.owner.service ? (
                    <span className="truncate text-muted-foreground">
                      · {route.owner.service}
                    </span>
                  ) : null}
                </Link>
              ) : (
                <ServerRouteOwner
                  id={route.owner.id}
                  server={servers[route.owner.id]}
                />
              )}
              <span
                className="truncate font-mono text-xs text-muted-foreground"
                title={route.upstream}
              >
                {route.upstream}
              </span>
            </li>
          ))}
        </ul>
      )}
    </InfoCard>
  )
}

function ServerRouteOwner({
  id,
  server,
}: {
  id: string
  server: { name: string; routeId: string } | undefined
}) {
  const content = (
    <>
      <Server className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{server?.name ?? id.slice(0, 8)}</span>
    </>
  )
  return server ? (
    <Link
      to="/server/$serverId/network"
      params={{ serverId: server.routeId }}
      className="flex min-w-0 items-center gap-1.5 text-xs hover:text-primary"
    >
      {content}
    </Link>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">{content}</span>
  )
}

// The bundled Traefik's files, as the Relay writes them.
function TraefikConfigurationCard({
  dynamicConfiguration,
  staticConfiguration,
}: {
  dynamicConfiguration: string
  staticConfiguration: string
}) {
  const files = [
    { content: dynamicConfiguration, id: "dynamic", name: "dynamic/kiln.yaml" },
    { content: staticConfiguration, id: "static", name: "traefik.yml" },
  ]
  const [selected, setSelected] = React.useState("dynamic")
  const file = files.find(({ id }) => id === selected) ?? files[0]!

  return (
    <InfoCard className="mt-4">
      <InfoCardHeader
        icon={<FileCode2 />}
        title="Traefik configuration"
        action={
          <div
              role="tablist"
              aria-label="Configuration file"
              className="flex rounded-lg border bg-background/60 p-0.5"
            >
              {files.map(({ id, name }) => (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  aria-selected={id === file.id}
                  className={cn(
                    "type-control-sm rounded-md px-2.5 py-1 font-mono transition-colors",
                    id === file.id
                      ? "bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setSelected(id)}
                >
                  {name}
                </button>
              ))}
            </div>
        }
      />
      <div className="flex h-[28rem] min-h-0 flex-col">
        <CodeDocumentPanel
          key={file.id}
          content={file.content}
          languagePath={file.name}
          noun="configuration"
          title={file.name}
        />
      </div>
    </InfoCard>
  )
}

function QueryState({
  error,
  errorFallback,
  pendingLabel,
}: {
  error: Error | null
  errorFallback: string
  pendingLabel: string
}) {
  return error ? (
    <p className="flex items-start gap-2 px-4 py-5 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      {error.message || errorFallback}
    </p>
  ) : (
    <p className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" />
      {pendingLabel}
    </p>
  )
}
