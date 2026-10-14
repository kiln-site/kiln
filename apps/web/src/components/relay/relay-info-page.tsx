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
import { RelativeTime } from "@/components/relative-time"
import { RelayMemoryCell } from "@/components/relay-memory-cell"
import { RemoveRelayDialog } from "@/components/relay/relay-actions"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { relayAddress } from "@/components/relay/relay-workspace"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { StatusIndicator } from "@/components/status-indicator"
import { formatBytes } from "@/lib/format-bytes"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

// Who and where the Relay is, the machine it runs on, and how to remove it.
export function RelayInfoPage() {
  const { relay } = useRelayWorkspace()
  const status = useRelayLiveStatus(relay)
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
        <RelayNodeCard connected={status.connected} relayId={relay.id} />
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
          value={dateFormatter.format(new Date(relay.createdAt))}
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
        <div className="flex min-h-14 items-center gap-3 border-b px-4 py-3 last:border-b-0">
          <History className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="type-technical-label block text-muted-foreground">
              Last connected
            </span>
            <span className="mt-0.5 block truncate text-xs font-medium">
              {relay.lastConnectedAt ? (
                <RelativeTime timestamp={Date.parse(relay.lastConnectedAt)} />
              ) : (
                "Never"
              )}
            </span>
          </span>
        </div>
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

function RelayNodeCard({
  connected,
  relayId,
}: {
  connected: boolean
  relayId: string
}) {
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
              node.startedAt
                ? dateFormatter.format(new Date(node.startedAt))
                : "Unknown"
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
          <div className="flex min-h-14 items-center gap-3 border-b px-4 py-3 last:border-b-0">
            <MemoryStick className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="type-technical-label block text-muted-foreground">
                Relay memory
              </span>
              <span className="mt-0.5 block text-xs">
                <RelayMemoryCell connected={connected} relayId={relayId} />
              </span>
            </span>
          </div>
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
          onRemoved={() => void navigate({ to: "/infra/relays" })}
        />
      ) : null}
    </>
  )
}
