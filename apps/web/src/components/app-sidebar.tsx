import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  CalendarClock,
  ChevronsUpDown,
  ListTodo,
  LoaderCircle,
  LogOut,
  Settings,
  UserRoundCog,
} from "lucide-react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { forkPromise } from "@/effect/promise"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { AccountAvatar } from "@/components/account-avatar"
import {
  AccountSwitcherSection,
  signOutAllAccounts,
  useBrowserAccountsPrefetch,
} from "@/components/account-switcher"
import { HearthMark } from "@/components/hearth-mark"
import {
  CollapsedNotificationsAnchor,
  NotificationsBell,
  NotificationsMenuItem,
  UnreadNotificationsIndicator,
} from "@/components/notifications"
import { BackupIcon } from "@/components/backup-icon"
import {
  RouteCommandMenuProvider,
  RouteCommandMenuTrigger,
} from "@/components/route-command-menu"
import { InstanceCard } from "@/components/instance-card"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import {
  InstancePickerContent,
  type InstancePickerItem,
  InstancePickerPopover,
  InstancePickerPopoverContent,
  InstancePickerPopoverTrigger,
} from "@/components/instance-picker"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { clearAppearanceCache } from "@/lib/appearance"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaysQueryOptions,
  serverDirectoryQueryOptions,
} from "@/lib/query-options"
import { kilnReleaseLabel } from "@/lib/release-version"
import { disableDevelopmentBypass } from "@/server/auth"
import { engineLabel } from "@/components/database/database-presentation"
import {
  databaseRouteIdFromSelection,
  databaseRouteIdentifier,
  databaseSelectionRouteId,
  resolveDatabaseRoute,
  type ManagedDatabaseDirectoryEntry,
} from "@/lib/database-route"
import type { getManagedDatabaseDirectory } from "@/server/databases"
import {
  appRouteIdFromSelection,
  appRouteIdentifier,
  appSelectionRouteId,
  resolveAppRoute,
  type AppDirectoryEntry,
} from "@/lib/app-route"
import {
  relayRouteIdFromSelection,
  relayRouteIdentifier,
  relaySelectionRouteId,
  resolveRelayRoute,
  type RelayDirectoryEntry,
} from "@/lib/relay-route"
import { relayInstanceRouteIdentifier } from "@/lib/relay-selectors"
import type { SidebarInstance } from "@/lib/relay-selectors"
import { globalSectionFromRouteId } from "@/lib/route-sections"
import type { GlobalSection } from "@/lib/route-sections"
import {
  accessibleDestinationsForApp,
  accessibleDestinationsForDatabase,
  accessibleDestinationsForRelay,
  accessibleDestinationsForServer,
  accessibleInfrastructureDestinations,
  canAccessActivity,
  canAccessAutomations,
  canAccessBackups,
  relayDestinations,
  serverDestinations,
  type AppDestinationId,
  type DatabaseDestinationId,
  type NavigationAccessCapabilities,
  type RelayDestinationId,
  type ServerDestination,
  type ServerDestinationId,
} from "@/lib/navigation-destinations"
import {
  persistSelectedInstanceRouteId,
  readSelectedInstanceRouteId,
} from "@/lib/ui-preference-cookies"
import { useSidebarServerNavigation } from "@/lib/use-server-navigation"
import { warmFileWorkspaceModule } from "@/lib/workspace-module-preloads"

export type InstanceTab = ServerDestinationId

interface AppSidebarViewProps {
  capabilities: NavigationAccessCapabilities
  user: AuthenticatedUser
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}

export const AppSidebar = React.memo(function AppSidebar({
  initialSelectedInstanceRouteId,
}: {
  initialSelectedInstanceRouteId: string | null
}) {
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { relayConfigured } = capabilities

  return (
    <AppSidebarView
      capabilities={capabilities}
      initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
      relayConfigured={relayConfigured}
      user={capabilities.user}
    />
  )
})

const AppSidebarView = React.memo(function AppSidebarView({
  capabilities,
  user,
  initialSelectedInstanceRouteId,
  relayConfigured,
}: AppSidebarViewProps) {
  return (
    <RouteCommandMenuProvider
      capabilities={capabilities}
      initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
      relayConfigured={relayConfigured}
    >
      <Sidebar collapsible="icon" className="border-sidebar-border/80">
        <SidebarHeader className="h-20 shrink-0 justify-center px-2 py-2">
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-1">
              <SidebarMenuButton
                size="lg"
                className="h-11 min-w-0 flex-1 hover:bg-transparent active:bg-transparent data-[state=open]:bg-transparent"
                tooltip="Kiln"
              >
                <HearthMark className="group-data-[collapsible=icon]:size-[40px]!" />
                <span className="min-w-0 flex-1 truncate font-heading text-2xl font-semibold tracking-[0.04em]">
                  KILN
                </span>
              </SidebarMenuButton>
              <HeaderNotificationsBell />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <div className="shrink-0 p-2 group-data-[collapsible=icon]:px-0">
          <RouteCommandMenuTrigger />
        </div>

        <SidebarSeparator />

        <SidebarContent>
          <InfrastructureNavigation
            capabilities={capabilities}
            initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
            relayConfigured={relayConfigured}
          />

          <SidebarInstanceNavigation
            capabilities={capabilities}
            initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
            relayConfigured={relayConfigured}
          />
        </SidebarContent>

        <AccountNavigation capabilities={capabilities} user={user} />
      </Sidebar>
    </RouteCommandMenuProvider>
  )
})

// Collapsed, notifications live in the account menu instead. Only one popover
// may be mounted at a time, since both share one open state.
function HeaderNotificationsBell() {
  const { isMobile, state } = useSidebar()
  if (state === "collapsed" && !isMobile) return null
  return <NotificationsBell className="mr-1" tooltipHidden={isMobile} />
}

