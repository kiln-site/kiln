import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ChevronDown,
  CircleAlert,
  EllipsisVertical,
  LoaderCircle,
  Play,
  Plus,
  RotateCw,
  Square,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { TunnelKindIcon } from "@/components/instance-kind-icon"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { StatusIndicator } from "@/components/status-indicator"
import { TailnetCard, tailnetMeta } from "@/components/tunnel/tailnet-card"
import {
  tunnelStatus,
  useTailnets,
  type TailnetOverview,
  type TunnelOverview,
} from "@/components/tunnel/tailnet-data"
import type { IdentityStatusPresentation } from "@/components/identity-name"
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
import { accessCapabilitiesQueryOptions, queryKeys } from "@/lib/query-options"
import { heldPowerActions } from "@/lib/use-instance-power"
import { performTunnelAction } from "@/server/tunnel-instances"

// Infrastructure → Tunnels: every tunnel the viewer sees, one row each, as
// the other kinds' tables are, with the tailnet it joins. Each tailnet's own
// page is a link away, from its column or the Tailnets menu.

interface TunnelRow {
  connected: number
  id: string
  ipv4: string | null
  name: string
  /** What the viewer may do with it, as every kind's pages check. */
  permissions: ReadonlyArray<string>
  relayId: string
  relayName: string
  status: IdentityStatusPresentation
  /** Its tailnet is being deleted, and it with it. */
  removing: boolean
  running: boolean
  tailnet: Pick<TailnetOverview, "domains" | "id" | "name"> & {
    meta: string
  }
}

function tunnelRows(
  tailnets: ReadonlyArray<TailnetOverview>
): Array<TunnelRow> {
  return tailnets.flatMap((tailnet) => {
    const meta = tailnetMeta(tailnet)
    return tailnet.deployments.map((tunnel: TunnelOverview): TunnelRow => ({
      connected: tailnet.bindings.filter(
        (binding) => binding.relayId === tunnel.relayId
      ).length,
      id: tunnel.id,
      ipv4: tunnel.status.ipv4Address,
      name: tunnel.name,
      permissions: tailnet.access.tunnels[tunnel.id] ?? [],
      relayId: tunnel.relayId,
      relayName: tunnel.relayName,
      removing: tailnet.cleanup !== null,
      running: tunnel.observedState === "running",
      status: tailnet.cleanup
        ? { label: "Deleting", pulse: true, tone: "warning" }
        : tunnelStatus(tunnel),
      tailnet: {
        domains: tailnet.domains,
        id: tailnet.id,
        meta,
        name: tailnet.name,
      },
    }))
  })
}

const columnHelper = createDataTableColumnHelper<TunnelRow>()
const searchFields = [
  (row: TunnelRow) => row.name,
  (row: TunnelRow) => row.id,
  (row: TunnelRow) => row.relayName,
  (row: TunnelRow) => row.relayId,
  (row: TunnelRow) => row.tailnet.name,
  (row: TunnelRow) => row.tailnet.domains.join(" "),
  (row: TunnelRow) => row.ipv4,
  (row: TunnelRow) => row.status.label,
] as const

