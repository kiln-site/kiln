import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  CalendarClock,
  Container,
  Cpu,
  Fingerprint,
  Globe2,
  HardDrive,
  History,
  KeyRound,
  MemoryStick,
  RadioTower,
  ServerCog,
  ShieldCheck,
  Timer,
  Trash2,
  TriangleAlert,
  UserRound,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  CopyMetaRow,
  DangerZone,
  InfoCard,
  InfoCardHeader,
  MetaRow,
  ResourceUsersCard,
} from "@/components/info-card"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { LocalDateTime } from "@/components/local-date-time"
import { RelativeTime } from "@/components/relative-time"
import { RelayMemoryCell } from "@/components/relay-memory-cell"
import { RemoveRelayDialog } from "@/components/relay/relay-actions"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { StatusIndicator } from "@/components/status-indicator"
import { formatBytes } from "@/lib/format-bytes"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { relayAddress, type RelayDirectoryEntry } from "@/lib/relay-route"

// Who and where the Relay is, the machine it runs on, and how to remove it.
export function RelayInfoPage() {
  const { relay } = useRelayWorkspace()
  const { data: canDelete = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relay.id, "relay.delete"),
  })

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <RelayIdentityCard relay={relay} />
          <ResourceUsersCard
            noun="Relay"
            relayId={relay.id}
            resourceId={relay.id}
            resourceType="relay"
          />
        </div>
        <RelayConnectionCard relay={relay} />
        <RelayNodeCard relay={relay} />
        {canDelete ? <RelayDangerZone relay={relay} /> : null}
      </div>
    </section>
  )
}

function RelayIdentityCard({ relay }: { relay: RelayDirectoryEntry }) {
  const { presentation } = useRelayLiveStatus(relay)
  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Fingerprint />}
        title="Identity"
        action={
          <div className="flex items-center gap-2">
            <StatusIndicator status={presentation} />
            <InstanceFavoriteButton
              id={relay.id}
              kind="relay"
              relayId={relay.id}
            />
          </div>
        }
      />
      <MetaRow icon={RadioTower} label="Name" value={relay.name} />
      <MetaRow
        icon={Fingerprint}
        label="Relay full ID"
        value={relay.id}
        mono
        wrap
      />
      <div className="grid sm:grid-cols-2">
        <MetaRow
          icon={UserRound}
          label="Owner"
          value={relay.ownerName ?? relay.ownerEmail ?? "Unassigned"}
        />
        <MetaRow
          icon={CalendarClock}
          label="Paired"
          value={<LocalDateTime timestamp={relay.createdAt} />}
        />
      </div>
    </InfoCard>
  )
}

function RelayConnectionCard({ relay }: { relay: RelayDirectoryEntry }) {
  return (
    <InfoCard className="mt-4">
      <InfoCardHeader icon={<Globe2 />} title="Connection" />
      <CopyMetaRow icon={Globe2} label="Address" value={relayAddress(relay)} />
      <div className="grid sm:grid-cols-2">
        <MetaRow
          icon={ShieldCheck}
          label="TLS"
          value={
            !relay.useTls
              ? "Off"
              : relay.managedTls
                ? "Managed by the Relay"
                : "Custom certificate"
          }
        />
        <MetaRow
          icon={KeyRound}
          label="Hearth access"
          value={
            relay.role === "full_access"
              ? "Full access"
              : relay.role === "read_only"
                ? "Read only"
                : "Custom"
          }
        />
        <MetaRow
          icon={Globe2}
          label="Browser origin"
          value={relay.browserOrigin || "Same as address"}
          mono
        />
        <MetaRow
          icon={History}
          label="Last connected"
          value={
            relay.lastConnectedAt ? (
              <RelativeTime timestamp={Date.parse(relay.lastConnectedAt)} />
            ) : (
              "Never"
            )
          }
        />
      </div>
      {relay.lastError ? (
        <MetaRow
          icon={TriangleAlert}
          label="Last error"
          value={relay.lastError}
          wrap
        />
      ) : null}
    </InfoCard>
  )
}

// The node's details change rarely; live usage samples are left out so they
// don't re-render the page.
function selectRelayNode(relayId: string) {
  return (snapshot: RelayFleetSnapshot) => {
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
      memoryTotalBytes: node.memory.totalBytes,
      platform: node.platform,
      startedAt: node.startedAt,
      storageTotalBytes: node.storage.totalBytes,
      version: node.version,
    }
  }
}

function RelayNodeCard({ relay }: { relay: RelayDirectoryEntry }) {
  const relayId = relay.id
  const { connected } = useRelayLiveStatus(relay)
  const select = React.useMemo(() => selectRelayNode(relayId), [relayId])
  const { data: node } = useQuery({ ...relaySnapshotQueryOptions(), select })

  return (
    <InfoCard className="mt-4">
      <InfoCardHeader icon={<ServerCog />} title="Node" />
      {node ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4">
          <MetaRow
            icon={RadioTower}
            label="Relay version"
            value={node.version}
          />
          <MetaRow
            icon={ServerCog}
            label="Platform"
            value={`${node.platform} · ${node.arch}`}
          />
          <MetaRow icon={Container} label="Docker" value={node.dockerVersion} />
          <MetaRow
            icon={Timer}
            label="Started"
            value={
              node.startedAt ? (
                <LocalDateTime timestamp={node.startedAt} />
              ) : (
                "Unknown"
              )
            }
          />
          <MetaRow icon={Cpu} label="CPU cores" value={String(node.cores)} />
          <MetaRow
            icon={MemoryStick}
            label="Memory"
            value={formatBytes(node.memoryTotalBytes)}
          />
          <MetaRow
            icon={HardDrive}
            label="Storage"
            value={formatBytes(node.storageTotalBytes)}
          />
          <MetaRow
            icon={MemoryStick}
            label="Relay memory"
            value={<RelayMemoryCell connected={connected} relayId={relayId} />}
          />
        </div>
      ) : (
        <p className="px-4 py-5 text-sm text-muted-foreground">
          {connected
            ? "Waiting for the Relay to report its node."
            : "Node details appear once Hearth reaches the Relay."}
        </p>
      )}
    </InfoCard>
  )
}

function RelayDangerZone({ relay }: { relay: RelayDirectoryEntry }) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <DangerZone
        title="Remove Relay"
        detail={relay.id}
        action={
          <Button
            type="button"
            variant="destructive"
            onClick={() => setOpen(true)}
          >
            <Trash2 />
            Remove
          </Button>
        }
      />
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
