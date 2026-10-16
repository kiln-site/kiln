import { useQuery } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import type { RelayProxyDiagnostics } from "@workspace/contracts"

import {
  InfoDetailRow,
  InfoDetails,
  InfoFact,
  InfoSection,
} from "@/components/info-page"
import { messageFrom } from "@/components/relay/relay-actions"
import {
  proxyModeLabels,
  proxyStatusPresentation,
  useRelayLiveStatus,
} from "@/components/relay/relay-presentation"
import { RelayConfigureButton } from "@/components/relay/relay-settings"
import { RelayTraefikConfigButton } from "@/components/relay/relay-traefik-config"
import { StatusIndicator } from "@/components/status-indicator"
import { relayProxyQueryOptions } from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// How the Relay publishes web domains: its proxy's settings and whether it's
// healthy. The bundled Traefik's details only show in that mode.
export function RelayProxySettings({ relay }: { relay: RelayDirectoryEntry }) {
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
      status={<StatusIndicator status={proxyStatusPresentation(diagnostics)} />}
      action={
        <>
          {bundled ? <RelayTraefikConfigButton relayId={relay.id} /> : null}
          <RelayConfigureButton relay={relay} />
        </>
      }
      notes={
        diagnostics.warnings.length > 0 ? (
          <ProxyWarnings warnings={diagnostics.warnings} />
        ) : null
      }
    >
      <InfoFact label="Mode">{proxyModeLabels[settings.mode]}</InfoFact>
      {bundled ? (
        <>
          <InfoFact label="Traefik image">
            <span className="truncate font-mono text-xs">
              {settings.traefikImage}
            </span>
          </InfoFact>
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

function ProxyWarnings({ warnings }: { warnings: ReadonlyArray<string> }) {
  return (
    <ul className="flex flex-col gap-2 border-t px-4 py-3">
      {warnings.map((warning) => (
        <li
          key={warning}
          className="flex items-start gap-2 text-xs text-amber-300"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {warning}
        </li>
      ))}
    </ul>
  )
}

function reachabilityLabel(
  reachability: RelayProxyDiagnostics["publicReachability"]
): string {
  if (reachability === "reachable") return "Reachable"
  if (reachability === "unreachable") return "Unreachable"
  return "Unknown"
}