function InfrastructureNavigation({
  capabilities,
  initialSelectedInstanceRouteId,
  relayConfigured,
}: {
  capabilities: NavigationAccessCapabilities
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}) {
  const destinations = accessibleInfrastructureDestinations(capabilities)
  const showRelays = destinations.some(
    (destination) => destination.to === "/infra/relays"
  )
  const showServers = destinations.some(
    (destination) => destination.to === "/infra/servers"
  )
  const showDatabases = destinations.some(
    (destination) => destination.to === "/infra/databases"
  )
  const showApps = destinations.some(
    (destination) => destination.to === "/infra/apps"
  )
  if (!showRelays && !showServers && !showDatabases && !showApps) return null

  return (
    <SidebarGroup className="pt-2">
      <SidebarGroupLabel className="type-technical-label">
        Infrastructure
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {showRelays ? (
            <RelaysNavigationItem relayConfigured={relayConfigured} />
          ) : null}
          {showServers ? (
            <ServersNavigationItem
              initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
              relayConfigured={relayConfigured}
            />
          ) : null}
          {showDatabases ? (
            <DatabasesNavigationItem relayConfigured={relayConfigured} />
          ) : null}
          {showApps ? (
            <AppsNavigationItem relayConfigured={relayConfigured} />
          ) : null}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function RelaysNavigationItem({
  relayConfigured,
}: {
  relayConfigured: boolean
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Relays">
        <Link
          to="/infra/relays"
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          <RelayKindIcon />
          <span>Relays</span>
        </Link>
      </SidebarMenuButton>
      <SidebarMenuBadge className="text-sidebar-muted-foreground">
        <RelayCount relayConfigured={relayConfigured} />
      </SidebarMenuBadge>
    </SidebarMenuItem>
  )
}

const RelayCount = React.memo(function RelayCount({
  relayConfigured,
}: {
  relayConfigured: boolean
}) {
  const { data: count = 0 } = useQuery({
    ...relaysQueryOptions(),
    enabled: relayConfigured,
    select: (relays) => relays.length,
  })

  return count
})

function DatabasesNavigationItem({
  relayConfigured,
}: {
  relayConfigured: boolean
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Databases">
        <Link
          to="/infra/databases"
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          <DatabaseKindIcon />
          <span>Databases</span>
        </Link>
      </SidebarMenuButton>
      <SidebarMenuBadge className="text-sidebar-muted-foreground">
        <DatabaseCount relayConfigured={relayConfigured} />
      </SidebarMenuBadge>
    </SidebarMenuItem>
  )
}

const DatabaseCount = React.memo(function DatabaseCount({
  relayConfigured,
}: {
  relayConfigured: boolean
}) {
  const { data: count = 0 } = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    enabled: relayConfigured,
    select: (databases) => databases.length,
  })

  return count
})

function AppsNavigationItem({ relayConfigured }: { relayConfigured: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Apps">
        <Link
          to="/infra/apps"
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          <AppKindIcon />
          <span>Apps</span>
        </Link>
      </SidebarMenuButton>
      <SidebarMenuBadge className="text-sidebar-muted-foreground">
        <AppCount relayConfigured={relayConfigured} />
      </SidebarMenuBadge>
    </SidebarMenuItem>
  )
}

const AppCount = React.memo(function AppCount({
  relayConfigured,
}: {
  relayConfigured: boolean
}) {
  const { data: count = 0 } = useQuery({
    ...appDirectoryQueryOptions(),
    enabled: relayConfigured,
    select: (apps) => apps.length,
  })

  return count
})

function ServersNavigationItem({
  initialSelectedInstanceRouteId,
  relayConfigured,
}: {
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Game Servers">
        <Link
          to="/infra/servers"
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          <ServerKindIcon />
          <span>Game Servers</span>
        </Link>
      </SidebarMenuButton>
      <SidebarMenuBadge className="text-sidebar-muted-foreground">
        <InfrastructureInstanceCount
          initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
          relayConfigured={relayConfigured}
        />
      </SidebarMenuBadge>
    </SidebarMenuItem>
  )
}

const InfrastructureInstanceCount = React.memo(
  function InfrastructureInstanceCount({
    initialSelectedInstanceRouteId,
    relayConfigured,
  }: {
    initialSelectedInstanceRouteId: string | null
    relayConfigured: boolean
  }) {
    const { data } = useSidebarServerNavigation(
      initialSelectedInstanceRouteId,
      relayConfigured
    )

    return data?.serverCount ?? 0
  }
)

function SidebarInstanceNavigation({
  capabilities,
  initialSelectedInstanceRouteId,
  relayConfigured,
}: {
  capabilities: NavigationAccessCapabilities
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}) {
  // "server", a database selection ("db:<id>"), an app selection
  // ("app:<id>"), a Relay selection ("relay:<id>"), or null off instance
  // routes.
  const routeSelection = useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params as
        | {
            appId?: string
            databaseId?: string
            relayId?: string
            serverId?: string
          }
        | undefined
      if (params?.databaseId) return databaseSelectionRouteId(params.databaseId)
      if (params?.appId) return appSelectionRouteId(params.appId)
      if (params?.relayId) return relaySelectionRouteId(params.relayId)
      return params?.serverId ? "server" : null
    },
  })
  const selection =
    routeSelection === "server"
      ? null
      : (routeSelection ??
        readSelectedInstanceRouteId() ??
        initialSelectedInstanceRouteId)
  const databaseRouteId = databaseRouteIdFromSelection(selection)
  const appRouteId = appRouteIdFromSelection(selection)
  const relayRouteId = relayRouteIdFromSelection(selection)
  const destinations = accessibleInfrastructureDestinations(capabilities)
  const showDatabases =
    relayConfigured &&
    destinations.some((destination) => destination.to === "/infra/databases")
  const showApps =
    relayConfigured &&
    destinations.some((destination) => destination.to === "/infra/apps")
  // Without servers, the sidebar opens the first database, then app, then
  // Relay, so whatever the user can reach still fills it.
  const relayFallback = relayConfigured ? (
    <SidebarRelayNavigation
      capabilities={capabilities}
      fallback={null}
      relayRouteId={null}
    />
  ) : null
  const appFallback = showApps ? (
    <SidebarAppNavigation
      appRouteId={null}
      capabilities={capabilities}
      fallback={relayFallback}
    />
  ) : (
    relayFallback
  )
  const databaseFallback = showDatabases ? (
    <SidebarDatabaseNavigation
      capabilities={capabilities}
      databaseRouteId={null}
      fallback={appFallback}
    />
  ) : (
    appFallback
  )
  const serverNavigation = (
    <SidebarServerNavigation
      capabilities={capabilities}
      emptyFallback={databaseFallback}
      initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
      relayConfigured={relayConfigured}
    />
  )

  return databaseRouteId ? (
    <SidebarDatabaseNavigation
      capabilities={capabilities}
      databaseRouteId={databaseRouteId}
      fallback={serverNavigation}
    />
  ) : appRouteId ? (
    <SidebarAppNavigation
      appRouteId={appRouteId}
      capabilities={capabilities}
      fallback={serverNavigation}
    />
  ) : relayRouteId ? (
    <SidebarRelayNavigation
      capabilities={capabilities}
      fallback={serverNavigation}
      relayRouteId={relayRouteId}
    />
  ) : (
    serverNavigation
  )
}

