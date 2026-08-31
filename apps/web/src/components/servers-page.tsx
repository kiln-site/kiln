import * as React from "react"
import { eq, not } from "@tanstack/db"
import { useDbClient, useLiveQuery } from "@tanstack/react-db"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  Copy,
  EllipsisVertical,
  Folder,
  ListTodo,
  Plus,
  RefreshCw,
  Search,
  Server,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
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
import {
  ServerDeleteDialog,
  type ServerDeleteTarget,
} from "@/components/server-delete-dialog"
import { DataTable } from "@/components/data-table"
import { InstanceName } from "@/components/instance-name"
import {
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import {
  accessCapabilitiesQueryOptions,
  brickCatalogQueryOptions,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import {
  getRelayInstancesCollection,
  relayInstancesCollectionOptions,
} from "@/lib/collections/relay-instances"
import { createDataTableColumnHelper, useDataTable } from "@/lib/data-table"
import { roleHasPermission } from "@/lib/permissions"
import { selectRelayConfigured } from "@/lib/relay-selectors"
import type { ServerListInstance } from "@/lib/relay-selectors"

const emptyServers: Array<ServerListInstance> = []
const minimumManualSyncFeedbackMs = 500
const serverInventoryError = new Error("Could not load servers")
const serverTableGridClassName =
  "grid-cols-[2.5rem_minmax(0,1fr)_8.25rem] sm:grid-cols-[6rem_minmax(0,1fr)_9.25rem] md:grid-cols-[6rem_minmax(0,1.2fr)_minmax(0,0.8fr)_9.25rem] xl:grid-cols-[6rem_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(12rem,1fr)_9.25rem]"
const serverTableItemCache = new WeakMap<ServerListInstance, ServerTableItem>()
const serverTableVirtualization = { estimateRowHeight: 56, overscan: 8 }

interface ServerTableItem {
  routeIdentifier: string
  searchText: string
  server: ServerListInstance
}

const serverTableColumnHelper = createDataTableColumnHelper<ServerTableItem>()

interface ServerDeleteAccess {
  all: boolean
  instances: ReadonlySet<string>
  relays: ReadonlySet<string>
}

export type ServerSearchStore = WorkspaceTableSearchStore

export function createServerSearchStore(
  initialValue: string
): ServerSearchStore {
  return createWorkspaceTableSearchStore(initialValue)
}

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
      <section
        data-slot="servers-workspace"
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card/45 [contain:paint]"
      >
        <ServerToolbar
          canProvision={canProvision}
          dialogStore={dialogStore}
          relayConfigured={relayConfigured}
          searchStore={searchStore}
        />
        <FilteredServerTableBoundary
          canProvision={canProvision}
          deleteAccess={deleteAccess}
          dialogStore={dialogStore}
          onDelete={openDelete}
          relayConfigured={relayConfigured}
          searchStore={searchStore}
        />
      </section>
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

const ServerToolbar = React.memo(function ServerToolbar({
  canProvision,
  dialogStore,
  relayConfigured,
  searchStore,
}: {
  canProvision: boolean
  dialogStore: AddServerDialogStore
  relayConfigured: boolean
  searchStore: ServerSearchStore
}) {
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(
    () => searchStore.getSnapshot().length > 0
  )
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const handleSearchEmpty = React.useCallback((value: string) => {
    if (value.length === 0) setMobileSearchOpen(false)
  }, [])

  React.useEffect(() => {
    if (mobileSearchOpen) searchInputRef.current?.focus()
  }, [mobileSearchOpen])

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <ServerSyncButton disabled={!relayConfigured} />

      {!mobileSearchOpen ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Search servers"
              aria-controls="server-search"
              aria-expanded={false}
              className="sm:hidden"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Search servers
          </TooltipContent>
        </Tooltip>
      ) : null}

      <div
        className={`${mobileSearchOpen ? "block" : "hidden"} min-w-0 flex-1 sm:block sm:max-w-md`}
      >
        <ServerSearchInput
          inputRef={searchInputRef}
          store={searchStore}
          onSearchEmpty={handleSearchEmpty}
        />
      </div>

      {mobileSearchOpen ? (
        <ClearMobileSearchButton
          searchStore={searchStore}
          onClose={() => setMobileSearchOpen(false)}
        />
      ) : null}

      <div
        className={`${mobileSearchOpen ? "hidden sm:flex" : "flex"} ml-auto shrink-0 items-center gap-2`}
      >
        <ActivityButton />
        <AddServerButton
          canProvision={canProvision}
          dialogStore={dialogStore}
        />
      </div>
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

function ClearMobileSearchButton({
  searchStore,
  onClose,
}: {
  searchStore: ServerSearchStore
  onClose: () => void
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="Close server search"
      className="sm:hidden"
      onClick={() => {
        onClose()
        searchStore.set("")
        replaceServerSearch("")
      }}
    >
      <X />
    </Button>
  )
}

const ServerSearchInput = React.memo(function ServerSearchInput({
  inputRef,
  store,
  onSearchEmpty,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  store: ServerSearchStore
  onSearchEmpty: (value: string) => void
}) {
  useWorkspaceTableSearchInput(inputRef, store)

  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        id="server-search"
        type="search"
        defaultValue={store.getServerSnapshot()}
        onChange={(event) => {
          const value = event.currentTarget.value
          store.set(value)
          onSearchEmpty(value)
          replaceServerSearch(value)
        }}
        placeholder="Search servers"
        aria-label="Search servers"
        className="pl-9 text-base md:text-sm"
      />
    </div>
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

const ServerTableSearchBoundary = React.memo(
  function ServerTableSearchBoundary({
    canProvision,
    deleteAccess,
    dialogStore,
    error,
    loading,
    onDelete,
    onRetry,
    searchStore,
    servers,
    updating,
  }: {
    canProvision: boolean
    deleteAccess: ServerDeleteAccess
    dialogStore: AddServerDialogStore
    error?: Error | null
    loading: boolean
    onDelete: (target: ServerDeleteTarget) => void
    onRetry: () => void
    searchStore: ServerSearchStore
    servers: Array<ServerListInstance>
    updating: boolean
  }) {
    const search = React.useSyncExternalStore(
      searchStore.subscribe,
      searchStore.getNormalizedSnapshot,
      searchStore.getNormalizedServerSnapshot
    )
    const items = React.useMemo(
      () => createServerTableItems(servers),
      [servers]
    )
    const visibleItems = React.useMemo(
      () =>
        search.length === 0
          ? items
          : items.filter((item) => item.searchText.includes(search)),
      [items, search]
    )

    return (
      <ServerDataTable
        canProvision={canProvision}
        deleteAccess={deleteAccess}
        dialogStore={dialogStore}
        error={error}
        items={visibleItems}
        loading={loading}
        onDelete={onDelete}
        onRetry={onRetry}
        scrollResetKey={search}
        searchActive={search.length > 0}
        updating={updating}
      />
    )
  }
)

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

    return (
      <ServerTableSearchBoundary
        canProvision={canProvision}
        deleteAccess={deleteAccess}
        dialogStore={dialogStore}
        error={result.isError ? serverInventoryError : null}
        loading={result.isLoading && !result.isReady}
        onDelete={onDelete}
        onRetry={retry}
        searchStore={searchStore}
        servers={result.data ?? emptyServers}
        updating={result.isLoading && result.isReady}
      />
    )
  }
)

const ServerDataTable = React.memo(function ServerDataTable({
  canProvision,
  deleteAccess,
  dialogStore,
  error,
  items,
  loading,
  onDelete,
  onRetry,
  scrollResetKey,
  searchActive,
  updating,
}: {
  canProvision: boolean
  deleteAccess: ServerDeleteAccess
  dialogStore: AddServerDialogStore
  error?: Error | null
  items: Array<ServerTableItem>
  loading: boolean
  onDelete: (target: ServerDeleteTarget) => void
  onRetry: () => void
  scrollResetKey: string
  searchActive: boolean
  updating: boolean
}) {
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "server" }],
  }))
  const columns = React.useMemo(
    () =>
      serverTableColumnHelper.columns([
        serverTableColumnHelper.accessor(
          ({ server }) => serverStatus(server).label,
          {
            id: "status",
            header: () => (
              <span className="sr-only sm:not-sr-only">Status</span>
            ),
            sortFn: "text",
            cell: ({ row }) => <ServerStatus server={row.original.server} />,
            meta: {
              cellClassName: "px-2 sm:px-3",
              headerClassName: "px-2 sm:px-3",
            },
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
          meta: { cellClassName: "px-0" },
        }),
        serverTableColumnHelper.accessor(({ server }) => server.relayName, {
          id: "relay",
          header: "Relay",
          sortFn: "text",
          cell: ({ row }) => (
            <span
              className="type-meta truncate text-foreground"
              title={row.original.server.relayName}
            >
              {row.original.server.relayName}
            </span>
          ),
          meta: {
            cellClassName: "hidden md:flex",
            headerClassName: "hidden md:flex md:items-center",
          },
        }),
        serverTableColumnHelper.accessor(
          ({ server }) => server.connectAddress,
          {
            id: "address",
            header: "Host / IP",
            sortFn: "text",
            cell: ({ row }) => {
              const address = row.original.server.connectAddress
              return (
                <span
                  className={`type-meta block truncate font-mono ${
                    address.startsWith("Error:")
                      ? "font-semibold text-destructive"
                      : "text-foreground"
                  }`}
                  title={address}
                >
                  {address.startsWith("Error:") ? "ERROR" : address}
                </span>
              )
            },
            meta: {
              cellClassName: "hidden xl:flex",
              headerClassName: "hidden xl:flex xl:items-center",
            },
          }
        ),
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
          meta: {
            cellClassName: "px-1 sm:px-3",
            headerClassName: "px-1 sm:px-3",
          },
        }),
      ]),
    [deleteAccess, onDelete]
  )
  const table = useDataTable(
    {
      columns,
      data: items,
      getRowId: serverTableItemKey,
      initialState: initialTableState,
    },
    selectNoServerTableState
  )
  const [sortingResetKey, setSortingResetKey] = React.useState("server:asc")

  React.useLayoutEffect(() => {
    const subscription = table.atoms.sorting.subscribe((sorting) => {
      const next = sorting
        .map(({ desc, id }) => `${id}:${desc ? "desc" : "asc"}`)
        .join("|")
      setSortingResetKey((current) => (current === next ? current : next))
    })
    return () => subscription.unsubscribe()
  }, [table])

  return (
    <DataTable
      ariaLabel="Servers"
      emptyState={
        <EmptyServerTable
          canProvision={canProvision}
          dialogStore={dialogStore}
          searchActive={searchActive}
        />
      }
      error={error}
      getRowClassName={serverTableRowClassName}
      gridClassName={serverTableGridClassName}
      loading={loading}
      loadingRowCount={8}
      onRetry={onRetry}
      scrollResetKey={`${scrollResetKey}\n${sortingResetKey}`}
      table={table}
      updating={updating}
      virtualization={serverTableVirtualization}
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
        <Tooltip>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            More actions
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-44">
          <CopyServerIdentifierMenuItem label="server ID" value={server.id} />
          <CopyServerIdentifierMenuItem
            label="Relay ID"
            value={server.relayId}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

const CopyServerIdentifierMenuItem = React.memo(
  function CopyServerIdentifierMenuItem({
    label,
    value,
  }: {
    label: "server ID" | "Relay ID"
    value: string
  }) {
    const copyIdentifier = React.useCallback(() => {
      forkPromise(
        async () => {
          await navigator.clipboard.writeText(value)
          showToast({
            message: `${label === "server ID" ? "Server ID" : label} copied`,
            type: "success",
          })
        },
        () =>
          showToast({
            message: `Could not copy ${label}`,
            type: "error",
          })
      )
    }, [label, value])

    return (
      <DropdownMenuItem onSelect={copyIdentifier}>
        <Copy /> Copy {label}
      </DropdownMenuItem>
    )
  }
)

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
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Server className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">
        {searchActive ? "No servers match your search" : "No managed servers"}
      </p>
      <p className="type-support mt-1 max-w-sm text-muted-foreground">
        {searchActive
          ? "Try a server name, short ID, Relay, address, game, implementation, or version."
          : canProvision
            ? "Provision the first game server managed by Hearth."
            : "No server instances have been assigned to your account yet."}
      </p>
      {!searchActive && canProvision ? (
        <Button
          type="button"
          size="sm"
          className="mt-4"
          onClick={dialogStore.open}
        >
          <Plus /> Add Server
        </Button>
      ) : null}
    </div>
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

    const item = {
      routeIdentifier,
      searchText: serverSearchText(server),
      server,
    }
    serverTableItemCache.set(server, item)
    return item
  })
}

function serverTableRowClassName() {
  return "group hover:bg-muted/20"
}

function selectNoServerTableState() {
  return undefined
}

function serverSearchText(server: ServerListInstance): string {
  return [
    server.name,
    server.id,
    server.shortId,
    server.routeId,
    server.game,
    server.implementation,
    server.version,
    server.connectAddress,
    server.relayId,
    server.relayName,
    server.relayStatus,
    server.observedState,
  ]
    .join(" ")
    .toLowerCase()
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
