import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import {
  CalendarDays,
  CircleUserRound,
  Command as CommandIcon,
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
  Search,
  Server,
  SlidersHorizontal,
  TerminalSquare,
  UserRoundCog,
  Waypoints,
  Wrench,
} from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@workspace/ui/components/command"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { Kbd } from "@workspace/ui/components/kbd"

import { BackupIcon } from "@/components/backup-icon"
import { relaySnapshotQueryOptions } from "@/lib/query-options"
import {
  findFirstCanonicalRelayInstance,
  relayInstanceRouteIdentifier,
  resolveCanonicalRelayInstance,
  selectSidebarInstances,
} from "@/lib/relay-selectors"
import type { SidebarInstance } from "@/lib/relay-selectors"
import { readSelectedInstanceRouteId } from "@/lib/ui-preference-cookies"

interface RouteCommandMenuProviderProps {
  canManageAccess: boolean
  canManageRelays: boolean
  children: React.ReactNode
  initialSelectedInstanceRouteId: string | null
  isPlatformAdmin: boolean
  relayConfigured: boolean
}

interface RouteDestination {
  href: string
  icon: React.ComponentType<{ className?: string }>
  keywords: Array<string>
  label: string
}

const infrastructureRoutes: Array<RouteDestination> = [
  {
    href: "/infra/setup",
    icon: Wrench,
    keywords: ["infrastructure", "configure"],
    label: "Setup",
  },
  {
    href: "/infra/servers",
    icon: Server,
    keywords: ["infrastructure", "instances"],
    label: "Servers",
  },
  {
    href: "/infra/databases",
    icon: Database,
    keywords: ["infrastructure", "mysql"],
    label: "Databases",
  },
]

const relayRoutes: Array<RouteDestination> = [
  {
    href: "/infra/relays",
    icon: RadioTower,
    keywords: ["infrastructure", "nodes"],
    label: "Relays",
  },
]

const platformRoutes: Array<RouteDestination> = [
  {
    href: "/infra/tailscale",
    icon: Waypoints,
    keywords: ["infrastructure", "network"],
    label: "Tailscale",
  },
  {
    href: "/infra/domains",
    icon: Globe2,
    keywords: ["infrastructure", "cloudflare", "urls"],
    label: "Domains",
  },
]

const automationRoutes: Array<RouteDestination> = [
  {
    href: "/automations/schedules",
    icon: ListTodo,
    keywords: ["automations", "tasks"],
    label: "Schedules",
  },
  {
    href: "/automations/sync",
    icon: RefreshCw,
    keywords: ["automations", "synchronize"],
    label: "Sync",
  },
  {
    href: "/automations/history",
    icon: History,
    keywords: ["automations", "runs"],
    label: "History",
  },
  {
    href: "/automations/calendar",
    icon: CalendarDays,
    keywords: ["automations", "dates"],
    label: "Calendar",
  },
]

const managementRoutes: Array<RouteDestination> = [
  {
    href: "/backups",
    icon: BackupIcon,
    keywords: ["manage", "restore", "snapshots"],
    label: "Backups",
  },
  {
    href: "/activity",
    icon: ListTodo,
    keywords: ["manage", "audit", "events"],
    label: "Activity",
  },
]

const accessRoute: RouteDestination = {
  href: "/access",
  icon: UserRoundCog,
  keywords: ["manage", "users", "permissions"],
  label: "Access",
}

const settingsRoutes: Array<RouteDestination> = [
  {
    href: "/settings/appearance",
    icon: Palette,
    keywords: ["settings", "theme", "color"],
    label: "Appearance",
  },
  {
    href: "/settings/files",
    icon: FolderDown,
    keywords: ["settings", "downloads", "editor"],
    label: "Files",
  },
  {
    href: "/settings/account",
    icon: CircleUserRound,
    keywords: ["settings", "profile", "security"],
    label: "Account",
  },
  {
    href: "/settings/billing",
    icon: CreditCard,
    keywords: ["settings", "plan", "subscription"],
    label: "Billing",
  },
]

const emptyInstances: Array<SidebarInstance> = []

function serverRoutes(instance: SidebarInstance, routeId: string) {
  const serverKeywords = ["server", instance.name, instance.implementation]
  const encodedRouteId = encodeURIComponent(routeId)

  return [
    {
      href: `/server/${encodedRouteId}/console`,
      icon: TerminalSquare,
      keywords: [...serverKeywords, "terminal"],
      label: "Console",
    },
    {
      href: `/server/${encodedRouteId}/files/`,
      icon: Folder,
      keywords: [...serverKeywords, "browser", "storage"],
      label: "Files",
    },
    {
      href: `/server/${encodedRouteId}/startup`,
      icon: Rocket,
      keywords: [...serverKeywords, "configuration", "variables"],
      label: "Startup",
    },
    {
      href: `/server/${encodedRouteId}/network`,
      icon: Network,
      keywords: [...serverKeywords, "ports", "allocation"],
      label: "Network",
    },
    {
      href: `/server/${encodedRouteId}/info`,
      icon: SlidersHorizontal,
      keywords: [...serverKeywords, "settings", "details"],
      label: "Info",
    },
  ] satisfies Array<RouteDestination>
}

