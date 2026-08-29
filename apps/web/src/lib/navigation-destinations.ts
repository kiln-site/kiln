import type { ComponentType } from "react"
import {
  CalendarDays,
  CircleUserRound,
  CreditCard,
  Database,
  Folder,
  FolderDown,
  Globe2,
  History,
  ListTodo,
  Network,
  Palette,
  RadioTower,
  RefreshCw,
  Rocket,
  Server,
  SlidersHorizontal,
  TerminalSquare,
  Waypoints,
  Wrench,
} from "lucide-react"
import {
  builtinTailscaleBrickId,
  type RelayInstance,
} from "@workspace/contracts"

import type { AccessPermission, AccessRole } from "@/lib/permissions"
import { roleHasPermission } from "@/lib/permissions"

export type NavigationIcon = ComponentType<{ className?: string }>

export interface NavigationDestination {
  icon: NavigationIcon
  keywords: ReadonlyArray<string>
  label: string
  to: string
}

export type InfrastructureDestinationAccess =
  | "database-read"
  | "instance-read"
  | "manage-relays"
  | "platform-admin"

export interface NavigationAccessCapabilities {
  canManageAccess: boolean
  canManageRelays: boolean
  grants: ReadonlyArray<{
    relayId: string
    resourceId: string
    resourceType: "database" | "instance" | "relay"
    role: AccessRole
  }>
  isPlatformAdmin: boolean
}

export const infrastructureDestinations = [
  {
    access: "manage-relays",
    icon: Wrench,
    keywords: ["infrastructure", "configure"],
    label: "Setup",
    to: "/infra/setup",
  },
  {
    access: "manage-relays",
    icon: RadioTower,
    keywords: ["infrastructure", "nodes"],
    label: "Relays",
    to: "/infra/relays",
  },
  {
    access: "platform-admin",
    icon: Waypoints,
    keywords: ["infrastructure", "network"],
    label: "Tailscale",
    to: "/infra/tailscale",
  },
  {
    access: "platform-admin",
    icon: Globe2,
    keywords: ["infrastructure", "cloudflare", "urls"],
    label: "Domains",
    to: "/infra/domains",
  },
  {
    access: "instance-read",
    icon: Server,
    keywords: ["infrastructure", "instances"],
    label: "Servers",
    to: "/infra/servers",
  },
  {
    access: "database-read",
    icon: Database,
    keywords: ["infrastructure", "mysql"],
    label: "Databases",
    to: "/infra/databases",
  },
] as const satisfies ReadonlyArray<
  NavigationDestination & { access: InfrastructureDestinationAccess }
>

export const automationDestinations = [
  {
    icon: ListTodo,
    keywords: ["automations", "tasks"],
    label: "Schedules",
    to: "/automations/schedules",
  },
  {
    icon: RefreshCw,
    keywords: ["automations", "synchronize"],
    label: "Sync",
    to: "/automations/sync",
  },
  {
    icon: History,
    keywords: ["automations", "runs"],
    label: "History",
    to: "/automations/history",
  },
  {
    icon: CalendarDays,
    keywords: ["automations", "dates"],
    label: "Calendar",
    to: "/automations/calendar",
  },
] as const satisfies ReadonlyArray<NavigationDestination>

export const settingsDestinations = [
  {
    icon: Palette,
    keywords: ["settings", "theme", "color"],
    label: "Appearance",
    to: "/settings/appearance",
  },
  {
    icon: FolderDown,
    keywords: ["settings", "downloads", "editor"],
    label: "Files",
    to: "/settings/files",
  },
  {
    icon: CircleUserRound,
    keywords: ["settings", "profile", "security"],
    label: "Account",
    to: "/settings/account",
  },
  {
    icon: CreditCard,
    keywords: ["settings", "plan", "subscription"],
    label: "Billing",
    to: "/settings/billing",
  },
] as const satisfies ReadonlyArray<NavigationDestination>

export type ServerDestinationId =
  | "console"
  | "files"
  | "info"
  | "network"
  | "startup"

type ServerWorkspaceKind = "network-stack" | "server"

export interface ServerDestination extends NavigationDestination {
  id: ServerDestinationId
  permission: AccessPermission
  workspaces: ReadonlyArray<ServerWorkspaceKind>
}

export const serverDestinations = [
  {
    icon: TerminalSquare,
    id: "console",
    keywords: ["terminal"],
    label: "Console",
    permission: "instance.console.read",
    to: "/server/$serverId/console",
    workspaces: ["network-stack", "server"],
  },
  {
    icon: Folder,
    id: "files",
    keywords: ["browser", "storage"],
    label: "Files",
    permission: "instance.files.read",
    to: "/server/$serverId/files/$",
    workspaces: ["network-stack", "server"],
  },
  {
    icon: Rocket,
    id: "startup",
    keywords: ["configuration", "variables"],
    label: "Startup",
    permission: "instance.settings",
    to: "/server/$serverId/startup",
    workspaces: ["server"],
  },
  {
    icon: Network,
    id: "network",
    keywords: ["ports", "allocation"],
    label: "Network",
    permission: "instance.network.read",
    to: "/server/$serverId/network",
    workspaces: ["network-stack", "server"],
  },
  {
    icon: SlidersHorizontal,
    id: "info",
    keywords: ["settings", "details"],
    label: "Info",
    permission: "instance.read",
    to: "/server/$serverId/info",
    workspaces: ["server"],
  },
] as const satisfies ReadonlyArray<ServerDestination>