function SidebarAppNavigation({
  appRouteId,
  capabilities,
  fallback,
}: {
  // null selects the first app, for users without servers or databases.
  appRouteId: string | null
  capabilities: NavigationAccessCapabilities
  fallback: React.ReactNode
}) {
  const select = React.useMemo(
    () => (apps: Array<AppDirectoryEntry>) => {
      const resolution = resolveAppRoute(apps, appRouteId)
      const app =
        resolution.status === "found"
          ? resolution.resource
          : appRouteId === null
            ? apps[0]
            : undefined
      return app ? { app, routeId: appRouteIdentifier(apps, app) } : null
    },
    [appRouteId]
  )
  const query = useQuery({ ...appDirectoryQueryOptions(), select })
  if (!query.data) return query.isPending ? null : fallback
  const { app, routeId } = query.data

  return (
    <SidebarResourceGroup
      capabilities={capabilities}
      selection={{ kind: "app", app }}
      selectionRouteId={appSelectionRouteId(routeId)}
    >
      <AppTabNavigation
        app={app}
        capabilities={capabilities}
        routeId={routeId}
      />
    </SidebarResourceGroup>
  )
}

// The picker and pages of the selected database, app, or Relay.
function SidebarResourceGroup({
  capabilities,
  children,
  selection,
  selectionRouteId,
}: {
  capabilities: NavigationAccessCapabilities
  children: React.ReactNode
  selection: InstanceSelection
  // Remembered so the sidebar reopens on this resource.
  selectionRouteId: string
}) {
  return (
    <>
      <RememberSelectedInstance instanceRouteId={selectionRouteId} />
      <SidebarSeparator />
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <InstanceSelector
              capabilities={capabilities}
              selection={selection}
            />
            {children}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}

const AppTabNavigation = React.memo(function AppTabNavigation({
  app,
  capabilities,
  routeId,
}: {
  app: AppDirectoryEntry
  capabilities: NavigationAccessCapabilities
  routeId: string
}) {
  return accessibleDestinationsForApp(app, capabilities).map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton asChild tooltip={item.label}>
        <Link
          to={appTabRoute(item.id)}
          params={{ appId: routeId }}
          activeOptions={{ exact: item.id !== "files" }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  ))
})

function appTabRoute(tab: AppDestinationId) {
  switch (tab) {
    case "files":
      return "/app/$appId/files/$" as const
    case "info":
      return "/app/$appId/info" as const
    case "logs":
      return "/app/$appId/logs" as const
    case "network":
      return "/app/$appId/network" as const
    case "terminal":
      return "/app/$appId/terminal" as const
  }
}

function SidebarDatabaseNavigation({
  capabilities,
  databaseRouteId,
  fallback,
}: {
  capabilities: NavigationAccessCapabilities
  // null selects the first database, for users without servers.
  databaseRouteId: string | null
  fallback: React.ReactNode
}) {
  const select = React.useMemo(
    () => (databases: Array<ManagedDatabaseDirectoryEntry>) => {
      const resolution = resolveDatabaseRoute(databases, databaseRouteId)
      const database =
        resolution.status === "found"
          ? resolution.resource
          : databaseRouteId === null
            ? databases[0]
            : undefined
      return database
        ? { database, routeId: databaseRouteIdentifier(databases, database) }
        : null
    },
    [databaseRouteId]
  )
  const query = useQuery({ ...managedDatabaseDirectoryQueryOptions(), select })
  if (!query.data) return query.isPending ? null : fallback
  const { database, routeId } = query.data

  return (
    <SidebarResourceGroup
      capabilities={capabilities}
      selection={{ kind: "database", database }}
      selectionRouteId={databaseSelectionRouteId(routeId)}
    >
      <DatabaseTabNavigation
        capabilities={capabilities}
        database={database}
        routeId={routeId}
      />
    </SidebarResourceGroup>
  )
}

function SidebarRelayNavigation({
  capabilities,
  fallback,
  relayRouteId,
}: {
  capabilities: NavigationAccessCapabilities
  fallback: React.ReactNode
  // null selects the first Relay with a page the user can open, for users
  // with no other instances.
  relayRouteId: string | null
}) {
  const select = React.useMemo(
    () => (relays: Array<RelayDirectoryEntry>) => {
      const resolution = resolveRelayRoute(relays, relayRouteId)
      const relay =
        resolution.status === "found"
          ? resolution.resource
          : relayRouteId === null
            ? relays.find(
                (candidate) =>
                  accessibleDestinationsForRelay(candidate, capabilities)
                    .length > 0
              )
            : undefined
      return relay
        ? { relay, routeId: relayRouteIdentifier(relays, relay) }
        : null
    },
    [capabilities, relayRouteId]
  )
  const query = useQuery({ ...relaysQueryOptions(), select })
  if (!query.data) return query.isPending ? null : fallback
  const { relay, routeId } = query.data

  return (
    <SidebarResourceGroup
      capabilities={capabilities}
      selection={{ kind: "relay", relay }}
      selectionRouteId={relaySelectionRouteId(routeId)}
    >
      <RelayTabNavigation
        capabilities={capabilities}
        relay={relay}
        routeId={routeId}
      />
    </SidebarResourceGroup>
  )
}

