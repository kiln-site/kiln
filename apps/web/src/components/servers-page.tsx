import { ServerKindIcon } from "@/components/instance-kind-icon"
import {
  loadingInfraTableSource,
  useInfraTableSource,
  type InfraInstanceRow,
} from "@/lib/infra-table-source"
import {
  PendingInvitationCard,
  PendingResourceInvitations,
  PendingResourceInvitationBadge,
  resourceInvitationScopeKey,
  type PendingInvitationCells,
} from "@/components/pending-resource-invitations"
import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  EllipsisVertical,
  Folder,
  ListTodo,
  Plus,
  TerminalSquare,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  DataTableInlineActions,
  DataTablePhoneMenuItems,
  DataTableTextCell,
  useRowMenuDialogs,
  dataTableRowLinkClassName,
  dataTableRowMenuTriggerClassName,
  dataTablePhoneDetailCellClassName,
  dataTablePhoneDetailWidth,
} from "@/components/data-table"
import {
  ServerDeleteDialog,
  type ServerDeleteTarget,
} from "@/components/server-delete-dialog"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import {
  AddFirstRelayButton,
  useAwaitingFirstRelay,
} from "@/components/relay/pair-first-relay"
import { DataTable } from "@/components/data-table-view"
import { InstanceCard, InstanceStatus } from "@/components/instance-card"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import { infraServersCollectionOptions } from "@/lib/collections/infra-directories"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { refreshInfraTable } from "@/lib/infra-directory"
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
  replaceDataTableRows,
  type DataTableSource,
} from "@/lib/data-table-source"
import type { InstanceFavorite } from "@/lib/instance-favorites"
import { grantHasPermission } from "@/lib/permissions"
import type { getInfraServerDirectory } from "@/server/infra-directory"
type ServerDirectory = Awaited<
  ReturnType<typeof getInfraServerDirectory>
>[number]

type InfraServer = InfraInstanceRow<ServerDirectory>
const serverReference = (server: ServerDirectory) => ({
  kind: "server" as const,
  id: server.id,
  relayId: server.relayId,
})

const serverTableItemCache = new WeakMap<ServerDirectory, ServerTableItem>()

interface ServerTableItem {
  routeIdentifier: string
  server: InfraServer
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
  ({ server }: ServerTableItem) => server.instanceStatus,
] as const

interface ServerDeleteAccess {
  all: boolean
  instances: ReadonlySet<string>
  relays: ReadonlySet<string>
}

export type ServerSearchStore = DataTableSearchStore

