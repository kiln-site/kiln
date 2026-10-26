import type { ComponentType } from "react"
import {
  Bell,
  CalendarDays,
  CircleUserRound,
  CreditCard,
  Folder,
  FolderDown,
  FolderGit2,
  FolderSync,
  Globe2,
  HardDrive,
  History,
  LayoutDashboard,
  ListTodo,
  Network,
  Palette,
  Rocket,
  ScrollText,
  ShieldAlert,
  SlidersHorizontal,
  Table2,
  TerminalSquare,
  Waypoints,
} from "lucide-react"
import {
  accessPermissionSupported,
  builtinTailscaleBrickId,
  type DatabaseEngine,
  type RelayInstance,
} from "@workspace/contracts"

import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import type { AccessPermission } from "@/lib/permissions"
import { grantHasPermission } from "@/lib/permissions"

export type NavigationIcon = ComponentType<{ className?: string }>

export interface NavigationDestination {
  icon: NavigationIcon
  keywords: ReadonlyArray<string>
  label: string
  to: string
}

export type InfrastructureDestinationAccess =
  | "app-read"
  | "database-read"
  | "domains"
  | "instance-read"
  | "manage-relays"
  | "platform-admin"
  | "sources"

export interface NavigationAccessCapabilities {
  canManageAccess: boolean
  canManageRelays: boolean
  pendingScopes?: readonly {
    relayId: string
    resourceType: "relay" | "instance" | "database"
    resourceId: string
    invitationId: string
  }[]
  grants: ReadonlyArray<{
    relayId: string
    resourceId: string
    resourceType: "app" | "database" | "instance" | "relay"
    permissions: readonly AccessPermission[]
  }>
  isPlatformAdmin: boolean
  isRelayCreator: boolean
}

// Tabs render in this order, with a divider wherever `group` changes.
export const infrastructureDestinations = [
  {
    access: "manage-relays",
    group: "overview",
    icon: LayoutDashboard,
    keywords: ["infrastructure", "summary", "setup"],
    label: "Overview",
    to: "/infra/overview",
  },
  {
    access: "manage-relays",
    group: "resources",
    icon: RelayKindIcon,
    keywords: ["infrastructure", "nodes"],
    label: "Relays",
    to: "/infra/relays",
  },
  {
    access: "database-read",
    group: "resources",
    icon: DatabaseKindIcon,
    keywords: ["infrastructure", "mysql"],
    label: "Databases",
    to: "/infra/databases",
  },
  {
    access: "instance-read",
    group: "resources",
    icon: ServerKindIcon,
    keywords: ["infrastructure", "instances", "servers"],
    // Users see "Game Servers"; the code keeps "servers". See AGENTS.md Naming.
    label: "Game Servers",
    to: "/infra/servers",
  },
  {
    access: "app-read",
    group: "resources",
    icon: AppKindIcon,
    keywords: ["infrastructure", "docker", "compose", "containers"],
    label: "Apps",
    to: "/infra/apps",
  },
  {
    access: "platform-admin",
    group: "network",
    icon: Waypoints,
    keywords: ["infrastructure", "network"],
    label: "Tailscale",
    to: "/infra/tailscale",
  },
  {
    access: "domains",
    group: "network",
    icon: Globe2,
    keywords: ["infrastructure", "cloudflare", "urls", "dns", "vanity"],
    label: "Domains",
    to: "/infra/domains",
  },
  {
    access: "sources",
    group: "network",
    icon: FolderGit2,
    keywords: ["infrastructure", "github", "git", "repositories"],
    label: "Sources",
    to: "/infra/sources",
  },
  {
    access: "app-read",
    group: "network",
    icon: Rocket,
    keywords: ["infrastructure", "deploys", "github", "commits", "releases"],
    label: "Deployments",
    to: "/infra/deployments",
  },
] as const satisfies ReadonlyArray<
  NavigationDestination & {
    access: InfrastructureDestinationAccess
    group: "network" | "overview" | "resources"
  }
