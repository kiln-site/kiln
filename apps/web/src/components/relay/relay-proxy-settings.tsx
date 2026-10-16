import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRight, Check, X } from "lucide-react"
import type { RelayProxyDiagnostics } from "@workspace/contracts"

import { cn } from "@workspace/ui/lib/utils"

import {
  InfoDetailRow,
  InfoDetails,
  InfoFact,
  InfoHint,
  InfoSection,
} from "@/components/info-page"
import { messageFrom } from "@/components/relay/relay-actions"
import {
  proxyModeCoverage,
  type ProxyModeCoverage,
  proxyModeLabels,
  proxyStatusPresentation,
  useRelayLiveStatus,
} from "@/components/relay/relay-presentation"
import {
  RelayConfigureButton,
  useRelayHostFiles,
} from "@/components/relay/relay-settings"
import { StatusIndicator } from "@/components/status-indicator"
import { relayProxyQueryOptions } from "@/lib/query-options"
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

  // A paused or unreachable Relay keeps its last reading in the cache; don't
  // present it as current.
  if (!proxy || !connected) {
    return (
      <InfoSection
        title="Proxy"
        action={<RelayConfigureButton relay={relay} />}
      >
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {!relay.enabled
            ? "Resume this Relay to see its proxy."
            : !connected
              ? "The proxy appears once Hearth reaches the Relay."
              : error
                ? messageFrom(error, "Could not read the proxy settings.")
                : "Reading the proxy settings…"}
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
      action={<RelayConfigureButton relay={relay} />}
    >
      <InfoFact label="Mode">
        {proxyModeLabels[settings.mode]}
        <InfoHint
          label="What this proxy mode carries"
          title={proxyModeLabels[settings.mode]}
        >
          <ProxyModeCoverageList coverage={proxyModeCoverage(diagnostics)} />
        </InfoHint>
      </InfoFact>
      {bundled ? (
        <>
          <InfoFact label="Traefik image">
            <span className="truncate font-mono text-xs">
              {settings.traefikImage}
            </span>
          </InfoFact>
          <TraefikConfigLink relay={relay} routeId={routeId} />
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
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const files = useRelayHostFiles(relay)
  if (!files?.traefikConfig) return null
  return (
    <InfoFact label="Traefik config">
      <Link
        to="/relay/$relayId/files/$"
        params={{
          relayId: routeId,
          _splat: files.traefikConfig,
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

function ProxyModeCoverageList({ coverage }: { coverage: ProxyModeCoverage }) {
  return (
    <>
      <p className="type-technical-label text-muted-foreground/80">Proxies</p>
      <ul className="flex flex-col gap-1.5">
        {coverage.items.map(({ covered, label }) => (
          <li
            key={label}
            className={cn(
              "flex items-center gap-2",
              covered ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {covered ? (
              <Check
                aria-label="Yes"
                className="size-3.5 shrink-0 text-emerald-400"
              />
            ) : (
              <X
                aria-label="No"
                className="size-3.5 shrink-0 text-muted-foreground/70"
              />
            )}
            {label}
          </li>
        ))}
      </ul>
      {coverage.note ? <p>{coverage.note}</p> : null}
    </>
  )
}

function reachabilityLabel(
  reachability: RelayProxyDiagnostics["publicReachability"]
): string {
  if (reachability === "reachable") return "Reachable"
  if (reachability === "unreachable") return "Unreachable"
  return "Unknown"
}
