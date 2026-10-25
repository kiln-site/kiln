import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight,
  CircleAlert,
  ScrollText,
  ShieldCheck,
  TerminalSquare,
  Zap,
} from "lucide-react"
import type { RelayPlatformStatus } from "@workspace/contracts"

import { HearthMark } from "@/components/hearth-mark"
import {
  InfoCopyValue,
  InfoFact,
  InfoHint,
  InfoPage,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
  InfoSection,
  InfoSectionLink,
} from "@/components/info-page"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { InstanceKindCounts } from "@/components/instance-kind-counts"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { KilnRestartButton } from "@/components/kiln/kiln-actions"
import { KilnDataSection } from "@/components/kiln/kiln-data-section"
import {
  kilnContainerPresentation,
  kilnContainers,
  kilnDeployer,
  kilnCopy,
  kilnShellAvailable,
  kilnVersion,
  useKilnHost,
  type KilnContainer,
} from "@/components/kiln/kiln-presentation"
import { OwnerCard } from "@/components/owner-card"
import {
  RelayNodeCard,
  useRelayNodeFacts,
} from "@/components/relay/relay-node-card"
import { RelativeTime } from "@/components/relative-time"
import {
  InfoRailBackupsLink,
  InfoRailRelayLink,
} from "@/components/resource-info-rail"
import { StatusIndicator } from "@/components/status-indicator"
import {
  appDirectoryQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
  relaysQueryOptions,
} from "@/lib/query-options"
import {
  relayRouteIdentifier,
  type RelayDirectoryEntry,
} from "@/lib/relay-route"
import { kilnFavorite } from "@/lib/instance-favorites"
import { selectSidebarInstanceCount } from "@/lib/relay-selectors"
import {
  queueTerminalInput,
  relayTerminalInputKey,
} from "@/lib/terminal-prefill"
import type { KilnPlatformHost } from "@/server/platform"

// Kiln's own services, each with what can be done to it, the commands for
// the Relay's host, and a rail summing up the installation.
export function KilnInfoPage() {
  const host = useKilnHost()
  if (!host) return null
  const status = host.status
  return (
    <InfoPage rail={<KilnInfoRail host={host} />}>
      {host.error ? (
        <KilnNotice>{host.error}</KilnNotice>
      ) : status?.issue ? (
        <KilnNotice>{status.issue}</KilnNotice>
      ) : null}
      {status ? (
        <>
          <div className="@container">
            <div className="grid gap-4 @2xl:grid-cols-2">
              {kilnContainers(status).map((container) => (
                <KilnContainerSection
                  key={container.target}
                  container={container}
                  host={host}
                />
              ))}
              {/* Older Relays don't report the proxy at all. */}
              {status.proxy === null ? (
                <NoProxySection status={status} />
              ) : null}
            </div>
          </div>
          <KilnDataSection host={host} />
          <KilnCommandsSection relayId={host.relayId} status={status} />
        </>
      ) : null}
    </InfoPage>
  )
}