>

// Tabs render in this order, with a divider wherever `group` changes.
export const automationDestinations = [
  {
    group: "calendar",
    icon: CalendarDays,
    keywords: ["automations", "dates"],
    label: "Calendar",
    to: "/automations/calendar",
  },
  {
    group: "automations",
    icon: ListTodo,
    keywords: ["automations", "tasks"],
    label: "Schedules",
    to: "/automations/schedules",
  },
  {
    group: "automations",
    icon: FolderSync,
    keywords: ["automations", "synchronize"],
    label: "Sync",
    to: "/automations/sync",
  },
  {
    group: "history",
    icon: History,
    keywords: ["automations", "runs"],
    label: "History",
    to: "/automations/history",
  },
] as const satisfies ReadonlyArray<
  NavigationDestination & { group: "automations" | "calendar" | "history" }
>

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
    icon: Bell,
    keywords: ["settings", "push", "alerts", "security", "vulnerabilities"],
    label: "Notifications",
    to: "/settings/notifications",
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
    permission: "instance.configuration.read",
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

function destinationsForServer(
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
      grantHasPermission(grant, permission) &&
      ((grant.resourceType === "relay" &&
        grant.resourceId === instance.relayId) ||
        (grant.resourceType === "instance" && grant.resourceId === instance.id))
  )
}

export type DatabaseDestinationId =
  | "info"
  | "logs"
  | "network"
  | "terminal"
  | "viewer"

export interface DatabaseDestination extends NavigationDestination {
  // Engines the destination applies to; every engine when omitted.
  engines?: ReadonlyArray<DatabaseEngine>
  id: DatabaseDestinationId
  permission: AccessPermission
}

export const databaseDestinations = [
  {
    icon: SlidersHorizontal,
    id: "info",
    keywords: ["settings", "credentials", "details"],
    label: "Info",
    permission: "database.read",
    to: "/db/$databaseId/info",
  },
  {
    icon: TerminalSquare,
    id: "terminal",
    keywords: ["console", "shell", "cli", "psql", "mysql"],
    label: "Terminal",
    permission: "database.terminal",
    to: "/db/$databaseId/terminal",
  },
  {
    icon: Network,
    id: "network",
    keywords: ["servers", "connections"],
    label: "Network",
    permission: "database.network.read",
    to: "/db/$databaseId/network",
  },
  {
    engines: ["mysql", "mariadb", "postgres"],
    icon: Table2,
    id: "viewer",
    keywords: ["tables", "rows", "sql", "query"],
    label: "Viewer",
    permission: "database.data.read",
    to: "/db/$databaseId/viewer",
  },
  {
    icon: ScrollText,
    id: "logs",
    keywords: ["output", "container", "errors"],
    label: "Logs",
    permission: "database.logs.read",
    to: "/db/$databaseId/logs",
  },
] as const satisfies ReadonlyArray<DatabaseDestination>

type AccessibleDatabase = {
  engine: DatabaseEngine
  id: string
  relayId: string
}

export function accessibleDestinationsForDatabase(
  database: AccessibleDatabase,
  capabilities: NavigationAccessCapabilities
): ReadonlyArray<DatabaseDestination> {
  const destinations: ReadonlyArray<DatabaseDestination> = databaseDestinations
  return destinations.filter(
    (destination) =>
      (!destination.engines || destination.engines.includes(database.engine)) &&
      canAccessDatabasePermission(
        capabilities,
        database,
        destination.permission
      )
  )
}

export function canAccessDatabasePermission(
  capabilities: NavigationAccessCapabilities,
  database: Pick<AccessibleDatabase, "id" | "relayId">,
  permission: AccessPermission
): boolean {
  if (capabilities.isPlatformAdmin) return true
  return capabilities.grants.some(
    (grant) =>
      grant.relayId === database.relayId &&
      grantHasPermission(grant, permission) &&
      ((grant.resourceType === "relay" &&
        grant.resourceId === database.relayId) ||
        (grant.resourceType === "database" && grant.resourceId === database.id))
  )
}

