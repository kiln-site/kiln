import * as React from "react"
import { eq, not } from "@tanstack/db"
import { useDbClient, useLiveQuery } from "@tanstack/react-db"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  EllipsisVertical,
  Folder,
  ListTodo,
  Plus,
  RefreshCw,
  Server,
  TerminalSquare,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { builtinTailscaleBrickId } from "@workspace/contracts"

import {
  AddServerDialogHost,
  createAddServerDialogStore,
} from "@/components/add-server-dialog"
import type { AddServerDialogStore } from "@/components/add-server-dialog"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import { DataTableEmptyState, DataTableTextCell } from "@/components/data-table"
import {
  ServerDeleteDialog,
  type ServerDeleteTarget,
} from "@/components/server-delete-dialog"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { DataTableView } from "@/components/data-table-view"
import { InstanceName } from "@/components/instance-name"
import {
  accessCapabilitiesQueryOptions,
  brickCatalogQueryOptions,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import {
  getRelayInstancesCollection,
  relayInstancesCollectionOptions,
} from "@/lib/collections/relay-instances"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import { type DataTableSearchStore } from "@/lib/data-table-search"
import {
  replaceDataTableRows,
  useLiveDataTableSource,
  type DataTableSource,
} from "@/lib/data-table-source"
import { roleHasPermission } from "@/lib/permissions"
import { selectRelayConfigured } from "@/lib/relay-selectors"
import type { ServerListInstance } from "@/lib/relay-selectors"

const minimumManualSyncFeedbackMs = 500
const serverInventoryError = new Error("Could not load servers")
const serverTableItemCache = new WeakMap<ServerListInstance, ServerTableItem>()
const serverTableVirtualization = { estimateRowHeight: 56, overscan: 8 }

interface ServerTableItem {
  routeIdentifier: string
  server: ServerListInstance
}

const serverTableColumnHelper = createDataTableColumnHelper<ServerTableItem>()
const serverTableSearchFields = [
  ({ server }: ServerTableItem) => server.name,
  ({ server }: ServerTableItem) => server.id,
  ({ server }: ServerTableItem) => server.shortId,
  ({ server }: ServerTableItem) => server.routeId,
  ({ server }: ServerTableItem) => server.game,
  ({ server }: ServerTableItem) => server.implementation,
  ({ server }: ServerTableItem) => server.version,
  ({ server }: ServerTableItem) => server.connectAddress,
  ({ server }: ServerTableItem) => server.relayId,
  ({ server }: ServerTableItem) => server.relayName,
  ({ server }: ServerTableItem) => server.relayStatus,
  ({ server }: ServerTableItem) => server.observedState,
] as const

interface ServerDeleteAccess {
  all: boolean
  instances: ReadonlySet<string>
  relays: ReadonlySet<string>
}

export type ServerSearchStore = DataTableSearchStore

export const ServersPage = React.memo(function ServersPage({
  canProvision,
  passwordRequired,
  searchStore,
}: {
  canProvision: boolean
  passwordRequired: boolean
  searchStore: ServerSearchStore
}) {
  const queryClient = useQueryClient()
  const [dialogStore] = React.useState(createAddServerDialogStore)
  const [deleteTarget, setDeleteTarget] =
    React.useState<ServerDeleteTarget | null>(null)
  const { data: relayConfigured } = useSuspenseQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConfigured,
  })
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const deleteAccess = React.useMemo<ServerDeleteAccess>(() => {
    const instances = new Set<string>()
    const relays = new Set<string>()
    for (const grant of capabilities.grants) {
      if (!roleHasPermission(grant.role, "instance.delete")) continue
      if (
        grant.resourceType === "relay" &&
        grant.resourceId === grant.relayId
      ) {
        relays.add(grant.relayId)
      } else if (grant.resourceType === "instance") {
        instances.add(`${grant.relayId}:${grant.resourceId}`)
      }
    }
    return {
      all: capabilities.isPlatformAdmin,
      instances,
      relays,
    }
  }, [capabilities.grants, capabilities.isPlatformAdmin])
  const openDelete = React.useCallback((target: ServerDeleteTarget) => {
    setDeleteTarget(target)
  }, [])

  React.useEffect(() => {
    if (canProvision) {
      void queryClient.prefetchQuery(brickCatalogQueryOptions())
    }
  }, [canProvision, queryClient])

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <DataTableWorkspace
        toolbar={
          <DataTableToolbar
            actions={
              <>
                <ActivityButton />
                <AddServerButton
                  canProvision={canProvision}
                  dialogStore={dialogStore}
                />
              </>
            }
            leading={<ServerSyncButton disabled={!relayConfigured} />}
            search={{
              ariaLabel: "Search servers",
              closeMobileWhenEmpty: true,
              id: "server-search",
              onValueChange: replaceServerSearch,
              placeholder: "Search servers",
              store: searchStore,
            }}
          />
        }
      >
        <FilteredServerTableBoundary
          canProvision={canProvision}
          deleteAccess={deleteAccess}
          dialogStore={dialogStore}
          onDelete={openDelete}
          relayConfigured={relayConfigured}
          searchStore={searchStore}
        />
      </DataTableWorkspace>
      {canProvision ? <AddServerDialogHost store={dialogStore} /> : null}
      {deleteTarget ? (
        <ServerDeleteDialog
          key={`${deleteTarget.relayId}:${deleteTarget.id}`}
          open
          target={deleteTarget}
          passwordRequired={passwordRequired}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
        />
      ) : null}
    </div>
  )
})

