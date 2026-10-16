import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { ExternalLink, RadioTower, Server, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Popover, PopoverTrigger } from "@workspace/ui/components/popover"

import {
  InfoDetailsContent,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
} from "@/components/info-page"
import { useInfraUpdateDialogStore } from "@/components/infra-update-dialog-provider"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { LocalDateTime } from "@/components/local-date-time"
import { RelativeTime } from "@/components/relative-time"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { RelayWorkloads } from "@/components/relay/relay-workloads"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceIdCopyButton } from "@/components/workspace-header"
import {
  relaySnapshotQueryOptions,
  relayUpdateQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// What the Relay is at a glance: who it is and whether it's current, what
// runs on it, who owns it, and the machine under it.
export function RelayInfoRail({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const machine = useRelayMachine(relay.id)
  return (
    <>
      <RelayIdentity
        relay={relay}
        version={machine?.version ?? relay.nodeVersion}
      />
      <RelayWorkloads relayId={relay.id} routeId={routeId} />
      <InfoRailGroup title="Ownership">
        <dl>
          <InfoFact label="Owner">
            <span className="truncate">
              {relay.ownerName ?? relay.ownerEmail ?? "Unassigned"}
            </span>
          </InfoFact>
          <InfoFact label="Paired">
            <LocalDateTime dateOnly timestamp={relay.createdAt} />
          </InfoFact>
          <InfoFact label="ID">
            <WorkspaceIdCopyButton
              id={relay.id}
              label="Relay ID"
              shortId={routeId.slice(0, 8)}
            />
          </InfoFact>
        </dl>
      </InfoRailGroup>
      <RelayMachine machine={machine} relay={relay} />
    </>
  )
}

function RelayIdentity({
  relay,
  version,
}: {
  relay: RelayDirectoryEntry
  version: string | null
}) {
  const { presentation } = useRelayLiveStatus(relay)
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-11 shrink-0 place-items-center border bg-background/60 text-primary">
        <RadioTower className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold tracking-tight">
          {relay.name}
        </p>
        <StatusIndicator status={presentation} />
        {/* Fixed height, so the update icon appearing doesn't move the rail. */}
        <p className="flex h-5 items-center gap-1 font-mono text-xs text-muted-foreground">
          <span className="truncate">
            {version
              ? `Relay ${versionLabel(version)}`
              : "Relay version unknown"}
          </span>
          {version ? (
            <RelayUpdateWarning relay={relay} version={version} />
          ) : null}
        </p>
      </div>
      <InstanceFavoriteButton
        compact
        id={relay.id}
        kind="relay"
        relayId={relay.id}
      />
    </div>
  )
}

function RelayUpdateWarning({
  relay,
  version,
}: {
  relay: RelayDirectoryEntry
  version: string
}) {
  const { connected } = useRelayLiveStatus(relay)
  const canUpdate = useRelayPermission(relay.id, "relay.update")
  const { data: release } = useQuery({
    ...relayUpdateQueryOptions(relay.id, version),
    enabled: canUpdate && connected,
  })
  if (!release) return null
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Update available: ${release.name}`}
        className="grid size-5 shrink-0 place-items-center text-amber-400 transition-colors outline-none hover:text-amber-300 focus-visible:text-amber-300"
      >
        <TriangleAlert className="size-3.5" />
      </PopoverTrigger>
      <InfoDetailsContent title={`${release.name} is available`}>
        <p>
          This Relay runs {versionLabel(version)}. Updating restarts the Relay;
          game servers, apps, and databases keep running.
        </p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <RelayUpdateButton relayId={relay.id} />
          <Button asChild size="sm" variant="ghost">
            <a href={release.url} target="_blank" rel="noreferrer">
              Release notes
              <ExternalLink />
            </a>
          </Button>
        </div>
      </InfoDetailsContent>
    </Popover>
  )
}

// The Updates dialog lives with the infrastructure pages.
function RelayUpdateButton({ relayId }: { relayId: string }) {
  const router = useRouter()
  const store = useInfraUpdateDialogStore()
  return (
    <Button
      type="button"
      size="sm"
      onClick={() => {
        void router.navigate({ to: "/infra/relays" }).then(() => {
          store.open(relayId)
        })
      }}
    >
      Update Relay
    </Button>
  )
}

interface RelayMachineFacts {
  arch: string
  cores: number
  dockerVersion: string
  platform: string
  startedAt: string | null
  version: string
}

// The node's details change rarely; selecting just these keeps usage samples
// from re-rendering the rail.
function useRelayMachine(relayId: string): RelayMachineFacts | null {
  const select = React.useCallback(
    (snapshot: RelayFleetSnapshot): RelayMachineFacts | null => {
      const node = snapshot.nodes.find(
        (candidate) => candidate.relayId === relayId
      )
      if (!node) return null
      return {
        arch: node.arch,
        cores: node.cpu.cores,
        dockerVersion: node.docker.available
          ? (node.docker.version ?? "Available")
          : "Unavailable",
        platform: node.platform,
        startedAt: node.startedAt,
        version: node.version,
      }
    },
    [relayId]
  )
  const { data = null } = useQuery({ ...relaySnapshotQueryOptions(), select })
  return data
}

function RelayMachine({
  machine,
  relay,
}: {
  machine: RelayMachineFacts | null
  relay: RelayDirectoryEntry
}) {
  const { connected } = useRelayLiveStatus(relay)
  return (
    <InfoRailCard icon={<Server />} title="Machine">
      {machine ? (
        <>
          <InfoFact label="System">
            {platformLabel(machine.platform)}, {machine.arch}
          </InfoFact>
          <InfoFact label="Cores">{machine.cores}</InfoFact>
          <InfoFact label="Docker">{machine.dockerVersion}</InfoFact>
          <InfoFact label="Relay started">
            {machine.startedAt ? (
              <RelativeTime timestamp={Date.parse(machine.startedAt)} />
            ) : (
              "Unknown"
            )}
          </InfoFact>
        </>
      ) : (
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {connected
            ? "Waiting for the Relay to report its machine."
            : "Machine details appear once Hearth reaches the Relay."}
        </p>
      )}
    </InfoRailCard>
  )
}

// Release versions read "v0.42.1"; development builds keep their name.
function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version
}

function platformLabel(platform: string): string {
  if (platform === "linux") return "Linux"
  if (platform === "darwin") return "macOS"
  if (platform === "win32") return "Windows"
  return platform
}