export function databaseDestinationHref(
  destination: DatabaseDestination,
  routeId: string
): string {
  return destination.to.replace("$databaseId", encodeURIComponent(routeId))
}

export type AppDestinationId =
  | "files"
  | "info"
  | "logs"
  | "network"
  | "terminal"

export interface AppDestination extends NavigationDestination {
  id: AppDestinationId
  permission: AccessPermission
}

export const appDestinations = [
  {
    icon: SlidersHorizontal,
    id: "info",
    keywords: [
      "overview",
      "settings",
      "details",
      "source",
      "dockerfile",
      "compose",
      "image",
      "environment",
      "deploy",
      "delete",
    ],
    label: "Info",
    permission: "app.read",
    to: "/app/$appId/info",
  },
  {
    icon: TerminalSquare,
    id: "terminal",
    keywords: ["console", "shell", "exec", "bash"],
    label: "Terminal",
    permission: "app.terminal",
    to: "/app/$appId/terminal",
  },
  {
    icon: Network,
    id: "network",
    keywords: ["ports", "domains", "web routes", "databases"],
    label: "Network",
    permission: "app.read",
    to: "/app/$appId/network",
  },
  {
    icon: Folder,
    id: "files",
    keywords: ["data", "volumes", "upload"],
    label: "Files",
    permission: "app.files.read",
    to: "/app/$appId/files/$",
  },
  {
    icon: ScrollText,
    id: "logs",
    keywords: ["deployment", "output", "containers", "errors"],
    label: "Logs",
    permission: "app.logs.read",
    to: "/app/$appId/logs",
  },
] as const satisfies ReadonlyArray<AppDestination>

// Granted on the app's Relay, for all of its apps, or by owning the app.
export function canAccessAppPermission(
  capabilities: NavigationAccessCapabilities,
  app: { id: string; relayId: string },
  permission: AccessPermission
): boolean {
  if (capabilities.isPlatformAdmin) return true
  return capabilities.grants.some(
    (grant) =>
      grant.relayId === app.relayId &&
      (grant.resourceType === "relay" ||
        (grant.resourceType === "app" && grant.resourceId === app.id)) &&
      grantHasPermission(grant, permission)
  )
}

export function accessibleDestinationsForApp(
  app: { id: string; relayId: string },
  capabilities: NavigationAccessCapabilities
): ReadonlyArray<AppDestination> {
  const destinations: ReadonlyArray<AppDestination> = appDestinations
  return destinations.filter((destination) =>
    canAccessAppPermission(capabilities, app, destination.permission)
  )
}

export function appDestinationHref(
  destination: AppDestination,
  routeId: string
): string {
  return destination.to.replace("$appId", encodeURIComponent(routeId))
}

export type RelayDestinationId =
  | "info"
  | "terminal"
  | "volumes"
  | "files"
  | "logs"

export interface RelayDestination extends NavigationDestination {
  id: RelayDestinationId
  permission: AccessPermission
}

export const relayDestinations = [
  {
    icon: SlidersHorizontal,
    id: "info",
    keywords: [
      "settings",
      "details",
      "node",
      "version",
      "proxy",
      "traefik",
      "database",
      "sqlite",
    ],
    label: "Info",
    permission: "relay.read",
    to: "/relay/$relayId/info",
  },
  {
    icon: TerminalSquare,
    id: "terminal",
    keywords: ["shell", "ssh", "host", "node"],
    label: "Terminal",
    permission: "relay.terminal",
    to: "/relay/$relayId/terminal",
  },
  {
    icon: HardDrive,
    id: "volumes",
    keywords: ["docker", "storage", "data", "persistent", "mounts"],
    label: "Volumes",
    permission: "relay.read",
    to: "/relay/$relayId/volumes",
  },
  {
    icon: Folder,
    id: "files",
    keywords: ["host", "filesystem", "editor", "upload", "download"],
    label: "Files",
    permission: "relay.files.read",
    to: "/relay/$relayId/files",
  },
  {
    icon: ScrollText,
    id: "logs",
    keywords: ["output", "container", "errors"],
    label: "Logs",
    permission: "relay.logs.read",
    to: "/relay/$relayId/logs",
  },
] as const satisfies ReadonlyArray<RelayDestination>

