import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ArrowRight,
  CalendarClock,
  Check,
  ChevronsUpDown,
  Database,
  ListTodo,
  LoaderCircle,
  LogOut,
  Search,
  Server as ServerIcon,
  Settings,
  UserRoundCog,
} from "lucide-react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { forkPromise } from "@/effect/promise"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Input } from "@workspace/ui/components/input"
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
import { HearthMark } from "@/components/hearth-mark"
import { BackupIcon } from "@/components/backup-icon"
import {
  RouteCommandMenuProvider,
  RouteCommandMenuTrigger,
} from "@/components/route-command-menu"
import { ServerTypeIcon } from "@/components/server-type-icon"
import { authClient } from "@/lib/auth-client"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { clearAppearanceCache } from "@/lib/appearance"
import { minecraftHeadUrl } from "@/lib/minecraft-profile"
import {
  accessCapabilitiesQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  minecraftProfileQueryOptions,
  relayConnectionQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { disableDevelopmentBypass } from "@/server/auth"
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
  destinationsForServer,
  serverDestinations,
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
  user: AuthenticatedUser
  canManageAccess: boolean
  canManageRelays: boolean
  initialSelectedInstanceRouteId: string | null
  isPlatformAdmin: boolean
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
      canManageAccess={capabilities.canManageAccess}
      canManageRelays={capabilities.canManageRelays}
      initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
      isPlatformAdmin={capabilities.isPlatformAdmin}
      relayConfigured={relayConfigured}
      user={capabilities.user}
    />
  )
})

const AppSidebarView = React.memo(function AppSidebarView({
  user,
  canManageAccess,
  canManageRelays,
  initialSelectedInstanceRouteId,
  isPlatformAdmin,
  relayConfigured,
}: AppSidebarViewProps) {
  return (
    <RouteCommandMenuProvider
      canManageAccess={canManageAccess}
      canManageRelays={canManageRelays}
      initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
      isPlatformAdmin={isPlatformAdmin}
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
            </SidebarMenuItem>
          </SidebarMenu>
          <RouteCommandMenuTrigger />
        </SidebarHeader>

        <SidebarSeparator />

        <SidebarContent>
          <InfrastructureNavigation relayConfigured={relayConfigured} />

          <SidebarInstanceNavigation
            initialSelectedInstanceRouteId={initialSelectedInstanceRouteId}
            relayConfigured={relayConfigured}
          />
        </SidebarContent>

        <AccountNavigation canManageAccess={canManageAccess} user={user} />
      </Sidebar>
    </RouteCommandMenuProvider>
  )
})

