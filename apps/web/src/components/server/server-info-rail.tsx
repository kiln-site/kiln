import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Activity, Archive, Box, RadioTower, Users } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import {
  InfoCopyValue,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
} from "@/components/info-page"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { RelativeTime } from "@/components/relative-time"
import { StatusIndicator } from "@/components/status-indicator"
import { formatBytes } from "@/lib/format-bytes"
import type { BackupRun, BackupRunsPage } from "@/lib/backup-runs"
import {
  canAccessActivity,
  canAccessInstancePermission,
} from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  backupRunsInfiniteQueryOptions,
  backupUsageQueryOptions,
  relaysQueryOptions,
} from "@/lib/query-options"
import { relayRouteIdentifier, type RelayDirectoryEntry } from "@/lib/relay-route"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"

// What the game server is at a glance: the Relay it runs on, who can reach
// it, its backups, and its container. Its name, status, and usage are in the header.
export function ServerInfoRail({
  instance,
  node,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
}) {
  return (
    <>
      <InfoRailGroup title="Runs on">
        <ServerRelayLink node={node} relayId={instance.relayId} />
      </InfoRailGroup>
      <ServerAccessLinks instance={instance} />
      <ServerBackups instance={instance} />
      <ServerContainerCard instance={instance} />
    </>
  )
}

// Links to the Relay for those who manage it; others see just its name.
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
        ? { relay, routeId: relayRouteIdentifier(relays, relay) }
        : null
    },
    [relayId]
  )
  const { data } = useQuery({ ...relaysQueryOptions(), select })
  if (!data) {
    return (
      <dl>
        <InfoFact label="Relay">
          <span className="truncate">{node.name}</span>
        </InfoFact>
      </dl>
    )
  }
  return <RelayLink relay={data.relay} routeId={data.routeId} />
}

function RelayLink({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const { presentation } = useRelayLiveStatus(relay)
  return (
    <InfoRailLink
      to="/relay/$relayId/info"
      params={{ relayId: routeId }}
      leading={<RadioTower />}
      detail={<StatusIndicator status={presentation} />}
    >
      {relay.name}
    </InfoRailLink>
  )
}

function ServerAccessLinks({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  const { data: access } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectAccessLinks,
  })
  if (!access?.canManageAccess && !access?.canViewActivity) return null
  return (
    <InfoRailGroup title="Access">
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
        >
          Users and permissions
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
    </InfoRailGroup>
  )
}

function selectAccessLinks(
  capabilities: Parameters<typeof canAccessActivity>[0]
) {
  return {
    canManageAccess: capabilities.canManageAccess,
    canViewActivity: canAccessActivity(capabilities),
  }
}

// The latest backup, and how many the server keeps against its limit, linking
// to them on the Backups page, for those who can read them.
function ServerBackups({ instance }: { instance: InstanceSettingsInstance }) {
  const select = React.useCallback(
    (capabilities: Parameters<typeof canAccessInstancePermission>[0]) =>
      canAccessInstancePermission(capabilities, instance, "backup.read"),
    [instance]
  )
  const { data: canRead = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select,
  })
  if (!canRead) return null
  return (
    <InfoRailGroup title="Backups">
      <dl>
        <InfoFact label="Latest">
          <LatestBackup instance={instance} />
        </InfoFact>
      </dl>
      <InfoRailLink
        to="/backups/runs"
        search={{ kind: "server", relay: instance.relayId, server: instance.id }}
        leading={<Archive />}
        detail={<BackupCount instance={instance} />}
      >
        All backups
      </InfoRailLink>
    </InfoRailGroup>
  )
}

// "3/10" against a limit, or just "3" without one.
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

// The same newest-first query the Backups page runs for this server, so the
// two share a cache and live updates.
function LatestBackup({ instance }: { instance: InstanceSettingsInstance }) {
  const options = React.useMemo(
    () =>
      backupRunsInfiniteQueryOptions({
        direction: "desc",
        scope: {
          kind: "instance",
          relayId: instance.relayId,
          targetId: instance.id,
        },
        search: "",
        sort: "createdAt",
      }),
    [instance.id, instance.relayId]
  )
  const { data: latest, isError, isPending } = useInfiniteQuery({
    ...options,
    select: selectLatestBackup,
  })
  if (isPending) return <span className="text-muted-foreground">—</span>
  if (isError) {
    return <span className="text-muted-foreground">Couldn’t load</span>
  }
  if (!latest) return <span className="text-muted-foreground">None yet</span>
  return (
    <>
      <StatusIndicator status={backupStatusPresentation(latest)} />
      <RelativeTime timestamp={Date.parse(latest.createdAt)} />
    </>
  )
}

function selectLatestBackup(data: {
  pages: ReadonlyArray<BackupRunsPage>
}): BackupRun | null {
  return data.pages[0]?.items[0] ?? null
}

function backupStatusPresentation(
  backup: BackupRun
): IdentityStatusPresentation {
  if (
    backup.status === "queued" ||
    backup.status === "running" ||
    backup.taskStatus === "queued" ||
    backup.taskStatus === "running"
  ) {
    return { label: "In progress", pulse: true, tone: "info" }
  }
  if (backup.status === "failed") return { label: "Failed", tone: "danger" }
  return { label: "Available", tone: "success" }
}

// Where the server lives on the Relay, and the limits it runs under.
function ServerContainerCard({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  return (
    <InfoRailCard icon={<Box />} title="Container">
      <InfoFact label="Container">
        {instance.containerId ? (
          <InfoCopyValue label="container ID" value={instance.containerId} />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      <InfoFact label="Service">
        <span className="truncate font-mono text-xs" title={instance.service}>
          {instance.service}
        </span>
      </InfoFact>
      <InfoFact label="Data">
        <InfoCopyValue label="data directory" value={instance.directory} />
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
