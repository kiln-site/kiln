import type { TunnelsResult } from "@/server/tunnels"
import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  CalendarClock,
  ChevronsUpDown,
  CloudDownload,
  ListTodo,
  LoaderCircle,
  LogOut,
  Settings,
  UserRoundCog,
} from "lucide-react"
import {
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
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
import { IdentityName } from "@/components/identity-name"
import { InstanceCard, isKilnIdentity } from "@/components/instance-card"
import {
  kilnPresentation,
  kilnVersion,
  selectKilnHost,
} from "@/components/kiln/kiln-presentation"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { clearAppearanceCache } from "@/lib/appearance"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  kilnPlatformQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  tunnelsQueryOptions,
  relaysQueryOptions,
  serverDirectoryQueryOptions,
  updateOverviewQueryOptions,
} from "@/lib/query-options"
import {
  compareLatestReleaseVersion,
  kilnReleaseLabel,
} from "@/lib/release-version"
import type { UpdateOverview } from "@/server/updates"
import {
  useInfraUpdateDialogStore,
  usePrefetchInfraUpdates,
} from "@/components/infra-update-dialog-provider"
import type { KilnPlatformHost } from "@/server/platform"
import { disableDevelopmentBypass } from "@/server/auth"
import { engineLabel } from "@/components/database/database-presentation"
import {
  databaseIdFromSelection,
  databaseSelectionValue,
  type ManagedDatabaseDirectoryEntry,
} from "@/lib/database-route"
import type { getManagedDatabaseDirectory } from "@/server/databases"
import {
  appIdFromSelection,
  appSelectionValue,
  type AppDirectoryEntry,
} from "@/lib/app-route"
import {
  relayIdFromSelection,
  relaySelectionValue,
  type RelayDirectoryEntry,
} from "@/lib/relay-route"
import type { SidebarInstance } from "@/lib/relay-selectors"
import { instanceSelection } from "@/lib/instance-selection"
import {
  tunnelPermissionsOf,
  tunnelStatus,
  useTunnel,
} from "@/components/tunnel/tunnel-data"
import type { TunnelWorkspaceValue as TunnelView } from "@/components/tunnel/tunnel-workspace-context"
import { globalSectionFromRouteId } from "@/lib/route-sections"
import type { GlobalSection } from "@/lib/route-sections"
import {
  accessibleDestinationsForApp,
  accessibleDestinationsForDatabase,
  accessibleDestinationsForRelay,
  accessibleDestinationsForServer,
  accessibleDestinationsForTunnel,
  accessibleInfrastructureDestinations,
  canAccessActivity,
  canAccessAutomations,
  canAccessBackups,
  firstAccessibleAppHref,
  kilnDestinations,
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
  persistSelectedInstance,
  readSelectedInstance,
} from "@/lib/ui-preference-cookies"
import { useSidebarServerNavigation } from "@/lib/use-server-navigation"
import { warmFileWorkspaceModule } from "@/lib/workspace-module-preloads"

export type InstanceTab = ServerDestinationId

interface AppSidebarViewProps {
  canUpdateRelays: boolean
  capabilities: NavigationAccessCapabilities
  user: AuthenticatedUser
  initialSelectedInstance: string | null
  relayConfigured: boolean
}

export const AppSidebar = React.memo(function AppSidebar({
  initialSelectedInstance,
}: {
  initialSelectedInstance: string | null
}) {
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { relayConfigured } = capabilities

  return (
    <AppSidebarView
      canUpdateRelays={capabilities.canUpdateRelays}
      capabilities={capabilities}
      initialSelectedInstance={initialSelectedInstance}
      relayConfigured={relayConfigured}
      user={capabilities.user}
    />
  )
})