export const ServersPage = React.memo(function ServersPage({
  passwordRequired,
  searchStore,
}: {
  passwordRequired: boolean
  searchStore: ServerSearchStore
}) {
  const [dialogStore] = React.useState(createAddServerDialogStore)
  const [deleteTarget, setDeleteTarget] =
    React.useState<ServerDeleteTarget | null>(null)
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const canProvision =
    capabilities.isPlatformAdmin ||
    capabilities.grants.some(
      (grant) =>
        grant.resourceType === "relay" &&
        grantHasPermission(grant, "instance.create")
    )
  const deleteAccess = React.useMemo<ServerDeleteAccess>(() => {
    const instances = new Set<string>()
    const relays = new Set<string>()
    for (const grant of capabilities.grants) {
      if (!grantHasPermission(grant, "instance.delete")) continue
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

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-2 pb-3 sm:px-5 sm:pb-5">
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
            controls={<FavoritesOnlyButton table="servers" />}
            leading={<ServerSyncButton />}
            search={{
              ariaLabel: "Search game servers",
              closeMobileWhenEmpty: true,
              id: "server-search",
              onValueChange: replaceDataTableUrlSearch,
              placeholder: "Search game servers",
              store: searchStore,
            }}
          />
        }
      >
        <React.Suspense
          fallback={
            <ServerDataTable
              canProvision={canProvision}
              deleteAccess={deleteAccess}
              dialogStore={dialogStore}
              onDelete={openDelete}
              searchStore={searchStore}
              source={loadingInfraTableSource}
            />
          }
        >
          <ServerTableData
            canProvision={canProvision}
            deleteAccess={deleteAccess}
            dialogStore={dialogStore}
            onDelete={openDelete}
            searchStore={searchStore}
          />
        </React.Suspense>
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

const ServerSyncButton = React.memo(function ServerSyncButton() {
  const queryClient = useQueryClient()
  const sync = React.useCallback(
    () => refreshInfraTable(queryClient, "server"),
    [queryClient]
  )
  return <InfraSyncButton label="Sync game servers" sync={sync} />
})

const ActivityButton = React.memo(function ActivityButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" className="px-2 sm:px-2.5">
          <Link to="/activity" aria-label="Game server activity">
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
  if (!canProvision) return null
  return (
    <Button
      type="button"
      aria-label="Add Game Server"
      onClick={dialogStore.open}
    >
      <Plus />
      <span className="sm:hidden">Add</span>
      <span className="hidden sm:inline">Add Game Server</span>
    </Button>
  )
})

const ServerTableData = React.memo(function ServerTableData({
  canProvision,
  deleteAccess,
  dialogStore,
  onDelete,
  searchStore,
}: {
  canProvision: boolean
  deleteAccess: ServerDeleteAccess
  dialogStore: AddServerDialogStore
  onDelete: (target: ServerDeleteTarget) => void
  searchStore: ServerSearchStore
}) {
  const { data } = useLiveSuspenseQuery({
    query: (query) => query.from({ server: infraServersCollectionOptions }),
  })
  const liveSource = useInfraTableSource({
    rows: data,
    reference: serverReference,
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
})

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
  const [favoritesOnly] = useFavoritesOnly("servers")
  const visibleSource = useFavoritesOnlySource(
    source,
    favoritesOnly,
    serverTableItemFavorite
  )
  const favoritesFiltered = favoritesOnly && source.rows.length > 0
  const visibleResourceKeys = React.useMemo(
    () =>
      new Set(
        visibleSource.rows.map(({ server }) =>
          resourceInvitationScopeKey(server.relayId, server.id)
        )
      ),
    [visibleSource.rows]
  )
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "server" }],
  }))
  const definition = React.useMemo(() => {
    const columns = serverTableColumnHelper.columns([
      serverTableColumnHelper.accessor(({ server }) => server.instanceStatus, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <InstanceStatus
            state={row.original.server.instanceState}
            instance={{
              kind: "server",
              id: row.original.server.id,
              relayId: row.original.server.relayId,
            }}
          />
        ),
        meta: dataTableColumnMeta(
          { hideBelow: "md", width: statusColumnWidth },
          { headerLabelClassName: "shrink-0 overflow-visible text-clip" }
        ),
      }),
      serverTableColumnHelper.display({
        id: "favorite",
        header: () => <span className="sr-only">Favorite</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <InstanceFavoriteToggle
            id={row.original.server.id}
            kind="server"
            name={row.original.server.name}
            relayId={row.original.server.relayId}
          />
        ),
        meta: dataTableColumnMeta(
          { hideBelow: "md", width: "1.75rem" },
          { cellClassName: "relative z-10 px-0", headerClassName: "px-0" }
        ),
      }),
      serverTableColumnHelper.accessor(({ server }) => server.name, {
        id: "server",
        header: "Server",
        sortFn: "text",
        cell: ({ row }) => {
          const { routeIdentifier, server } = row.original
          return (
            <div className="flex w-full min-w-0 items-center">
              <Link
                to="/server/$serverId/console"
                params={{ serverId: routeIdentifier }}
                preload="intent"
                className={cn(
                  dataTableRowLinkClassName,
                  "group/server-link flex min-h-14 min-w-0 flex-1 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
                )}
              >
                <InstanceCard
                  state={server.instanceState}
                  instance={{
                    brickId: server.brickId,
                    id: server.id,
                    implementation: server.implementation,
                    kind: "server",
                    relayId: server.relayId,
                  }}
                  name={server.name}
                  nameClassName="transition-colors group-hover/server-link:text-primary-ink"
                  meta={
                    [server.game, server.implementation]
                      .filter(Boolean)
                      .join(" · ") || server.shortId
                  }
                  metaClassName="font-mono"
                  iconFavorite
                  iconFavoriteClassName="md:hidden"
                  showFavorite={false}
                />
              </Link>
              <PendingResourceInvitationBadge
                resourceType="instance"
                relayId={server.relayId}
                resourceId={server.id}
              />
            </div>
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
          hideBelow: "xl",
          width: "minmax(0,0.8fr)",
        }),
      }),
      serverTableColumnHelper.accessor(({ server }) => server.connectAddress, {
        id: "address",
        header: "Host / IP",
        sortFn: "text",
        cell: ({ row }) => {
          const address = row.original.server.connectAddress || "—"
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
        meta: dataTableColumnMeta(
          {
            width: {
              base: dataTablePhoneDetailWidth,
              md: "minmax(0,1fr)",
              xl: "minmax(12rem,1fr)",
            },
          },
          {
            cellClassName: dataTablePhoneDetailCellClassName,
            headerClassName: dataTablePhoneDetailCellClassName,
          }
        ),
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
          { width: { base: "3rem", md: "9.5rem" } },
          {
            cellClassName: "relative z-10 px-0 md:px-3",
            headerClassName: "px-1 md:px-3",
          }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Game Servers",
      columns,
      getRowId: serverTableItemKey,
      model: {
        initialState: initialTableState,
      },
      search: { fields: serverTableSearchFields },
      virtualization: true,
    })
  }, [deleteAccess, initialTableState, onDelete])
  return (
    <DataTable
      leadingBody={
        <PendingResourceInvitations
          cells={serverPendingCells}
          columns={definition.columns}
          resourceType="instance"
          visibleResourceKeys={visibleResourceKeys}
          searchStore={searchStore}
        />
      }
      definition={definition}
      emptyState={({ searchActive }) =>
        favoritesFiltered ? (
          <FavoritesOnlyEmptyState
            icon={<ServerKindIcon className="size-6" />}
            searchActive={searchActive}
            table="servers"
          />
        ) : (
          <EmptyServerTable
            canProvision={canProvision}
            dialogStore={dialogStore}
            searchActive={searchActive}
          />
        )
      }
      searchStore={searchStore}
      source={visibleSource}
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
  server: InfraServer
}) {
  const deleteEnabled =
    server.instanceState.phase === "ready" &&
    server.instanceState.observation.reachability === "connected"
  const menu = useRowMenuDialogs()
  const deleteServer = () =>
    onDelete({
      backupAvailable:
        server.instanceState.phase === "ready" &&
        server.instanceState.observation.runtime !== "provisioning",
      id: server.id,
      name: server.name,
      relayId: server.relayId,
    })
  return (
    <DataTableActionGroup>
      <DataTableInlineActions>
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
                className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
                disabled={!deleteEnabled}
                onClick={deleteServer}
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {deleteEnabled ? "Delete" : "Relay unavailable"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </DataTableInlineActions>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className={dataTableRowMenuTriggerClassName}
            aria-label={`More actions for ${server.name}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-44"
          onCloseAutoFocus={menu.onCloseAutoFocus}
        >
          <DataTablePhoneMenuItems>
            <DropdownMenuItem asChild>
              <Link
                to="/server/$serverId/console"
                params={{ serverId: routeIdentifier }}
              >
                <TerminalSquare /> Console
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link
                to="/server/$serverId/files/$"
                params={{ serverId: routeIdentifier, _splat: "" }}
              >
                <Folder /> Files
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </DataTablePhoneMenuItems>
          <InstanceFavoriteMenuItem
            favorite={{
              id: server.id,
              kind: "server",
              relayId: server.relayId,
            }}
          />
          <DropdownMenuSeparator />
          <CopyIdentifierMenuItem label="Server ID" value={server.id} />
          <CopyIdentifierMenuItem label="Relay ID" value={server.relayId} />
          {canDelete ? (
            <DataTablePhoneMenuItems>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!deleteEnabled}
                variant="destructive"
                onSelect={menu.openAfterClose(deleteServer)}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DataTablePhoneMenuItems>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
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
          className="text-muted-foreground hover:text-primary-ink"
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
  server: ServerDirectory
): boolean {
  if (server.brickId === builtinTailscaleBrickId) return false
  return (
    access.all ||
    access.relays.has(server.relayId) ||
    access.instances.has(`${server.relayId}:${server.id}`)
  )
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
  const awaitingFirstRelay = useAwaitingFirstRelay()
  return (
    <DataTableEmptyState
      action={
        searchActive ? null : awaitingFirstRelay ? (
          <AddFirstRelayButton />
        ) : canProvision ? (
          <Button type="button" size="sm" onClick={dialogStore.open}>
            <Plus /> Add Game Server
          </Button>
        ) : null
      }
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a game server name, short ID, Relay, address, game, implementation, or version."
            : awaitingFirstRelay
              ? "Pair a Relay to start hosting game servers."
              : canProvision
                ? "Provision the first game server managed by Hearth."
                : "No game servers have been assigned to your account yet."}
        </span>
      }
      icon={<ServerKindIcon className="size-6" />}
      title={
        searchActive
          ? "No game servers match your search"
          : "No managed game servers"
      }
    />
  )
}

function serverRowKey(server: ServerDirectory): string {
  return `${server.relayId}:${server.id}`
}

function serverTableItemKey(item: ServerTableItem): string {
  return serverRowKey(item.server)
}

function serverTableItemFavorite({
  server,
}: ServerTableItem): InstanceFavorite {
  return { id: server.id, kind: "server", relayId: server.relayId }
}

function createServerTableItems(
  servers: Array<InfraServer>
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

// A pending game server shows what its row will once accepted, except its
// address, which the invitation doesn't carry yet.
const serverPendingCells: PendingInvitationCells = {
  server: (invitation) => (
    <div className="flex w-full min-w-0 items-center px-3">
      <PendingInvitationCard invitation={invitation} />
    </div>
  ),
  relay: (invitation) => <DataTableTextCell value={invitation.relayName} />,
  address: () => <DataTableTextCell monospace value="—" />,
}