function editDistance(left: string, right: string) {
  const distances = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) =>
      row === 0 ? column : column === 0 ? row : 0
    )
  )

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1

      distances[row]![column] = Math.min(
        distances[row - 1]![column]! + 1,
        distances[row]![column - 1]! + 1,
        distances[row - 1]![column - 1]! + substitutionCost
      )

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distances[row]![column] = Math.min(
          distances[row]![column]!,
          distances[row - 2]![column - 2]! + 1
        )
      }
    }
  }

  return distances[left.length]![right.length]!
}

function scoreTerm(term: string, candidate: string) {
  if (candidate === term) return 1
  if (candidate.startsWith(term)) return 0.95
  if (candidate.includes(term)) return 0.9

  const allowedEdits = term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0
  if (
    allowedEdits === 0 ||
    Math.abs(candidate.length - term.length) > allowedEdits
  ) {
    return 0
  }

  const distance = editDistance(term, candidate)
  return distance <= allowedEdits ? 0.75 - distance * 0.05 : 0
}

export function filterRoutes(
  value: string,
  search: string,
  keywords?: Array<string>
) {
  const terms = search.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []
  if (terms.length === 0) return 1

  const candidates =
    [value, ...(keywords ?? [])]
      .join(" ")
      .toLocaleLowerCase()
      .match(/[a-z0-9]+/g) ?? []

  const scores = terms.map((term) =>
    Math.max(...candidates.map((candidate) => scoreTerm(term, candidate)), 0)
  )

  return scores.every((score) => score > 0) ? Math.min(...scores) : 0
}

const RouteCommandMenuContext = React.createContext<(() => void) | null>(null)

function subscribeToPlatform() {
  return () => undefined
}

function isApplePlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export function RouteCommandMenuProvider({
  canManageAccess,
  canManageRelays,
  children,
  initialSelectedInstanceRouteId,
  isPlatformAdmin,
  relayConfigured,
}: RouteCommandMenuProviderProps) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const { data: instances = emptyInstances } = useQuery({
    ...relaySnapshotQueryOptions(),
    enabled: relayConfigured,
    select: selectSidebarInstances,
  })
  const serverId = useRouterState({
    select: (state) =>
      (state.matches.at(-1)?.params as { serverId?: string } | undefined)
        ?.serverId,
  })
  const selectedInstanceRouteId =
    serverId ?? readSelectedInstanceRouteId() ?? initialSelectedInstanceRouteId
  const preferredResolution = resolveCanonicalRelayInstance(
    instances,
    selectedInstanceRouteId
  )
  const selectedInstance =
    preferredResolution.status === "found"
      ? preferredResolution.instance
      : serverId || preferredResolution.status === "ambiguous"
        ? null
        : (findFirstCanonicalRelayInstance(instances) ?? null)
  const selectedInstanceRouteIdentifier = selectedInstance
    ? (relayInstanceRouteIdentifier(instances, selectedInstance) ?? null)
    : null
  const selectedServerRoutes = React.useMemo(
    () =>
      selectedInstance && selectedInstanceRouteIdentifier
        ? serverRoutes(selectedInstance, selectedInstanceRouteIdentifier)
        : [],
    [selectedInstance, selectedInstanceRouteIdentifier]
  )

  const openMenu = React.useCallback(() => setOpen(true), [])

  React.useEffect(() => {
    const openFromKeyboard = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.key.toLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey)
      ) {
        return
      }

      event.preventDefault()
      setOpen((current) => !current)
    }

    document.addEventListener("keydown", openFromKeyboard)
    return () => document.removeEventListener("keydown", openFromKeyboard)
  }, [])

  const navigateToRoute = React.useCallback(
    (href: string) => {
      setOpen(false)
      void navigate({ href })
    },
    [navigate]
  )

  return (
    <RouteCommandMenuContext.Provider value={openMenu}>
      {children}
      <CommandDialog
        className="max-w-xl gap-0 border-accent-border/25 bg-popover shadow-2xl shadow-black/55 sm:max-w-xl"
        description="Search Kiln routes and navigate to a page."
        open={open}
        title="Navigate Kiln"
        onOpenChange={setOpen}
      >
        <Command
          className="rounded-xl! bg-transparent p-0"
          filter={filterRoutes}
        >
          <CommandInput placeholder="Search routes..." />
          <CommandList className="max-h-[min(28rem,60dvh)] p-1">
            <CommandEmpty>No matching routes.</CommandEmpty>
            {selectedServerRoutes.length > 0 ? (
              <>
                <RouteGroup
                  heading="Server"
                  routes={selectedServerRoutes}
                  onSelect={navigateToRoute}
                />
                <CommandSeparator />
              </>
            ) : null}
            <CommandGroup heading="Manage">
              <RouteItems
                routes={automationRoutes}
                onSelect={navigateToRoute}
              />
              <RouteItems
                routes={managementRoutes}
                onSelect={navigateToRoute}
              />
              {canManageAccess ? (
                <RouteItem route={accessRoute} onSelect={navigateToRoute} />
              ) : null}
            </CommandGroup>
            <CommandSeparator />
            <RouteGroup
              heading="Settings"
              routes={settingsRoutes}
              onSelect={navigateToRoute}
            />
            <CommandSeparator />
            <CommandGroup heading="Infrastructure">
              <RouteItems
                routes={infrastructureRoutes}
                onSelect={navigateToRoute}
              />
              {canManageRelays ? (
                <RouteItems routes={relayRoutes} onSelect={navigateToRoute} />
              ) : null}
              {isPlatformAdmin ? (
                <RouteItems
                  routes={platformRoutes}
                  onSelect={navigateToRoute}
                />
              ) : null}
            </CommandGroup>
          </CommandList>
          <div className="type-meta flex items-center justify-between border-t border-border/70 bg-background/35 px-3 py-2 text-muted-foreground">
            <span>Navigate Kiln</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd className="border-0 bg-transparent p-0 text-foreground shadow-none">
                  ↑↓
                </Kbd>
                Select
              </span>
              <span className="flex items-center gap-1">
                <Kbd className="border-0 bg-transparent p-0 text-foreground shadow-none">
                  Esc
                </Kbd>
                Close
              </span>
            </span>
          </div>
        </Command>
      </CommandDialog>
    </RouteCommandMenuContext.Provider>
  )
}

