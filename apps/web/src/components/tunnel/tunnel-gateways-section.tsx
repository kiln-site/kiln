import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  EllipsisVertical,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"

import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import { DataTableActionGroup } from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import { InfoCopyValue, InfoHint, InfoSection } from "@/components/info-page"
import { RelayKindIcon, TunnelKindIcon } from "@/components/instance-kind-icon"
import { StatusIndicator } from "@/components/status-indicator"
import {
  gatewayPermissionsOf,
  gatewayStatus,
  gatewayStream,
  type GatewayOverview,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import type { DataTableSource } from "@/lib/data-table-source"
import type { ServerAction } from "@/lib/instance-power-state"
import { queryKeys } from "@/lib/query-options"
import { heldPowerActions } from "@/lib/use-instance-power"
import {
  performGatewayAction,
  redeployGateway,
} from "@/server/tunnel-instances"

// A tunnel's gateways, on its Info page: its part on each Relay something it
// connects is on, Tailscale and CoreDNS there. They follow what's connected,
// so none is added here; each can be restarted, stopped, started or deployed
// again.

interface GatewayRow {
  connects: number
  gateway: GatewayOverview
}

const columnHelper = createDataTableColumnHelper<GatewayRow>()

export const TunnelGatewaysSection = React.memo(function TunnelGatewaysSection({
  tunnel,
}: {
  tunnel: TunnelOverview
}) {
  const rows = React.useMemo(
    () =>
      tunnel.gateways.map((gateway) => ({
        connects: tunnel.bindings.filter(
          (binding) => binding.relayId === gateway.relayId
        ).length,
        gateway,
      })),
    [tunnel.bindings, tunnel.gateways]
  )
  const source = React.useMemo(
    (): DataTableSource<GatewayRow> => ({
      body: { kind: "ready" },
      refreshing: false,
      rows,
    }),
    [rows]
  )
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Gateways",
        columns: columnHelper.columns([
          columnHelper.accessor((row) => row.gateway.relayName, {
            id: "relay",
            header: "Relay",
            enableSorting: false,
            cell: ({ row }) => (
              <Link
                to="/relay/$relayId"
                params={{ relayId: row.original.gateway.relayId }}
                preload="intent"
                className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] font-medium hover:text-primary-ink"
              >
                <RelayKindIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {row.original.gateway.relayName}
                </span>
              </Link>
            ),
            meta: dataTableColumnMeta({ width: "minmax(0,1fr)" }),
          }),
          columnHelper.accessor((row) => row.gateway.observedState, {
            id: "status",
            header: "Status",
            enableSorting: false,
            cell: ({ row }) => {
              const status = gatewayStatus(row.original.gateway)
              const dnsError = tunnel.dnsPending[row.original.gateway.id]
              // Up, but missing the latest names until the DNS worker
              // brings its hosts file up to date.
              return (
                <StatusIndicator
                  status={
                    dnsError !== undefined && status.tone === "success"
                      ? {
                          detail:
                            dnsError ??
                            "Its names are being brought up to date",
                          label: "DNS pending",
                          tone: "warning",
                        }
                      : status
                  }
                />
              )
            },
            meta: dataTableColumnMeta({ width: "7.5rem" }),
          }),
          columnHelper.accessor((row) => row.gateway.status.ipv4Address, {
            id: "ip",
            header: "IP",
            enableSorting: false,
            cell: ({ row }) => {
              const address = row.original.gateway.status.ipv4Address
              return address ? (
                <InfoCopyValue label="Tailscale IP" value={address} />
              ) : (
                <span className="type-meta text-muted-foreground">Not yet</span>
              )
            },
            meta: dataTableColumnMeta({ hideBelow: "md", width: "10rem" }),
          }),
          columnHelper.accessor((row) => row.connects, {
            id: "connects",
            header: "Connects",
            enableSorting: false,
            cell: ({ row }) => (
              <span className="type-meta text-muted-foreground">
                {row.original.connects}{" "}
                {row.original.connects === 1 ? "instance" : "instances"}
              </span>
            ),
            meta: dataTableColumnMeta({ hideBelow: "sm", width: "6.5rem" }),
          }),
          columnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <GatewayActions gateway={row.original.gateway} tunnel={tunnel} />
            ),
            meta: dataTableColumnMeta(
              { width: "2.75rem" },
              { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
            ),
          }),
        ]),
        getRowId: (row) => row.gateway.id,
      }),
    [tunnel]
  )
  const empty = rows.length === 0
  return (
    <InfoSection
      icon={<TunnelKindIcon />}
      title="Gateways"
      status={
        <InfoHint label="About gateways" title="Gateways">
          <p>
            A gateway is the tunnel's Tailscale and CoreDNS on one Relay. Kiln
            adds one when the first thing on that Relay connects, and takes it
            away when the last one leaves.
          </p>
        </InfoHint>
      }
      content={empty ? true : "flush"}
    >
      {empty ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          None yet. Connect a game server, App or database to {tunnel.name}, and
          Kiln adds a gateway on its Relay.
        </p>
      ) : (
        // Its rows are all there is, so the table isn't a scroll area of its
        // own: over it, the wheel scrolls the page.
        <div className="[&_tbody]:overflow-visible [&_tbody]:overscroll-auto">
          <DataTable
            definition={definition}
            emptyState={null}
            source={source}
          />
        </div>
      )}
    </InfoSection>
  )
})