const ServerSyncButton = React.memo(function ServerSyncButton({
  disabled,
}: {
  disabled: boolean
}) {
  const dbClient = useDbClient()
  const instances = getRelayInstancesCollection(dbClient)
  const [manualSyncing, setManualSyncing] = React.useState(false)
  const manualSyncingRef = React.useRef(false)
  const feedbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)
  const syncing = manualSyncing

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (feedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(feedbackTimeoutRef.current)
      }
    }
  }, [])

  const syncServers = React.useCallback(() => {
    if (disabled || manualSyncingRef.current) return
    manualSyncingRef.current = true
    setManualSyncing(true)
    const startedAt = performance.now()

    forkPromise(() =>
      ensuringPromise(
        () => instances.utils.refetch({ throwOnError: true }),
        () => {
          if (!mountedRef.current) return
          const elapsed = performance.now() - startedAt
          const remaining = Math.max(0, minimumManualSyncFeedbackMs - elapsed)
          feedbackTimeoutRef.current = window.setTimeout(() => {
            manualSyncingRef.current = false
            setManualSyncing(false)
            feedbackTimeoutRef.current = undefined
          }, remaining)
        }
      )
    )
  }, [disabled, instances])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync servers"
          aria-busy={syncing}
          disabled={disabled || syncing}
          onClick={syncServers}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync servers
      </TooltipContent>
    </Tooltip>
  )
})

const ActivityButton = React.memo(function ActivityButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" className="px-2 sm:px-2.5">
          <Link to="/activity" aria-label="Server activity">
            <ListTodo />
            <span className="hidden sm:inline">Activity</span>
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Server activity
      </TooltipContent>
    </Tooltip>
  )
})

