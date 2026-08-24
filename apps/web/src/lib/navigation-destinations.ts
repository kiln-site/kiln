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

export type NavigationIcon = ComponentType<{ className?: string }>

export interface NavigationDestination {
  icon: NavigationIcon
  keywords: ReadonlyArray<string>
  label: string
  to: string
}

export type InfrastructureDestinationAccess =
  | "authenticated"
  | "manage-relays"
  | "platform-admin"

export const infrastructureDestinations = [
  {
    access: "authenticated",
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
    access: "authenticated",
    icon: Server,
    keywords: ["infrastructure", "instances"],
    label: "Servers",
    to: "/infra/servers",
  },
  {
    access: "authenticated",
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
  workspaces: ReadonlyArray<ServerWorkspaceKind>
}

export const serverDestinations = [
  {
    icon: TerminalSquare,
    id: "console",
    keywords: ["terminal"],
    label: "Console",
    to: "/server/$serverId/console",
    workspaces: ["network-stack", "server"],
  },
  {
    icon: Folder,
    id: "files",
    keywords: ["browser", "storage"],
    label: "Files",
    to: "/server/$serverId/files/$",
    workspaces: ["network-stack", "server"],
  },
  {
    icon: Rocket,
    id: "startup",
    keywords: ["configuration", "variables"],
    label: "Startup",
    to: "/server/$serverId/startup",
    workspaces: ["server"],
  },
  {
    icon: Network,
    id: "network",
    keywords: ["ports", "allocation"],
    label: "Network",
    to: "/server/$serverId/network",
    workspaces: ["network-stack", "server"],
  },
  {
    icon: SlidersHorizontal,
    id: "info",
    keywords: ["settings", "details"],
    label: "Info",
    to: "/server/$serverId/info",
    workspaces: ["server"],
  },
] as const satisfies ReadonlyArray<ServerDestination>

type NavigableServer = Pick<RelayInstance, "brickId">

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
