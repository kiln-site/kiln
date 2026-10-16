import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRight, TriangleAlert } from "lucide-react"
import type { RelayProxyDiagnostics } from "@workspace/contracts"

import { Popover, PopoverTrigger } from "@workspace/ui/components/popover"

import {
  InfoDetailRow,
  InfoDetails,
  InfoDetailsContent,
  InfoFact,
  InfoSection,
} from "@/components/info-page"
import { messageFrom } from "@/components/relay/relay-actions"
import {
  proxyModeLabels,
  proxyStatusPresentation,
  useRelayLiveStatus,
} from "@/components/relay/relay-presentation"
import {
  RelayConfigureButton,
  useRelayPermission,
} from "@/components/relay/relay-settings"
import { StatusIndicator } from "@/components/status-indicator"
import {
  relayProxyQueryOptions,
  relayHostFilesQueryOptions,
} from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// How the Relay publishes web domains: its proxy's settings and whether it's
// healthy. The bundled Traefik's details only show in that mode.
export function RelayProxySettings({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const { connected } = useRelayLiveStatus(relay)
  const { data: proxy, error } = useQuery({
    ...relayProxyQueryOptions(relay.id),
    enabled: connected,
  })

  if (!proxy) {
    return (
      <InfoSection
        title="Proxy"
        action={<RelayConfigureButton relay={relay} />}
      >
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {!relay.enabled
            ? "Resume this Relay to see its proxy."
            : error
              ? messageFrom(error, "Could not read the proxy settings.")
              : connected
                ? "Reading the proxy settings…"
                : "The proxy appears once Hearth reaches the Relay."}
        </p>
      </InfoSection>
    )
  }

  const { diagnostics, settings } = proxy
  const bundled = settings.mode === "traefik"
  return (
    <InfoSection
      title="Proxy"
      status={
        <>
          <StatusIndicator status={proxyStatusPresentation(diagnostics)} />
          {diagnostics.warnings.length > 0 ? (
            <ProxyWarnings warnings={diagnostics.warnings} />
          ) : null}
        </>
      }
      action={<RelayConfigureButton relay={relay} />}
    >
      <InfoFact label="Mode">{proxyModeLabels[settings.mode]}</InfoFact>
      {bundled ? (
        <>
          <InfoFact label="Traefik image">
            <span className="truncate font-mono text-xs">
              {settings.traefikImage}
            </span>
          </InfoFact>
          <TraefikConfigLink relayId={relay.id} routeId={routeId} />
          <InfoFact label="Certificate email">
            <InfoDetails
              title="Certificate email"
              trigger={settings.acmeEmail ?? "None"}
            >
              <p>
                Let’s Encrypt writes here about certificates the bundled Traefik
                requests, such as ones about to expire.
              </p>
            </InfoDetails>
          </InfoFact>
          <InfoFact label="Traefik">
            {diagnostics.containerRunning ? "Running" : "Not running"}
          </InfoFact>
          <InfoFact label="Public access">
            <InfoDetails
              title="Public access"
              trigger={reachabilityLabel(diagnostics.publicReachability)}
            >
              <p>
                Whether the internet reaches the bundled Traefik, so it can
                serve domains and get certificates for them.
              </p>
            </InfoDetails>
          </InfoFact>
        </>
      ) : null}
      <InfoFact label="Ports">
        <ProxyPorts ports={diagnostics.ports} />
      </InfoFact>
    </InfoSection>
  )
}

// Opens the bundled Traefik's config in the Relay's host files, where it's
// pinned by default and the routes file sits beside it.
function TraefikConfigLink({
  relayId,
  routeId,
}: {
  relayId: string
  routeId: string
}) {
  const canReadFiles = useRelayPermission(relayId, "relay.files.read")
  const { data } = useQuery({
    ...relayHostFilesQueryOptions(relayId),
    enabled: canReadFiles,
  })
  if (!canReadFiles || !data?.traefikConfig) return null
  return (
    <InfoFact label="Traefik config">
      <Link
        to="/relay/$relayId/files/$"
        params={{
          relayId: routeId,
          _splat: data.traefikConfig,
        }}
        className="group flex min-w-0 items-center gap-1.5 font-mono text-xs transition-colors hover:text-primary"
      >
        <span className="truncate">traefik.yaml</span>
        <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </InfoFact>
  )
}

function ProxyPorts({ ports }: { ports: RelayProxyDiagnostics["ports"] }) {
  if (ports.length === 0)
    return <span className="text-muted-foreground">—</span>
  const taken = ports.filter((port) => !port.available)
  const summary =
    taken.length === 0
      ? `${ports.map((port) => port.port).join(" and ")} available`
      : taken
          .map((port) =>
            port.owner
              ? `${port.port} used by ${port.owner}`
              : `${port.port} in use`
          )
          .join(", ")
  return (
    <InfoDetails title="Web ports" trigger={summary}>
      <p>The ports a proxy on this node serves web domains from.</p>
      {ports.map((port) => (
        <InfoDetailRow
          key={port.port}
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
    </InfoDetails>
  )
}

// A warning icon beside the status, as the console's toolbar has; clicking
// it shows what the Relay reported.
function ProxyWarnings({ warnings }: { warnings: ReadonlyArray<string> }) {
  const label =
    warnings.length === 1
      ? "1 proxy warning"
      : `${warnings.length} proxy warnings`
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="grid size-6 shrink-0 place-items-center text-amber-300 transition-colors outline-none hover:text-amber-200 focus-visible:text-amber-200 data-[state=open]:text-amber-200"
      >
        <TriangleAlert className="size-3.5" />
      </PopoverTrigger>
      <InfoDetailsContent
        align="start"
        title={warnings.length === 1 ? "Proxy warning" : "Proxy warnings"}
      >
        <ul className="flex flex-col gap-2">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </InfoDetailsContent>
    </Popover>
  )
}

function reachabilityLabel(
  reachability: RelayProxyDiagnostics["publicReachability"]
): string {
  if (reachability === "reachable") return "Reachable"
  if (reachability === "unreachable") return "Unreachable"
  return "Unknown"
}
