import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  CircleAlert,
  EllipsisVertical,
  LoaderCircle,
  Play,
  Plus,
  RotateCw,
  Square,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  AddInstanceDialogHost,
  createAddInstanceDialogStore,
} from "@/components/add-instance-dialog"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableTextCell,
  dataTablePhoneDetailCellClassName,
  dataTablePhoneDetailWidth,
  dataTableRowLinkClassName,
  dataTableRowMenuTriggerClassName,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { TunnelKindIcon } from "@/components/instance-kind-icon"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { StatusIndicator } from "@/components/status-indicator"
import {
  tunnelPermissionsOf,
  tunnelStatus,
  useTunnels,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  replaceDataTableUrlSearch,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import type { ServerAction } from "@/lib/instance-power-state"
import type { AccessPermission } from "@/lib/permissions"
import { accessCapabilitiesQueryOptions, queryKeys } from "@/lib/query-options"
import { heldPowerActions } from "@/lib/use-instance-power"
import { performTunnelAction } from "@/server/tunnel-instances"

// Infrastructure → Tunnels: every tunnel the viewer sees, one row each, as
// the other kinds' tables are. A tunnel's gateways, one on each Relay
// something it connects is on, are on its own page.

interface TunnelRow {
  connected: number
  domains: ReadonlyArray<string>
  gateways: number
  /** The Relays its gateways are on, by name. */
  gatewayRelays: string
  id: string
  name: string
  /** What the viewer may do with it, as its pages check. */
  permissions: ReadonlyArray<AccessPermission>
  /** It's being deleted. */
  removing: boolean
  /** Any of its gateways runs. */
  running: boolean
  status: IdentityStatusPresentation
}

function tunnelRows(tunnels: ReadonlyArray<TunnelOverview>): Array<TunnelRow> {
  return tunnels.map((tunnel) => ({
    connected: tunnel.bindings.length,
    domains: tunnel.domains,
    gatewayRelays: tunnel.gateways.map(({ relayName }) => relayName).join(", "),
    gateways: tunnel.gateways.length,
    id: tunnel.id,
    name: tunnel.name,
    permissions: tunnelPermissionsOf(tunnel),
    removing: tunnel.cleanup !== null,
    running: tunnel.gateways.some(
      ({ observedState }) => observedState === "running"
    ),
    status: tunnelStatus(tunnel),
  }))
}

const columnHelper = createDataTableColumnHelper<TunnelRow>()
const searchFields = [
  (row: TunnelRow) => row.name,
  (row: TunnelRow) => row.id,
  (row: TunnelRow) => row.domains.join(" "),
  (row: TunnelRow) => row.gatewayRelays,
  (row: TunnelRow) => row.status.label,
] as const

export const TunnelsPage = React.memo(function TunnelsPage({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  // Making a tunnel is a platform administrator's until tunnels have
  // permissions of their own.
  const { data: canCreate = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })
  const [addStore] = React.useState(() =>
    createAddInstanceDialogStore("tunnel")
  )
  const { data, error, isPending, refetch } = useTunnels()
  const rows = React.useMemo(() => tunnelRows(data.tunnels), [data.tunnels])
  const source = React.useMemo(
    (): DataTableSource<TunnelRow> => ({
      body: error
        ? { kind: "error", error, retry: () => void refetch() }
        : isPending && rows.length === 0
          ? { kind: "loading" }
          : { kind: "ready" },
      refreshing: false,
      rows,
    }),
    [error, isPending, refetch, rows]
  )

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col gap-3 px-2 pb-3 sm:px-5 sm:pb-5">
      {data.unavailableRelays.length > 0 ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 light:bg-amber-500/20"
          role="status"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Gateways not shown while away:{" "}
            {data.unavailableRelays.map(({ name }) => name).join(", ")}. A
            tunnel with a gateway there can't change until they're back.
          </span>
        </p>
      ) : null}
      <DataTableWorkspace
        toolbar={
          <TunnelToolbar
            canCreate={canCreate}
            searchStore={searchStore}
            onCreate={addStore.open}
          />
        }
      >
        <TunnelTable
          canCreate={canCreate}
          searchStore={searchStore}
          source={source}
          onCreate={addStore.open}
        />
      </DataTableWorkspace>
      {canCreate ? <AddInstanceDialogHost store={addStore} /> : null}
    </div>
  )
})

