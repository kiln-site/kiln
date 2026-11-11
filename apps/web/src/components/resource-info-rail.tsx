import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  Activity,
  Archive,
  Check,
  Copy,
  PackagePlus,
  Users,
} from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import {
  InfoRailGroup,
  InfoRailLink,
  InfoRailRow,
} from "@/components/info-page"
import { RelayKindIcon } from "@/components/instance-kind-icon"
import {
  InstanceUpdatesStatus,
  instanceUpdatesQueryOptions,
  type UpdatedInstance,
} from "@/components/instance-updates"
import { OwnerCard } from "@/components/owner-card"
import { ResourceNotificationsCard } from "@/components/resource-notifications-card"
import { InfoRailSecurityLink } from "@/components/resource-security-link"
import { useCopyFeedback } from "@/components/workspace-header"
import {
  canAccessActivity,
  canAccessDatabasePermission,
  canAccessInstancePermission,
  type NavigationAccessCapabilities,
} from "@/lib/navigation-destinations"
import type { NotificationKind } from "@/lib/notifications"
import {
  accessCapabilitiesQueryOptions,
  backupUsageQueryOptions,
  relaysQueryOptions,
  resourceOwnerQueryOptions,
  resourceUserCountQueryOptions,
} from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// The Info rail of an instance that runs on a Relay, a game server or a
// database (an app's rail reuses its Relay link): links to its Relay, who can reach it, its activity, and its
// backups, each shown only to those who can open it, then its owner. Its
// container has a section of its own on the page.

export interface RailResource {
  // "instance" is a game server.
  kind: "database" | "instance"
  id: string
  name: string
  relayId: string
}

export function InstanceInfoRail({
  relayName,
  resource,
}: {
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
        <InfoRailUpdatesRow resource={resource} />
        <InfoRailSecurityLink
          relayId={resource.relayId}
          resourceId={resource.id}
          resourceType={resource.kind}
        />
      </InfoRailGroup>
      <InfoRailOwner resource={resource} />
      <InfoRailNotifications resource={resource} />
    </>
  )
}

// What this person can hear about it depends on what they can do with it.
const InfoRailNotifications = React.memo(function InfoRailNotifications({
  resource,
}: {
  resource: RailResource
}) {
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const { id, kind, name, relayId } = resource
  const subject = React.useMemo(
    () => ({ id, name, relayId, type: kind }),
    [id, kind, name, relayId]
  )
  const kinds = React.useMemo((): ReadonlyArray<NotificationKind> => {
    if (!capabilities) return []
    // An update is told to whoever may take it.
    if (kind === "instance")
      return [
        ...(canAccessInstancePermission(
          capabilities,
          { id, relayId },
          "instance.deploy"
        )
          ? (["instance.image-update"] as const)
          : []),
        ...(canAccessInstancePermission(
          capabilities,
          { id, relayId },
          "instance.configuration.write"
        )
          ? (["security.report"] as const)
          : []),
      ]
    return [
      ...(canAccessDatabasePermission(
        capabilities,
        { id, relayId },
        "database.read"
      )
        ? (["resource.disk-limit"] as const)
        : []),
      ...(canAccessDatabasePermission(
        capabilities,
        { id, relayId },
        "instance.deploy"
      )
        ? (["instance.image-update"] as const)
        : []),
      ...(canAccessDatabasePermission(
        capabilities,
        { id, relayId },
        "instance.power.restart"
      )
        ? (["security.report"] as const)
        : []),
    ]
  }, [capabilities, id, kind, relayId])
  return <ResourceNotificationsCard kinds={kinds} resource={subject} />
})

// Whether its image has a newer release out, and what Kiln does about it.
// Whoever may deploy it decides that, and takes an update.
const InfoRailUpdatesRow = React.memo(function InfoRailUpdatesRow({
  resource,
}: {
  resource: RailResource
}) {
  const navigate = useNavigate()
  const { id, kind, relayId } = resource
  const updatedKind = kind === "instance" ? "server" : "database"
  const { data: updates } = useQuery(
    instanceUpdatesQueryOptions({ id, kind: updatedKind, relayId })
  )
  const select = React.useCallback(
    (capabilities: NavigationAccessCapabilities) =>
      kind === "database"
        ? canAccessDatabasePermission(
            capabilities,
            { id, relayId },
            "instance.deploy"
          )
        : canAccessInstancePermission(
            capabilities,
            { id, relayId },
            "instance.deploy"
          ),
    [id, kind, relayId]
  )
  const { data: canDeploy = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select,
  })
  const instance = React.useMemo(
    (): UpdatedInstance => ({
      canDeploy,
      // Its Logs page lists its deployments.
      followDeployment: () =>
        kind === "database"
          ? navigate({
              params: { databaseId: id },
              search: { stream: "deployment" },
              to: "/db/$databaseId/logs",
            })
          : navigate({ params: { serverId: id }, to: "/server/$serverId/logs" }),
      id,
      kind: updatedKind,
      relayId,
    }),
    [canDeploy, id, kind, navigate, relayId, updatedKind]
  )
  if (!updates) return null
  return (
    <InfoRailRow
      action={<InstanceUpdatesStatus instance={instance} updates={updates} />}
      leading={<PackagePlus />}
    >
      Updates
    </InfoRailRow>
  )
})

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
  if (owner === undefined) return null
  return (
    <OwnerCard
      email={owner?.email ?? null}
      name={owner?.name ?? null}
      userId={owner?.userId ?? null}
    />
  )
})

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
      return relay ? { name: relay.name, id: relay.id } : null
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
      params={{ relayId: data.id }}
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

// What has backups: an instance, or Kiln itself, kept by the Relay on its
// host (`id` is that Relay's).
type BackupsResource =
  | RailResource
  | { id: string; kind: "platform"; relayId: string }

// Opens the instance's backups on the Backups page, with how many it keeps.
export function InfoRailBackupsLink({
  resource,
}: {
  resource: BackupsResource
}) {
  const { id, kind, relayId } = resource
  const select = React.useCallback(
    (capabilities: NavigationAccessCapabilities) =>
      kind === "platform"
        ? capabilities.isPlatformAdmin
        : kind === "database"
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
        kind:
          resource.kind === "database"
            ? "database"
            : resource.kind === "platform"
              ? "relay"
              : "server",
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

// "3/10" against the newest kept, or just "3" without that limit.
function BackupCount({ resource }: { resource: BackupsResource }) {
  const { data } = useQuery(
    backupUsageQueryOptions(resource.relayId, {
      id: resource.id,
      kind: resource.kind,
    })
  )
  if (!data) return null
  return (
    <span
      className="tabular-nums"
      title={
        data.quantityLimit === null
          ? "Backups kept"
          : `Backups kept, of the newest ${data.quantityLimit}`
      }
    >
      {data.quantityLimit === null
        ? data.quantityUsed
        : `${data.quantityUsed}/${data.quantityLimit}`}
    </span>
  )
}