const RelayTabNavigation = React.memo(function RelayTabNavigation({
  capabilities,
  relay,
  routeId,
}: {
  capabilities: NavigationAccessCapabilities
  relay: RelayDirectoryEntry
  routeId: string
}) {
  return accessibleDestinationsForRelay(relay, capabilities).map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton asChild tooltip={item.label}>
        <Link
          to={relayTabRoute(item.id)}
          params={{ relayId: routeId }}
          activeOptions={{ exact: true }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  ))
})

function relayTabRoute(tab: RelayDestinationId) {
  switch (tab) {
    case "files":
      return "/relay/$relayId/files" as const
    case "info":
      return "/relay/$relayId/info" as const
    case "terminal":
      return "/relay/$relayId/terminal"
    case "logs":
      return "/relay/$relayId/logs" as const
    case "volumes":
      return "/relay/$relayId/volumes" as const
  }
}

const DatabaseTabNavigation = React.memo(function DatabaseTabNavigation({
  capabilities,
  database,
  routeId,
}: {
  capabilities: NavigationAccessCapabilities
  database: ManagedDatabaseDirectoryEntry
  routeId: string
}) {
  return accessibleDestinationsForDatabase(database, capabilities).map(
    (item) => (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton asChild tooltip={item.label}>
          <Link
            to={
              item.id === "terminal"
                ? "/db/$databaseId/terminal"
                : item.id === "logs"
                  ? "/db/$databaseId/logs"
                  : item.id === "viewer"
                    ? "/db/$databaseId/viewer"
                    : item.id === "network"
                      ? "/db/$databaseId/network"
                      : "/db/$databaseId/info"
            }
            params={{ databaseId: routeId }}
            activeOptions={{ exact: true }}
            activeProps={{ "data-active": true }}
            preload="intent"
          >
            <item.icon />
            <span>{item.label}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  )
})

function SidebarServerNavigation({
  capabilities,
  emptyFallback,
  initialSelectedInstanceRouteId,
  relayConfigured,
}: {
  capabilities: NavigationAccessCapabilities
  // Shown once the fleet loads without servers.
  emptyFallback: React.ReactNode
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}) {
  const { data, isPending, selectedRouteId, serverId } =
    useSidebarServerNavigation(initialSelectedInstanceRouteId, relayConfigured)
  if (!data || data.serverCount === 0) return isPending ? null : emptyFallback
  const { instance, routeId: instanceRouteId } = data

  return (
    <>
      {instanceRouteId ? (
        <RememberSelectedInstance instanceRouteId={instanceRouteId} />
      ) : null}
      <SidebarSeparator />
      <InstanceNavigation
        capabilities={capabilities}
        instance={instance}
        instanceRouteId={instanceRouteId}
        serverCount={data.serverCount}
        unresolvedServerId={
          serverId ??
          (data.ambiguous ? (selectedRouteId ?? undefined) : undefined)
        }
      />
    </>
  )
}

function RememberSelectedInstance({
  instanceRouteId,
}: {
  instanceRouteId: string
}) {
  React.useEffect(() => {
    persistSelectedInstanceRouteId(instanceRouteId)
  }, [instanceRouteId])

  return null
}

const InstanceNavigation = React.memo(function InstanceNavigation({
  capabilities,
  instance,
  instanceRouteId,
  serverCount,
  unresolvedServerId,
}: {
  capabilities: NavigationAccessCapabilities
  instance: SidebarInstance | null
  instanceRouteId: string | null
  serverCount: number
  unresolvedServerId: string | undefined
}) {
  const navigate = useNavigate()

  const navigateToTab = React.useCallback(
    (tab: InstanceTab, nextServerId: string, replace = false) => {
      if (tab === "files") {
        return navigate({
          to: "/server/$serverId/files/$",
          params: { serverId: nextServerId, _splat: "" },
          replace,
        })
      }
      if (tab === "startup") {
        return navigate({
          to: "/server/$serverId/startup",
          params: { serverId: nextServerId },
          replace,
        })
      }
      if (tab === "info") {
        return navigate({
          to: "/server/$serverId/info",
          params: { serverId: nextServerId },
          replace,
        })
      }
      if (tab === "network") {
        return navigate({
          to: "/server/$serverId/network",
          params: { serverId: nextServerId },
          replace,
        })
      }
      return navigate({
        to: "/server/$serverId/console",
        params: { serverId: nextServerId },
        replace,
      })
    },
    [navigate]
  )

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <InstanceSelector
            capabilities={capabilities}
            navigateToTab={navigateToTab}
            selection={
              instance
                ? { kind: "server", instance }
                : { kind: "none", serverCount }
            }
          />
          <InstanceTabNavigation
            capabilities={capabilities}
            instance={instance}
            instanceRouteId={instanceRouteId}
            unresolvedServerId={unresolvedServerId}
          />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
})

function ambiguousServerHref(shortId: string) {
  return `/infra/servers?search=${encodeURIComponent(shortId)}`
}

type InstanceSelection =
  | { kind: "server"; instance: SidebarInstance }
  | { kind: "database"; database: ManagedDatabaseDirectoryEntry }
  | { kind: "app"; app: AppDirectoryEntry }
  | { kind: "relay"; relay: RelayDirectoryEntry }
  | { kind: "none"; serverCount: number }

const InstanceSelector = React.memo(function InstanceSelector({
  capabilities,
  navigateToTab,
  selection,
}: {
  capabilities: NavigationAccessCapabilities
  // Server tab navigation; database routes navigate here directly.
  navigateToTab?: (tab: InstanceTab, serverId: string) => void
  selection: InstanceSelection
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
  }, [])
  // Picking an instance or link moves focus to the new page; returning it to
  // the picker button would pop the button's tooltip over that page.
  const navigatedRef = React.useRef(false)
  const closePicker = React.useCallback(() => {
    navigatedRef.current = true
    setOpen(false)
  }, [])
  const handleCloseAutoFocus = React.useCallback((event: Event) => {
    if (navigatedRef.current) event.preventDefault()
    navigatedRef.current = false
  }, [])
  // The picker lists every instance; fetch the lists as the pointer arrives
  // so it opens filled.
  const warmPicker = React.useCallback(() => {
    void queryClient.prefetchQuery(serverDirectoryQueryOptions())
  }, [queryClient])
  const selectInstance = React.useCallback(
    (item: InstancePickerItem) => {
      closePicker()
      if (item.identity.kind === "database") {
        const databases = queryClient.getQueryData(
          managedDatabaseDirectoryQueryOptions().queryKey
        )
        const routeId = databases
          ? databaseRouteIdentifier(databases, item.identity)
          : item.identity.id
        const tab = databaseTabFromPathname(window.location.pathname)
        void navigate(
          tab === "terminal"
            ? {
                to: "/db/$databaseId/terminal",
                params: { databaseId: routeId },
              }
            : tab === "logs"
              ? {
                  to: "/db/$databaseId/logs",
                  params: { databaseId: routeId },
                }
              : tab === "viewer"
                ? {
                    to: "/db/$databaseId/viewer",
                    params: { databaseId: routeId },
                  }
                : tab === "network"
                  ? {
                      to: "/db/$databaseId/network",
                      params: { databaseId: routeId },
                    }
                  : tab === "info"
                    ? {
                        to: "/db/$databaseId/info",
                        params: { databaseId: routeId },
                      }
                    : { to: "/db/$databaseId", params: { databaseId: routeId } }
        )
        return
      }
      if (item.identity.kind === "app") {
        const apps = queryClient.getQueryData(
          appDirectoryQueryOptions().queryKey
        )
        const routeId = apps
          ? appRouteIdentifier(apps, item.identity)
          : item.identity.id
        const tab = appTabFromPathname(window.location.pathname)
        void navigate(
          tab
            ? { to: appTabRoute(tab), params: { appId: routeId } }
            : { to: "/app/$appId", params: { appId: routeId } }
        )
        return
      }
      if (item.identity.kind === "relay") {
        const relays = queryClient.getQueryData(relaysQueryOptions().queryKey)
        const routeId = relays
          ? relayRouteIdentifier(relays, { id: item.identity.relayId })
          : item.identity.relayId
        const tab = relayTabFromPathname(window.location.pathname)
        void navigate(
          tab
            ? { to: relayTabRoute(tab), params: { relayId: routeId } }
            : { to: "/relay/$relayId", params: { relayId: routeId } }
        )
        return
      }
      const instances = queryClient.getQueryData(
        serverDirectoryQueryOptions().queryKey
      )
      if (!instances) return
      const selected = instances.find(
        (candidate) =>
          candidate.id === item.identity.id &&
          candidate.relayId === item.identity.relayId
      )
      if (!selected) return
      const routeIdentifier = relayInstanceRouteIdentifier(instances, selected)
      if (!routeIdentifier) {
        void navigate({ href: ambiguousServerHref(selected.shortId) })
        return
      }

      const tab = instanceTabFromPathname(window.location.pathname) ?? "console"
      if (navigateToTab) {
        navigateToTab(tab, routeIdentifier)
        return
      }
      void navigate({
        to: "/server/$serverId/console",
        params: { serverId: routeIdentifier },
      })
    },
    [closePicker, navigate, navigateToTab, queryClient]
  )
  const selectedKey =
    selection.kind === "server"
      ? sidebarPickerKey(
          "server",
          selection.instance.relayId,
          selection.instance.id
        )
      : selection.kind === "database"
        ? sidebarPickerKey(
            "database",
            selection.database.relayId,
            selection.database.id
          )
        : selection.kind === "app"
          ? sidebarPickerKey("app", selection.app.relayId, selection.app.id)
          : selection.kind === "relay"
            ? sidebarPickerKey("relay", selection.relay.id, selection.relay.id)
            : null
  const selectedKeys = React.useMemo(
    () => new Set(selectedKey ? [selectedKey] : []),
    [selectedKey]
  )
  const instance = selection.kind === "server" ? selection.instance : null

  return (
    <SidebarMenuItem>
      <InstancePickerPopover open={open} onOpenChange={handleOpenChange}>
        <InstancePickerPopoverTrigger asChild>
          <SidebarMenuButton
            size="lg"
            tooltip={
              selection.kind === "database"
                ? "Switch database"
                : selection.kind === "app"
                  ? "Switch app"
                  : selection.kind === "relay"
                    ? "Switch Relay"
                    : "Switch game server"
            }
            aria-label={
              selection.kind === "none" ? "Choose a game server" : undefined
            }
            onFocus={warmPicker}
            onPointerEnter={warmPicker}
            className="mb-1.5 h-auto border border-sidebar-border/75 bg-background/35 px-2 py-2 group-data-[collapsible=icon]:h-[40px]! group-data-[collapsible=icon]:overflow-visible group-data-[collapsible=icon]:bg-card hover:border-sidebar-border hover:bg-sidebar-accent group-data-[collapsible=icon]:hover:bg-sidebar-accent data-[state=open]:border-sidebar-border data-[state=open]:bg-sidebar-accent dark:group-data-[collapsible=icon]:bg-black/25 dark:group-data-[collapsible=icon]:hover:bg-black/35"
          >
            {instance ? (
              <SelectorInstanceName
                instance={{
                  brickId: instance.brickId,
                  id: instance.id,
                  implementation: instance.implementation,
                  kind: "server",
                  relayId: instance.relayId,
                }}
                label="Switch game server."
                meta={`${instance.implementation} ${instance.version}`}
                name={instance.name}
              />
            ) : selection.kind === "database" ? (
              <SelectorInstanceName
                instance={{
                  id: selection.database.id,
                  kind: "database",
                  relayId: selection.database.relayId,
                }}
                label="Switch database."
                meta={`${engineLabel(selection.database.engine)} · ${selection.database.relayName}`}
                name={selection.database.name}
              />
            ) : selection.kind === "app" ? (
              <SelectorInstanceName
                instance={{
                  id: selection.app.id,
                  kind: "app",
                  relayId: selection.app.relayId,
                }}
                label="Switch app."
                meta={`${selection.app.shortId} · ${selection.app.relayName}`}
                name={selection.app.name}
              />
            ) : selection.kind === "relay" ? (
              <SelectorRelayName relay={selection.relay} />
            ) : (
              <>
                <span className="relative grid size-8 shrink-0 place-items-center rounded-md border border-sidebar-border/70 bg-background/25 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-full group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent">
                  <ServerKindIcon className="size-4" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start group-data-[collapsible=icon]:hidden">
                  <span className="type-control-sm w-full truncate">
                    Choose a game server
                  </span>
                  <span className="type-meta w-full truncate text-sidebar-muted-foreground">
                    {selection.kind === "none" && selection.serverCount === 0
                      ? "No managed game servers"
                      : "Selection required"}
                  </span>
                </span>
              </>
            )}
            <ChevronsUpDown className="ml-auto size-3.5! text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden light:text-sidebar-foreground/80" />
          </SidebarMenuButton>
        </InstancePickerPopoverTrigger>
        <InstancePickerPopoverContent
          title="Switch instance"
          aria-label="Instances"
          side="right"
          align="start"
          sideOffset={6}
          className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <SidebarInstancePicker
            capabilities={capabilities}
            selectedKeys={selectedKeys}
            onNavigate={closePicker}
            onSelect={selectInstance}
          />
        </InstancePickerPopoverContent>
      </InstancePickerPopover>
    </SidebarMenuItem>
  )
})

