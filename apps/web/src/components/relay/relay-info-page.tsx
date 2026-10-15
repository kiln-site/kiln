import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  InfoCopyValue,
  InfoDetailRow,
  InfoDetails,
  InfoFact,
  InfoFactList,
  InfoFooter,
  InfoFooterItem,
  InfoManageAccessButton,
  InfoPage,
} from "@/components/info-page"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { LocalDateTime } from "@/components/local-date-time"
import { RelativeTime } from "@/components/relative-time"
import { RemoveRelayDialog } from "@/components/relay/relay-actions"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { RelayUsage } from "@/components/relay/relay-usage"
import { RelayWorkloads } from "@/components/relay/relay-workloads"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { WorkspaceIdCopyButton } from "@/components/workspace-header"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { relayAddress, type RelayDirectoryEntry } from "@/lib/relay-route"

// How the Relay's machine is doing and what runs on it, then how Hearth
// reaches it and what it runs on, then who owns it.
export function RelayInfoPage() {
  const { relay, routeId } = useRelayWorkspace()

  return (
    <InfoPage>
      <RelayLiveUsage relay={relay} />
      <RelayWorkloads relayId={relay.id} routeId={routeId} />
      <div className="mt-8 grid gap-8 lg:grid-cols-2 lg:gap-6">
        <RelayConnectionFacts relay={relay} />
        <RelayMachineFacts relay={relay} />
      </div>
      <RelayFooter relay={relay} routeId={routeId} />
    </InfoPage>
  )
}

function RelayLiveUsage({ relay }: { relay: RelayDirectoryEntry }) {
  const { connected } = useRelayLiveStatus(relay)
  return <RelayUsage connected={connected} relayId={relay.id} />
}

function RelayConnectionFacts({ relay }: { relay: RelayDirectoryEntry }) {
  return (
    <InfoFactList title="Connection">
      <InfoFact label="Address">
        <InfoCopyValue label="Relay address" value={relayAddress(relay)} />
      </InfoFact>
      <InfoFact label="TLS">
        <InfoDetails title="TLS" trigger={tlsLabel(relay)}>
          <p>{tlsDescription(relay)}</p>
          <InfoDetailRow
            label="Browser origin"
            value={relay.browserOrigin || "Same as address"}
          />
          <p>Where browsers reach the Relay directly.</p>
        </InfoDetails>
      </InfoFact>
      <InfoFact label="Hearth access">
        <InfoDetails
          title={roleLabel(relay.role)}
          trigger={roleLabel(relay.role)}
        >
          <p>{roleDescription(relay)}</p>
        </InfoDetails>
      </InfoFact>
      <InfoFact label="Last connected">
        {relay.lastConnectedAt ? (
          <RelativeTime timestamp={Date.parse(relay.lastConnectedAt)} />
        ) : (
          "Never"
        )}
      </InfoFact>
      {relay.lastError ? (
        <InfoFact label="Last error">
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={relay.lastError}
          >
            {relay.lastError}
          </span>
        </InfoFact>
      ) : null}
    </InfoFactList>
  )
}

// The node's details change rarely; live usage is left to RelayUsage so new
// samples don't re-render these facts.
function selectRelayMachine(relayId: string) {
  return (snapshot: RelayFleetSnapshot) => {
    const node = snapshot.nodes.find(
      (candidate) => candidate.relayId === relayId
    )
    if (!node) return null
    return {
      arch: node.arch,
      dockerVersion: node.docker.available
        ? (node.docker.version ?? "Available")
        : "Unavailable",
      platform: node.platform,
      startedAt: node.startedAt,
      version: node.version,
    }
  }
}

function RelayMachineFacts({ relay }: { relay: RelayDirectoryEntry }) {
  const relayId = relay.id
  const { connected } = useRelayLiveStatus(relay)
  const select = React.useMemo(() => selectRelayMachine(relayId), [relayId])
  const { data: machine } = useQuery({ ...relaySnapshotQueryOptions(), select })

  return (
    <InfoFactList title="Machine">
      {machine ? (
        <>
          <InfoFact label="Relay version">{machine.version}</InfoFact>
          <InfoFact label="System">
            {platformLabel(machine.platform)}, {machine.arch}
          </InfoFact>
          <InfoFact label="Docker">{machine.dockerVersion}</InfoFact>
          <InfoFact label="Started">
            {machine.startedAt ? (
              <LocalDateTime timestamp={machine.startedAt} />
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
    </InfoFactList>
  )
}

function RelayFooter({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const { data: canDelete = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relay.id, "relay.delete"),
  })
  return (
    <InfoFooter
      actions={
        <>
          <InstanceFavoriteButton
            id={relay.id}
            kind="relay"
            relayId={relay.id}
          />
          <InfoManageAccessButton
            relayId={relay.id}
            resourceId={relay.id}
            resourceType="relay"
          />
          {canDelete ? <RemoveRelayButton relay={relay} /> : null}
        </>
      }
    >
      <InfoFooterItem label="Owner">
        {relay.ownerName ?? relay.ownerEmail ?? "Unassigned"}
      </InfoFooterItem>
      <InfoFooterItem label="Paired">
        <LocalDateTime timestamp={relay.createdAt} />
      </InfoFooterItem>
      <InfoFooterItem label="ID">
        <WorkspaceIdCopyButton
          id={relay.id}
          label="Relay ID"
          shortId={routeId.slice(0, 8)}
        />
      </InfoFooterItem>
    </InfoFooter>
  )
}

function RemoveRelayButton({ relay }: { relay: RelayDirectoryEntry }) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 />
        Remove Relay
      </Button>
      {open ? (
        <RemoveRelayDialog
          name={relay.name}
          relayId={relay.id}
          onOpenChange={setOpen}
          onRemoved={() => navigate({ to: "/infra/relays" })}
        />
      ) : null}
    </>
  )
}

function tlsLabel(relay: RelayDirectoryEntry): string {
  if (!relay.useTls) return "Off"
  return relay.managedTls ? "Managed by the Relay" : "Custom certificate"
}

function tlsDescription(relay: RelayDirectoryEntry): string {
  if (!relay.useTls) {
    return "Traffic between Hearth and this Relay is not encrypted."
  }
  return relay.managedTls
    ? "The Relay issues its own certificate. Hearth trusts it through the certificate authority saved when the Relay was paired."
    : "The Relay serves a certificate from a public or custom certificate authority."
}

function roleLabel(role: RelayDirectoryEntry["role"]): string {
  if (role === "full_access") return "Full access"
  if (role === "read_only") return "Read only"
  return "Custom"
}

function roleDescription(relay: RelayDirectoryEntry): string {
  if (relay.role === "full_access") {
    return "Hearth can use every Relay action: create and remove servers, open terminals, edit files, and change settings."
  }
  if (relay.role === "read_only") {
    return "Hearth can see this Relay and what runs on it, but can’t change anything."
  }
  return `Hearth can use ${relay.actions.length} selected Relay ${relay.actions.length === 1 ? "action" : "actions"}.`
}

function platformLabel(platform: string): string {
  if (platform === "linux") return "Linux"
  if (platform === "darwin") return "macOS"
  if (platform === "win32") return "Windows"
  return platform
}
