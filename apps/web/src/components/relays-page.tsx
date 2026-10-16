import {
  PendingResourceInvitations,
  PendingResourceInvitationBadge,
  resourceInvitationScopeKey,
} from "@/components/pending-resource-invitations"
import * as React from "react"
import { useLiveQuery } from "@tanstack/react-db"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  Check,
  CircleAlert,
  EllipsisVertical,
  Fingerprint,
  ListTodo,
  LoaderCircle,
  Plus,
  RefreshCw,
  ServerCog,
  Settings2,
  UserRound,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { forkPromise } from "@/effect/promise"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import {
  relayConnectionSettingsSchema,
  relayNameSchema,
  relayProxySettingsSchema,
} from "@workspace/contracts"

import {
  RelayDeleteButton,
  RelayPauseButton,
  invalidateRelayRuntimeQueries,
  messageFrom,
  showRelayError,
  updateRelayCache,
} from "@/components/relay/relay-actions"
import { relayLiveState } from "@/components/relay/relay-presentation"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  FavoritesOnlyButton,
  FavoritesOnlyEmptyState,
  InstanceFavoriteMenuItem,
  InstanceFavoriteToggle,
  useFavoritesOnly,
  useFavoritesOnlySource,
} from "@/components/instance-favorite"
import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableTextCell,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { IdentityName } from "@/components/identity-name"
import { InstanceName } from "@/components/instance-name"
import {
  relayStatusPresentation,
  statusColumnWidth,
  type RelayIdentityStatus,
} from "@/components/instance-name-presentation"
import { RelayMemoryCell } from "@/components/relay-memory-cell"
import { StatusIndicator } from "@/components/status-indicator"
import { UserAvatar } from "@/components/account-avatar"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import {
  minecraftUsernameKey,
  relayOwnerNamesKey,
  selectOwnerProfileIds,
} from "@/lib/minecraft-profile"
import { pairingFeedbackFrom } from "@/lib/relay-pairing-errors"
import { relayAddress } from "@/lib/relay-route"
import {
  accessCapabilitiesQueryOptions,
  queryKeys,
  relayConnectionQueryOptions,
  relayOwnerMinecraftProfilesQueryOptions,
  relayProxyQueryOptions,
  relaysQueryOptions,
  type RelayConnection,
} from "@/lib/query-options"
import type { InstanceFavorite } from "@/lib/instance-favorites"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  replaceDataTableUrlSearch,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import {
  useLiveDataTableSource,
  type DataTableSource,
} from "@/lib/data-table-source"
import {
  addRelay,
  checkRelay,
  previewRelayPairing,
  renameRelay,
  updateRelay,
  updateRelayProxy,
} from "@/server/relays"
import type { ManagedRelay } from "@/server/relays"

const invitationTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
})
const minimumRelaySyncFeedbackMs = 500
const relayInventoryError = new Error("Could not load Relays")
const noOwnerProfileIds: ReadonlyMap<string, string> = new Map()
// Owner cells read profiles from context so avatars never rebuild columns.
const RelayOwnerProfileIdsContext =
  React.createContext<ReadonlyMap<string, string>>(noOwnerProfileIds)

type RelayRegistryTableItem = Pick<
  ManagedRelay,
  | "enabled"
  | "hostname"
  | "id"
  | "lastError"
  | "name"
  | "nodeArch"
  | "nodePlatform"
  | "ownerEmail"
  | "ownerName"
  | "port"
  | "useTls"
>

type RelayReachability = "connected" | "paused" | "unreachable"
interface RelayConnectionStatus {
  id: string
  status: RelayReachability
  updating: boolean
}
const noRelayConnectionStates: ReadonlyArray<RelayConnectionStatus> = []

interface RelayTableItem extends RelayRegistryTableItem {
  relayStatus: RelayIdentityStatus
  updating: boolean
}

const relayTableItemCache = new WeakMap<
  RelayRegistryTableItem,
  Map<string, RelayTableItem>
>()

const relayTableColumnHelper = createDataTableColumnHelper<RelayTableItem>()
const relayTableSearchFields = [
  (relay: RelayTableItem) => relay.name,
  (relay: RelayTableItem) => relay.id,
  (relay: RelayTableItem) => relay.hostname,
  (relay: RelayTableItem) => relay.nodeArch,
  (relay: RelayTableItem) => relay.nodePlatform,
  (relay: RelayTableItem) => relay.ownerEmail,
  (relay: RelayTableItem) => relay.ownerName,
  (relay: RelayTableItem) => relayStatusPresentation(relay).label,
] as const

interface RelayEditView {
  enabled: boolean
  hostname: string
  id: string
  name: string
  port: number
  useTls: boolean
}