// The selected instance in the sidebar's picker button; collapsed, only its
// icon shows.
function SelectorInstanceName({
  instance,
  label,
  meta,
  name,
}: {
  instance: React.ComponentProps<typeof InstanceCard>["instance"]
  // Read before the name by screen readers, for example "Switch app."
  label: string
  meta: string
  name: string
}) {
  return (
    <>
      <span className="sr-only">{label} </span>
      <InstanceCard
        className="min-w-0 flex-1 gap-2 group-data-[collapsible=icon]:gap-0"
        iconClassName="border-sidebar-border/70 bg-background/25 text-sidebar-foreground/85 light:text-sidebar-foreground/92 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-full group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
        iconSizeClassName="group-data-[collapsible=icon]:size-5!"
        instance={instance}
        meta={meta}
        metaClassName="text-sidebar-muted-foreground"
        name={name}
        nameClassName="type-control-sm text-sidebar-foreground"
        showFavorite={false}
        statusClassName="ring-popover"
        textClassName="group-data-[collapsible=icon]:sr-only"
      />
    </>
  )
}

function SelectorRelayName({ relay }: { relay: RelayDirectoryEntry }) {
  return (
    <SelectorInstanceName
      instance={{
        id: relay.id,
        kind: "relay",
        relayId: relay.id,
      }}
      label="Switch Relay."
      meta={`${relay.nodeArch ?? "unknown"} · ${relay.id.slice(0, 8)}`}
      name={relay.name}
    />
  )
}