export type KilnDestinationId =
  | "info"
  | "logs"
  | "security"
  | "terminal"
  | "viewer"

export interface KilnDestination extends NavigationDestination {
  id: KilnDestinationId
}

// Kiln itself: Hearth, its database and cache, and the Traefik in front of
// them. Platform administrators only.
export const kilnDestinations = [
  {
    icon: SlidersHorizontal,
    id: "info",
    keywords: [
      "kiln",
      "system",
      "hearth",
      "panel",
      "mysql",
      "valkey",
      "cache",
      "traefik",
      "https",
      "platform",
      "repair",
      "recovery",
    ],
    label: "Info",
    to: "/kiln/info",
  },
  {
    icon: ShieldAlert,
    id: "security",
    keywords: [
      "kiln",
      "security",
      "vulnerabilities",
      "cve",
      "sbom",
      "images",
      "hosts",
    ],
    label: "Security",
    to: "/kiln/security",
  },
  {
    icon: Table2,
    id: "viewer",
    keywords: ["kiln", "hearth", "database", "tables", "rows", "sql", "query"],
    label: "Viewer",
    to: "/kiln/viewer",
  },
  {
    icon: ScrollText,
    id: "logs",
    keywords: ["kiln", "hearth", "output", "errors"],
    label: "Logs",
    to: "/kiln/logs",
  },
  {
    icon: TerminalSquare,
    id: "terminal",
    keywords: ["kiln", "shell", "mysql", "valkey", "traefik"],
    label: "Terminal",
    to: "/kiln/terminal",
  },
] as const satisfies ReadonlyArray<KilnDestination>

// Granted on the Relay itself.
export function canAccessRelayPermission(
  capabilities: NavigationAccessCapabilities,
  relayId: string,
  permission: AccessPermission
): boolean {
  if (capabilities.isPlatformAdmin) return true
  return capabilities.grants.some(
    (grant) =>
      grant.relayId === relayId &&
      grant.resourceType === "relay" &&
      grant.resourceId === relayId &&
      grantHasPermission(grant, permission)
  )
}

export function accessibleDestinationsForRelay(
  relay: { id: string },
  capabilities: NavigationAccessCapabilities
): ReadonlyArray<RelayDestination> {
  const destinations: ReadonlyArray<RelayDestination> = relayDestinations
  return destinations.filter((destination) =>
    canAccessRelayPermission(capabilities, relay.id, destination.permission)
  )
}