const AddServerButton = React.memo(function AddServerButton({
  canProvision,
  dialogStore,
}: {
  canProvision: boolean
  dialogStore: AddServerDialogStore
}) {
  if (canProvision) {
    return (
      <Button type="button" onClick={dialogStore.open}>
        <Plus /> Add Server
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" disabled>
          <Plus /> Add Server
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Server provisioning requires administrator access
      </TooltipContent>
    </Tooltip>
  )
})

const FilteredServerTableBoundary = React.memo(
  function FilteredServerTableBoundary({
    canProvision,
    deleteAccess,
    dialogStore,
    onDelete,
    relayConfigured,
    searchStore,
  }: {
    canProvision: boolean
    deleteAccess: ServerDeleteAccess
    dialogStore: AddServerDialogStore
    onDelete: (target: ServerDeleteTarget) => void
    relayConfigured: boolean
    searchStore: ServerSearchStore
  }) {
    const dbClient = useDbClient()
    const result = useLiveQuery({
      query: (query) => {
        if (!relayConfigured) return undefined
        return query
          .from({ instance: relayInstancesCollectionOptions })
          .where(({ instance }) =>
            not(eq(instance.brickId, builtinTailscaleBrickId))
          )
          .select(({ instance }) => ({
            brickId: instance.brickId,
            connectAddress: instance.connectAddress,
            game: instance.game,
            id: instance.id,
            implementation: instance.implementation,
            name: instance.name,
            observedState: instance.observedState,
            provisioning: instance.provisioning,
            relayId: instance.relayId,
            relayName: instance.relayName,
            relayStatus: instance.relayStatus,
            routeId: instance.routeId,
            shortId: instance.shortId,
            version: instance.version,
          }))
      },
    })
    const retry = React.useCallback(() => {
      forkPromise(() =>
        getRelayInstancesCollection(dbClient).utils.refetch({
          throwOnError: true,
        })
      )
    }, [dbClient])
    const liveSource = useLiveDataTableSource<ServerListInstance>({
      data: result.data,
      error: serverInventoryError,
      isError: result.isError,
      isLoading: result.isLoading,
      retry,
    })
    const items = React.useMemo(
      () => createServerTableItems(liveSource.rows),
      [liveSource.rows]
    )
    const source = React.useMemo(
      () => replaceDataTableRows(liveSource, items),
      [items, liveSource]
    )

    return (
      <ServerDataTable
        canProvision={canProvision}
        deleteAccess={deleteAccess}
        dialogStore={dialogStore}
        onDelete={onDelete}
        searchStore={searchStore}
        source={source}
      />
    )
  }
)

const ServerDataTable = React.memo(function ServerDataTable({
  canProvision,
  deleteAccess,
  dialogStore,
  onDelete,
  searchStore,
  source,
}: {
  canProvision: boolean
  deleteAccess: ServerDeleteAccess
  dialogStore: AddServerDialogStore
  onDelete: (target: ServerDeleteTarget) => void
  searchStore: ServerSearchStore
  source: DataTableSource<ServerTableItem>
}) {
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "server" }],
  }))
  const definition = React.useMemo(() => {
    const columns = serverTableColumnHelper.columns([
      serverTableColumnHelper.accessor(
        ({ server }) => serverStatus(server).label,
        {
          id: "status",
          header: () => <span className="sr-only sm:not-sr-only">Status</span>,
          sortFn: "text",
          cell: ({ row }) => <ServerStatus server={row.original.server} />,
          meta: dataTableColumnMeta(
            { width: { base: "2.5rem", sm: "6.5rem" } },
            {
              cellClassName: "px-2 sm:px-3",
              headerClassName: "px-2 sm:px-3",
              headerLabelClassName: "shrink-0 overflow-visible text-clip",
            }
          ),
        }
      ),
      serverTableColumnHelper.accessor(({ server }) => server.name, {
        id: "server",
        header: "Server",
        sortFn: "text",
        cell: ({ row }) => {
          const { routeIdentifier, server } = row.original
          return (
            <Link
              to="/server/$serverId/console"
              params={{ serverId: routeIdentifier }}
              preload="intent"
              className="group/server-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
            >
              <InstanceName
                instance={{
                  id: server.id,
                  kind: "server",
                  observedState: server.observedState,
                  relayId: server.relayId,
                  relayStatus: server.relayStatus,
                }}
                name={server.name}
                nameClassName="transition-colors group-hover/server-link:text-primary"
                meta={`${server.game} · ${server.implementation}`}
                metaClassName="font-mono"
              />
            </Link>
          )
        },
        meta: dataTableColumnMeta(
          {
            width: {
              base: "minmax(0,1fr)",
              md: "minmax(0,1.2fr)",
            },
          },
          { cellClassName: "px-0" }
        ),
      }),
      serverTableColumnHelper.accessor(({ server }) => server.relayName, {
        id: "relay",
        header: "Relay",
        sortFn: "text",
        cell: ({ row }) => (
          <DataTableTextCell value={row.original.server.relayName} />
        ),
        meta: dataTableColumnMeta({
          hideBelow: "md",
          width: "minmax(0,0.8fr)",
        }),
      }),
      serverTableColumnHelper.accessor(({ server }) => server.connectAddress, {
        id: "address",
        header: "Host / IP",
        sortFn: "text",
        cell: ({ row }) => {
          const address = row.original.server.connectAddress
          return (
            <DataTableTextCell
              className={
                address.startsWith("Error:")
                  ? "font-semibold text-destructive"
                  : undefined
              }
              monospace
              title={address}
              value={address.startsWith("Error:") ? "ERROR" : address}
            />
          )
        },
        meta: dataTableColumnMeta({
          hideBelow: "xl",
          width: "minmax(12rem,1fr)",
        }),
      }),
      serverTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const { routeIdentifier, server } = row.original
          return (
            <ServerActions
              canDelete={canDeleteServer(deleteAccess, server)}
              onDelete={onDelete}
              routeIdentifier={routeIdentifier}
              server={server}
            />
          )
        },
        meta: dataTableColumnMeta(
          { width: { base: "8.5rem", sm: "9.5rem" } },
          {
            cellClassName: "px-1 sm:px-3",
            headerClassName: "px-1 sm:px-3",
          }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Servers",
      columns,
      getRowClassName: serverTableRowClassName,
      model: {
        getRowId: serverTableItemKey,
        initialState: initialTableState,
      },
      search: { fields: serverTableSearchFields },
      virtualization: serverTableVirtualization,
    })
  }, [deleteAccess, initialTableState, onDelete])
  return (
    <DataTableView
      definition={definition}
      emptyState={({ searchActive }) => (
        <EmptyServerTable
          canProvision={canProvision}
          dialogStore={dialogStore}
          searchActive={searchActive}
        />
      )}
      searchStore={searchStore}
      source={source}
    />
  )
})

