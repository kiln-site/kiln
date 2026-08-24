import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import {
  Command as CommandIcon,
  ListTodo,
  Search,
  UserRoundCog,
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
import {
  automationDestinations,
  destinationsForServer,
  infrastructureDestinations,
  serverDestinationHref,
  settingsDestinations,
  type NavigationDestination,
} from "@/lib/navigation-destinations"

interface RouteCommandMenuProviderProps {
  canManageAccess: boolean
  canManageRelays: boolean
  children: React.ReactNode
  initialSelectedInstanceRouteId: string | null
  isPlatformAdmin: boolean
  relayConfigured: boolean
}

const managementRoutes: Array<NavigationDestination> = [
  {
    icon: BackupIcon,
    keywords: ["manage", "restore", "snapshots"],
    label: "Backups",
    to: "/backups",
  },
  {
    icon: ListTodo,
    keywords: ["manage", "audit", "events"],
    label: "Activity",
    to: "/activity",
  },
]

const accessRoute: NavigationDestination = {
  icon: UserRoundCog,
  keywords: ["manage", "users", "permissions"],
  label: "Access",
  to: "/access",
}

const authenticatedInfrastructureDestinations =
  infrastructureDestinations.filter(
    (destination) => destination.access === "authenticated"
  )
const relayInfrastructureDestinations = infrastructureDestinations.filter(
  (destination) => destination.access === "manage-relays"
)
const platformInfrastructureDestinations = infrastructureDestinations.filter(
  (destination) => destination.access === "platform-admin"
)

const emptyInstances: Array<SidebarInstance> = []

function serverRoutes(instance: SidebarInstance, routeId: string) {
  const serverKeywords = ["server", instance.name, instance.implementation]
  return destinationsForServer(instance).map((destination) => ({
    icon: destination.icon,
    keywords: [...serverKeywords, ...destination.keywords],
    label: destination.label,
    to: serverDestinationHref(destination, routeId),
  })) satisfies Array<NavigationDestination>
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
    (to: string) => {
      setOpen(false)
      void navigate({ href: to })
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
                routes={automationDestinations}
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
              routes={settingsDestinations}
              onSelect={navigateToRoute}
            />
            <CommandSeparator />
            <CommandGroup heading="Infrastructure">
              <RouteItems
                routes={authenticatedInfrastructureDestinations}
                onSelect={navigateToRoute}
              />
              {canManageRelays ? (
                <RouteItems
                  routes={relayInfrastructureDestinations}
                  onSelect={navigateToRoute}
                />
              ) : null}
              {isPlatformAdmin ? (
                <RouteItems
                  routes={platformInfrastructureDestinations}
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
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-keyshortcuts="Control+K Meta+K"
            aria-label={`Search Kiln, ${shortcutLabel}`}
            className="h-8 w-full justify-start gap-2.5 bg-black/10 px-2 shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--sidebar-foreground)_16%,transparent)]! group-data-[collapsible=icon]:justify-center hover:bg-black/15 hover:shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--sidebar-foreground)_24%,transparent)]! dark:bg-black/25 dark:hover:bg-black/35"
            tooltip={`Search Kiln · ${shortcutLabel}`}
            type="button"
            onClick={openMenu}
          >
            <Search />
            <span className="min-w-0 flex-1 truncate text-sidebar-foreground/60 group-data-[collapsible=icon]:sr-only">
              Search Kiln...
            </span>
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
  routes: ReadonlyArray<NavigationDestination>
  onSelect: (to: string) => void
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
  routes: ReadonlyArray<NavigationDestination>
  onSelect: (to: string) => void
}) {
  return routes.map((route) => (
    <RouteItem key={route.to} route={route} onSelect={onSelect} />
  ))
}

function RouteItem({
  route,
  onSelect,
}: {
  route: NavigationDestination
  onSelect: (to: string) => void
}) {
  return (
    <CommandItem
      keywords={[route.label, ...route.keywords]}
      value={route.to}
      onSelect={onSelect}
    >
      <route.icon className="text-muted-foreground" />
      <span>{route.label}</span>
    </CommandItem>
  )
}