function selectRelayConnectionStates(
  connection: RelayConnection
): ReadonlyArray<RelayConnectionStatus> {
  return connection.status === "unconfigured"
    ? noRelayConnectionStates
    : connection.relays.map(({ id, status, updating }) => ({
        id,
        status,
        updating: updating === true,
      }))
}

function projectRelayTableItems(
  relays: ReadonlyArray<RelayRegistryTableItem> | undefined,
  relayStatuses: ReadonlyMap<string, RelayConnectionStatus>,
  missingStatus: "checking" | "unknown"
): Array<RelayTableItem> | undefined {
  return relays?.map((relay) => {
    const { relayStatus, updating } = relayLiveState(
      relay.enabled,
      relayStatuses.get(relay.id),
      missingStatus
    )
    let statusCache = relayTableItemCache.get(relay)
    if (!statusCache) {
      statusCache = new Map()
      relayTableItemCache.set(relay, statusCache)
    }
    const cacheKey = `${relayStatus}:${updating}`
    const cached = statusCache.get(cacheKey)
    if (cached) return cached
    const item = { ...relay, relayStatus, updating }
    statusCache.set(cacheKey, item)
    return item
  })
}

export const RelaysPage = React.memo(function RelaysPage({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  const [dialogStore] = React.useState(createRelayDialogStore)

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <DataTableWorkspace
        toolbar={
          <RelayToolbar searchStore={searchStore} onAdd={dialogStore.openAdd} />
        }
      >
        <FilteredRelayTable
          searchStore={searchStore}
          onAdd={dialogStore.openAdd}
          onEdit={dialogStore.openEdit}
        />
      </DataTableWorkspace>

      <RelayDialogHost store={dialogStore} />
    </div>
  )
})

type RelayDialogState =
  | { kind: "add" }
  | { kind: "closed" }
  | { kind: "edit"; relayId: string }

interface RelayDialogStore {
  close: () => void
  getServerSnapshot: () => RelayDialogState
  getSnapshot: () => RelayDialogState
  openAdd: () => void
  openEdit: (relayId: string) => void
  subscribe: (listener: () => void) => () => void
}

const closedRelayDialogState: RelayDialogState = { kind: "closed" }

function createRelayDialogStore(): RelayDialogStore {
  let state = closedRelayDialogState
  const listeners = new Set<() => void>()

  function publish(nextState: RelayDialogState) {
    if (nextState === state) return
    state = nextState
    for (const listener of listeners) listener()
  }

  return {
    close: () => publish(closedRelayDialogState),
    getServerSnapshot: () => closedRelayDialogState,
    getSnapshot: () => state,
    openAdd: () => publish({ kind: "add" }),
    openEdit: (relayId) => publish({ kind: "edit", relayId }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const RelayToolbar = React.memo(function RelayToolbar({
  searchStore,
  onAdd,
}: {
  searchStore: DataTableSearchStore
  onAdd: () => void
}) {
  return (
    <DataTableToolbar
      actions={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="outline" className="px-2 sm:px-2.5">
                <Link to="/activity" aria-label="Activity">
                  <ListTodo />
                  <span className="hidden sm:inline">Activity</span>
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Activity
            </TooltipContent>
          </Tooltip>
          <RelayAddButton onAdd={onAdd} />
        </>
      }
      controls={<FavoritesOnlyButton table="relays" />}
      leading={<RelaySyncButton />}
      search={{
        ariaLabel: "Search relays",
        closeMobileWhenEmpty: true,
        id: "relay-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search relays",
        store: searchStore,
      }}
    />
  )
})

const RelayAddButton = React.memo(function RelayAddButton({
  onAdd,
}: {
  onAdd: () => void
}) {
  const { data: canAddRelay } = useSuspenseQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectCanAddRelay,
  })
  if (!canAddRelay) return null
  return (
    <Button type="button" onClick={onAdd}>
      <Plus /> Add Relay
    </Button>
  )
})

const RelayDialogHost = React.memo(function RelayDialogHost({
  store,
}: {
  store: RelayDialogStore
}) {
  const state = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
  const selectEditingRelay = React.useCallback(
    (relays: Array<PersistedRelay>): RelayEditView | null => {
      if (state.kind !== "edit") return null
      const relay = relays.find((item) => item.id === state.relayId)
      return relay
        ? {
            enabled: relay.enabled,
            hostname: relay.hostname,
            id: relay.id,
            name: relay.name,
            port: relay.port,
            useTls: relay.useTls,
          }
        : null
    },
    [state]
  )
  const { data: editingRelay } = useSuspenseQuery({
    ...relaysQueryOptions(),
    select: selectEditingRelay,
  })

  return (
    <>
      <AddRelayDialog
        open={state.kind === "add"}
        onOpenChange={(open) => {
          if (!open) store.close()
        }}
      />
      {editingRelay ? (
        <EditRelayDialog
          key={editingRelay.id}
          relay={editingRelay}
          open
          onOpenChange={(open) => {
            if (!open) store.close()
          }}
        />
      ) : null}
    </>
  )
})

const FilteredRelayTable = React.memo(function FilteredRelayTable({
  searchStore,
  onAdd,
  onEdit,
}: {
  searchStore: DataTableSearchStore
  onAdd: () => void
  onEdit: (relayId: string) => void
}) {
  const queryClient = useQueryClient()
  const result = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .orderBy(({ relay }) => relay.name)
        .orderBy(({ relay }) => relay.createdAt)
        .select(({ relay }) => ({
          enabled: relay.enabled,
          hostname: relay.hostname,
          id: relay.id,
          lastError: relay.lastError,
          name: relay.name,
          nodeArch: relay.nodeArch,
          nodePlatform: relay.nodePlatform,
          ownerEmail: relay.ownerEmail,
          ownerName: relay.ownerName,
          port: relay.port,
          useTls: relay.useTls,
        })),
  })
  const connectionQuery = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    notifyOnChangeProps: ["data", "isPending"],
    select: selectRelayConnectionStates,
  })
  const connectionStates = connectionQuery.data ?? noRelayConnectionStates
  const ownerNames = React.useMemo(
    () => relayOwnerNamesKey(result.data),
    [result.data]
  )
  const relayStatuses = React.useMemo(
    () => new Map(connectionStates.map((relay) => [relay.id, relay])),
    [connectionStates]
  )
  const tableItems = React.useMemo(
    () =>
      projectRelayTableItems(
        result.data,
        relayStatuses,
        connectionQuery.isPending ? "checking" : "unknown"
      ),
    [connectionQuery.isPending, relayStatuses, result.data]
  )
  const retry = React.useCallback(() => {
    forkPromise(() =>
      queryClient.refetchQueries({ exact: true, queryKey: queryKeys.relays })
    )
  }, [queryClient])
  const source = useLiveDataTableSource<RelayTableItem>({
    data: tableItems,
    error: relayInventoryError,
    isError: result.isError,
    isLoading: result.isLoading,
    retry,
  })

  return (
    <RelayOwnerProfilesProvider ownerNames={ownerNames}>
      <RelayTable
        source={source}
        searchStore={searchStore}
        onAdd={onAdd}
        onEdit={onEdit}
      />
    </RelayOwnerProfilesProvider>
  )
})