function InfrastructureNavigation({
  relayConfigured,
}: {
  relayConfigured: boolean
}) {
  return (
    <SidebarGroup className="pt-2">
      <SidebarGroupLabel className="type-technical-label">
        Infrastructure
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <ServersNavigationItem relayConfigured={relayConfigured} />
          <DatabasesNavigationItem relayConfigured={relayConfigured} />
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
  initialSelectedInstanceRouteId,
  relayConfigured,
}: {
  initialSelectedInstanceRouteId: string | null
  relayConfigured: boolean
}) {
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
  return (
    <>
      {instanceRouteId ? (
        <RememberSelectedInstance instanceRouteId={instanceRouteId} />
      ) : null}
      <SidebarSeparator />
      <InstanceNavigation
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
  instance,
  instanceRouteId,
  instances,
  unresolvedServerId,
}: {
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
          <ServerSelector
            instance={instance}
            instances={instances}
            navigateToTab={navigateToTab}
          />
          <InstanceTabNavigation
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

const ServerSelector = React.memo(function ServerSelector({
  instance,
  instances,
  navigateToTab,
}: {
  instance: SidebarInstance | null
  instances: Array<SidebarInstance>
  navigateToTab: (tab: InstanceTab, serverId: string) => void
}) {
  const { isMobile } = useSidebar()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
  }, [])
  const selectInstance = React.useCallback(
    (routeId: string) => {
      handleOpenChange(false)
      const snapshot = queryClient.getQueryData(
        relaySnapshotQueryOptions().queryKey
      )
      if (!snapshot) return
      const instances = selectSidebarInstances(snapshot)
      const resolution = resolveCanonicalRelayInstance(instances, routeId)
      if (resolution.status === "ambiguous") {
        void navigate({ href: ambiguousServerHref(routeId) })
        return
      }
      if (resolution.status === "not-found") return
      const routeIdentifier = relayInstanceRouteIdentifier(
        instances,
        resolution.instance
      )
      if (!routeIdentifier) {
        void navigate({
          href: ambiguousServerHref(resolution.instance.shortId),
        })
        return
      }

      navigateToTab(
        instanceTabFromPathname(window.location.pathname) ?? "console",
        routeIdentifier
      )
    },
    [handleOpenChange, navigate, navigateToTab, queryClient]
  )

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            size="lg"
            tooltip="Switch server"
            aria-label={
              instance
                ? `Switch server. ${instance.name}, ${instance.implementation} ${instance.version}, ${serverStatusLabel(instance.observedState)}`
                : "Choose a server"
            }
            className="mb-1.5 h-auto border border-sidebar-border/75 bg-background/35 px-2 py-2 group-data-[collapsible=icon]:h-[32px]! group-data-[collapsible=icon]:overflow-visible group-data-[collapsible=icon]:bg-black/10 hover:border-sidebar-border hover:bg-sidebar-accent group-data-[collapsible=icon]:hover:bg-black/15 data-[state=open]:border-sidebar-border data-[state=open]:bg-sidebar-accent dark:group-data-[collapsible=icon]:bg-black/25 dark:group-data-[collapsible=icon]:hover:bg-black/35"
          >
            <span className="relative grid size-7 shrink-0 place-items-center rounded-md border border-sidebar-border/70 bg-background/25 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:m-auto group-data-[collapsible=icon]:size-6 group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent">
              <ServerTypeIcon
                implementation={instance?.implementation ?? ""}
                className="size-4 text-sidebar-foreground/85"
                aria-hidden="true"
              />
              {instance ? (
                <span
                  className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-popover ${statusDotTone(instance.observedState)}`}
                  aria-hidden="true"
                />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col items-start group-data-[collapsible=icon]:hidden">
              <span className="type-control-sm w-full truncate">
                {instance?.name ?? "Choose a server"}
              </span>
              <span className="type-meta flex w-full items-center gap-1.5 truncate text-sidebar-muted-foreground">
                {instance ? (
                  <>
                    <span className="truncate">
                      {instance.implementation} {instance.version}
                    </span>
                    <span className="sr-only">
                      Status: {serverStatusLabel(instance.observedState)}
                    </span>
                  </>
                ) : instances.length === 0 ? (
                  "No managed servers"
                ) : (
                  "Selection required"
                )}
              </span>
            </span>
            <ChevronsUpDown className="ml-auto size-3.5! text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Managed servers"
          side={isMobile ? "bottom" : "right"}
          align="start"
          sideOffset={6}
          className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        >
          <ServerSelectorSearch
            activeInstanceId={instance?.id}
            activeRelayId={instance?.relayId}
            instances={instances}
            onSelect={selectInstance}
          />
          <div className="border-t border-border/70 p-1.5">
            <Link
              to="/infra/servers"
              onClick={() => handleOpenChange(false)}
              className="type-control-sm group flex h-9 w-full items-center gap-2 rounded-md bg-muted/45 px-2.5 text-foreground transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ServerIcon
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <span>View all servers</span>
              <ArrowRight
                className="ml-auto size-3.5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  )
})

const ServerSelectorSearch = React.memo(function ServerSelectorSearch({
  activeInstanceId,
  activeRelayId,
  instances,
  onSelect,
}: {
  activeInstanceId: string | undefined
  activeRelayId: string | undefined
  instances: Array<SidebarInstance>
  onSelect: (routeId: string) => void
}) {
  const [search, setSearch] = React.useState("")

  return (
    <>
      <ServerSelectorSearchField value={search} onValueChange={setSearch} />
      <ServerSelectorResults
        activeInstanceId={activeInstanceId}
        activeRelayId={activeRelayId}
        instances={instances}
        onSelect={onSelect}
        search={search}
      />
    </>
  )
})

const ServerSelectorSearchField = React.memo(
  function ServerSelectorSearchField({
    value,
    onValueChange,
  }: {
    value: string
    onValueChange: (value: string) => void
  }) {
    return (
      <div className="border-b border-border/70 p-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            autoFocus
            type="search"
            value={value}
            onChange={(event) => onValueChange(event.currentTarget.value)}
            placeholder="Search servers"
            aria-label="Search servers"
            className="h-8 bg-input/14 pr-2 pl-8 text-sm"
          />
        </div>
      </div>
    )
  }
)

interface ServerSelectorResultsProps {
  activeInstanceId: string | undefined
  activeRelayId: string | undefined
  instances: Array<SidebarInstance>
  onSelect: (routeId: string) => void
  search: string
}

const ServerSelectorResults = React.memo(function ServerSelectorResults({
  activeInstanceId,
  activeRelayId,
  instances,
  onSelect,
  search,
}: ServerSelectorResultsProps) {
  const query = normalizeServerSearch(search)
  const filteredInstances = React.useMemo(() => {
    if (!query) return instances
    return instances.filter((item) =>
      matchesNormalizedServerSearch(item, query)
    )
  }, [instances, query])

  return filteredInstances.length > 0 ? (
    <VirtualizedServerSelectorResults
      key={query}
      activeInstanceId={activeInstanceId}
      activeRelayId={activeRelayId}
      instances={filteredInstances}
      onSelect={onSelect}
    />
  ) : (
    <div className="px-4 py-6 text-center">
      <p className="type-control-sm">
        {instances.length === 0
          ? "No managed servers"
          : "No servers match your search"}
      </p>
      <p className="type-meta mt-1 text-muted-foreground">
        {instances.length === 0
          ? "Servers will appear here once they are provisioned."
          : "Try a name, version, ID, or status."}
      </p>
    </div>
  )
}, serverSelectorResultsAreEqual)

const VirtualizedServerSelectorResults = React.memo(
  function VirtualizedServerSelectorResults({
    activeInstanceId,
    activeRelayId,
    instances,
    onSelect,
  }: {
    activeInstanceId: string | undefined
    activeRelayId: string | undefined
    instances: Array<SidebarInstance>
    onSelect: (routeId: string) => void
  }) {
    const scrollElementRef = React.useRef<HTMLDivElement>(null)
    const getScrollElement = React.useCallback(
      () => scrollElementRef.current,
      []
    )
    const getItemKey = React.useCallback(
      (index: number) => {
        const item = instances[index]
        return item ? `${item.relayId}:${item.id}` : index
      },
      [instances]
    )
    const rowVirtualizer = useVirtualizer({
      count: instances.length,
      estimateSize: estimateServerSelectorRowSize,
      gap: serverSelectorRowGap,
      getItemKey,
      getScrollElement,
      overscan: 3,
    })

    return (
      <div
        ref={scrollElementRef}
        className="max-h-64 overflow-y-auto overscroll-contain p-1.5"
      >
        <div
          className="relative w-full"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = instances[virtualRow.index]
            if (!item) return null
            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                className={`absolute top-0 left-0 w-full pb-0.5 ${virtualRow.index < instances.length - 1 ? "border-b border-border/50" : ""}`}
                data-index={virtualRow.index}
                style={{ top: virtualRow.start }}
              >
                <ServerSelectorItem
                  active={
                    item.id === activeInstanceId &&
                    item.relayId === activeRelayId
                  }
                  item={item}
                  onSelect={onSelect}
                />
              </div>
            )
          })}
        </div>
      </div>
    )
  }
)

const serverSelectorRowGap = 3

function estimateServerSelectorRowSize(): number {
  return 46
}

function serverSelectorResultsAreEqual(
  previous: ServerSelectorResultsProps,
  next: ServerSelectorResultsProps
): boolean {
  if (
    previous.activeInstanceId !== next.activeInstanceId ||
    previous.activeRelayId !== next.activeRelayId ||
    previous.instances !== next.instances ||
    previous.onSelect !== next.onSelect
  ) {
    return false
  }
  if (previous.search === next.search) return true

  const previousQuery = normalizeServerSearch(previous.search)
  const nextQuery = normalizeServerSearch(next.search)
  return previous.instances.every(
    (item) =>
      matchesNormalizedServerSearch(item, previousQuery) ===
      matchesNormalizedServerSearch(item, nextQuery)
  )
}

function normalizeServerSearch(search: string): string {
  return search.trim().toLocaleLowerCase()
}

function matchesNormalizedServerSearch(
  item: SidebarInstance,
  query: string
): boolean {
  if (!query) return true

  return [
    item.name,
    item.implementation,
    item.version,
    item.shortId,
    item.routeId,
    item.relayName,
    item.observedState,
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query)
}

const ServerSelectorItem = React.memo(function ServerSelectorItem({
  active,
  item,
  onSelect,
}: {
  active: boolean
  item: SidebarInstance
  onSelect: (routeId: string) => void
}) {
  return (
    <button
      type="button"
      aria-label={`${item.name}, ${item.implementation} ${item.version}, ${item.observedState}`}
      aria-pressed={active}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-[color,background-color,box-shadow] duration-100 outline-none hover:bg-popover-accent hover:text-popover-accent-foreground focus-visible:bg-popover-accent focus-visible:text-popover-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/35 ${active ? "bg-primary/8 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_14%,transparent)]" : ""}`}
      onClick={() => onSelect(item.routeId)}
    >
      <span className="relative grid size-7 shrink-0 place-items-center rounded-md bg-muted/55">
        <ServerTypeIcon
          implementation={item.implementation}
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-popover ${statusDotTone(item.observedState)}`}
          aria-hidden="true"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="type-control-sm block truncate">{item.name}</span>
        <span className="type-meta block truncate font-mono text-muted-foreground">
          {item.implementation} {item.version} · {item.shortId}
        </span>
      </span>
      {active ? (
        <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : null}
    </button>
  )
})

const InstanceTabNavigation = React.memo(function InstanceTabNavigation({
  instance,
  instanceRouteId,
  unresolvedServerId,
}: {
  instance: SidebarInstance | null
  instanceRouteId: string | null
  unresolvedServerId: string | undefined
}) {
  const items = instance ? destinationsForServer(instance) : serverDestinations
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
  canManageAccess,
  user,
}: {
  canManageAccess: boolean
  user: AuthenticatedUser
}) {
  const { isMobile, state } = useSidebar()
  return (
    <SidebarFooter>
      <SidebarGroup className="p-0">
        <SidebarGroupLabel className="type-technical-label">
          Manage
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
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
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Backups">
                <Link
                  to="/backups"
                  activeOptions={{ exact: true, includeSearch: false }}
                  activeProps={{ "data-active": true }}
                  preload="intent"
                >
                  <BackupIcon />
                  <span>Backups</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
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
            <SidebarMenuItem>
              {canManageAccess ? <AccessNavigationButton /> : null}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarSeparator />
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

const AccountAvatar = React.memo(function AccountAvatar({
  name,
}: {
  name: string
}) {
  const { data: profile } = useQuery(minecraftProfileQueryOptions(name))

  return (
    <Avatar size="sm" className="rounded-none">
      {profile ? (
        <AvatarImage
          src={minecraftHeadUrl(profile.id)}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : null}
      <AvatarFallback className="type-label rounded-none bg-primary/12 font-bold text-primary">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
})

function CollapsedAccountMenu({ user }: { user: AuthenticatedUser }) {
  const [open, setOpen] = React.useState(false)
  const [signingOut, setSigningOut] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="grid size-[32px] place-items-center transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
          aria-label={`Open account menu for ${user.name}`}
        >
          <AccountAvatar name={user.name} />
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

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("")
}

function statusDotTone(state: SidebarInstance["observedState"]): string {
  if (state === "running") return "bg-emerald-400"
  if (state === "failed") return "bg-destructive"
  if (state === "starting" || state === "provisioning") {
    return "bg-amber-400"
  }
  if (state === "stopping") return "bg-amber-400/70"
  return "bg-muted-foreground/45"
}

function serverStatusLabel(state: SidebarInstance["observedState"]): string {
  if (state === "running") return "Running"
  if (state === "failed") return "Failed"
  if (state === "starting") return "Starting"
  if (state === "provisioning") return "Provisioning"
  if (state === "stopping") return "Stopping"
  return "Stopped"
}

function globalSectionFromPathname(pathname: string): GlobalSection {
  if (pathname === "/infra" || pathname.startsWith("/infra/")) return "infra"
  if (pathname === "/automations" || pathname.startsWith("/automations/")) {
    return "automations"
  }
  if (pathname === "/backups") return "backups"
  if (pathname === "/access") return "access"
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