export const TunnelsPage = React.memo(function TunnelsPage({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  // Tailnets are a platform administrator's until tunnels have permissions
  // of their own.
  const { data: canCreate = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })
  const [addStore] = React.useState(() =>
    createAddInstanceDialogStore("tunnel")
  )
  const { data, error, isPending, refetch } = useTailnets()
  const rows = React.useMemo(() => tunnelRows(data.stacks), [data.stacks])
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
            Not shown while away:{" "}
            {data.unavailableRelays.map(({ name }) => name).join(", ")}. A
            tailnet can't change until they're back.
          </span>
        </p>
      ) : null}
      <DataTableWorkspace
        toolbar={
          <TunnelToolbar
            canCreate={canCreate}
            searchStore={searchStore}
            tailnets={data.stacks}
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
  tailnets,
}: {
  canCreate: boolean
  onCreate: () => void
  searchStore: DataTableSearchStore
  tailnets: ReadonlyArray<TailnetOverview>
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
      controls={<TailnetsMenu tailnets={tailnets} />}
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

// Every tailnet's page, a tailnet with no tunnels among them.
const TailnetsMenu = React.memo(function TailnetsMenu({
  tailnets,
}: {
  tailnets: ReadonlyArray<TailnetOverview>
}) {
  if (tailnets.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline">
          Tailnets
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuLabel className="type-technical-label text-muted-foreground">
          Tailnets
        </DropdownMenuLabel>
        {tailnets.map((tailnet) => (
          <DropdownMenuItem key={tailnet.id} asChild>
            <Link
              to="/tailnet/$tailnetId"
              params={{ tailnetId: tailnet.id }}
              preload="intent"
            >
              <TailnetCard meta={tailnetMeta(tailnet)} name={tailnet.name} />
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

const TunnelSyncButton = React.memo(function TunnelSyncButton() {
  const queryClient = useQueryClient()
  const sync = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.tailnets }),
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
                instance={{
                  id: tunnel.id,
                  kind: "tunnel",
                  relayId: tunnel.relayId,
                }}
                meta={tunnel.id}
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
      columnHelper.accessor((tunnel) => tunnel.tailnet.name, {
        id: "tailnet",
        header: "Tailnet",
        sortFn: "text",
        cell: ({ row }) => (
          <Link
            to="/tailnet/$tailnetId"
            params={{ tailnetId: row.original.tailnet.id }}
            preload="intent"
            className="relative z-10 flex min-w-0 rounded-md outline-none hover:text-primary-ink focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <TailnetCard
              meta={row.original.tailnet.meta}
              name={row.original.tailnet.name}
            />
          </Link>
        ),
        meta: dataTableColumnMeta(
          { width: { base: dataTablePhoneDetailWidth, md: "minmax(0,1fr)" } },
          {
            cellClassName: dataTablePhoneDetailCellClassName,
            headerClassName: dataTablePhoneDetailCellClassName,
          }
        ),
      }),
      columnHelper.accessor((tunnel) => tunnel.ipv4 ?? "", {
        id: "address",
        header: "Tailscale IP",
        sortFn: "text",
        cell: ({ row }) => (
          <DataTableTextCell
            className="font-mono"
            value={row.original.ipv4 ?? "—"}
          />
        ),
        meta: dataTableColumnMeta({ hideBelow: "lg", width: "9rem" }),
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
      columnHelper.accessor((tunnel) => tunnel.relayName, {
        id: "relay",
        header: "Relay",
        sortFn: "text",
        cell: ({ row }) => <DataTableTextCell value={row.original.relayName} />,
        meta: dataTableColumnMeta({
          hideBelow: "xl",
          width: "minmax(8rem,0.8fr)",
        }),
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
                ? "Try a tunnel, tailnet, TLD, Relay, or Tailscale IP."
                : "A tunnel joins a Relay to your Tailscale tailnet, so what runs there answers to names like survival.kiln."}
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
      queryClient.invalidateQueries({ queryKey: queryKeys.tailnets }),
    onError: (cause) =>
      showToast({
        description: cause.message,
        message: "The tunnel's power didn't change",
        type: "error",
      }),
  })
  const power = heldPowerActions(
    tunnel.permissions as Parameters<typeof heldPowerActions>[0],
    !tunnel.removing
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
              {tunnel.running ? "Stop" : "Start"}
            </DropdownMenuItem>
          ) : null}
          {power.restart ? (
            <DropdownMenuItem onSelect={() => action.mutate("restart")}>
              <RotateCw /> Restart
            </DropdownMenuItem>
          ) : null}
          {canToggle || power.restart ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem asChild>
            <Link
              to="/tailnet/$tailnetId"
              params={{ tailnetId: tunnel.tailnet.id }}
            >
              <TunnelKindIcon /> Open {tunnel.tailnet.name}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <CopyIdentifierMenuItem label="Tunnel ID" value={tunnel.id} />
          <CopyIdentifierMenuItem label="Relay ID" value={tunnel.relayId} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})