type NavigableServer = Pick<RelayInstance, "brickId">

type AccessibleServer = NavigableServer & {
  id: string
  relayId: string
}

export function destinationsForServer(
  instance: NavigableServer
): ReadonlyArray<ServerDestination> {
  const workspace =
    instance.brickId === builtinTailscaleBrickId ? "network-stack" : "server"
  const destinations: ReadonlyArray<ServerDestination> = serverDestinations
  return destinations.filter((destination) =>
    destination.workspaces.includes(workspace)
  )
}

export function accessibleDestinationsForServer(
  instance: AccessibleServer,
  capabilities: NavigationAccessCapabilities
): ReadonlyArray<ServerDestination> {
  return destinationsForServer(instance).filter((destination) =>
    canAccessServerDestination(capabilities, instance, destination.id)
  )
}

export function canAccessServerDestination(
  capabilities: NavigationAccessCapabilities,
  instance: Pick<AccessibleServer, "id" | "relayId">,
  destinationId: ServerDestinationId
): boolean {
  const destination = serverDestinations.find(
    (candidate) => candidate.id === destinationId
  )
  if (!destination) return false
  return canAccessInstancePermission(
    capabilities,
    instance,
    destination.permission
  )
}

export function canAccessInstancePermission(
  capabilities: NavigationAccessCapabilities,
  instance: Pick<AccessibleServer, "id" | "relayId">,
  permission: AccessPermission
): boolean {
  if (capabilities.isPlatformAdmin) return true
  return capabilities.grants.some(
    (grant) =>
      grant.relayId === instance.relayId &&
      roleHasPermission(grant.role, permission) &&
      ((grant.resourceType === "relay" &&
        grant.resourceId === instance.relayId) ||
        (grant.resourceType === "instance" && grant.resourceId === instance.id))
  )
}

export function accessibleInfrastructureDestinations(
  capabilities: NavigationAccessCapabilities
) {
  return infrastructureDestinations.filter((destination) =>
    canAccessInfrastructureDestination(capabilities, destination)
  )
}

export function canAccessInfrastructureDestination(
  capabilities: NavigationAccessCapabilities,
  destination: (typeof infrastructureDestinations)[number]
): boolean {
  if (destination.access === "manage-relays") {
    return capabilities.canManageRelays
  }
  if (destination.access === "platform-admin") {
    return capabilities.isPlatformAdmin
  }
  if (destination.access === "instance-read") {
    return (
      capabilities.canManageRelays ||
      hasScopedPermission(capabilities, "instance.read", ["instance", "relay"])
    )
  }
  return hasScopedPermission(capabilities, "database.read", [
    "database",
    "relay",
  ])
}

export function canAccessAutomations(
  capabilities: NavigationAccessCapabilities
): boolean {
  return hasScopedPermission(capabilities, "schedule.read")
}

export function canAccessBackups(
  capabilities: NavigationAccessCapabilities
): boolean {
  return hasScopedPermission(capabilities, "backup.read")
}

export function canAccessActivity(
  capabilities: NavigationAccessCapabilities
): boolean {
  return hasScopedPermission(capabilities, "instance.read", [
    "instance",
    "relay",
  ])
}

export function firstAccessibleAppHref(
  capabilities: NavigationAccessCapabilities
): string {
  const infrastructure = accessibleInfrastructureDestinations(capabilities)[0]
  if (infrastructure) return infrastructure.to
  if (canAccessAutomations(capabilities)) return "/automations/schedules"
  if (canAccessBackups(capabilities)) return "/backups/runs"
  if (canAccessActivity(capabilities)) return "/activity"
  if (capabilities.canManageAccess) return "/access"
  return "/settings/account"
}

function hasScopedPermission(
  capabilities: NavigationAccessCapabilities,
  permission: AccessPermission,
  resourceTypes?: ReadonlyArray<
    NavigationAccessCapabilities["grants"][number]["resourceType"]
  >
): boolean {
  if (capabilities.isPlatformAdmin) return true
  const allowedResourceTypes = resourceTypes ? new Set(resourceTypes) : null
  return capabilities.grants.some(
    (grant) =>
      (!allowedResourceTypes || allowedResourceTypes.has(grant.resourceType)) &&
      roleHasPermission(grant.role, permission)
  )
}

export function serverDestinationHref(
  destination: ServerDestination,
  routeId: string
): string {
  const serverId = encodeURIComponent(routeId)
  return destination.to.replace("$serverId", serverId).replace(/\/\$$/u, "/")
}

export function sectionDestinationLabel(
  section: "automations" | "infra" | "settings",
  pathname: string
): string | null {
  const destinations =
    section === "infra"
      ? infrastructureDestinations
      : section === "settings"
        ? settingsDestinations
        : automationDestinations
  return (
    destinations.find((destination) => pathname.startsWith(destination.to))
      ?.label ?? null
  )
}