/** Owns the avatar query so profile updates only reach owner cells. */
function RelayOwnerProfilesProvider({
  children,
  ownerNames,
}: {
  children: React.ReactNode
  ownerNames: string
}) {
  const { data: ownerProfileIds = noOwnerProfileIds } = useQuery({
    ...relayOwnerMinecraftProfilesQueryOptions(ownerNames),
    select: selectOwnerProfileIds,
  })
  return (
    <RelayOwnerProfileIdsContext.Provider value={ownerProfileIds}>
      {children}
    </RelayOwnerProfileIdsContext.Provider>
  )
}

const RelaySyncButton = React.memo(function RelaySyncButton() {
  const queryClient = useQueryClient()
  const [manualSyncing, setManualSyncing] = React.useState(false)
  const manualSyncingRef = React.useRef(false)
  const feedbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)
  const { data: hasEnabledRelay } = useSuspenseQuery({
    ...relaysQueryOptions(),
    select: selectHasEnabledRelay,
  })
  const syncRelays = useMutation({
    mutationFn: async () => {
      const relays =
        queryClient.getQueryData<Array<PersistedRelay>>(queryKeys.relays) ?? []
      const checks: Array<ReturnType<typeof checkRelay>> = []
      for (const relay of relays) {
        if (relay.enabled) checks.push(checkRelay({ data: { id: relay.id } }))
      }
      const checkedRelays = await Promise.all(checks)
      updateRelayCache(queryClient, checkedRelays)
    },
    onError: (cause) => showRelayError(cause, "Could not sync Relays"),
  })
  const syncing = manualSyncing || syncRelays.isPending

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (feedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(feedbackTimeoutRef.current)
      }
    }
  }, [])

  const sync = React.useCallback(() => {
    if (!hasEnabledRelay || manualSyncingRef.current) return
    manualSyncingRef.current = true
    setManualSyncing(true)
    const startedAt = performance.now()

    syncRelays.mutate(undefined, {
      onSettled: () => {
        if (!mountedRef.current) return
        const elapsed = performance.now() - startedAt
        const remaining = Math.max(0, minimumRelaySyncFeedbackMs - elapsed)
        feedbackTimeoutRef.current = window.setTimeout(() => {
          manualSyncingRef.current = false
          setManualSyncing(false)
          feedbackTimeoutRef.current = undefined
        }, remaining)
      },
    })
  }, [hasEnabledRelay, syncRelays])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync relays"
          aria-busy={syncing}
          disabled={syncing || !hasEnabledRelay}
          onClick={sync}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync relays
      </TooltipContent>
    </Tooltip>
  )
})

