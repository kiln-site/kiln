import { RelayKindIcon } from "@/components/instance-kind-icon"
import {
  PendingInvitationCard,
  PendingResourceInvitations,
  PendingResourceInvitationBadge,
  pendingRowDetailClassName,
  resourceInvitationScopeKey,
  type PendingInvitationCells,
} from "@/components/pending-resource-invitations"
import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { InfraSyncButton } from "@/components/infra-sync-button"
import { Effect } from "effect"
import {
  Check,
  EllipsisVertical,
  ListTodo,
  LoaderCircle,
  Plus,
  Settings2,
  UserRound,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
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
  AddRelayDialog,
  DialogFeedback,
  Field,
} from "@/components/relay/add-relay-dialog"
import {
  RelayDeleteButton,
  RelayPauseButton,
  invalidateRelayRuntimeQueries,
  messageFrom,
  showRelayError,
  updateRelayCache,
} from "@/components/relay/relay-actions"
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
import { InstanceCard, InstanceStatus } from "@/components/instance-card"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import {
  RelayMemoryCell,
  RelayMemoryValue,
} from "@/components/relay-memory-cell"
import { UserIdentity } from "@/components/user-identity"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import {
  minecraftUsernameKey,
  relayOwnerNamesKey,
  selectOwnerProfileIds,
} from "@/lib/minecraft-profile"
import { relayAddress } from "@/lib/relay-route"
import {
  myInvitationsQueryOptions,
  type ResourceInvitation,
} from "@/lib/resource-invitation-query"
import {
  accessCapabilitiesQueryOptions,
  queryKeys,
  relayOwnerMinecraftProfilesQueryOptions,
  relayProxyQueryOptions,
  relaysQueryOptions,
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
import { type DataTableSource } from "@/lib/data-table-source"
import {
  checkRelay,
  renameRelay,
  updateRelay,
  updateRelayProxy,
} from "@/server/relays"
import {
  loadingInfraTableSource,
  useInfraTableSource,
  type InfraInstanceRow,
} from "@/lib/infra-table-source"
import type { ManagedRelay } from "@/server/relays"

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

type RelayTableItem = InfraInstanceRow<RelayRegistryTableItem>
const relayReference = (relay: RelayRegistryTableItem) => ({
  kind: "relay" as const,
  id: relay.id,
  relayId: relay.id,
})

const relayTableColumnHelper = createDataTableColumnHelper<RelayTableItem>()
const relayTableSearchFields = [
  (relay: RelayTableItem) => relay.name,
  (relay: RelayTableItem) => relay.id,
  (relay: RelayTableItem) => relay.hostname,
  (relay: RelayTableItem) => relay.nodeArch,
  (relay: RelayTableItem) => relay.nodePlatform,
  (relay: RelayTableItem) => relay.ownerEmail,
  (relay: RelayTableItem) => relay.ownerName,
  (relay: RelayTableItem) => relay.instanceStatus,
] as const

interface RelayEditView {
  enabled: boolean
  hostname: string
  id: string
  name: string
  port: number
  useTls: boolean
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
        <React.Suspense
          fallback={
            <RelayTable
              searchStore={searchStore}
              onAdd={dialogStore.openAdd}
              onEdit={dialogStore.openEdit}
              source={loadingInfraTableSource}
            />
          }
        >
          <FilteredRelayTable
            searchStore={searchStore}
            onAdd={dialogStore.openAdd}
            onEdit={dialogStore.openEdit}
          />
        </React.Suspense>
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
  const { data } = useLiveSuspenseQuery({
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
  const { data: invitedOwners = noInvitedOwners } = useQuery({
    ...myInvitationsQueryOptions(),
    select: selectInvitedOwners,
  })
  const ownerNames = React.useMemo(
    () => relayOwnerNamesKey([...data, ...invitedOwners]),
    [data, invitedOwners]
  )
  const source = useInfraTableSource({ rows: data, reference: relayReference })

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
  const { data: hasEnabledRelay } = useQuery({
    ...relaysQueryOptions(),
    select: selectHasEnabledRelay,
  })
  const sync = React.useCallback(async () => {
    const relays =
      queryClient.getQueryData<Array<PersistedRelay>>(queryKeys.relays) ?? []
    const checkedRelays = await Promise.all(
      relays.flatMap((relay) =>
        relay.enabled ? [checkRelay({ data: { id: relay.id } })] : []
      )
    )
    updateRelayCache(queryClient, checkedRelays)
  }, [queryClient])
  return (
    <InfraSyncButton
      disabled={!hasEnabledRelay}
      label="Sync relays"
      sync={sync}
      onError={syncFailed}
    />
  )
})

const syncFailed = (cause: Error) =>
  showRelayError(cause, "Could not sync Relays")

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
      relayTableColumnHelper.accessor((relay) => relay.instanceStatus, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <InstanceStatus
            state={row.original.instanceState}
            instance={{
              kind: "relay",
              id: row.original.id,
              relayId: row.original.id,
            }}
          />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "2.5rem", sm: statusColumnWidth } },
          {
            cellClassName: "px-2 sm:px-3",
            headerClassName: "px-2 sm:px-3",
            headerLabelClassName: "shrink-0 overflow-visible text-clip",
          }
        ),
      }),
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
                <InstanceCard
                  state={relay.instanceState}
                  className="min-w-0 flex-1"
                  instance={{ id: relay.id, kind: "relay", relayId: relay.id }}
                  meta={
                    <span title={relay.id}>
                      {relay.nodeArch ?? "unknown"} <span aria-hidden>•</span>{" "}
                      {shortRelayId(relay.id)}
                    </span>
                  }
                  metaClassName="font-mono"
                  name={relay.name}
                  nameClassName="transition-colors group-hover/relay-link:text-primary-ink"
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
            connected={
              row.original.instanceState.phase === "ready" &&
              row.original.instanceState.observation.reachability ===
                "connected"
            }
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
          cells={relayPendingCells}
          columns={definition.columns}
          resourceType="relay"
          visibleResourceKeys={visibleResourceKeys}
          searchStore={searchStore}
        />
      }
      definition={definition}
      emptyState={({ searchActive }) =>
        favoritesFiltered ? (
          <FavoritesOnlyEmptyState
            icon={<RelayKindIcon className="size-6" />}
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

const noInvitedOwners: ReadonlyArray<{ ownerName: string | null }> = []
// Owners only, so a pending Relay's new memory reading doesn't re-render the
// table.
const selectInvitedOwners = (invitations: Array<ResourceInvitation>) =>
  invitations.flatMap((invitation) =>
    invitation.relay ? [{ ownerName: invitation.relay.ownerName }] : []
  )

// A pending Relay shows what its row will once accepted.
const relayPendingCells: PendingInvitationCells = {
  relay: (invitation) => <PendingInvitationCard invitation={invitation} />,
  memory: (invitation) => (
    <span className={pendingRowDetailClassName}>
      <RelayMemoryValue memory={invitation.relay?.memory} />
    </span>
  ),
  host: ({ relay }) =>
    relay ? (
      <DataTableTextCell
        className={pendingRowDetailClassName}
        monospace
        title={relayAddress(relay)}
        value={relay.hostname}
      />
    ) : null,
  owner: ({ relay }) =>
    relay ? (
      <RelayOwnerCell
        ownerEmail={relay.ownerEmail}
        ownerName={relay.ownerName}
      />
    ) : null,
}

const RelayOwnerCell = React.memo(function RelayOwnerCell({
  ownerEmail,
  ownerName,
}: Pick<RelayTableItem, "ownerEmail" | "ownerName">) {
  const profileIds = React.useContext(RelayOwnerProfileIdsContext)
  return ownerName ? (
    <UserIdentity
      className="w-full"
      emailClassName={pendingRowDetailClassName}
      email={ownerEmail}
      name={ownerName}
      profileId={profileIds.get(minecraftUsernameKey(ownerName))}
    />
  ) : (
    <IdentityName
      icon={<UserRound className="size-4" aria-hidden="true" />}
      iconClassName="border-0 bg-transparent"
      name="Unassigned"
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
      icon={<RelayKindIcon className="size-6" />}
      title={searchActive ? "No Relays match your search" : "No saved Relays"}
    />
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
          <p className="type-technical-label text-primary-ink">
            Edit connection
          </p>
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
            <p className="type-technical-label mb-3 text-primary-ink">Proxy</p>
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
        <p className="type-meta mt-2 text-sky-300 light:text-sky-700">
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