const SidebarInstancePicker = React.memo(function SidebarInstancePicker({
  capabilities,
  onNavigate,
  onSelect,
  selectedKeys,
}: {
  capabilities: NavigationAccessCapabilities
  onNavigate: () => void
  onSelect: (item: InstancePickerItem) => void
  selectedKeys: ReadonlySet<string>
}) {
  const destinations = accessibleInfrastructureDestinations(capabilities)
  const showDatabases = destinations.some(
    (destination) => destination.to === "/infra/databases"
  )
  const showRelays = destinations.some(
    (destination) => destination.to === "/infra/relays"
  )
  const showApps = destinations.some(
    (destination) => destination.to === "/infra/apps"
  )
  const { data: serverItems = emptyPickerItems } = useQuery({
    ...serverDirectoryQueryOptions(),
    select: selectSidebarServerPickerItems,
  })
  const { data: relayItems = emptyPickerItems } = useQuery({
    ...relaysQueryOptions(),
    enabled: showRelays,
    select: selectSidebarRelayPickerItems,
  })
  const { data: databaseItems = emptyPickerItems } = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    enabled: showDatabases,
    select: selectSidebarDatabasePickerItems,
  })
  const { data: appItems = emptyPickerItems } = useQuery({
    ...appDirectoryQueryOptions(),
    enabled: showApps,
    select: selectSidebarAppPickerItems,
  })
  const items = React.useMemo(
    () =>
      databaseItems.length === 0 &&
      relayItems.length === 0 &&
      appItems.length === 0
        ? serverItems
        : [
            ...serverItems,
            ...(showDatabases ? databaseItems : emptyPickerItems),
            ...(showApps ? appItems : emptyPickerItems),
            ...(showRelays ? relayItems : emptyPickerItems),
          ],
    [
      appItems,
      databaseItems,
      relayItems,
      serverItems,
      showApps,
      showDatabases,
      showRelays,
    ]
  )

  return (
    <InstancePickerContent
      ariaLabel="Instances"
      emptyMessage="No managed instances"
      items={items}
      selectedKeys={selectedKeys}
      viewAll
      onNavigate={onNavigate}
      onSelect={onSelect}
    />
  )
})

const emptyPickerItems: Array<InstancePickerItem> = []

function sidebarPickerKey(
  kind: InstancePickerItem["identity"]["kind"],
  relayId: string,
  id: string
) {
  return `${kind}:${relayId}:${id}`
}

function selectSidebarServerPickerItems(
  servers: ReadonlyArray<SidebarInstance>
): Array<InstancePickerItem> {
  return servers.map((instance) => ({
    identity: {
      brickId: instance.brickId,
      id: instance.id,
      implementation: instance.implementation,
      kind: "server",
      relayId: instance.relayId,
    },
    key: sidebarPickerKey("server", instance.relayId, instance.id),
    meta: `${instance.implementation} ${instance.version} · ${instance.shortId}`,
    name: instance.name,
    searchText: `${instance.routeId} ${instance.relayName}`,
  }))
}

function selectSidebarRelayPickerItems(
  relays: Array<RelayDirectoryEntry>
): Array<InstancePickerItem> {
  return relays.map((relay) => ({
    identity: { id: relay.id, kind: "relay", relayId: relay.id },
    key: sidebarPickerKey("relay", relay.id, relay.id),
    meta: `${relay.nodeArch ?? "unknown"} · ${
      relay.nodeVersion
        ? kilnReleaseLabel(relay.nodeVersion)
        : relay.id.slice(0, 8)
    }`,
    name: relay.name,
    searchText: `${relay.id} ${relay.nodeVersion ?? ""}`,
  }))
}