function RelayTable({
  searchStore,
  source,
  onAdd,
  onEdit,
}: {
  searchStore: DataTableSearchStore
  source: DataTableSource<RelayTableItem>
  onAdd: () => void
  onEdit: (relayId: string) => void
}) {
  const [favoritesOnly] = useFavoritesOnly("relays")
  const visibleSource = useFavoritesOnlySource(
    source,
    favoritesOnly,
    relayFavorite
  )
  const favoritesFiltered = favoritesOnly && source.rows.length > 0
  const visibleResourceKeys = React.useMemo(
    () =>
      new Set(
        visibleSource.rows.map((relay) =>
          resourceInvitationScopeKey(relay.id, relay.id)
        )
      ),
    [visibleSource.rows]
  )
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "relay" }],
  }))
  const definition = React.useMemo(() => {
    const columns = relayTableColumnHelper.columns([
      relayTableColumnHelper.accessor(
        (relay) => relayStatusPresentation(relay).label,
        {
          id: "status",
          header: () => <span className="sr-only sm:not-sr-only">Status</span>,
          sortFn: "text",
          cell: ({ row }) => (
            <StatusIndicator status={relayStatusPresentation(row.original)} />
          ),
          meta: dataTableColumnMeta(
            { width: { base: "2.5rem", sm: statusColumnWidth } },
            {
              cellClassName: "px-2 sm:px-3",
              headerClassName: "px-2 sm:px-3",
              headerLabelClassName: "shrink-0 overflow-visible text-clip",
            }
          ),
        }
      ),
      relayTableColumnHelper.display({
        id: "favorite",
        header: () => <span className="sr-only">Favorite</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <InstanceFavoriteToggle
            id={row.original.id}
            kind="relay"
            name={row.original.name}
            relayId={row.original.id}
          />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "1.75rem" } },
          { cellClassName: "px-0", headerClassName: "px-0" }
        ),
      }),
      relayTableColumnHelper.accessor((relay) => relay.name, {
        id: "relay",
        header: "Relay",
        sortFn: "text",
        cell: ({ row }) => {
          const relay = row.original
          return (
            <div className="flex w-full min-w-0 items-center gap-1">
              <Link
                to="/relay/$relayId"
                // The full ID always resolves; the route shortens it when no
                // other Relay shares its short ID.
                params={{ relayId: relay.id }}
                preload="intent"
                className="group/relay-link flex min-h-14 min-w-0 flex-1 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
              >
                <InstanceName
                  className="min-w-0 flex-1"
                  instance={{
                    enabled: relay.enabled,
                    id: relay.id,
                    kind: "relay",
                    relayId: relay.id,
                    relayStatus: relay.relayStatus,
                    source: "registry",
                    updating: relay.updating,
                  }}
                  live={false}
                  meta={
                    <span title={relay.id}>
                      {relay.nodeArch ?? "unknown"} <span aria-hidden>•</span>{" "}
                      {shortRelayId(relay.id)}
                    </span>
                  }
                  metaClassName="font-mono"
                  name={relay.name}
                  nameClassName="transition-colors group-hover/relay-link:text-primary"
                  showFavorite={false}
                />
              </Link>
              <PendingResourceInvitationBadge
                resourceType="relay"
                relayId={relay.id}
                resourceId={relay.id}
              />
            </div>
          )
        },
        meta: dataTableColumnMeta({
          width: {
            base: "minmax(0,1fr)",
            // Fit the icon, architecture, and short ID; long names truncate.
            lg: "12rem",
          },
        }),
      }),
      relayTableColumnHelper.display({
        id: "memory",
        header: "Memory",
        enableSorting: false,
        cell: ({ row }) => (
          <RelayMemoryCell
            connected={row.original.relayStatus === "connected"}
            relayId={row.original.id}
          />
        ),
        meta: dataTableColumnMeta({
          hideBelow: "lg",
          width: "7.5rem",
        }),
      }),
      relayTableColumnHelper.accessor((relay) => relay.hostname, {
        id: "host",
        header: "Host / IP",
        sortFn: "text",
        cell: ({ row }) => {
          const relay = row.original
          return (
            <DataTableTextCell
              monospace
              title={relayAddress(relay)}
              value={relay.hostname}
            />
          )
        },
        meta: dataTableColumnMeta({
          hideBelow: "lg",
          width: "minmax(0,1fr)",
        }),
      }),
      relayTableColumnHelper.accessor(
        (relay) =>
          `${relay.ownerName ?? "Unassigned"} ${relay.ownerEmail ?? ""}`,
        {
          id: "owner",
          header: "Owner",
          sortFn: "text",
          cell: ({ row }) => (
            <RelayOwnerCell
              ownerEmail={row.original.ownerEmail}
              ownerName={row.original.ownerName}
            />
          ),
          meta: dataTableColumnMeta({
            hideBelow: "lg",
            width: "minmax(0,1fr)",
          }),
        }
      ),
      relayTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <RelayActions relay={row.original} onEdit={onEdit} />
        ),
        meta: dataTableColumnMeta(
          {
            width: {
              base: "9rem",
              sm: "10rem",
            },
          },
          {
            cellClassName: "px-1 sm:px-3",
            headerClassName: "px-1 sm:px-3",
          }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Relays",
      columns,
      getRowId: relayRowKey,
      model: { initialState: initialTableState },
      search: { fields: relayTableSearchFields },
      virtualization: true,
    })
  }, [initialTableState, onEdit])

  return (
    <DataTable
      leadingBody={
        <PendingResourceInvitations
          resourceType="relay"
          visibleResourceKeys={visibleResourceKeys}
          searchStore={searchStore}
        />
      }
      definition={definition}
      emptyState={({ searchActive }) =>
        favoritesFiltered ? (
          <FavoritesOnlyEmptyState
            icon={<ServerCog className="size-6 text-muted-foreground/45" />}
            searchActive={searchActive}
            table="relays"
          />
        ) : (
          <EmptyRelayTable searchActive={searchActive} onAdd={onAdd} />
        )
      }
      searchStore={searchStore}
      source={visibleSource}
    />
  )
}

