import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Archive, Check, Copy, RadioTower, Users } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { InfoRailLink, InfoRailRow } from "@/components/info-page"
import { useCopyFeedback } from "@/components/workspace-header"
import {
  canAccessDatabasePermission,
  canAccessInstancePermission,
  type NavigationAccessCapabilities,
} from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  backupUsageQueryOptions,
  relaysQueryOptions,
  resourceUserCountQueryOptions,
} from "@/lib/query-options"
import { relayRouteIdentifier, type RelayDirectoryEntry } from "@/lib/relay-route"

// Rail links shared by the Info pages of instances that run on a Relay: the
// Relay itself, who can reach the instance, and its backups. Each shows only
// to those who can open it.

interface RailResource {
  // "instance" is a game server.
  kind: "database" | "instance"
  id: string
  relayId: string
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
      <InfoRailRow action={copyId} leading={<RadioTower />}>
        {name}
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

function selectCanManageAccess(capabilities: NavigationAccessCapabilities) {
  return capabilities.canManageAccess
}

// Opens the instance on the Access page, with how many people it lists.
export function InfoRailUsersLink({ resource }: { resource: RailResource }) {
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
  const { data } = useQuery(
    resourceUserCountQueryOptions({
      relayId: resource.relayId,
      resourceId: resource.id,
      resourceType: resource.kind,
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

// Opens the instance's backups on the Backups page, with how many it keeps.
export function InfoRailBackupsLink({ resource }: { resource: RailResource }) {
  const { id, kind, relayId } = resource
  const select = React.useCallback(
    (capabilities: NavigationAccessCapabilities) =>
      kind === "database"
        ? canAccessDatabasePermission(capabilities, { id, relayId }, "backup.read")
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