function selectSidebarDatabasePickerItems(
  databases: Awaited<ReturnType<typeof getManagedDatabaseDirectory>>
): Array<InstancePickerItem> {
  return databases.map((database) => ({
    identity: { id: database.id, kind: "database", relayId: database.relayId },
    key: sidebarPickerKey("database", database.relayId, database.id),
    meta: `${engineLabel(database.engine)} · ${database.shortId}`,
    name: database.name,
    searchText: `${database.id} ${database.relayName}`,
  }))
}

function selectSidebarAppPickerItems(
  apps: Array<AppDirectoryEntry>
): Array<InstancePickerItem> {
  return apps.map((app) => ({
    identity: { id: app.id, kind: "app", relayId: app.relayId },
    key: sidebarPickerKey("app", app.relayId, app.id),
    meta: `App · ${app.shortId}`,
    name: app.name,
    searchText: `${app.id} ${app.relayName}`,
  }))
}

const InstanceTabNavigation = React.memo(function InstanceTabNavigation({
  capabilities,
  instance,
  instanceRouteId,
  unresolvedServerId,
}: {
  capabilities: NavigationAccessCapabilities
  instance: SidebarInstance | null
  instanceRouteId: string | null
  unresolvedServerId: string | undefined
}) {
  const items = instance
    ? accessibleDestinationsForServer(instance, capabilities)
    : serverDestinations
  return items.map((item) => (
    <InstanceTabNavigationItem
      key={item.id}
      item={item}
      instanceRouteId={instanceRouteId}
      unresolvedServerId={unresolvedServerId}
    />
  ))
})