const AppSidebarView = React.memo(function AppSidebarView({
  canUpdateRelays,
  capabilities,
  user,
  initialSelectedInstance,
  relayConfigured,
}: AppSidebarViewProps) {
  return (
    <RouteCommandMenuProvider
      capabilities={capabilities}
      initialSelectedInstance={initialSelectedInstance}
      relayConfigured={relayConfigured}
    >
      <Sidebar collapsible="icon" className="border-sidebar-border/80">
        <SidebarHeader className="h-20 shrink-0 justify-center px-2 py-2">
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-1">
              <SidebarMenuButton
                asChild
                size="lg"
                className="h-11 min-w-0 flex-1 hover:bg-transparent active:bg-transparent data-[state=open]:bg-transparent"
                tooltip="Kiln"
              >
                <Link
                  aria-label="Kiln home"
                  preload="intent"
                  to={firstAccessibleAppHref(capabilities)}
                >
                  <HearthMark className="group-data-[collapsible=icon]:size-[40px]!" />
                  <span className="min-w-0 flex-1 truncate font-heading text-2xl font-semibold tracking-[0.04em]">
                    KILN
                  </span>
                </Link>
              </SidebarMenuButton>
              {canUpdateRelays ? (
                <HeaderUpdateButton capabilities={capabilities} />
              ) : null}
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
            initialSelectedInstance={initialSelectedInstance}
            relayConfigured={relayConfigured}
          />

          <SidebarInstanceNavigation
            capabilities={capabilities}
            initialSelectedInstance={initialSelectedInstance}
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

// Shows only while a release is out that Hearth or a Relay this person can
// update hasn't taken, and opens the updater over the infrastructure pages.
// It reads the updater's own overview, so the dialog then opens on it.
function HeaderUpdateButton({
  capabilities,
}: {
  capabilities: NavigationAccessCapabilities
}) {
  const { isMobile, state } = useSidebar()
  const { data: available = false } = useQuery({
    ...updateOverviewQueryOptions(),
    // The overview only changes with a release or an update, and both
    // refresh it; the updater keeps it fresher while open.
    staleTime: 5 * 60_000,
    select: selectUpdateAvailable,
  })
  if (!available || (state === "collapsed" && !isMobile)) return null
  return (
    <UpdateAvailableButton
      capabilities={capabilities}
      tooltipHidden={isMobile}
    />
  )
}

// Hearth is behind exactly when Relays wait for it, which only a release
// build of Hearth ever is. Relays that aren't on a release, like development
// builds, never are.
function selectUpdateAvailable(overview: UpdateOverview): boolean {
  return (
    (overview.canUpdateHearth && overview.relaysWaitForHearth) ||
    overview.relays.some(
      (relay) =>
        relay.reachable &&
        compareLatestReleaseVersion(relay.currentVersion, overview.releases) ===
          1
    )
  )
}

const UpdateAvailableButton = React.memo(function UpdateAvailableButton({
  capabilities,
  tooltipHidden,
}: {
  capabilities: NavigationAccessCapabilities
  tooltipHidden: boolean
}) {
  const router = useRouter()
  const store = useInfraUpdateDialogStore()
  const prefetch = usePrefetchInfraUpdates()
  const openUpdater = React.useCallback(() => {
    // The updater closes away from the infrastructure pages, so it opens
    // over the one someone is on, or else over the first.
    if (router.state.location.pathname.startsWith("/infra/")) {
      store.open()
      return
    }
    const to =
      accessibleInfrastructureDestinations(capabilities)[0]?.to ??
      "/infra/relays"
    void router.navigate({ to }).then(() => {
      store.open()
    })
  }, [capabilities, router, store])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Update available"
          className="relative grid size-8 shrink-0 place-items-center text-primary-ink transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none"
          onClick={openUpdater}
          onFocus={prefetch}
          onPointerEnter={prefetch}
        >
          <CloudDownload className="size-4" />
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-sidebar" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={6}
        align="center"
        hidden={tooltipHidden}
      >
        Update available
      </TooltipContent>
    </Tooltip>
  )
})

// One row of tiles, each a kind's icon and how many there are, so the
// section stays a line tall. Their names show on hover; collapsed, the tiles
// stack like the rest of the sidebar's icons.
function InfrastructureNavigation({
  capabilities,
  initialSelectedInstance,
  relayConfigured,
}: {
  capabilities: NavigationAccessCapabilities
  initialSelectedInstance: string | null
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
    <SidebarGroup className="py-2">
      <SidebarGroupContent>
        <SidebarMenu
          aria-label="Infrastructure"
          className="grid auto-cols-fr grid-flow-col gap-1 group-data-[collapsible=icon]:grid-flow-row group-data-[collapsible=icon]:justify-items-center"
        >
          {showRelays ? (
            <InfrastructureTile
              icon={<RelayKindIcon />}
              label="Relays"
              to="/infra/relays"
            >
              <RelayCount relayConfigured={relayConfigured} />
            </InfrastructureTile>
          ) : null}
          {showServers ? (
            <InfrastructureTile
              icon={<ServerKindIcon />}
              label="Game Servers"
              to="/infra/servers"
            >
              <InfrastructureInstanceCount
                initialSelectedInstance={initialSelectedInstance}
                relayConfigured={relayConfigured}
              />
            </InfrastructureTile>
          ) : null}
          {showDatabases ? (
            <InfrastructureTile
              icon={<DatabaseKindIcon />}
              label="Databases"
              to="/infra/databases"
            >
              <DatabaseCount relayConfigured={relayConfigured} />
            </InfrastructureTile>
          ) : null}
          {showApps ? (
            <InfrastructureTile
              icon={<AppKindIcon />}
              label="Apps"
              to="/infra/apps"
            >
              <AppCount relayConfigured={relayConfigured} />
            </InfrastructureTile>
          ) : null}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function InfrastructureTile({
  children,
  icon,
  label,
  to,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  label: string
  to: "/infra/apps" | "/infra/databases" | "/infra/relays" | "/infra/servers"
}) {
  const { isMobile, state } = useSidebar()
  const collapsed = state === "collapsed" && !isMobile
  return (
    <SidebarMenuItem className="min-w-0">
      <SidebarMenuButton
        asChild
        className="h-9 justify-center gap-1.5 px-1 before:hidden group-data-[collapsible=icon]:before:block data-active:bg-sidebar-accent group-data-[collapsible=icon]:data-active:bg-transparent"
        // Tiles show no name, so their tooltip shows open or collapsed.
        tooltip={
          isMobile
            ? undefined
            : {
                children: label,
                hidden: false,
                side: collapsed ? "right" : "bottom",
                sideOffset: 6,
              }
        }
      >
        <Link
          aria-label={label}
          to={to}
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          {icon}
          <span className="type-label text-sidebar-muted-foreground tabular-nums group-data-[active=true]/menu-button:text-primary-ink group-data-[collapsible=icon]:hidden">
            {children}
          </span>
        </Link>
      </SidebarMenuButton>
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

const InfrastructureInstanceCount = React.memo(
  function InfrastructureInstanceCount({
    initialSelectedInstance,
    relayConfigured,
  }: {
    initialSelectedInstance: string | null
    relayConfigured: boolean
  }) {
    const { data } = useSidebarServerNavigation(
      initialSelectedInstance,
      relayConfigured
    )

    return data?.serverCount ?? 0
  }
)

function SidebarInstanceNavigation({
  capabilities,
  initialSelectedInstance,
  relayConfigured,
}: {
  capabilities: NavigationAccessCapabilities
  initialSelectedInstance: string | null
  relayConfigured: boolean
}) {
  // "server", a database selection ("db:<id>"), an app selection
  // ("app:<id>"), a Relay selection ("relay:<id>"), or null off instance
  // routes.
  const kilnRoute = useRouterState({
    select: (state) =>
      state.matches.at(-1)?.routeId.startsWith("/_app/kiln") === true,
  })
  const routeSelection = useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params as
        | {
            appId?: string
            databaseId?: string
            relayId?: string
            serverId?: string
            tunnelId?: string
          }
        | undefined
      if (params?.databaseId) return databaseSelectionValue(params.databaseId)
      if (params?.tunnelId) return tunnelSelection.toSelection(params.tunnelId)
      if (params?.appId) return appSelectionValue(params.appId)
      if (params?.relayId) return relaySelectionValue(params.relayId)
      return params?.serverId ? "server" : null
    },
  })
  const selection =
    routeSelection === "server"
      ? null
      : (routeSelection ?? readSelectedInstance() ?? initialSelectedInstance)
  const databaseId = databaseIdFromSelection(selection)
  const appId = appIdFromSelection(selection)
  const relayId = relayIdFromSelection(selection)
  const tunnelId = tunnelSelection.fromSelection(selection)
  const destinations = accessibleInfrastructureDestinations(capabilities)
  const showDatabases =
    relayConfigured &&
    destinations.some((destination) => destination.to === "/infra/databases")
  const showApps =
    relayConfigured &&
    destinations.some((destination) => destination.to === "/infra/apps")
  // Without servers, the sidebar opens the first database, then app, then
  // Relay, then Kiln for platform administrators, so whatever the user can
  // reach still fills it, even before a Relay is added.
  const kilnFallback = capabilities.isPlatformAdmin ? (
    <SidebarKilnNavigation capabilities={capabilities} followServices={false} />
  ) : null
  const relayFallback = relayConfigured ? (
    <SidebarRelayNavigation
      capabilities={capabilities}
      fallback={kilnFallback}
      relayId={null}
    />
  ) : (
    kilnFallback
  )
  const appFallback = showApps ? (
    <SidebarAppNavigation
      appId={null}
      capabilities={capabilities}
      fallback={relayFallback}
    />
  ) : (
    relayFallback
  )
  const databaseFallback = showDatabases ? (
    <SidebarDatabaseNavigation
      capabilities={capabilities}
      databaseId={null}
      fallback={appFallback}
    />
  ) : (
    appFallback
  )
  const serverNavigation = (
    <SidebarServerNavigation
      capabilities={capabilities}
      emptyFallback={databaseFallback}
      initialSelectedInstance={initialSelectedInstance}
      relayConfigured={relayConfigured}
    />
  )

  if (kilnRoute) {
    return <SidebarKilnNavigation capabilities={capabilities} followServices />
  }
  return databaseId ? (
    <SidebarDatabaseNavigation
      capabilities={capabilities}
      databaseId={databaseId}
      fallback={serverNavigation}
    />
  ) : appId ? (
    <SidebarAppNavigation
      appId={appId}
      capabilities={capabilities}
      fallback={serverNavigation}
    />
  ) : relayId ? (
    <SidebarRelayNavigation
      capabilities={capabilities}
      fallback={serverNavigation}
      relayId={relayId}
    />
  ) : tunnelId ? (
    <SidebarTunnelNavigation
      capabilities={capabilities}
      fallback={serverNavigation}
      tunnelId={tunnelId}
    />
  ) : (
    serverNavigation
  )
}

const tunnelSelection = instanceSelection("tunnel")

// A tunnel's pages, while one is open or was last.
function SidebarTunnelNavigation({
  capabilities,
  fallback,
  tunnelId,
}: {
  capabilities: NavigationAccessCapabilities
  fallback: React.ReactNode
  tunnelId: string
}) {
  const query = useTunnel(tunnelId)
  const tunnel = query.data
  const view = React.useMemo(
    (): TunnelView | null =>
      tunnel ? { permissions: tunnelPermissionsOf(tunnel), tunnel } : null,
    [tunnel]
  )
  if (!view) return query.isPending ? null : fallback
  return (
    <SidebarResourceGroup
      capabilities={capabilities}
      selection={{ kind: "tunnel", view }}
      selectionValue={tunnelSelection.toSelection(view.tunnel.id)}
    >
      <TunnelTabNavigation view={view} />
    </SidebarResourceGroup>
  )
}

const TunnelTabNavigation = React.memo(function TunnelTabNavigation({
  view,
}: {
  view: TunnelView
}) {
  return accessibleDestinationsForTunnel(view.permissions).map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton asChild tooltip={item.label}>
        <Link
          to={item.to}
          params={{ tunnelId: view.tunnel.id }}
          activeOptions={{ exact: true, includeSearch: false }}
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

// Kiln itself: Hearth and the services beside it, while one of its pages
// is open, or when an administrator has nothing else to open.
function SidebarKilnNavigation({
  capabilities,
  followServices,
}: {
  capabilities: NavigationAccessCapabilities
  // Polls Kiln's services, as its own pages do. Elsewhere it only names Kiln.
  followServices: boolean
}) {
  const { data: host = null } = useQuery({
    ...kilnPlatformQueryOptions(),
    select: selectKilnHost,
    ...(followServices
      ? null
      : { refetchInterval: false, staleTime: kilnPickerStaleTime }),
  })
  return (
    <>
      <SidebarSeparator />
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <InstanceSelector
              capabilities={capabilities}
              selection={{ kind: "kiln", host }}
            />
            {kilnDestinations.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton asChild tooltip={item.label}>
                  <Link
                    to={item.to}
                    activeOptions={{ exact: true, includeSearch: false }}
                    activeProps={{ "data-active": true }}
                    preload="intent"
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}

function SidebarAppNavigation({
  appId,
  capabilities,
  fallback,
}: {
  // null selects the first app, for users without servers or databases.
  appId: string | null
  capabilities: NavigationAccessCapabilities
  fallback: React.ReactNode
}) {
  const select = React.useMemo(
    () => (apps: Array<AppDirectoryEntry>) =>
      (appId === null ? apps[0] : apps.find((app) => app.id === appId)) ?? null,
    [appId]
  )
  const query = useQuery({ ...appDirectoryQueryOptions(), select })
  const app = query.data
  if (!app) return query.isPending ? null : fallback

  return (
    <SidebarResourceGroup
      capabilities={capabilities}
      selection={{ kind: "app", app }}
      selectionValue={appSelectionValue(app.id)}
    >
      <AppTabNavigation app={app} capabilities={capabilities} />
    </SidebarResourceGroup>
  )
}

// The picker and pages of the selected database, app, or Relay.
function SidebarResourceGroup({
  capabilities,
  children,
  selection,
  selectionValue,
}: {
  capabilities: NavigationAccessCapabilities
  children: React.ReactNode
  selection: InstanceSelection
  // Remembered so the sidebar reopens on this resource.
  selectionValue: string
}) {
  return (
    <>
      <RememberSelectedInstance selection={selectionValue} />
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
}: {
  app: AppDirectoryEntry
  capabilities: NavigationAccessCapabilities
}) {
  return accessibleDestinationsForApp(app, capabilities).map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton asChild tooltip={item.label}>
        <Link
          to={appTabRoute(item.id)}
          params={{ appId: app.id }}
          activeOptions={{ exact: item.id !== "files", includeSearch: false }}
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
  databaseId,
  fallback,
}: {
  capabilities: NavigationAccessCapabilities
  // null selects the first database, for users without servers.
  databaseId: string | null
  fallback: React.ReactNode
}) {
  const select = React.useMemo(
    () => (databases: Array<ManagedDatabaseDirectoryEntry>) =>
      (databaseId === null
        ? databases[0]
        : databases.find((database) => database.id === databaseId)) ?? null,
    [databaseId]
  )
  const query = useQuery({ ...managedDatabaseDirectoryQueryOptions(), select })
  const database = query.data
  if (!database) return query.isPending ? null : fallback

  return (
    <SidebarResourceGroup
      capabilities={capabilities}
      selection={{ kind: "database", database }}
      selectionValue={databaseSelectionValue(database.id)}
    >
      <DatabaseTabNavigation capabilities={capabilities} database={database} />
    </SidebarResourceGroup>
  )
}

function SidebarRelayNavigation({
  capabilities,
  fallback,
  relayId,
}: {
  capabilities: NavigationAccessCapabilities
  fallback: React.ReactNode
  // null selects the first Relay with a page the user can open, for users
  // with no other instances.
  relayId: string | null
}) {
  const select = React.useMemo(
    () => (relays: Array<RelayDirectoryEntry>) =>
      (relayId === null
        ? relays.find(
            (candidate) =>
              accessibleDestinationsForRelay(candidate, capabilities).length > 0
          )
        : relays.find((relay) => relay.id === relayId)) ?? null,
    [capabilities, relayId]
  )
  const query = useQuery({ ...relaysQueryOptions(), select })
  const relay = query.data
  if (!relay) return query.isPending ? null : fallback

  return (
    <SidebarResourceGroup
      capabilities={capabilities}
      selection={{ kind: "relay", relay }}
      selectionValue={relaySelectionValue(relay.id)}
    >
      <RelayTabNavigation capabilities={capabilities} relay={relay} />
    </SidebarResourceGroup>
  )
}

const RelayTabNavigation = React.memo(function RelayTabNavigation({
  capabilities,
  relay,
}: {
  capabilities: NavigationAccessCapabilities
  relay: RelayDirectoryEntry
}) {
  return accessibleDestinationsForRelay(relay, capabilities).map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton asChild tooltip={item.label}>
        <Link
          to={relayTabRoute(item.id)}
          params={{ relayId: relay.id }}
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
    case "desktop":
      return "/relay/$relayId/desktop" as const
    case "logs":
      return "/relay/$relayId/logs" as const
    case "volumes":
      return "/relay/$relayId/volumes" as const
  }
}

const DatabaseTabNavigation = React.memo(function DatabaseTabNavigation({
  capabilities,
  database,
}: {
  capabilities: NavigationAccessCapabilities
  database: ManagedDatabaseDirectoryEntry
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
            params={{ databaseId: database.id }}
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
  initialSelectedInstance,
  relayConfigured,
}: {
  capabilities: NavigationAccessCapabilities
  // Shown once the fleet loads without servers.
  emptyFallback: React.ReactNode
  initialSelectedInstance: string | null
  relayConfigured: boolean
}) {
  const { data, isPending } = useSidebarServerNavigation(
    initialSelectedInstance,
    relayConfigured
  )
  if (!data || data.serverCount === 0) return isPending ? null : emptyFallback
  const { instance } = data

  return (
    <>
      {instance ? <RememberSelectedInstance selection={instance.id} /> : null}
      <SidebarSeparator />
      <InstanceNavigation
        capabilities={capabilities}
        instance={instance}
        serverCount={data.serverCount}
      />
    </>
  )
}

function RememberSelectedInstance({ selection }: { selection: string }) {
  React.useEffect(() => {
    persistSelectedInstance(selection)
  }, [selection])

  return null
}

const InstanceNavigation = React.memo(function InstanceNavigation({
  capabilities,
  instance,
  serverCount,
}: {
  capabilities: NavigationAccessCapabilities
  instance: SidebarInstance | null
  serverCount: number
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
      if (tab === "logs") {
        return navigate({
          to: "/server/$serverId/logs",
          params: { serverId: nextServerId },
          replace,
        })
      }
      if (tab === "terminal") {
        return navigate({
          to: "/server/$serverId/terminal",
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
          />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
})

type InstanceSelection =
  | { kind: "server"; instance: SidebarInstance }
  | { kind: "database"; database: ManagedDatabaseDirectoryEntry }
  | { kind: "app"; app: AppDirectoryEntry }
  | { kind: "relay"; relay: RelayDirectoryEntry }
  | { kind: "tunnel"; view: TunnelView }
  | {
      kind: "kiln"
      host: ReturnType<typeof selectKilnHost>
    }
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
    if (capabilities.isPlatformAdmin) {
      void queryClient.prefetchQuery({
        ...kilnPlatformQueryOptions(),
        staleTime: kilnPickerStaleTime,
      })
    }
  }, [capabilities.isPlatformAdmin, queryClient])
  const selectInstance = React.useCallback(
    (item: InstancePickerItem) => {
      closePicker()
      if (isKilnIdentity(item.identity)) {
        // Already on one of Kiln's pages, stay on it.
        if (!window.location.pathname.startsWith("/kiln/")) {
          void navigate({ to: "/kiln/info" })
        }
        return
      }
      if (item.identity.kind === "database") {
        const databaseId = item.identity.id
        const tab = databaseTabFromPathname(window.location.pathname)
        void navigate(
          tab === "terminal"
            ? {
                to: "/db/$databaseId/terminal",
                params: { databaseId },
              }
            : tab === "logs"
              ? {
                  to: "/db/$databaseId/logs",
                  params: { databaseId },
                }
              : tab === "viewer"
                ? {
                    to: "/db/$databaseId/viewer",
                    params: { databaseId },
                  }
                : tab === "network"
                  ? {
                      to: "/db/$databaseId/network",
                      params: { databaseId },
                    }
                  : tab === "info"
                    ? {
                        to: "/db/$databaseId/info",
                        params: { databaseId },
                      }
                    : { to: "/db/$databaseId", params: { databaseId } }
        )
        return
      }
      if (item.identity.kind === "app") {
        const appId = item.identity.id
        const tab = appTabFromPathname(window.location.pathname)
        void navigate(
          tab
            ? { to: appTabRoute(tab), params: { appId } }
            : { to: "/app/$appId", params: { appId } }
        )
        return
      }
      if (item.identity.kind === "tunnel") {
        const tunnelId = item.identity.id
        const tab = tunnelTabFromPathname(window.location.pathname)
        void navigate(
          tab === "connected"
            ? { to: "/tunnel/$tunnelId/connected", params: { tunnelId } }
            : tab === "logs"
              ? { to: "/tunnel/$tunnelId/logs", params: { tunnelId } }
              : tab === "terminal"
                ? { to: "/tunnel/$tunnelId/terminal", params: { tunnelId } }
                : tab === "info"
                  ? { to: "/tunnel/$tunnelId/info", params: { tunnelId } }
                  : { to: "/tunnel/$tunnelId", params: { tunnelId } }
        )
        return
      }
      if (item.identity.kind === "relay") {
        const relayId = item.identity.relayId
        const tab = relayTabFromPathname(window.location.pathname)
        void navigate(
          tab
            ? { to: relayTabRoute(tab), params: { relayId } }
            : { to: "/relay/$relayId", params: { relayId } }
        )
        return
      }
      const serverId = item.identity.id
      const tab = instanceTabFromPathname(window.location.pathname) ?? "console"
      if (navigateToTab) {
        navigateToTab(tab, serverId)
        return
      }
      void navigate({
        to: "/server/$serverId/console",
        params: { serverId },
      })
    },
    [closePicker, navigate, navigateToTab]
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
            : selection.kind === "kiln"
              ? kilnPickerKey
              : selection.kind === "tunnel"
                ? sidebarPickerKey("tunnel", "", selection.view.tunnel.id)
                : null
  const selectedKeys = React.useMemo(
    () => new Set(selectedKey ? [selectedKey] : []),
    [selectedKey]
  )
  const instance = selection.kind === "server" ? selection.instance : null

  return (
    <SidebarMenuItem>
      <DrawerPopover open={open} onOpenChange={handleOpenChange}>
        <DrawerPopoverTrigger asChild>
          <SidebarMenuButton
            size="lg"
            tooltip={
              selection.kind === "database"
                ? "Switch database"
                : selection.kind === "app"
                  ? "Switch app"
                  : selection.kind === "relay"
                    ? "Switch Relay"
                    : selection.kind === "kiln" || selection.kind === "tunnel"
                      ? "Switch instance"
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
                meta={`${selection.app.id} · ${selection.app.relayName}`}
                name={selection.app.name}
              />
            ) : selection.kind === "relay" ? (
              <SelectorRelayName relay={selection.relay} />
            ) : selection.kind === "tunnel" ? (
              <SelectorInstanceName
                instance={{
                  id: selection.view.tunnel.id,
                  kind: "tunnel",
                  relayId: "",
                }}
                label="Switch instance."
                meta={`Tunnel · ${selection.view.tunnel.domains
                  .map((domain) => `.${domain}`)
                  .join(" ")}`}
                name={selection.view.tunnel.name}
                status={tunnelStatus(selection.view.tunnel)}
              />
            ) : selection.kind === "kiln" ? (
              <SelectorKilnName host={selection.host} />
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
        </DrawerPopoverTrigger>
        <DrawerPopoverContent
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
        </DrawerPopoverContent>
      </DrawerPopover>
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
  status,
}: {
  instance: React.ComponentProps<typeof InstanceCard>["instance"]
  // Read before the name by screen readers, for example "Switch app."
  label: string
  meta: string
  name: string
  /** A status of its own, for a kind without live instance state. */
  status?: React.ComponentProps<typeof InstanceCard>["status"]
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
        status={status}
        statusClassName="ring-popover"
        textClassName="group-data-[collapsible=icon]:sr-only"
      />
    </>
  )
}

// Kiln, with its own logo: the panel itself and the services beside it.
function SelectorKilnName({
  host,
}: {
  host: ReturnType<typeof selectKilnHost>
}) {
  const version = kilnVersion(host?.status ?? null)
  return (
    <>
      <span className="sr-only">Switch instance. </span>
      <IdentityName
        className="min-w-0 flex-1 gap-2 group-data-[collapsible=icon]:gap-0"
        icon={
          <HearthMark className="size-4.5 group-data-[collapsible=icon]:size-5" />
        }
        iconClassName="border-sidebar-border/70 bg-background/25 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-full group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
        meta={[version ? kilnReleaseLabel(version) : null, host?.relayName]
          .filter(Boolean)
          .join(" · ")}
        metaClassName="text-sidebar-muted-foreground"
        name="Kiln"
        nameClassName="type-control-sm text-sidebar-foreground"
        status={kilnPresentation(host)}
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
      meta={`${relay.nodeArch ?? "unknown"} · ${relay.id}`}
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
  const showTunnels = destinations.some(
    (destination) => destination.to === "/infra/tunnels"
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
  const { data: tunnelItems = emptyPickerItems } = useQuery({
    ...tunnelsQueryOptions(),
    enabled: showTunnels,
    select: selectSidebarTunnelPickerItems,
  })
  // Kiln's own pages follow its services; the picker only names it, so it
  // doesn't poll them.
  const showKiln = capabilities.isPlatformAdmin
  const { data: kilnHost = null } = useQuery({
    ...kilnPlatformQueryOptions(),
    enabled: showKiln,
    refetchInterval: false,
    select: selectKilnHost,
    staleTime: kilnPickerStaleTime,
  })
  const items = React.useMemo(
    () =>
      !showKiln &&
      databaseItems.length === 0 &&
      relayItems.length === 0 &&
      appItems.length === 0 &&
      tunnelItems.length === 0
        ? serverItems
        : [
            // Kiln leads, so a fresh installation's picker isn't empty.
            ...(showKiln
              ? [sidebarKilnPickerItem(kilnHost)]
              : emptyPickerItems),
            ...serverItems,
            ...(showDatabases ? databaseItems : emptyPickerItems),
            ...(showApps ? appItems : emptyPickerItems),
            ...(showTunnels ? tunnelItems : emptyPickerItems),
            ...(showRelays ? relayItems : emptyPickerItems),
          ],
    [
      appItems,
      showTunnels,
      tunnelItems,
      databaseItems,
      kilnHost,
      relayItems,
      serverItems,
      showApps,
      showDatabases,
      showKiln,
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
const kilnPickerKey = "kiln"
const kilnPickerStaleTime = 60_000

// Kiln itself, shown through the Relay on its host like the other pickers
// show it, with the status of its services.
function sidebarKilnPickerItem(
  host: KilnPlatformHost | null
): InstancePickerItem {
  const version = kilnVersion(host?.status ?? null)
  const relayId = host?.relayId ?? ""
  return {
    identity: { id: relayId, kind: "relay", platform: true, relayId },
    key: kilnPickerKey,
    meta:
      [version ? kilnReleaseLabel(version) : null, host?.relayName]
        .filter(Boolean)
        .join(" · ") || "Hearth",
    name: "Kiln",
    searchText: `hearth platform ${host?.relayName ?? ""}`,
    status: kilnPresentation(host),
  }
}

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
    meta: `${instance.implementation} ${instance.version} · ${instance.id}`,
    name: instance.name,
    searchText: `${instance.id} ${instance.relayName}`,
  }))
}

function selectSidebarRelayPickerItems(
  relays: Array<RelayDirectoryEntry>
): Array<InstancePickerItem> {
  return relays.map((relay) => ({
    identity: { id: relay.id, kind: "relay", relayId: relay.id },
    key: sidebarPickerKey("relay", relay.id, relay.id),
    meta: `${relay.nodeArch ?? "unknown"} · ${
      relay.nodeVersion ? kilnReleaseLabel(relay.nodeVersion) : relay.id
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
    meta: `${engineLabel(database.engine)} · ${database.id}`,
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
    meta: `App · ${app.id}`,
    name: app.name,
    searchText: `${app.id} ${app.relayName}`,
  }))
}

function selectSidebarTunnelPickerItems(
  result: TunnelsResult
): Array<InstancePickerItem> {
  return result.tunnels.map((tunnel) => ({
    identity: { id: tunnel.id, kind: "tunnel", relayId: "" },
    key: sidebarPickerKey("tunnel", "", tunnel.id),
    meta: `Tailscale · ${tunnel.id}`,
    name: tunnel.name,
    searchText: `${tunnel.id} ${tunnel.domains.join(" ")}`,
    // The Relays' inventories don't list tunnels; their gateways say.
    status: tunnelStatus(tunnel),
  }))
}

const InstanceTabNavigation = React.memo(function InstanceTabNavigation({
  capabilities,
  instance,
}: {
  capabilities: NavigationAccessCapabilities
  instance: SidebarInstance | null
}) {
  const items = instance
    ? accessibleDestinationsForServer(instance, capabilities)
    : serverDestinations
  return items.map((item) => (
    <InstanceTabNavigationItem
      key={item.id}
      item={item}
      serverId={instance?.id ?? null}
    />
  ))
})

const InstanceTabNavigationItem = React.memo(
  function InstanceTabNavigationItem({
    item,
    serverId,
  }: {
    item: ServerDestination
    serverId: string | null
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
          {!serverId ? (
            <Link
              to="/infra/servers"
              activeOptions={{ exact: true, includeSearch: false }}
            >
              {content}
            </Link>
          ) : item.id === "console" ? (
            <Link
              to="/server/$serverId/console"
              params={{ serverId }}
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
              params={{ serverId, _splat: "" }}
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
              params={{ serverId }}
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={{ "data-active": true }}
              preload="intent"
            >
              {content}
            </Link>
          ) : item.id === "startup" ? (
            <Link
              to="/server/$serverId/startup"
              params={{ serverId }}
              activeOptions={{ exact: true }}
              activeProps={{ "data-active": true }}
              preload="intent"
            >
              {content}
            </Link>
          ) : item.id === "terminal" ? (
            <Link
              to="/server/$serverId/terminal"
              params={{ serverId }}
              activeOptions={{ exact: true }}
              activeProps={{ "data-active": true }}
              preload="intent"
            >
              {content}
            </Link>
          ) : item.id === "logs" ? (
            <Link
              to="/server/$serverId/logs"
              params={{ serverId }}
              // Whichever deployment's log is open.
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={{ "data-active": true }}
              preload="intent"
            >
              {content}
            </Link>
          ) : (
            <Link
              to="/server/$serverId/info"
              params={{ serverId }}
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
              userId={user.id}
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
            <AccountAvatar name={user.name} userId={user.id} />
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
  if (/^\/server\/[^/]+\/logs\/?$/.test(pathname)) return "logs"
  if (/^\/server\/[^/]+\/info\/?$/.test(pathname)) return "info"
  if (/^\/server\/[^/]+\/console\/?$/.test(pathname)) return "console"
  if (/^\/server\/[^/]+\/terminal\/?$/.test(pathname)) return "terminal"
  return null
}

function appTabFromPathname(pathname: string): AppDestinationId | null {
  const match =
    /^\/app\/[^/]+\/(files|info|logs|network|terminal)(?:\/|$)/.exec(pathname)
  return match ? (match[1] as AppDestinationId) : null
}

function tunnelTabFromPathname(pathname: string) {
  return (
    /^\/tunnel\/[^/]+\/(connected|info|logs|terminal)\/?$/.exec(
      pathname
    )?.[1] ?? null
  )
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
