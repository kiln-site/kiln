import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Activity,
  Archive,
  Check,
  Container,
  Copy,
  LoaderCircle,
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
import { RelayKindIcon } from "@/components/instance-kind-icon"
import { OwnerCard } from "@/components/owner-card"
import { useCopyFeedback } from "@/components/workspace-header"
import {
  canAccessActivity,
  canAccessDatabasePermission,
  canAccessInstancePermission,
  type NavigationAccessCapabilities,
} from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  backupUsageQueryOptions,
  relaysQueryOptions,
  resourceOwnerMinecraftProfileQueryOptions,
  resourceOwnerQueryOptions,
  resourceUserCountQueryOptions,
} from "@/lib/query-options"
import {
  relayRouteIdentifier,
  type RelayDirectoryEntry,
} from "@/lib/relay-route"

// The Info rail of an instance that runs on a Relay, a game server or a
// database (an app's rail reuses its Relay link): links to its Relay, who can reach it, its activity, and its
// backups, each shown only to those who can open it, then its owner and its
// container.

export interface RailResource {
  // "instance" is a game server.
  kind: "database" | "instance"
  id: string
  relayId: string
}

export function InstanceInfoRail({
  container,
  relayName,
  resource,
}: {
  container: React.ReactNode
  // The Relay's name as the instance reports it, for those who can't list
  // Relays.
  relayName: string
  resource: RailResource
}) {
  return (
    <>
      <InfoRailGroup card>
        <InfoRailRelayLink name={relayName} relayId={resource.relayId} />
        <InfoRailUsersLink resource={resource} />
        <InfoRailActivityLink resource={resource} />
        <InfoRailBackupsLink resource={resource} />
      </InfoRailGroup>
      <InfoRailOwner resource={resource} />
      {container}
    </>
  )
}

function railScope(resource: RailResource) {
  return {
    relayId: resource.relayId,
    resourceId: resource.id,
    resourceType: resource.kind,
  }
}

// Shows once the owner loads, so it doesn't stand in for the platform first.
const InfoRailOwner = React.memo(function InfoRailOwner({
  resource,
}: {
  resource: RailResource
}) {
  const scope = railScope(resource)
  const { data: owner } = useQuery(resourceOwnerQueryOptions(scope))
  const { data: profileId } = useQuery({
    ...resourceOwnerMinecraftProfileQueryOptions(scope, owner?.name ?? ""),
    enabled: Boolean(owner),
  })
  if (owner === undefined) return null
  return (
    <OwnerCard
      email={owner?.email ?? null}
      name={owner?.name ?? null}
      profileId={profileId}
    />
  )
})