const InstanceTabNavigationItem = React.memo(
  function InstanceTabNavigationItem({
    item,
    instanceRouteId,
    unresolvedServerId,
  }: {
    item: ServerDestination
    instanceRouteId: string | null
    unresolvedServerId: string | undefined
  }) {
    const content = (
      <>
        <item.icon />
        <span>{item.label}</span>
      </>
    )

    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip={item.label}>
          {!instanceRouteId ? (
            <Link
              to="/infra/servers"
              search={unresolvedServerId ? { search: unresolvedServerId } : {}}
              activeOptions={{ exact: true, includeSearch: false }}
            >
              {content}
            </Link>
          ) : item.id === "console" ? (
            <Link
              to="/server/$serverId/console"
              params={{ serverId: instanceRouteId }}
              activeOptions={{ exact: true }}
              activeProps={{ "data-active": true }}
              // Warming on hover keeps the console quick to open without
              // loading the fleet on every page while a server is selected.
              preload="intent"
            >
              {content}
            </Link>
          ) : item.id === "files" ? (
            <Link
              to="/server/$serverId/files/$"
              params={{ serverId: instanceRouteId, _splat: "" }}
              activeProps={{ "data-active": true }}
              preload="intent"
              onFocus={warmFileWorkspaceModule}
              onMouseEnter={warmFileWorkspaceModule}
              onTouchStart={warmFileWorkspaceModule}
            >
              {content}
            </Link>
          ) : item.id === "network" ? (
            <Link
              to="/server/$serverId/network"
              params={{ serverId: instanceRouteId }}
              activeOptions={{ exact: true }}
              activeProps={{ "data-active": true }}
              preload="intent"
            >
              {content}
            </Link>
          ) : item.id === "startup" ? (
            <Link
              to="/server/$serverId/startup"
              params={{ serverId: instanceRouteId }}
              activeOptions={{ exact: true }}
              activeProps={{ "data-active": true }}
              preload="intent"
            >
              {content}
            </Link>
          ) : (
            <Link
              to="/server/$serverId/info"
              params={{ serverId: instanceRouteId }}
              activeOptions={{ exact: true }}
              activeProps={{ "data-active": true }}
              preload="intent"
            >
              {content}
            </Link>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }
)

function AccountNavigation({
  capabilities,
  user,
}: {
  capabilities: NavigationAccessCapabilities
  user: AuthenticatedUser
}) {
  const { isMobile, state } = useSidebar()
  const showAutomations = canAccessAutomations(capabilities)
  const showBackups = canAccessBackups(capabilities)
  const showActivity = canAccessActivity(capabilities)
  const showManage =
    showAutomations ||
    showBackups ||
    showActivity ||
    capabilities.canManageAccess
  return (
    <SidebarFooter>
      {showManage ? (
        <>
          <SidebarSeparator />
          <SidebarGroup className="p-0">
            <SidebarGroupLabel className="type-technical-label">
              Manage
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {showAutomations ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Automations">
                      <Link
                        to="/automations/schedules"
                        activeOptions={{ includeSearch: false }}
                        activeProps={{ "data-active": true }}
                        preload="intent"
                      >
                        <CalendarClock />
                        <span>Automations</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
                {showBackups ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Backups">
                      <Link
                        to="/backups/runs"
                        activeOptions={{ includeSearch: false }}
                        activeProps={{ "data-active": true }}
                        preload="intent"
                      >
                        <BackupIcon />
                        <span>Backups</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
                {showActivity ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Activity">
                      <Link
                        to="/activity"
                        activeOptions={{ exact: true, includeSearch: false }}
                        activeProps={{ "data-active": true }}
                        preload="intent"
                      >
                        <ListTodo />
                        <span>Activity</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
                {capabilities.canManageAccess ? (
                  <SidebarMenuItem>
                    <AccessNavigationButton />
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
        </>
      ) : null}
      <SidebarMenu>
        <SidebarMenuItem>
          {state === "collapsed" && !isMobile ? (
            <CollapsedAccountMenu user={user} />
          ) : (
            <ExpandedAccountRow isMobile={isMobile} user={user} />
          )}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  )
}

function CollapsedAccountMenu({ user }: { user: AuthenticatedUser }) {
  const [open, setOpen] = React.useState(false)
  const prefetchAccounts = useBrowserAccountsPrefetch(!user.isDevelopmentBypass)
  const [signingOut, setSigningOut] = React.useState(false)
  const closeMenu = React.useCallback(() => setOpen(false), [])

  return (
    <CollapsedNotificationsAnchor>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative grid size-[40px] place-items-center transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
            aria-label={`Open account menu for ${user.name}`}
            {...prefetchAccounts}
          >
            <AccountAvatar
              className="data-[size=sm]:size-[30px]"
              name={user.name}
            />
            <UnreadNotificationsIndicator />
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Account menu"
          side="right"
          align="end"
          className="w-64 p-1"
        >
          <AccountSwitcherSection user={user} onNavigate={closeMenu} />
          <div className="-mx-1 my-1 h-px bg-border" />
          <NotificationsMenuItem onSelect={closeMenu} />
          <Link
            to="/settings/account"
            preload="intent"
            className="flex h-9 w-full items-center gap-2 px-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
            onClick={() => setOpen(false)}
          >
            <Settings className="size-4" />
            <span>Settings</span>
          </Link>
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 px-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
            aria-label={signingOut ? "Signing out" : "Logout"}
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true)
              forkPromise(
                () => signOut(user.isDevelopmentBypass),
                () => setSigningOut(false)
              )
            }}
          >
            {signingOut ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            <span>{signingOut ? "Signing out" : "Logout"}</span>
          </button>
        </PopoverContent>
      </Popover>
    </CollapsedNotificationsAnchor>
  )
}

function ExpandedAccountRow({
  isMobile,
  user,
}: {
  isMobile: boolean
  user: AuthenticatedUser
}) {
  const [open, setOpen] = React.useState(false)
  const closeMenu = React.useCallback(() => setOpen(false), [])
  const prefetchAccounts = useBrowserAccountsPrefetch(!user.isDevelopmentBypass)
  return (
    <div className="flex h-11 items-center gap-1 px-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="-ml-1 flex h-9 min-w-0 flex-1 items-center gap-2 px-1 text-left text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
            aria-label={`Open account menu for ${user.name}`}
            {...prefetchAccounts}
          >
            <AccountAvatar name={user.name} />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">
              {user.name}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/55 light:text-sidebar-foreground/78" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Account menu"
          side="top"
          align="start"
          className="w-64 p-1"
        >
          <AccountSwitcherSection user={user} onNavigate={closeMenu} />
        </PopoverContent>
      </Popover>
      <SettingsIconButton tooltipHidden={isMobile} />
      <SignOutButton
        developmentBypass={user.isDevelopmentBypass}
        tooltipHidden={isMobile}
      />
    </div>
  )
}

function SettingsIconButton({ tooltipHidden }: { tooltipHidden: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/settings/account"
          preload="intent"
          className="grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none light:text-sidebar-foreground/78"
          aria-label="Settings"
        >
          <Settings className="size-4" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={tooltipHidden}>
        Settings
      </TooltipContent>
    </Tooltip>
  )
}

function SignOutButton({
  developmentBypass,
  tooltipHidden,
}: {
  developmentBypass: boolean
  tooltipHidden: boolean
}) {
  const [signingOut, setSigningOut] = React.useState(false)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="ml-auto grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 light:text-sidebar-foreground/78"
          aria-label={signingOut ? "Signing out" : "Sign out"}
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true)
            forkPromise(
              () => signOut(developmentBypass),
              () => setSigningOut(false)
            )
          }}
        >
          {signingOut ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <LogOut className="size-4" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={tooltipHidden}>
        Logout
      </TooltipContent>
    </Tooltip>
  )
}

function AccessNavigationButton() {
  const navigate = useNavigate()
  const isActive = useRouterState({
    select: (state) =>
      globalSectionFromRouteId(state.matches.at(-1)?.routeId) === "access",
  })
  return (
    <SidebarMenuButton
      tooltip="Access"
      isActive={isActive}
      type="button"
      onClick={() => void navigate({ to: "/access" })}
    >
      <UserRoundCog />
      <span>Access</span>
    </SidebarMenuButton>
  )
}

async function signOut(isDevelopmentBypass: boolean) {
  if (!isDevelopmentBypass) return signOutAllAccounts()
  await disableDevelopmentBypass()
  clearAppearanceCache()
  window.location.assign("/")
}

function globalSectionFromPathname(pathname: string): GlobalSection {
  if (pathname === "/infra" || pathname.startsWith("/infra/")) return "infra"
  if (pathname === "/automations" || pathname.startsWith("/automations/")) {
    return "automations"
  }
  if (pathname === "/backups" || pathname.startsWith("/backups/")) {
    return "backups"
  }
  if (pathname === "/access") return "access"
  if (pathname === "/notifications") return "notifications"
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings"
  }
  return null
}

function instanceTabFromPathname(pathname: string): InstanceTab | null {
  if (globalSectionFromPathname(pathname)) return null
  if (/^\/server\/[^/]+\/files(?:\/|$)/.test(pathname)) return "files"
  if (/^\/server\/[^/]+\/startup\/?$/.test(pathname)) return "startup"
  if (/^\/server\/[^/]+\/network\/?$/.test(pathname)) return "network"
  if (/^\/server\/[^/]+\/info\/?$/.test(pathname)) return "info"
  if (/^\/server\/[^/]+\/console\/?$/.test(pathname)) return "console"
  return null
}

function appTabFromPathname(pathname: string): AppDestinationId | null {
  const match =
    /^\/app\/[^/]+\/(files|info|logs|network|terminal)(?:\/|$)/.exec(pathname)
  return match ? (match[1] as AppDestinationId) : null
}

function relayTabFromPathname(pathname: string): RelayDestinationId | null {
  const segment = /^\/relay\/[^/]+\/([^/]+)/.exec(pathname)?.[1]
  return (
    relayDestinations.find((destination) => destination.id === segment)?.id ??
    null
  )
}

function databaseTabFromPathname(
  pathname: string
): DatabaseDestinationId | null {
  const match = /^\/db\/[^/]+\/(info|logs|network|terminal|viewer)\/?$/.exec(
    pathname
  )
  return match ? (match[1] as DatabaseDestinationId) : null
}