export function relayDestinationHref(
  destination: RelayDestination,
  routeId: string
): string {
  return destination.to.replace("$relayId", encodeURIComponent(routeId))
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
    // A pending Relay invitation opens only the Relays list, where the
    // invitation row lives; it does not unlock the rest of the section.
    return (
      capabilities.canManageRelays ||
      (destination.to === "/infra/relays" &&
        capabilities.pendingScopes?.some(
          (scope) => scope.resourceType === "relay"
        ) === true)
    )
  }
  if (destination.access === "platform-admin") {
    return capabilities.isPlatformAdmin
  }
  if (destination.access === "sources") {
    // Sources feed syncs. Each person's sources are their own.
    return canUseSyncs(capabilities)
  }
  if (destination.access === "domains") {
    // Each person's Cloudflare connections are their own, for the game
    // servers and apps they reach.
    return (
      capabilities.isPlatformAdmin ||
      hasScopedPermission(capabilities, "instance.read", [
        "instance",
        "relay",
      ]) ||
      hasScopedPermission(capabilities, "instance.create", ["relay"]) ||
      hasScopedPermission(capabilities, "app.read", ["relay", "app"]) ||
      hasScopedPermission(capabilities, "app.create", ["relay"])
    )
  }
  // Each list also opens for people who can only create there; its create
  // action is what they came for.
  if (destination.access === "app-read") {
    return (
      hasScopedPermission(capabilities, "app.read", ["relay", "app"]) ||
      hasScopedPermission(capabilities, "app.create", ["relay"])
    )
  }
  if (destination.access === "instance-read") {
    return (
      capabilities.pendingScopes?.some(
        (scope) => scope.resourceType === "instance"
      ) === true ||
      hasScopedPermission(capabilities, "instance.read", [
        "instance",
        "relay",
      ]) ||
      hasScopedPermission(capabilities, "instance.create", ["relay"])
    )
  }
  return (
    capabilities.pendingScopes?.some(
      (scope) => scope.resourceType === "database"
    ) === true ||
    hasScopedPermission(capabilities, "database.read", ["database", "relay"]) ||
    hasScopedPermission(capabilities, "database.create", ["relay"])
  )
}

export function canAccessAccessManagement(
  capabilities: NavigationAccessCapabilities
): boolean {
  return (
    capabilities.canManageAccess ||
    [
      "access.read",
      "access.invite",
      "access.manage",
      "preset.read",
      "preset.create",
      "preset.manage",
    ].some((permission) =>
      hasScopedPermission(capabilities, permission as AccessPermission)
    )
  )
}

export function canAccessAutomations(
  capabilities: NavigationAccessCapabilities
): boolean {
  return (
    hasScopedPermission(capabilities, "schedule.read") ||
    canUseSyncs(capabilities)
  )
}

/** Syncs write files, so they're for whoever may edit files somewhere. */
function canUseSyncs(capabilities: NavigationAccessCapabilities): boolean {
  return (
    capabilities.isPlatformAdmin ||
    capabilities.canManageRelays ||
    hasScopedPermission(capabilities, "instance.files.write", [
      "instance",
      "relay",
    ]) ||
    hasScopedPermission(capabilities, "app.files.write", ["relay", "app"]) ||
    hasScopedPermission(capabilities, "relay.files.write", ["relay"])
  )
}

export function canAccessBackups(
  capabilities: NavigationAccessCapabilities
): boolean {
  return hasScopedPermission(capabilities, "backup.read")
}

export function canAccessActivity(
  capabilities: NavigationAccessCapabilities
): boolean {
  return (
    hasScopedPermission(capabilities, "relay.audit.read", ["relay"]) ||
    hasScopedPermission(capabilities, "instance.read", ["instance", "relay"])
  )
}

export function firstAccessibleAppHref(
  capabilities: NavigationAccessCapabilities
): string {
  const infrastructure = accessibleInfrastructureDestinations(capabilities)[0]
  if (infrastructure) return infrastructure.to
  if (canAccessAutomations(capabilities)) return "/automations/schedules"
  if (canAccessBackups(capabilities)) return "/backups/runs"
  if (canAccessActivity(capabilities)) return "/activity"
  if (canAccessAccessManagement(capabilities)) return "/access"
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
  // A Relay Creator owns every Relay they pair, with every Relay permission.
  // Show that workspace from the start instead of after the first pairing.
  if (
    capabilities.isRelayCreator &&
    (!allowedResourceTypes || allowedResourceTypes.has("relay")) &&
    accessPermissionSupported(permission, "relay")
  ) {
    return true
  }
  return capabilities.grants.some(
    (grant) =>
      (!allowedResourceTypes || allowedResourceTypes.has(grant.resourceType)) &&
      grantHasPermission(grant, permission)
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