const RelayActions = React.memo(function RelayActions({
  relay,
  onEdit,
}: {
  relay: RelayTableItem
  onEdit: (relayId: string) => void
}) {
  return (
    <DataTableActionGroup>
      <RelayEditButton relay={relay} onEdit={onEdit} />
      <RelayPauseButton relay={relay} />
      <RelayDeleteButton relayId={relay.id} name={relay.name} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`More actions for ${relay.name}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <InstanceFavoriteMenuItem
            favorite={{ id: relay.id, kind: "relay", relayId: relay.id }}
          />
          <DropdownMenuSeparator />
          <CopyIdentifierMenuItem label="Relay ID" value={relay.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

const RelayEditButton = React.memo(function RelayEditButton({
  relay,
  onEdit,
}: {
  relay: Pick<RelayTableItem, "enabled" | "id" | "name">
  onEdit: (relayId: string) => void
}) {
  const queryClient = useQueryClient()
  const warmProxy = React.useCallback(() => {
    if (!relay.enabled) return
    void queryClient.prefetchQuery(relayProxyQueryOptions(relay.id))
  }, [queryClient, relay.enabled, relay.id])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Configure ${relay.name}`}
          className="text-muted-foreground hover:text-foreground"
          onFocus={warmProxy}
          onPointerEnter={warmProxy}
          onClick={() => onEdit(relay.id)}
        >
          <Settings2 />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Configure
      </TooltipContent>
    </Tooltip>
  )
})

const RelayOwnerCell = React.memo(function RelayOwnerCell({
  ownerEmail,
  ownerName,
}: Pick<RelayTableItem, "ownerEmail" | "ownerName">) {
  const profileIds = React.useContext(RelayOwnerProfileIdsContext)
  return (
    <IdentityName
      icon={
        ownerName ? (
          <UserAvatar
            name={ownerName}
            profileId={profileIds.get(minecraftUsernameKey(ownerName))}
          />
        ) : (
          <UserRound className="size-4" aria-hidden="true" />
        )
      }
      iconClassName="border-0 bg-transparent"
      meta={ownerEmail}
      name={ownerName ?? "Unassigned"}
    />
  )
})

function EmptyRelayTable({
  searchActive,
  onAdd,
}: {
  searchActive: boolean
  onAdd: () => void
}) {
  const { data: canAddRelay } = useSuspenseQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectCanAddRelay,
  })
  return (
    <DataTableEmptyState
      action={
        !searchActive && canAddRelay ? (
          <Button type="button" size="sm" onClick={onAdd}>
            <Plus /> Add Relay
          </Button>
        ) : undefined
      }
      description={
        searchActive
          ? "Try a Relay name, ID, host, architecture, owner, or status."
          : canAddRelay
            ? "Pair the first Relay to start managing game servers from Hearth."
            : "No Relays have been assigned to your account."
      }
      icon={<ServerCog className="size-6 text-muted-foreground/45" />}
      title={searchActive ? "No Relays match your search" : "No saved Relays"}
    />
  )
}

function AddRelayDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const formRef = React.useRef<HTMLFormElement>(null)
  const [pending, setPending] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{
    docsHref?: string
    message: string
  } | null>(null)
  const [reviewedPairing, setReviewedPairing] = React.useState<{
    pairingUri: string
    preview: {
      controlEndpoint: string
      existingRelayName: string | null
      expiresAt: number
      managedTls: boolean
      mode: "add" | "repair"
      relayFingerprint: string
      relayName: string
    }
  } | null>(null)
  const addMutation = useMutation({
    mutationFn: addRelay,
    onSuccess: async (relay) => {
      queryClient.setQueryData<Array<PersistedRelay>>(
        queryKeys.relays,
        (current) =>
          current?.some((item) => item.id === relay.id)
            ? current.map((item) => (item.id === relay.id ? relay : item))
            : [...(current ?? []), relay]
      )
      await Promise.all([
        invalidateRelayRuntimeQueries(queryClient),
        queryClient.invalidateQueries({
          queryKey: queryKeys.access.capabilities,
        }),
      ])
    },
  })

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && pending) return
    onOpenChange(nextOpen)
    if (!nextOpen) {
      setFeedback(null)
      setReviewedPairing(null)
      formRef.current?.reset()
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setFeedback(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (!reviewedPairing) {
            const form = new FormData(event.currentTarget)
            const pairingUri = String(form.get("pairingUri") ?? "").trim()
            const preview = await previewRelayPairing({ data: { pairingUri } })
            setReviewedPairing({ pairingUri, preview })
            return
          }
          const relay = await addMutation.mutateAsync({
            data: { pairingUri: reviewedPairing.pairingUri },
          })
          const repaired = reviewedPairing.preview.mode === "repair"
          showToast({
            type: "success",
            message: repaired
              ? `${relay.name} repaired`
              : `${relay.name} paired`,
            description: repaired
              ? "The Relay connection was repaired without replacing its Hearth data."
              : "The Relay is now available to Hearth.",
            duration: 4_000,
          })
          onOpenChange(false)
          setFeedback(null)
          setReviewedPairing(null)
          formRef.current?.reset()
          // A repaired Relay keeps its place; a new one opens its Info page.
          if (!repaired) {
            await navigate({
              params: { relayId: relay.id },
              to: "/relay/$relayId/info",
            })
          }
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => setFeedback(pairingFeedbackFrom(cause)))
        ),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <p className="type-technical-label text-primary">
            {reviewedPairing?.preview.mode === "repair"
              ? "Existing connection"
              : "New connection"}
          </p>
          <DialogTitle>
            {reviewedPairing?.preview.mode === "repair"
              ? "Repair Relay connection"
              : "Add a Relay"}
          </DialogTitle>
          <DialogDescription>
            {reviewedPairing?.preview.mode === "repair"
              ? "Verify the Relay identity before authorizing it again."
              : "Paste the one-time pairing URI printed by Relay, then verify its identity before connecting."}
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          className="space-y-4"
          onSubmit={(event) => void submit(event)}
        >
          {reviewedPairing ? (
            <PairingReview
              pairing={reviewedPairing.preview}
              onBack={() => {
                setFeedback(null)
                setReviewedPairing(null)
              }}
            />
          ) : (
            <>
              <Field
                label="Create a pairing URI"
                htmlFor="relay-pairing-command"
              >
                <Input
                  id="relay-pairing-command"
                  value="docker exec <container-id> kiln-relay pair create"
                  className="type-meta font-mono"
                  readOnly
                />
                <p className="type-meta text-muted-foreground">
                  Run this against your Relay container, then paste the returned
                  URI below.
                </p>
              </Field>

              <Field label="One-time pairing URI" htmlFor="relay-pairing-uri">
                <textarea
                  id="relay-pairing-uri"
                  name="pairingUri"
                  className="type-code min-h-32 w-full resize-y rounded-md border border-input bg-background/35 px-3 py-2 shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  placeholder="kiln-relay://pair/v1?payload=…"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>
            </>
          )}

          {feedback ? (
            <DialogFeedback
              message={feedback.message}
              docsHref={feedback.docsHref}
            />
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
              {reviewedPairing?.preview.mode === "repair"
                ? "Repair connection"
                : reviewedPairing
                  ? "Confirm and pair"
                  : "Review pairing"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PairingReview({
  pairing,
  onBack,
}: {
  pairing: {
    controlEndpoint: string
    existingRelayName: string | null
    expiresAt: number
    managedTls: boolean
    mode: "add" | "repair"
    relayFingerprint: string
    relayName: string
  }
  onBack: () => void
}) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.045] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
            <Fingerprint className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="type-technical-label text-primary">Verify identity</p>
            <p className="mt-0.5 truncate text-sm font-semibold">
              {pairing.relayName}
            </p>
          </div>
        </div>
        <Button type="button" size="xs" variant="ghost" onClick={onBack}>
          <X /> Back
        </Button>
      </div>
      {pairing.mode === "repair" ? (
        <div className="mt-4 flex gap-2.5 rounded-md border border-primary/20 bg-background/55 p-3">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <div>
            <p className="type-label text-foreground">
              Existing Relay identity found
            </p>
            <p className="type-meta mt-1 text-muted-foreground">
              Hearth will repair{" "}
              <span className="font-medium text-foreground">
                {pairing.existingRelayName ?? pairing.relayName}
              </span>{" "}
              in place. Server records, file activity, pins, and access stay
              attached.
            </p>
          </div>
        </div>
      ) : null}
      <dl className="type-meta mt-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Relay fingerprint</dt>
          <dd className="mt-1 font-mono break-all text-foreground">
            {pairing.relayFingerprint}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Control endpoint</dt>
          <dd className="mt-1 font-mono break-all text-foreground">
            {pairing.controlEndpoint}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">TLS trust</dt>
          <dd className="mt-1 text-foreground">
            {pairing.managedTls ? "Relay-managed CA" : "System trust"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Invitation expires</dt>
          <dd className="mt-1 text-foreground">
            {invitationTimeFormatter.format(new Date(pairing.expiresAt))}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function EditRelayDialog({
  relay,
  open,
  onOpenChange,
}: {
  relay: RelayEditView
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState(false)
  const [feedback, setFeedback] = React.useState<string | null>(null)
  const updateConnection = useMutation({
    mutationFn: updateRelay,
    onSuccess: async (updatedRelay) => {
      updateRelayCache(queryClient, [updatedRelay])
      await invalidateRelayRuntimeQueries(queryClient)
    },
  })
  const updateName = useMutation({
    mutationFn: renameRelay,
    onSuccess: async (updatedRelay) => {
      updateRelayCache(queryClient, [updatedRelay])
      await invalidateRelayRuntimeQueries(queryClient)
    },
  })
  const updateProxy = useMutation({
    mutationFn: updateRelayProxy,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.relayProxy(relay.id), result)
    },
  })

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setFeedback(null)

    // These values live in separate Hearth and Relay stores, so validate the
    // complete form before starting the intentionally sequential updates.
    const parsedName = relayNameSchema.safeParse(form.get("name"))
    if (!parsedName.success) {
      setFeedback(parsedName.error.issues[0]?.message ?? "Enter a Relay name")
      return
    }
    const parsedConnection = relayConnectionSettingsSchema.safeParse({
      hostname: form.get("hostname"),
      port: Number(form.get("port")),
      useTls: relay.useTls,
    })
    if (!parsedConnection.success) {
      setFeedback(
        parsedConnection.error.issues[0]?.message ??
          "Enter valid connection settings"
      )
      return
    }
    const proxy = relay.enabled
      ? queryClient.getQueryData(relayProxyQueryOptions(relay.id).queryKey)
      : undefined
    if (relay.enabled && !proxy) {
      setFeedback("Proxy configuration is still loading. Try again shortly.")
      return
    }
    const parsedProxy =
      relay.enabled && proxy
        ? relayProxySettingsSchema.safeParse({
            acmeEmail: String(form.get("acmeEmail") ?? "").trim() || null,
            mode: relayProxyMode(form.get("mode")),
            traefikImage: form.get("traefikImage"),
          })
        : null
    if (parsedProxy && !parsedProxy.success) {
      setFeedback(
        parsedProxy.error.issues[0]?.message ?? "Enter valid proxy settings"
      )
      return
    }

    setPending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (parsedName.data !== relay.name) {
            await updateName.mutateAsync({
              data: { name: parsedName.data, relayId: relay.id },
            })
          }
          await updateConnection.mutateAsync({
            data: {
              id: relay.id,
              ...parsedConnection.data,
            },
          })
          if (parsedProxy?.success) {
            await updateProxy.mutateAsync({
              data: {
                relayId: relay.id,
                ...parsedProxy.data,
              },
            })
          }
          showToast({
            type: "success",
            message: `${parsedName.data} updated`,
            description: "Relay connection settings were saved.",
            duration: 4_000,
          })
          onOpenChange(false)
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setFeedback(messageFrom(cause, "Could not update Relay"))
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <p className="type-technical-label text-primary">Edit connection</p>
          <DialogTitle>{relay.name}</DialogTitle>
          <DialogDescription>
            Update the Relay identity, control endpoint, and edge proxy
            configuration.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="type-meta rounded-md border border-border/70 bg-background/35 px-3 py-2 font-mono text-muted-foreground">
            Relay ID <span className="ml-1 text-foreground">{relay.id}</span>
          </div>

          <Field label="Relay name" htmlFor={`relay-name-${relay.id}`}>
            <Input
              id={`relay-name-${relay.id}`}
              name="name"
              defaultValue={relay.name}
              maxLength={120}
              required
            />
          </Field>

          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <Field label="Hostname" htmlFor={`relay-hostname-${relay.id}`}>
              <Input
                id={`relay-hostname-${relay.id}`}
                name="hostname"
                defaultValue={relay.hostname}
                placeholder="relay.example.com"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </Field>
            <Field label="Port" htmlFor={`relay-port-${relay.id}`}>
              <Input
                id={`relay-port-${relay.id}`}
                name="port"
                defaultValue={String(relay.port)}
                type="number"
                min={1}
                max={65_535}
                required
              />
            </Field>
          </div>

          <div className="border-t border-border/70 pt-4">
            <p className="type-technical-label mb-3 text-primary">Proxy</p>
            <RelayProxyFields relayEnabled={relay.enabled} relayId={relay.id} />
          </div>

          {feedback ? <DialogFeedback message={feedback} /> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <RelayEditSubmitButton
              pending={pending}
              relayEnabled={relay.enabled}
              relayId={relay.id}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const RelayProxyFields = React.memo(function RelayProxyFields({
  relayEnabled,
  relayId,
}: {
  relayEnabled: boolean
  relayId: string
}) {
  const proxy = useQuery({
    ...relayProxyQueryOptions(relayId),
    enabled: relayEnabled,
  })

  if (relayEnabled && proxy.isPending) {
    return (
      <div className="type-meta flex h-20 items-center justify-center gap-2 rounded-md border border-border/70 bg-background/25 text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Reading proxy
        configuration…
      </div>
    )
  }
  if (relayEnabled && proxy.error) {
    return (
      <DialogFeedback
        message={messageFrom(proxy.error, "Could not read proxy configuration")}
      />
    )
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Proxy mode" htmlFor={`relay-proxy-mode-${relayId}`}>
          <Select
            name="mode"
            defaultValue={proxy.data?.settings.mode ?? "none"}
            disabled={!relayEnabled}
          >
            <SelectTrigger
              id={`relay-proxy-mode-${relayId}`}
              className="type-control-sm h-8 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None / existing Traefik</SelectItem>
              <SelectItem value="hearth">Hearth proxy</SelectItem>
              <SelectItem value="traefik">Bundled Traefik</SelectItem>
              <SelectItem value="coolify">Coolify Traefik</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Traefik image" htmlFor={`traefik-image-${relayId}`}>
          <Input
            id={`traefik-image-${relayId}`}
            name="traefikImage"
            defaultValue={proxy.data?.settings.traefikImage ?? ""}
            placeholder="traefik:v3.6"
            disabled={!relayEnabled}
            required={relayEnabled}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field
            label="Certificate email"
            htmlFor={`relay-acme-email-${relayId}`}
          >
            <Input
              id={`relay-acme-email-${relayId}`}
              name="acmeEmail"
              type="email"
              defaultValue={proxy.data?.settings.acmeEmail ?? ""}
              placeholder="Optional"
              disabled={!relayEnabled}
            />
          </Field>
        </div>
      </div>
      {!relayEnabled ? (
        <p className="type-meta mt-2 text-sky-300">
          Resume this Relay to edit its proxy configuration.
        </p>
      ) : null}
    </>
  )
})

const RelayEditSubmitButton = React.memo(function RelayEditSubmitButton({
  pending,
  relayEnabled,
  relayId,
}: {
  pending: boolean
  relayEnabled: boolean
  relayId: string
}) {
  const proxy = useQuery({
    ...relayProxyQueryOptions(relayId),
    enabled: relayEnabled,
    notifyOnChangeProps: ["data", "error", "isPending"],
  })

  return (
    <Button
      type="submit"
      disabled={
        pending || (relayEnabled && (proxy.isPending || Boolean(proxy.error)))
      }
    >
      {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
      Save changes
    </Button>
  )
})

function DialogFeedback({
  docsHref,
  message,
}: {
  docsHref?: string
  message: string
}) {
  return (
    <div
      role="status"
      className="type-meta flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-destructive"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p>{message}</p>
        {docsHref ? (
          <a
            href={docsHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex font-medium underline underline-offset-2 hover:text-destructive/80"
          >
            Docs
          </a>
        ) : null}
      </div>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="type-label block text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

function selectHasEnabledRelay(relays: Array<PersistedRelay>): boolean {
  return relays.some((relay) => relay.enabled)
}

function relayFavorite(relay: RelayTableItem): InstanceFavorite {
  return { id: relay.id, kind: "relay", relayId: relay.id }
}

function relayRowKey(relay: RelayTableItem): string {
  return relay.id
}

function shortRelayId(id: string): string {
  return id.slice(0, 7)
}

function relayProxyMode(value: FormDataEntryValue | null) {
  if (value === "coolify") return "coolify"
  if (value === "traefik") return "traefik"
  if (value === "hearth") return "hearth"
  return "none"
}

function selectCanAddRelay(capabilities: {
  isPlatformAdmin: boolean
  user: { role: string | null }
}): boolean {
  return (
    capabilities.isPlatformAdmin || capabilities.user.role === "relay_creator"
  )
}