export const RouteCommandMenuTrigger = React.memo(
  function RouteCommandMenuTrigger() {
    const openMenu = React.useContext(RouteCommandMenuContext)
    const isApple = React.useSyncExternalStore(
      subscribeToPlatform,
      isApplePlatform,
      () => true
    )
    const shortcutLabel = isApple ? "Command K" : "Ctrl K"

    if (!openMenu) {
      throw new Error(
        "RouteCommandMenuTrigger must be used inside RouteCommandMenuProvider"
      )
    }

    return (
      <SidebarMenu className="w-fit self-center justify-self-end group-data-[collapsible=icon]:justify-self-center">
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-keyshortcuts="Control+K Meta+K"
            aria-label={`Search routes, ${shortcutLabel}`}
            className="h-8 w-auto! justify-start gap-2.5 bg-black/10 px-1.5 shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--sidebar-foreground)_16%,transparent)]! group-data-[collapsible=icon]:justify-center hover:bg-black/15 hover:shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--sidebar-foreground)_24%,transparent)]! dark:bg-black/25 dark:hover:bg-black/35"
            tooltip={`Search routes · ${shortcutLabel}`}
            type="button"
            onClick={openMenu}
          >
            <Search />
            <span className="sr-only">Search routes</span>
            <Kbd
              aria-label={shortcutLabel}
              className="h-[18px] min-w-8 gap-0.5 px-1 group-data-[collapsible=icon]:hidden"
            >
              {isApple ? (
                <CommandIcon className="size-3!" aria-hidden="true" />
              ) : (
                <span className="tracking-[-0.03em]">Ctrl</span>
              )}
              <span>K</span>
            </Kbd>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }
)

function RouteGroup({
  heading,
  routes,
  onSelect,
}: {
  heading: string
  routes: Array<RouteDestination>
  onSelect: (href: string) => void
}) {
  return (
    <CommandGroup heading={heading}>
      <RouteItems routes={routes} onSelect={onSelect} />
    </CommandGroup>
  )
}

function RouteItems({
  routes,
  onSelect,
}: {
  routes: Array<RouteDestination>
  onSelect: (href: string) => void
}) {
  return routes.map((route) => (
    <RouteItem key={route.href} route={route} onSelect={onSelect} />
  ))
}

function RouteItem({
  route,
  onSelect,
}: {
  route: RouteDestination
  onSelect: (href: string) => void
}) {
  return (
    <CommandItem
      keywords={[route.label, ...route.keywords]}
      value={route.href}
      onSelect={onSelect}
    >
      <route.icon className="text-muted-foreground" />
      <span>{route.label}</span>
    </CommandItem>
  )
}