const TunnelToolbar = React.memo(function TunnelToolbar({
  canCreate,
  onCreate,
  searchStore,
}: {
  canCreate: boolean
  onCreate: () => void
  searchStore: DataTableSearchStore
}) {
  return (
    <DataTableToolbar
      actions={
        canCreate ? (
          <Button type="button" onClick={onCreate}>
            <Plus /> Add tunnel
          </Button>
        ) : null
      }
      leading={<TunnelSyncButton />}
      search={{
        ariaLabel: "Search tunnels",
        closeMobileWhenEmpty: true,
        id: "tunnel-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search tunnels",
        store: searchStore,
      }}
    />
  )
})

const TunnelSyncButton = React.memo(function TunnelSyncButton() {
  const queryClient = useQueryClient()
  const sync = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.tunnels }),
    [queryClient]
  )
  return <InfraSyncButton label="Sync tunnels" sync={sync} />
})

const TunnelTable = React.memo(function TunnelTable({
  canCreate,
  onCreate,
  searchStore,
  source,
}: {
  canCreate: boolean
  onCreate: () => void
  searchStore: DataTableSearchStore
  source: DataTableSource<TunnelRow>
}) {
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "tunnel" }],
  }))
  const definition = React.useMemo(() => {
    const columns = columnHelper.columns([
      columnHelper.accessor((tunnel) => tunnel.status.label, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => <StatusIndicator status={row.original.status} />,
        meta: dataTableColumnMeta(
          { hideBelow: "md", width: statusColumnWidth },
          { headerLabelClassName: "shrink-0 overflow-visible text-clip" }
        ),
      }),
      columnHelper.accessor((tunnel) => tunnel.name, {
        id: "tunnel",
        header: "Tunnel",
        sortFn: "text",
        cell: ({ row }) => {
          const tunnel = row.original
          return (
            <Link
              to="/tunnel/$tunnelId/info"
              params={{ tunnelId: tunnel.id }}
              preload="intent"
              className={cn(
                dataTableRowLinkClassName,
                "group/tunnel-link flex min-h-14 w-full min-w-0 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
              )}
            >
              <InstanceCard
                className="min-w-0 flex-1"
                instance={{ id: tunnel.id, kind: "tunnel", relayId: "" }}
                meta={`Tailscale · ${tunnel.id}`}
                metaClassName="font-mono"
                name={tunnel.name}
                nameClassName="transition-colors group-hover/tunnel-link:text-primary-ink"
                showFavorite={false}
                status={tunnel.status}
              />
            </Link>
          )
        },
        meta: dataTableColumnMeta({
          width: { base: "minmax(0,1fr)", md: "minmax(0,1.3fr)" },
        }),
      }),
      columnHelper.accessor((tunnel) => tunnel.domains.join(" "), {
        id: "tlds",
        header: "TLDs",
        sortFn: "text",
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-wrap gap-1">
            {row.original.domains.map((domain) => (
              <Badge key={domain} variant="outline" className="font-mono">
                .{domain}
              </Badge>
            ))}
          </span>
        ),
        meta: dataTableColumnMeta(
          { width: { base: dataTablePhoneDetailWidth, md: "minmax(0,0.8fr)" } },
          {
            cellClassName: dataTablePhoneDetailCellClassName,
            headerClassName: dataTablePhoneDetailCellClassName,
          }
        ),
      }),
      columnHelper.accessor((tunnel) => tunnel.gateways, {
        id: "gateways",
        header: "Gateways",
        enableSorting: false,
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0">
                <DataTableTextCell
                  value={
                    row.original.gateways === 0
                      ? "None yet"
                      : String(row.original.gateways)
                  }
                />
              </span>
            </TooltipTrigger>
            {row.original.gatewayRelays ? (
              <TooltipContent side="bottom">
                On {row.original.gatewayRelays}
              </TooltipContent>
            ) : null}
          </Tooltip>
        ),
        meta: dataTableColumnMeta({ hideBelow: "lg", width: "7rem" }),
      }),
      columnHelper.accessor((tunnel) => tunnel.connected, {
        id: "connected",
        header: "Connected",
        enableSorting: false,
        cell: ({ row }) => (
          <DataTableTextCell value={String(row.original.connected)} />
        ),
        meta: dataTableColumnMeta({ hideBelow: "lg", width: "7rem" }),
      }),
      columnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => <TunnelActions tunnel={row.original} />,
        meta: dataTableColumnMeta(
          { width: "3rem" },
          { cellClassName: "relative z-10 px-0", headerClassName: "px-1" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Tunnels",
      columns,
      getRowId: (tunnel) => tunnel.id,
      model: { initialState: initialTableState },
      search: { fields: searchFields },
      virtualization: true,
    })
  }, [initialTableState])

  return (
    <DataTable
      definition={definition}
      emptyState={({ searchActive }) => (
        <DataTableEmptyState
          action={
            !searchActive && canCreate ? (
              <Button size="sm" type="button" onClick={onCreate}>
                <Plus /> Add tunnel
              </Button>
            ) : null
          }
          description={
            <span className="block max-w-sm">
              {searchActive
                ? "Try a tunnel, TLD, or Relay."
                : "A tunnel puts game servers, Apps and databases on your Tailscale tailnet, so they answer to names like survival.kiln."}
            </span>
          }
          icon={<TunnelKindIcon className="size-6" />}
          title={searchActive ? "No tunnels match your search" : "No tunnels"}
        />
      )}
      searchStore={searchStore}
      source={source}
    />
  )
})

