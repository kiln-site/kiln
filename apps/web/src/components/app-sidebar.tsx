import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  CalendarClock,
  ChevronsUpDown,
  Database,
  ListTodo,
  LoaderCircle,
  LogOut,
  Server as ServerIcon,
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
import { InstanceName } from "@/components/instance-name"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { authClient } from "@/lib/auth-client"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { clearAppearanceCache } from "@/lib/appearance"
import {
  accessCapabilitiesQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relayConnectionQueryOptions,
  relaySnapshotQueryOptions,
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
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import {
  findFirstCanonicalRelayInstance,
  relayInstanceRouteIdentifier,
  resolveCanonicalRelayInstance,
  selectRelayConfigured,
  selectSidebarInstanceCount,
  selectSidebarInstances,
} from "@/lib/relay-selectors"
import type { SidebarInstance } from "@/lib/relay-selectors"
import { globalSectionFromRouteId } from "@/lib/route-sections"
import type { GlobalSection } from "@/lib/route-sections"
import {
  accessibleDestinationsForDatabase,
  accessibleDestinationsForServer,
  accessibleInfrastructureDestinations,
  canAccessActivity,
  canAccessAutomations,
  canAccessBackups,
  serverDestinations,
  type DatabaseDestinationId,
  type NavigationAccessCapabilities,
  type ServerDestination,
  type ServerDestinationId,
} from "@/lib/navigation-destinations"
import {
  persistSelectedInstanceRouteId,
  readSelectedInstanceRouteId,
} from "@/lib/ui-preference-cookies"
import { warmFileWorkspaceModule } from "@/lib/workspace-module-preloads"

export type InstanceTab = ServerDestinationId

interface AppSidebarViewProps {
  capabilities: NavigationAccessCapabilities
  user: AuthenticatedUser
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}

const emptyInstances: Array<SidebarInstance> = []

export const AppSidebar = React.memo(function AppSidebar({
  initialSelectedInstanceRouteId,
}: {
  initialSelectedInstanceRouteId: string | null
}) {
  const queryClient = useQueryClient()
  const { data: relayConfigured } = useSuspenseQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConfigured,
  })
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )

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
        <SidebarHeader className="gap-1.5 px-2 py-2">
          <SidebarMenu className="h-16 justify-center">
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                className="h-11 hover:bg-transparent active:bg-transparent data-[state=open]:bg-transparent"
                tooltip="Kiln"
              >
                <HearthMark className="group-data-[collapsible=icon]:size-[32px]!" />
                <span className="min-w-0 flex-1 truncate font-heading text-lg font-semibold tracking-[0.04em]">
                  KILN
                </span>
              </SidebarMenuButton>
              <HeaderNotificationsBell />
            </SidebarMenuItem>
          </SidebarMenu>
          <RouteCommandMenuTrigger />
        </SidebarHeader>

        <SidebarSeparator />

        <SidebarContent>
          <InfrastructureNavigation
            capabilities={capabilities}
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
  return (
    <NotificationsBell
      className="absolute top-1/2 right-1 -translate-y-1/2"
      tooltipHidden={isMobile}
    />
  )
}

function InfrastructureNavigation({
  capabilities,
  relayConfigured,
}: {
  capabilities: NavigationAccessCapabilities
  relayConfigured: boolean
}) {
  const destinations = accessibleInfrastructureDestinations(capabilities)
  const showServers = destinations.some(
    (destination) => destination.to === "/infra/servers"
  )
  const showDatabases = destinations.some(
    (destination) => destination.to === "/infra/databases"
  )
  if (!showServers && !showDatabases) return null

  return (
    <SidebarGroup className="pt-2">
      <SidebarGroupLabel className="type-technical-label">
        Infrastructure
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {showServers ? (
            <ServersNavigationItem relayConfigured={relayConfigured} />
          ) : null}
          {showDatabases ? (
            <DatabasesNavigationItem relayConfigured={relayConfigured} />
          ) : null}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

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
          <Database />
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

function ServersNavigationItem({
  relayConfigured,
}: {
  relayConfigured: boolean
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Servers">
        <Link
          to="/infra/servers"
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ "data-active": true }}
          preload="intent"
        >
          <ServerIcon />
          <span>Servers</span>
        </Link>
      </SidebarMenuButton>
      <SidebarMenuBadge className="text-sidebar-muted-foreground">
        <InfrastructureInstanceCount relayConfigured={relayConfigured} />
      </SidebarMenuBadge>
    </SidebarMenuItem>
  )
}