const GatewayActions = React.memo(function GatewayActions({
  gateway,
  tunnel,
}: {
  gateway: GatewayOverview
  tunnel: TunnelOverview
}) {
  const queryClient = useQueryClient()
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.tunnels })
  const onError = (message: string) => (cause: Error) =>
    showToast({ description: cause.message, message, type: "error" })
  const power = useMutation({
    mutationFn: (action: ServerAction) =>
      performGatewayAction({ data: { action, gatewayId: gateway.id } }),
    onSettled: refresh,
    onError: onError(`The gateway on ${gateway.relayName} didn't change`),
  })
  const redeploy = useMutation({
    mutationFn: () => redeployGateway({ data: { gatewayId: gateway.id } }),
    onSettled: refresh,
    onSuccess: () =>
      showToast({
        message: `The gateway on ${gateway.relayName} is redeployed`,
        type: "success",
      }),
    onError: onError(`The gateway on ${gateway.relayName} wasn't redeployed`),
  })
  const permissions = gatewayPermissionsOf(tunnel, gateway.id)
  const actions = heldPowerActions(permissions, !tunnel.cleanup)
  const running = gateway.observedState === "running"
  const canToggle = running ? actions.stop : actions.start
  const canDeploy = !tunnel.cleanup && permissions.includes("instance.deploy")
  const canReadLogs = permissions.includes("instance.logs.read")
  const pending = power.isPending || redeploy.isPending
  return (
    <DataTableActionGroup>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for the gateway on ${gateway.relayName}`}
            disabled={pending}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {pending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <EllipsisVertical />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {actions.restart ? (
            <DropdownMenuItem onSelect={() => power.mutate("restart")}>
              <RotateCw /> Restart
            </DropdownMenuItem>
          ) : null}
          {canToggle ? (
            <DropdownMenuItem
              onSelect={() => power.mutate(running ? "stop" : "start")}
            >
              {running ? <Square /> : <Play />}
              {running ? "Stop" : "Start"}
            </DropdownMenuItem>
          ) : null}
          {canDeploy ? (
            <DropdownMenuItem onSelect={() => redeploy.mutate()}>
              <RefreshCw /> Redeploy
            </DropdownMenuItem>
          ) : null}
          {canReadLogs ? (
            <>
              {actions.restart || canToggle || canDeploy ? (
                <DropdownMenuSeparator />
              ) : null}
              <DropdownMenuItem asChild>
                <Link
                  to="/tunnel/$tunnelId/logs"
                  params={{ tunnelId: tunnel.id }}
                  search={{ stream: gatewayStream(gateway.id, "tailscale") }}
                >
                  <ScrollText /> Logs
                </Link>
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <CopyIdentifierMenuItem label="Gateway ID" value={gateway.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})
