import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Activity,
  Archive,
  Check,
  Container,
  Copy,
  RadioTower,
  Users,
} from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import {
  InfoCopyValue,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
  InfoRailRow,
} from "@/components/info-page"
import { useCopyFeedback } from "@/components/workspace-header"
import { formatBytes } from "@/lib/format-bytes"
import {
  canAccessActivity,
  canAccessInstancePermission,
} from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  backupUsageQueryOptions,
  relaysQueryOptions,
  resourceUserCountQueryOptions,
} from "@/lib/query-options"
import { relayRouteIdentifier, type RelayDirectoryEntry } from "@/lib/relay-route"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"

// What the game server is at a glance: links to the Relay it runs on, who
// can reach it, its activity, and its backups, then its container. Its name,
// status, and usage are in the header.
export function ServerInfoRail({
  instance,
  node,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
}) {
  return (
    <>
      <InfoRailGroup>
        <ServerRelayLink node={node} relayId={instance.relayId} />
        <ServerLinks instance={instance} />
      </InfoRailGroup>
      <ServerContainerCard instance={instance} />
    </>
  )
}

// The Relay the server runs on, with its ID to copy. It opens the Relay for
// those who manage it; others see just its name.
function ServerRelayLink({
  node,
  relayId,
}: {
  node: RelayNodeSummary
  relayId: string
}) {
  const select = React.useCallback(
    (relays: Array<RelayDirectoryEntry>) => {
      const relay = relays.find((candidate) => candidate.id === relayId)
      return relay
        ? { name: relay.name, routeId: relayRouteIdentifier(relays, relay) }
        : null
    },
    [relayId]
  )
  const { data } = useQuery({ ...relaysQueryOptions(), select })
  const copyId = <CopyRelayIdButton relayId={relayId} />
  if (!data) {
    return (
      <InfoRailRow action={copyId} leading={<RadioTower />}>
        {node.name}
      </InfoRailRow>
    )
  }
  return (
    <InfoRailLink
      to="/relay/$relayId/info"
      params={{ relayId: data.routeId }}
      action={copyId}
      leading={<RadioTower />}
    >
      {data.name}
    </InfoRailLink>
  )
}

function CopyRelayIdButton({ relayId }: { relayId: string }) {
  const { copied, copy } = useCopyFeedback(relayId)
  return (
    <button
      type="button"
      aria-label={`Copy Relay ID ${relayId}`}
      title={relayId}
      className={cn(
        "flex items-center gap-1.5 px-2 text-xs transition-colors outline-none focus-visible:text-primary",
        copied
          ? "text-emerald-400"
          : "text-muted-foreground/80 hover:text-primary"
      )}
      onClick={() => void copy()}
    >
      {copied ? "Copied" : "Copy ID"}
      {copied ? (
        <Check className="size-3 shrink-0" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-70" />
      )}
    </button>
  )
}

// Each link shows only to those who can open it.
function ServerLinks({ instance }: { instance: InstanceSettingsInstance }) {
  const select = React.useCallback(
    (capabilities: Parameters<typeof canAccessActivity>[0]) => ({
      canManageAccess: capabilities.canManageAccess,
      canReadBackups: canAccessInstancePermission(
        capabilities,
        instance,
        "backup.read"
      ),
      canViewActivity: canAccessActivity(capabilities),
    }),
    [instance]
  )
  const { data: access } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select,
  })
  if (!access) return null
  return (
    <>
      {access.canManageAccess ? (
        <InfoRailLink
          to="/access"
          search={{
            relayId: instance.relayId,
            resourceId: instance.id,
            resourceType: "instance",
            tab: "users",
          }}
          leading={<Users />}
          detail={<UserCount instance={instance} />}
        >
          Users
        </InfoRailLink>
      ) : null}
      {access.canViewActivity ? (
        <InfoRailLink
          to="/activity"
          search={{ relay: instance.relayId, server: instance.id }}
          leading={<Activity />}
        >
          Activity
        </InfoRailLink>
      ) : null}
      {access.canReadBackups ? (
        <InfoRailLink
          to="/backups/runs"
          search={{
            kind: "server",
            relay: instance.relayId,
            server: instance.id,
          }}
          leading={<Archive />}
          detail={<BackupCount instance={instance} />}
        >
          Backups
        </InfoRailLink>
      ) : null}
    </>
  )
}

// The owner and everyone invited or with access, as the Access page lists
// them. Platform admins count only when they're one of those.
function UserCount({ instance }: { instance: InstanceSettingsInstance }) {
  const { data } = useQuery(
    resourceUserCountQueryOptions({
      relayId: instance.relayId,
      resourceId: instance.id,
      resourceType: "instance",
    })
  )
  if (data === undefined || data === null) return null
  return (
    <span
      className="tabular-nums"
      title={data === 1 ? "1 person has access" : `${data} people have access`}
    >
      {data}
    </span>
  )
}

// How many backups the server keeps: "3/10" against a limit, or just "3"
// without one.
function BackupCount({ instance }: { instance: InstanceSettingsInstance }) {
  const { data } = useQuery(
    backupUsageQueryOptions(instance.relayId, {
      id: instance.id,
      kind: "instance",
    })
  )
  if (!data) return null
  const full =
    data.quantityLimit !== null && data.quantityUsed >= data.quantityLimit
  return (
    <span
      className={cn("tabular-nums", full && "text-amber-300")}
      title={
        data.quantityLimit === null
          ? "Backups kept, with no limit"
          : full
            ? "At the backup limit; delete one to make another"
            : `Backups kept, of ${data.quantityLimit} allowed`
      }
    >
      {data.quantityLimit === null
        ? data.quantityUsed
        : `${data.quantityUsed}/${data.quantityLimit}`}
    </span>
  )
}

// Where the server lives on the Relay, and the limits it runs under.
function ServerContainerCard({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  return (
    <InfoRailCard icon={<Container />} title="Container">
      <InfoFact label="Name">
        <InfoCopyValue label="container name" value={instance.service} />
      </InfoFact>
      <InfoFact label="ID">
        {instance.containerId ? (
          <InfoCopyValue label="container ID" value={instance.containerId} />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      {/* The server's folder on the Relay's host; older Relays don't say. */}
      {instance.hostDirectory ? (
        <InfoFact label="Data">
          <InfoCopyValue
            display="Copy path"
            label="data path"
            mono={false}
            value={instance.hostDirectory}
          />
        </InfoFact>
      ) : null}
      {/* Game servers have no CPU limit yet. */}
      <InfoFact label="CPU">
        <span className="text-muted-foreground" title="No CPU limit">
          —
        </span>
      </InfoFact>
      <InfoFact label="Memory">
        {instance.limits.memoryBytes > 0
          ? `${formatBytes(instance.limits.memoryBytes)} limit`
          : "No limit"}
      </InfoFact>
      <InfoFact label="Disk">
        {`${formatBytes(instance.limits.diskBytes)} limit`}
      </InfoFact>
    </InfoRailCard>
  )
}