const InfrastructureInstanceCount = React.memo(
  function InfrastructureInstanceCount({
    relayConfigured,
  }: {
    relayConfigured: boolean
  }) {
    const { data: instanceCount = 0 } = useQuery({
      ...relaySnapshotQueryOptions(),
      enabled: relayConfigured,
      select: selectSidebarInstanceCount,
    })

    return instanceCount
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
  // "server", a database selection ("db:<id>"), or null off instance routes.
  const routeSelection = useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params as
        | { databaseId?: string; serverId?: string }
        | undefined
      if (params?.databaseId) return databaseSelectionRouteId(params.databaseId)
      return params?.serverId ? "server" : null
    },
  })
  const databaseRouteId =
    routeSelection === "server"
      ? null
      : databaseRouteIdFromSelection(
          routeSelection ??
            readSelectedInstanceRouteId() ??
            initialSelectedInstanceRouteId
        )
  const showDatabases =
    relayConfigured &&
    accessibleInfrastructureDestinations(capabilities).some(
      (destination) => destination.to === "/infra/databases"
    )
  const serverNavigation = (
    <SidebarServerNavigation
      capabilities={capabilities}
      emptyFallback={
        showDatabases ? (
          <SidebarDatabaseNavigation
            capabilities={capabilities}
            databaseRouteId={null}
            fallback={null}
          />
        ) : null
      }
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
  ) : (
    serverNavigation
  )
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
          ? resolution.database
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
    <>
      <RememberSelectedInstance
        instanceRouteId={databaseSelectionRouteId(routeId)}
      />
      <SidebarSeparator />
      <SidebarGroup>
        <SidebarGroupLabel className="type-technical-label">
          Database
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <InstanceSelector
              capabilities={capabilities}
              selection={{ kind: "database", database }}
            />
            <DatabaseTabNavigation
              capabilities={capabilities}
              database={database}
              routeId={routeId}
            />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
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
  const { data: instances = emptyInstances, isPending } = useQuery({
    ...relaySnapshotQueryOptions(),
    enabled: relayConfigured,
    select: selectSidebarInstances,
  })
  const serverId = useRouterState({
    select: (state) =>
      (state.matches.at(-1)?.params as { serverId?: string } | undefined)
        ?.serverId,
  })
  const selectedInstanceRouteId = React.useMemo(
    () =>
      serverId ??
      readSelectedInstanceRouteId() ??
      initialSelectedInstanceRouteId,
    [initialSelectedInstanceRouteId, serverId]
  )
  const preferredResolution = resolveCanonicalRelayInstance(
    instances,
    selectedInstanceRouteId
  )
  const instance =
    preferredResolution.status === "found"
      ? preferredResolution.instance
      : serverId || preferredResolution.status === "ambiguous"
        ? null
        : (findFirstCanonicalRelayInstance(instances) ?? null)
  const instanceRouteId = instance
    ? (relayInstanceRouteIdentifier(instances, instance) ?? null)
    : null
  if (instances.length === 0) return isPending ? null : emptyFallback

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
        instances={instances}
        unresolvedServerId={
          serverId ??
          (preferredResolution.status === "ambiguous"
            ? (selectedInstanceRouteId ?? undefined)
            : undefined)
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
  instances,
  unresolvedServerId,
}: {
  capabilities: NavigationAccessCapabilities
  instance: SidebarInstance | null
  instanceRouteId: string | null
  instances: Array<SidebarInstance>
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
      <SidebarGroupLabel className="type-technical-label">
        Server
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <InstanceSelector
            capabilities={capabilities}
            navigateToTab={navigateToTab}
            selection={
              instance
                ? { kind: "server", instance }
                : { kind: "none", serverCount: instances.length }
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
  const { isMobile } = useSidebar()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
  }, [])
  const closePicker = React.useCallback(() => setOpen(false), [])
  const selectInstance = React.useCallback(
    (item: InstancePickerItem) => {
      handleOpenChange(false)
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
      if (item.identity.kind === "relay") {
        void navigate({
          to: "/infra/relays",
          search: { search: item.identity.relayId },
        })
        return
      }
      const snapshot = queryClient.getQueryData(
        relaySnapshotQueryOptions().queryKey
      )
      if (!snapshot) return
      const instances = selectSidebarInstances(snapshot)
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
    [handleOpenChange, navigate, navigateToTab, queryClient]
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
        : null
  const selectedKeys = React.useMemo(
    () => new Set(selectedKey ? [selectedKey] : []),
    [selectedKey]
  )
  const instance = selection.kind === "server" ? selection.instance : null

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            size="lg"
            tooltip={
              selection.kind === "database"
                ? "Switch database"
                : "Switch server"
            }
            aria-label={
              selection.kind === "none" ? "Choose a server" : undefined
            }
            className="mb-1.5 h-auto border border-sidebar-border/75 bg-background/35 px-2 py-2 group-data-[collapsible=icon]:h-[32px]! group-data-[collapsible=icon]:overflow-visible group-data-[collapsible=icon]:bg-black/10 hover:border-sidebar-border hover:bg-sidebar-accent group-data-[collapsible=icon]:hover:bg-black/15 data-[state=open]:border-sidebar-border data-[state=open]:bg-sidebar-accent dark:group-data-[collapsible=icon]:bg-black/25 dark:group-data-[collapsible=icon]:hover:bg-black/35"
          >
            {instance ? (
              <>
                <span className="sr-only">Switch server. </span>
                <InstanceName
                  className="min-w-0 flex-1 gap-2 group-data-[collapsible=icon]:gap-0"
                  iconClassName="border-sidebar-border/70 bg-background/25 text-sidebar-foreground/85 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-full group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
                  iconSizeClassName="group-data-[collapsible=icon]:size-5!"
                  instance={{
                    brickId: instance.brickId,
                    brickSource: instance.brickSource,
                    id: instance.id,
                    implementation: instance.implementation,
                    kind: "server",
                    observedState: instance.observedState,
                    relayId: instance.relayId,
                  }}
                  meta={`${instance.implementation} ${instance.version}`}
                  metaClassName="text-sidebar-muted-foreground"
                  name={instance.name}
                  nameClassName="type-control-sm text-sidebar-foreground"
                  showFavorite={false}
                  statusClassName="ring-popover"
                  textClassName="group-data-[collapsible=icon]:sr-only"
                />
              </>
            ) : selection.kind === "database" ? (
              <>
                <span className="sr-only">Switch database. </span>
                <InstanceName
                  className="min-w-0 flex-1 gap-2 group-data-[collapsible=icon]:gap-0"
                  iconClassName="border-sidebar-border/70 bg-background/25 text-sidebar-foreground/85 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-full group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
                  iconSizeClassName="group-data-[collapsible=icon]:size-5!"
                  instance={{
                    id: selection.database.id,
                    kind: "database",
                    relayId: selection.database.relayId,
                  }}
                  meta={`${engineLabel(selection.database.engine)} · ${selection.database.relayName}`}
                  metaClassName="text-sidebar-muted-foreground"
                  name={selection.database.name}
                  nameClassName="type-control-sm text-sidebar-foreground"
                  showFavorite={false}
                  statusClassName="ring-popover"
                  textClassName="group-data-[collapsible=icon]:sr-only"
                />
              </>
            ) : (
              <>
                <span className="relative grid size-8 shrink-0 place-items-center rounded-md border border-sidebar-border/70 bg-background/25 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-full group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent">
                  <ServerIcon
                    className="size-4 text-sidebar-foreground/85"
                    aria-hidden="true"
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start group-data-[collapsible=icon]:hidden">
                  <span className="type-control-sm w-full truncate">
                    Choose a server
                  </span>
                  <span className="type-meta w-full truncate text-sidebar-muted-foreground">
                    {selection.kind === "none" && selection.serverCount === 0
                      ? "No managed servers"
                      : "Selection required"}
                  </span>
                </span>
              </>
            )}
            <ChevronsUpDown className="ml-auto size-3.5! text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Instances"
          side={isMobile ? "bottom" : "right"}
          align="start"
          sideOffset={6}
          className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        >
          <SidebarInstancePicker
            capabilities={capabilities}
            selectedKeys={selectedKeys}
            onNavigate={closePicker}
            onSelect={selectInstance}
          />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  )
})

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
  const { data: serverItems = emptyPickerItems } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectSidebarServerPickerItems,
  })
  const { data: relayItems = emptyPickerItems } = useQuery({
    ...relaySnapshotQueryOptions(),
    enabled: showRelays,
    select: selectSidebarRelayPickerItems,
  })
  const { data: databaseItems = emptyPickerItems } = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    enabled: showDatabases,
    select: selectSidebarDatabasePickerItems,
  })
  const items = React.useMemo(
    () =>
      databaseItems.length === 0 && relayItems.length === 0
        ? serverItems
        : [
            ...serverItems,
            ...(showDatabases ? databaseItems : emptyPickerItems),
            ...(showRelays ? relayItems : emptyPickerItems),
          ],
    [databaseItems, relayItems, serverItems, showDatabases, showRelays]
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
  snapshot: RelayFleetSnapshot
): Array<InstancePickerItem> {
  return selectSidebarInstances(snapshot).map((instance) => ({
    identity: {
      brickId: instance.brickId,
      brickSource: instance.brickSource,
      id: instance.id,
      implementation: instance.implementation,
      kind: "server",
      observedState: instance.observedState,
      relayId: instance.relayId,
    },
    key: sidebarPickerKey("server", instance.relayId, instance.id),
    meta: `${instance.implementation} ${instance.version} · ${instance.shortId}`,
    name: instance.name,
    searchText: `${instance.routeId} ${instance.relayName} ${instance.observedState}`,
  }))
}

