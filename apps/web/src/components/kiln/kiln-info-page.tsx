import * as React from "react"
import { CircleAlert, ScrollText, ShieldCheck, TerminalSquare, Zap } from "lucide-react"
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
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { KilnRestartButton } from "@/components/kiln/kiln-actions"
import {
  kilnContainerPresentation,
  kilnContainers,
  kilnCopy,
  kilnShellAvailable,
  kilnVersion,
  useKilnHost,
  type KilnContainer,
} from "@/components/kiln/kiln-presentation"
import { RelativeTime } from "@/components/relative-time"
import { InfoRailRelayLink } from "@/components/resource-info-rail"
import { StatusIndicator } from "@/components/status-indicator"
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
              {status.proxy === null ? <NoProxySection status={status} /> : null}
            </div>
          </div>
          <KilnCommandsSection status={status} />
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

const proxyManagers = {
  coolify: {
    label: "Coolify",
    hint: "Coolify runs this Traefik, so Kiln only shows it. Change its settings in Coolify; Kiln's labels on Hearth route its address through it.",
  },
  external: {
    label: "Outside Kiln",
    hint: "This Traefik already served ports 80 and 443 on this host, so Kiln only shows it. Change it where it was set up.",
  },
  kiln: {
    label: "Kiln",
    hint: "The Relay runs this Traefik for Hearth and renews its Let's Encrypt certificates.",
  },
} as const

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
            <KilnRestartButton relayId={host.relayId} target={container.target} />
          ) : null}
        </>
      }
    >
      <InfoFact label="Runs">
        <span className="truncate text-muted-foreground">{copy.description}</span>
      </InfoFact>
      {container.managedBy ? (
        <InfoFact label="Managed by">
          <span>{proxyManagers[container.managedBy].label}</span>
          <InfoHint
            label={`About who manages ${copy.noun}`}
            title={`Managed by ${proxyManagers[container.managedBy].label}`}
          >
            <p>{proxyManagers[container.managedBy].hint}</p>
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
          {https ? "Expected, but no Traefik answers" : "Off; Hearth is at its own port"}
        </span>
        <InfoHint label="About HTTPS" title="Serving Kiln over HTTPS">
          <p>
            Kiln's installer starts Traefik on ports 80 and 443 and gets a
            Let's Encrypt certificate, for a domain or the host's address.
          </p>
          <p>
            Without it, Hearth is only at its own port, over plain HTTP.
          </p>
        </InfoHint>
      </InfoFact>
    </InfoSection>
  )
}

// What an operator runs on the Relay's host, for what Hearth can't do.
function KilnCommandsSection({ status }: { status: RelayPlatformStatus }) {
  if (status.management !== "relay") {
    return (
      <InfoSection icon={<TerminalSquare />} title="Commands" content>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Compose or Coolify manages these containers, so Kiln only shows them.
          Change them where they were deployed.
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
        {commands.map((command) => (
          <InfoFact key={command.label} label={command.label}>
            <InfoCopyValue
              label="command"
              value={`docker exec kiln-relay kiln-relay platform ${command.args}`}
            />
          </InfoFact>
        ))}
      </dl>
    </InfoSection>
  )
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
      </InfoRailGroup>
      <InfoRailCard icon={<HearthMark className="size-3.5" />} title="Installation">
        <InfoFact label="Address">
          {status?.hearthUrl ? (
            <InfoCopyValue label="address" value={status.hearthUrl} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </InfoFact>
        <InfoFact label="Version">
          <span className="font-mono text-xs">{kilnVersion(status) ?? "—"}</span>
        </InfoFact>
        <InfoFact label="Installed by">
          <span>
            {status?.management === "relay" ? host.relayName : "Compose or Coolify"}
          </span>
        </InfoFact>
        <InfoFact label="HTTPS">
          <span>
            {proxy
              ? `Traefik, by ${proxyManagers[proxy.managedBy].label}`
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
    </>
  )
}