// Where the instance lives on the Relay and the limits it runs under. Values
// the Relay reports separately show a spinner until they arrive.
export function InfoContainerCard({
  containerId,
  cpu,
  dataDirectory,
  disk,
  memory,
  name,
  pending = false,
}: {
  containerId: string | null
  cpu?: React.ReactNode
  // The instance's folder on the Relay's host; null when the Relay doesn't
  // say.
  dataDirectory: string | null
  disk: React.ReactNode
  memory: React.ReactNode
  name: string | null
  pending?: boolean
}) {
  const unknown = pending ? (
    <LoaderCircle
      aria-label="Loading"
      className="size-3.5 animate-spin text-muted-foreground"
    />
  ) : (
    <span className="text-muted-foreground">—</span>
  )
  return (
    <InfoRailCard icon={<Container />} title="Container">
      <InfoFact label="Name">
        {name ? <InfoCopyValue label="container name" value={name} /> : unknown}
      </InfoFact>
      <InfoFact label="ID">
        {/* Shortened as Docker shows it; the full ID is what's copied. */}
        {containerId ? (
          <InfoCopyValue
            display={containerId.slice(0, 12)}
            label="container ID"
            value={containerId}
          />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      <InfoFact label="Data">
        {dataDirectory ? (
          <InfoCopyValue
            display="Copy path"
            label="data path"
            mono={false}
            value={dataDirectory}
          />
        ) : (
          unknown
        )}
      </InfoFact>
      <InfoFact label="CPU">
        {cpu ?? (
          <span className="text-muted-foreground" title="No CPU limit">
            —
          </span>
        )}
      </InfoFact>
      <InfoFact label="Memory">{memory}</InfoFact>
      <InfoFact label="Disk">{disk}</InfoFact>
    </InfoRailCard>
  )
}

// The Relay the instance runs on, with its ID to copy. It opens the Relay for
// those who manage it; others see just the name the instance reports.
export function InfoRailRelayLink({
  name,
  relayId,
}: {
  name: string
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
      <InfoRailRow action={copyId} leading={<RelayKindIcon />}>
        {name}
      </InfoRailRow>
    )
  }
  return (
    <InfoRailLink
      to="/relay/$relayId/info"
      params={{ relayId: data.routeId }}
      action={copyId}
      leading={<RelayKindIcon />}
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
        "flex items-center gap-1.5 px-2 text-xs transition-colors outline-none focus-visible:text-primary-ink",
        copied
          ? "text-emerald-400 light:text-emerald-700"
          : "text-muted-foreground/80 hover:text-primary-ink light:text-muted-foreground/90"
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

function selectCanManageAccess(capabilities: NavigationAccessCapabilities) {
  return capabilities.canManageAccess
}

// Opens the instance on the Access page, with how many people it lists.
function InfoRailUsersLink({ resource }: { resource: RailResource }) {
  const { data: canManageAccess } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectCanManageAccess,
  })
  if (!canManageAccess) return null
  return (
    <InfoRailLink
      to="/access"
      search={{
        relayId: resource.relayId,
        resourceId: resource.id,
        resourceType: resource.kind,
        tab: "users",
      }}
      leading={<Users />}
      detail={<UserCount resource={resource} />}
    >
      Users
    </InfoRailLink>
  )
}

// The owner and everyone invited or with access, as the Access page lists
// them. Platform admins count only when they're one of those.
function UserCount({ resource }: { resource: RailResource }) {
  const { data } = useQuery(resourceUserCountQueryOptions(railScope(resource)))
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

// Opens the Activity page filtered to the instance.
function InfoRailActivityLink({ resource }: { resource: RailResource }) {
  const { data: canViewActivity } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: canAccessActivity,
  })
  if (!canViewActivity) return null
  return (
    <InfoRailLink
      to="/activity"
      search={
        resource.kind === "database"
          ? { database: resource.id, relay: resource.relayId }
          : { relay: resource.relayId, server: resource.id }
      }
      leading={<Activity />}
    >
      Activity
    </InfoRailLink>
  )
}

// Opens the instance's backups on the Backups page, with how many it keeps.
function InfoRailBackupsLink({ resource }: { resource: RailResource }) {
  const { id, kind, relayId } = resource
  const select = React.useCallback(
    (capabilities: NavigationAccessCapabilities) =>
      kind === "database"
        ? canAccessDatabasePermission(
            capabilities,
            { id, relayId },
            "backup.read"
          )
        : canAccessInstancePermission(
            capabilities,
            { id, relayId },
            "backup.read"
          ),
    [id, kind, relayId]
  )
  const { data: canReadBackups } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select,
  })
  if (!canReadBackups) return null
  return (
    <InfoRailLink
      to="/backups/runs"
      search={{
        kind: resource.kind === "database" ? "database" : "server",
        relay: resource.relayId,
        server: resource.id,
      }}
      leading={<Archive />}
      detail={<BackupCount resource={resource} />}
    >
      Backups
    </InfoRailLink>
  )
}

// "3/10" against a limit, or just "3" without one.
function BackupCount({ resource }: { resource: RailResource }) {
  const { data } = useQuery(
    backupUsageQueryOptions(resource.relayId, {
      id: resource.id,
      kind: resource.kind,
    })
  )
  if (!data) return null
  const full =
    data.quantityLimit !== null && data.quantityUsed >= data.quantityLimit
  return (
    <span
      className={cn(
        "tabular-nums",
        full && "text-amber-300 light:text-amber-700"
      )}
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
