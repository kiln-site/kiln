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
import { filterRoutes } from "@/components/route-command-filter"
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
  accessibleDestinationsForServer,
  accessibleInfrastructureDestinations,
  automationDestinations,
  canAccessActivity,
  canAccessAutomations,
  canAccessBackups,
  serverDestinationHref,
  settingsDestinations,
  type NavigationAccessCapabilities,
  type NavigationDestination,
} from "@/lib/navigation-destinations"

interface RouteCommandMenuProviderProps {
  capabilities: NavigationAccessCapabilities
  children: React.ReactNode
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}

const managementRoutes: Array<NavigationDestination> = [
  {
    icon: BackupIcon,
    keywords: ["manage", "restore", "snapshots"],
    label: "Backups",
    to: "/backups/runs",
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

const emptyInstances: Array<SidebarInstance> = []

function serverRoutes(
  instance: SidebarInstance,
  routeId: string,
  capabilities: NavigationAccessCapabilities
) {
  const serverKeywords = ["server", instance.name, instance.implementation]
  return accessibleDestinationsForServer(instance, capabilities).map(
    (destination) => ({
      icon: destination.icon,
      keywords: [...serverKeywords, ...destination.keywords],
      label: destination.label,
      to: serverDestinationHref(destination, routeId),
    })
  ) satisfies Array<NavigationDestination>
}

const RouteCommandMenuContext = React.createContext<(() => void) | null>(null)

function subscribeToPlatform() {
  return () => undefined
}

function isApplePlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export function RouteCommandMenuProvider({
  capabilities,
  children,
  initialSelectedInstanceRouteId,
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
        ? serverRoutes(
            selectedInstance,
            selectedInstanceRouteIdentifier,
            capabilities
          )
        : [],
    [capabilities, selectedInstance, selectedInstanceRouteIdentifier]
  )
  const infrastructureRoutes =
    accessibleInfrastructureDestinations(capabilities)
  const manageRoutes = [
    ...(canAccessAutomations(capabilities) ? automationDestinations : []),
    ...(canAccessBackups(capabilities) ? [managementRoutes[0]!] : []),
    ...(canAccessActivity(capabilities) ? [managementRoutes[1]!] : []),
    ...(capabilities.canManageAccess ? [accessRoute] : []),
  ]

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
            {manageRoutes.length > 0 ? (
              <>
                <RouteGroup
                  heading="Manage"
                  routes={manageRoutes}
                  onSelect={navigateToRoute}
                />
                <CommandSeparator />
              </>
            ) : null}
            <RouteGroup
              heading="Settings"
              routes={settingsDestinations}
              onSelect={navigateToRoute}
            />
            {infrastructureRoutes.length > 0 ? (
              <>
                <CommandSeparator />
                <RouteGroup
                  heading="Infrastructure"
                  routes={infrastructureRoutes}
                  onSelect={navigateToRoute}
                />
              </>
            ) : null}
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