const ServerActions = React.memo(function ServerActions({
  canDelete,
  onDelete,
  routeIdentifier,
  server,
}: {
  canDelete: boolean
  onDelete: (target: ServerDeleteTarget) => void
  routeIdentifier: string
  server: ServerListInstance
}) {
  const deleteEnabled = server.relayStatus === "connected"
  return (
    <div className="flex items-center justify-end gap-1">
      <ServerActionLink
        icon={TerminalSquare}
        label={`Open ${server.name} console`}
        routeIdentifier={routeIdentifier}
        tab="console"
        tooltip="Console"
      />
      <ServerActionLink
        icon={Folder}
        label={`Open ${server.name} files`}
        routeIdentifier={routeIdentifier}
        tab="files"
        tooltip="Files"
      />
      {canDelete ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${server.name}`}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={!deleteEnabled}
              onClick={() =>
                onDelete({
                  backupAvailable: !server.provisioning,
                  id: server.id,
                  name: server.name,
                  relayId: server.relayId,
                })
              }
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {deleteEnabled ? "Delete" : "Relay unavailable"}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`More actions for ${server.name}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <CopyIdentifierMenuItem label="Server ID" value={server.id} />
          <CopyIdentifierMenuItem
            label="Relay ID"
            value={server.relayId}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

const ServerActionLink = React.memo(function ServerActionLink({
  icon: Icon,
  label,
  routeIdentifier,
  tab,
  tooltip,
}: {
  icon: typeof TerminalSquare
  label: string
  routeIdentifier: string
  tab: "console" | "files"
  tooltip: string
}) {
  const link =
    tab === "files" ? (
      <Link
        to="/server/$serverId/files/$"
        params={{ serverId: routeIdentifier, _splat: "" }}
        preload="intent"
        aria-label={label}
      >
        <Icon />
      </Link>
    ) : (
      <Link
        to={`/server/$serverId/${tab}`}
        params={{ serverId: routeIdentifier }}
        preload="intent"
        aria-label={label}
      >
        <Icon />
      </Link>
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-primary"
        >
          {link}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
})

function canDeleteServer(
  access: ServerDeleteAccess,
  server: ServerListInstance
): boolean {
  if (server.brickId === builtinTailscaleBrickId) return false
  return (
    access.all ||
    access.relays.has(server.relayId) ||
    access.instances.has(`${server.relayId}:${server.id}`)
  )
}

function ServerStatus({ server }: { server: ServerListInstance }) {
  const status = serverStatus(server)
  return (
    <span
      aria-label={status.label}
      className={`type-label inline-flex items-center gap-1.5 ${status.text}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
      <span className="hidden sm:inline">{status.label}</span>
    </span>
  )
}

function serverStatus(server: ServerListInstance) {
  return server.relayStatus === "unreachable"
    ? {
        dot: "bg-destructive",
        label: "Relay unavailable",
        text: "text-destructive",
      }
    : serverStatusTone(server.observedState)
}

function EmptyServerTable({
  canProvision,
  dialogStore,
  searchActive,
}: {
  canProvision: boolean
  dialogStore: AddServerDialogStore
  searchActive: boolean
}) {
  return (
    <DataTableEmptyState
      action={
        !searchActive && canProvision ? (
          <Button type="button" size="sm" onClick={dialogStore.open}>
            <Plus /> Add Server
          </Button>
        ) : null
      }
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a server name, short ID, Relay, address, game, implementation, or version."
            : canProvision
              ? "Provision the first game server managed by Hearth."
              : "No server instances have been assigned to your account yet."}
        </span>
      }
      icon={<Server className="size-6 text-muted-foreground/45" />}
      title={
        searchActive ? "No servers match your search" : "No managed servers"
      }
    />
  )
}

function serverRowKey(server: ServerListInstance): string {
  return `${server.relayId}:${server.id}`
}

function serverTableItemKey(item: ServerTableItem): string {
  return serverRowKey(item.server)
}

function createServerTableItems(
  servers: Array<ServerListInstance>
): Array<ServerTableItem> {
  const shortIdCounts = new Map<string, number>()
  for (const server of servers) {
    shortIdCounts.set(
      server.shortId,
      (shortIdCounts.get(server.shortId) ?? 0) + 1
    )
  }

  return servers.map((server) => {
    const routeIdentifier =
      shortIdCounts.get(server.shortId) === 1 ? server.shortId : server.routeId
    const cached = serverTableItemCache.get(server)
    if (cached?.routeIdentifier === routeIdentifier) return cached

    const item = { routeIdentifier, server }
    serverTableItemCache.set(server, item)
    return item
  })
}

function serverTableRowClassName() {
  return "group hover:bg-muted/20"
}

function replaceServerSearch(search: string) {
  const url = new URL(window.location.href)
  if (search.length > 0) url.searchParams.set("search", search)
  else url.searchParams.delete("search")

  // TanStack patches the history instance methods so router consumers update
  // after navigation. Search typing is intentionally local to this workspace;
  // use the browser prototype method to update the current entry without
  // repainting the router's SafeFragment and CatchBoundary tree.
  History.prototype.replaceState.call(
    window.history,
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  )
}

function serverStatusTone(state: ServerListInstance["observedState"]) {
  if (state === "running") {
    return {
      dot: "bg-emerald-400",
      label: "Running",
      text: "text-emerald-300",
    }
  }
  if (state === "failed") {
    return {
      dot: "bg-destructive",
      label: "Failed",
      text: "text-destructive",
    }
  }
  if (state === "starting" || state === "provisioning") {
    return {
      dot: "bg-amber-400",
      label: state === "starting" ? "Starting" : "Provisioning",
      text: "text-amber-300",
    }
  }
  if (state === "stopping") {
    return {
      dot: "bg-amber-400/70",
      label: "Stopping",
      text: "text-amber-300",
    }
  }
  return {
    dot: "bg-muted-foreground/50",
    label: "Stopped",
    text: "text-muted-foreground",
  }
}