function selectSidebarRelayPickerItems(
  snapshot: RelayFleetSnapshot
): Array<InstancePickerItem> {
  return snapshot.nodes.map((node) => ({
    identity: {
      id: node.relayId,
      kind: "relay",
      relayId: node.relayId,
      relayStatus: node.relayStatus,
      source: "fleet",
    },
    key: sidebarPickerKey("relay", node.relayId, node.relayId),
    meta: `${node.arch} · ${kilnReleaseLabel(node.version)}`,
    name: node.relayName,
    searchText: `${node.relayId} ${node.version}`,
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
              preload="render"
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
  const [signingOut, setSigningOut] = React.useState(false)
  const closeMenu = React.useCallback(() => setOpen(false), [])

  return (
    <CollapsedNotificationsAnchor>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative grid size-[32px] place-items-center transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
            aria-label={`Open account menu for ${user.name}`}
          >
            <AccountAvatar name={user.name} />
            <UnreadNotificationsIndicator />
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Account menu"
          side="right"
          align="end"
          className="w-48 p-1"
        >
          <p className="truncate px-2 py-2 text-xs text-muted-foreground">
            {user.name}
          </p>
          <div className="-mx-1 mb-1 h-px bg-border" />
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
  return (
    <div className="flex h-11 items-center gap-1 px-2">
      <Link
        to="/settings/account"
        preload="intent"
        className="flex min-w-0 flex-1 items-center gap-2 text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none"
      >
        <AccountAvatar name={user.name} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {user.name}
        </span>
      </Link>
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
          className="grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none"
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
          className="ml-auto grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
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
  if (isDevelopmentBypass) await disableDevelopmentBypass()
  else await authClient.signOut()
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

function databaseTabFromPathname(
  pathname: string
): DatabaseDestinationId | null {
  const match = /^\/db\/[^/]+\/(info|network|terminal|viewer)\/?$/.exec(
    pathname
  )
  return match ? (match[1] as DatabaseDestinationId) : null
}