const TunnelActions = React.memo(function TunnelActions({
  tunnel,
}: {
  tunnel: TunnelRow
}) {
  const queryClient = useQueryClient()
  const action = useMutation({
    mutationFn: (next: ServerAction) =>
      performTunnelAction({ data: { action: next, tunnelId: tunnel.id } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.tunnels }),
    onSuccess: (outcomes) => {
      const failed = outcomes.filter(({ error }) => error !== null)
      if (failed.length > 0) {
        showToast({
          description: failed.map(({ error }) => error).join("; "),
          message: "Some gateways' power didn't change",
          type: "error",
        })
      }
    },
    onError: (cause) =>
      showToast({
        description: cause.message,
        message: "The tunnel's power didn't change",
        type: "error",
      }),
  })
  const power = heldPowerActions(
    tunnel.permissions,
    !tunnel.removing && tunnel.gateways > 0
  )
  const canToggle = tunnel.running ? power.stop : power.start
  return (
    <DataTableActionGroup>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                className={dataTableRowMenuTriggerClassName}
                aria-label={`More actions for ${tunnel.name}`}
                disabled={action.isPending}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {action.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <EllipsisVertical />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-44">
          {canToggle ? (
            <DropdownMenuItem
              onSelect={() => action.mutate(tunnel.running ? "stop" : "start")}
            >
              {tunnel.running ? <Square /> : <Play />}
              {tunnel.running ? "Stop all" : "Start all"}
            </DropdownMenuItem>
          ) : null}
          {power.restart ? (
            <DropdownMenuItem onSelect={() => action.mutate("restart")}>
              <RotateCw /> Restart all
            </DropdownMenuItem>
          ) : null}
          {canToggle || power.restart ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem asChild>
            <Link
              to="/tunnel/$tunnelId/gateways"
              params={{ tunnelId: tunnel.id }}
            >
              <TunnelKindIcon /> Gateways
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <CopyIdentifierMenuItem label="Tunnel ID" value={tunnel.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})