function KilnNotice({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 border border-amber-400/25 bg-amber-400/8 px-3 py-2.5 text-xs leading-5 text-amber-200 light:text-amber-800"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

function containerIcon(container: KilnContainer) {
  switch (container.target) {
    case "hearth":
      return <HearthMark className="size-4" />
    case "database":
      return <DatabaseKindIcon />
    case "cache":
      return <Zap />
    case "proxy":
      return <ShieldCheck />
  }
}

const managerLabels = {
  compose: "Compose",
  coolify: "Coolify",
  external: "Outside Kiln",
  kiln: "Kiln",
} as const

const proxyManagerHints = {
  coolify:
    "Coolify runs this Traefik, so Kiln only shows it. Change its settings in Coolify; Kiln's labels on Hearth route its address through it.",
  external:
    "This Traefik already served ports 80 and 443 on this host, so Kiln only shows it. Change it where it was set up.",
  kiln: "The Relay runs this Traefik for Hearth and renews its Let's Encrypt certificates.",
} as const

// Services the Relay installed don't say who manages them.
const serviceManagerHints = {
  compose:
    "Docker Compose runs it, so Kiln only shows it. Change it in its Compose file.",
  coolify: "Coolify runs it, so Kiln only shows it. Change it in Coolify.",
  external:
    "It was deployed outside Kiln, so Kiln only shows it. Change it where it was set up.",
} as const

function managerHint(container: KilnContainer): string | null {
  const managedBy = container.managedBy
  if (!managedBy) return null
  if (container.target === "proxy" && managedBy !== "compose") {
    return proxyManagerHints[managedBy]
  }
  return managedBy === "kiln" ? null : serviceManagerHints[managedBy]
}

const KilnContainerSection = React.memo(function KilnContainerSection({
  container,
  host,
}: {
  container: KilnContainer
  host: KilnPlatformHost
}) {
  const copy = kilnCopy[container.target]
  const logs = container.container !== null
  const terminal = kilnShellAvailable(host, container)
  const restart = container.actions.includes("restart")
  const managerHintText = managerHint(container)
  return (
    <InfoSection
      icon={containerIcon(container)}
      title={copy.title}
      status={<StatusIndicator status={kilnContainerPresentation(container)} />}
      action={
        <>
          {logs ? (
            <InfoSectionLink
              aria-label={`${copy.title} logs`}
              search={{ service: container.target }}
              to="/kiln/logs"
            >
              <ScrollText /> Logs
            </InfoSectionLink>
          ) : null}
          {terminal ? (
            <InfoSectionLink
              aria-label={`${copy.title} terminal`}
              search={{ service: container.target }}
              to="/kiln/terminal"
            >
              <TerminalSquare /> Terminal
            </InfoSectionLink>
          ) : null}
          {restart ? (
            <KilnRestartButton
              relayId={host.relayId}
              target={container.target}
            />
          ) : null}
        </>
      }
    >
      <InfoFact label="Runs">
        <span className="truncate text-muted-foreground">
          {copy.description}
        </span>
      </InfoFact>
      {container.managedBy && managerHintText ? (
        <InfoFact label="Managed by">
          <span>{managerLabels[container.managedBy]}</span>
          <InfoHint
            label={`About who manages ${copy.noun}`}
            title={`Managed by ${managerLabels[container.managedBy]}`}
          >
            <p>{managerHintText}</p>
          </InfoHint>
        </InfoFact>
      ) : null}
      <InfoFact label="Image">
        {container.image ? (
          <InfoCopyValue label="image" value={container.image} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </InfoFact>
      {container.version ? (
        <InfoFact label="Version">
          <span className="font-mono text-xs">{container.version}</span>
        </InfoFact>
      ) : null}
      <InfoFact label="Container">
        {container.container ? (
          <InfoCopyValue label="container name" value={container.container} />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      <InfoFact label="Started">
        {container.startedAt ? (
          <RelativeTime timestamp={Date.parse(container.startedAt)} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </InfoFact>
      {container.target === "hearth" && container.shell === false ? (
        <InfoFact label="Terminal">
          <span className="text-muted-foreground">No shell in its image</span>
        </InfoFact>
      ) : null}
    </InfoSection>
  )
})

// Hearth served at its own port: nothing on ports 80 and 443 in front of it.
function NoProxySection({ status }: { status: RelayPlatformStatus }) {
  const https = status.hearthUrl?.startsWith("https:") === true
  return (
    <InfoSection
      icon={<ShieldCheck />}
      title={kilnCopy.proxy.title}
      status={
        <StatusIndicator
          status={{ label: "Not running", tone: https ? "warning" : "neutral" }}
        />
      }
    >
      <InfoFact label="Runs">
        <span className="truncate text-muted-foreground">
          {kilnCopy.proxy.description}
        </span>
      </InfoFact>
      <InfoFact label="HTTPS">
        <span className="text-muted-foreground">
          {https
            ? "Expected, but no Traefik answers"
            : "Off; Hearth is at its own port"}
        </span>
        <InfoHint label="About HTTPS" title="Serving Kiln over HTTPS">
          <p>
            Kiln's installer starts Traefik on ports 80 and 443 and gets a Let's
            Encrypt certificate, for a domain or the host's address.
          </p>
          <p>Without it, Hearth is only at its own port, over plain HTTP.</p>
        </InfoHint>
      </InfoFact>
    </InfoSection>
  )
}

// What an operator runs on the Relay's host, for what Hearth can't do. Run
// opens the Relay's host shell with the command typed, for them to send.
function KilnCommandsSection({
  relayId,
  status,
}: {
  relayId: string
  status: RelayPlatformStatus
}) {
  const relay = useRelayEntry(relayId)
  if (status.management !== "relay") {
    const deployer = kilnDeployer(status)
    return (
      <InfoSection icon={<TerminalSquare />} title="Commands" content>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {deployer} manages these containers, so Kiln only shows them. Change
          them{" "}
          {deployer === "Coolify" ? "in Coolify" : "where they were deployed"}.
        </p>
      </InfoSection>
    )
  }
  return (
    <InfoSection icon={<TerminalSquare />} title="Commands" content="flush">
      <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        On the Relay's host, for when Hearth itself is down.
      </p>
      <dl className="@container px-4">
        {commands.map((command) => {
          const line = `docker exec kiln-relay kiln-relay platform ${command.args}`
          return (
            <InfoFact key={command.label} label={command.label}>
              <InfoCopyValue label="command" value={line} />
              {relay ? (
                <Link
                  aria-label={`Run ${command.label.toLowerCase()} in ${relay.name}'s terminal`}
                  className="type-control-sm ml-1.5 flex h-7 shrink-0 items-center gap-1 border-l border-border/60 pl-3 text-muted-foreground transition-colors outline-none hover:text-primary-ink focus-visible:text-primary-ink"
                  params={{ relayId: relay.routeId }}
                  to="/relay/$relayId/terminal"
                  onClick={() =>
                    queueTerminalInput(relayTerminalInputKey(relayId), line)
                  }
                >
                  Run
                  <ArrowRight className="size-3.5" />
                </Link>
              ) : null}
            </InfoFact>
          )
        })}
      </dl>
    </InfoSection>
  )
}

function useRelayEntry(relayId: string) {
  const select = React.useCallback(
    (relays: Array<RelayDirectoryEntry>) => {
      const relay = relays.find((candidate) => candidate.id === relayId)
      return relay
        ? {
            entry: relay,
            name: relay.name,
            routeId: relayRouteIdentifier(relays, relay),
          }
        : null
    },
    [relayId]
  )
  return useQuery({ ...relaysQueryOptions(), select }).data ?? null
}

const commands = [
  { args: "status", label: "Status" },
  { args: "repair", label: "Repair" },
  { args: "setup-url", label: "Setup link" },
  { args: "export-kit > kiln-recovery.json", label: "Recovery kit" },
] as const

function KilnInfoRail({ host }: { host: KilnPlatformHost }) {
  const status = host.status
  const proxy = status?.proxy
  const relay = useRelayEntry(host.relayId)
  return (
    <>
      <InfoRailGroup card>
        <InfoRailRelayLink name={host.relayName} relayId={host.relayId} />
        <InfoRailLink leading={<ScrollText />} to="/kiln/logs">
          Logs
        </InfoRailLink>
        {status?.canManage && host.v2 ? (
          <InfoRailLink leading={<TerminalSquare />} to="/kiln/terminal">
            Terminal
          </InfoRailLink>
        ) : null}
        <InfoRailBackupsLink
          resource={{
            id: host.relayId,
            kind: "platform",
            relayId: host.relayId,
          }}
        />
      </InfoRailGroup>
      <OwnerCard email={null} name={null} />
      <InfoRailCard
        action={<InstanceFavoriteButton {...kilnFavorite} />}
        icon={<HearthMark className="size-3.5" />}
        title="Installation"
        sections={<KilnInstanceCounts />}
      >
        <InfoFact label="Address">
          {status?.hearthUrl ? (
            <InfoCopyValue label="address" value={status.hearthUrl} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </InfoFact>
        <InfoFact label="Version">
          <span className="font-mono text-xs">
            {kilnVersion(status) ?? "—"}
          </span>
        </InfoFact>
        <InfoFact label="Installed by">
          <span>
            {status?.management === "relay"
              ? host.relayName
              : kilnDeployer(status)}
          </span>
        </InfoFact>
        <InfoFact label="HTTPS">
          <span>
            {proxy
              ? `Traefik, by ${managerLabels[proxy.managedBy]}`
              : status?.hearthUrl?.startsWith("https:")
                ? "Not answering"
                : "Off"}
          </span>
        </InfoFact>
        <InfoFact label="Installation">
          {status?.installationId ? (
            <InfoCopyValue
              display={status.installationId.slice(0, 8)}
              label="installation ID"
              value={status.installationId}
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </InfoFact>
      </InfoRailCard>
      {relay ? <KilnNodeCard relay={relay.entry} /> : null}
    </>
  )
}

function KilnNodeCard({ relay }: { relay: RelayDirectoryEntry }) {
  const facts = useRelayNodeFacts(relay.id)
  return <RelayNodeCard facts={facts} relay={relay} />
}

// Everything this Kiln runs, a count per kind.
const KilnInstanceCounts = React.memo(function KilnInstanceCounts() {
  const { data: relays = 0 } = useQuery({
    ...relaysQueryOptions(),
    select: countAll,
  })
  const { data: instances = 0 } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectSidebarInstanceCount,
  })
  const { data: apps = 0 } = useQuery({
    ...appDirectoryQueryOptions(),
    select: countAll,
  })
  const { data: databases = 0 } = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    select: countAll,
  })
  return (
    <div className="type-meta grid grid-cols-4 justify-items-center border-t border-border/60 px-3 py-2.5 text-muted-foreground">
      <InstanceKindCounts counts={{ apps, databases, instances, relays }} />
    </div>
  )
})

function countAll(resources: ReadonlyArray<unknown>) {
  return resources.length
}
