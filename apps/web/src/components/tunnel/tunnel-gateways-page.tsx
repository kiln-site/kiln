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
import { InfoCard, InfoCardHeader } from "@/components/info-card"
import { RelayKindIcon, TunnelKindIcon } from "@/components/instance-kind-icon"
import { StatusIndicator } from "@/components/status-indicator"
import {
  gatewayPermissionsOf,
  gatewayStatus,
  gatewayStream,
  type GatewayOverview,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"
import { useCopyFeedback } from "@/components/workspace-header"
import type { ServerAction } from "@/lib/instance-power-state"
import { queryKeys } from "@/lib/query-options"
import { heldPowerActions } from "@/lib/use-instance-power"
import {
  performGatewayAction,
  redeployGateway,
} from "@/server/tunnel-instances"

// A tunnel's gateways: its part on each Relay something it connects is on,
// Tailscale and CoreDNS there. They follow what's connected, so none is
// added here; each can be restarted, stopped, started or deployed again.
export function TunnelGatewaysPage() {
  const { tunnel } = useTunnelWorkspace()
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background/55 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <InfoCard>
          <InfoCardHeader icon={<TunnelKindIcon />} title="Gateways" />
          {tunnel.gateways.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <TunnelKindIcon className="mx-auto size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
              <p className="mt-3 text-sm font-semibold">No gateways yet</p>
              <p className="type-support mx-auto mt-1 max-w-sm text-muted-foreground">
                Connect a game server, App or database to {tunnel.name}, and
                Kiln adds a gateway on its Relay. The last thing to leave a
                Relay takes its gateway with it.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/65">
              <li className="type-technical-label hidden grid-cols-[8rem_minmax(0,1fr)_9rem_6rem_2.5rem] gap-4 px-4 py-2 text-muted-foreground sm:grid">
                <span>Status</span>
                <span>Relay</span>
                <span>Tailscale IP</span>
                <span>Connects</span>
                <span className="sr-only">Actions</span>
              </li>
              {tunnel.gateways.map((gateway) => (
                <GatewayRow
                  key={gateway.id}
                  gateway={gateway}
                  tunnel={tunnel}
                />
              ))}
            </ul>
          )}
        </InfoCard>
      </div>
    </main>
  )
}

const GatewayRow = React.memo(function GatewayRow({
  gateway,
  tunnel,
}: {
  gateway: GatewayOverview
  tunnel: TunnelOverview
}) {
  const connects = tunnel.bindings.filter(
    (binding) => binding.relayId === gateway.relayId
  ).length
  return (
    <li className="grid items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_9rem_6rem_2.5rem]">
      <StatusIndicator status={gatewayStatus(gateway)} />
      <Link
        to="/relay/$relayId"
        params={{ relayId: gateway.relayId }}
        preload="intent"
        className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:text-primary-ink"
      >
        <RelayKindIcon className="size-3.5 shrink-0" />
        <span className="truncate">{gateway.relayName}</span>
      </Link>
      <GatewayAddress address={gateway.status.ipv4Address} />
      <span className="type-meta text-muted-foreground">
        {connects} {connects === 1 ? "instance" : "instances"}
      </span>
      <GatewayActions gateway={gateway} tunnel={tunnel} />
    </li>
  )
})

function GatewayAddress({ address }: { address: string | null }) {
  const { copied, copy } = useCopyFeedback(address ?? "")
  if (!address) {
    return <span className="type-meta text-muted-foreground">Not yet</span>
  }
  return (
    <button
      type="button"
      className="type-meta min-w-0 truncate text-left font-mono text-muted-foreground hover:text-foreground"
      aria-label={`Copy ${address}`}
      onClick={() => void copy()}
    >
      {copied ? "Copied" : address}
    </button>
  )
}

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Actions for the gateway on ${gateway.relayName}`}
          className="justify-self-end"
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
  )
})
