import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { LoaderCircle, Plus, Unplug } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { InfoCard, InfoCardHeader } from "@/components/info-card"
import { TunnelKindIcon } from "@/components/instance-kind-icon"
import { StatusIndicator } from "@/components/status-indicator"
import {
  gatewayStatus,
  useTunnelConnection,
  useTunnels,
  type TunnelMemberRef,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import { TunnelMemberNames } from "@/components/tunnel/tunnel-member-names"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

/**
 * A game server, a database, or an App's service, as it connects to
 * tunnels: through each one's gateway on its own Relay. Named by its member
 * ID (`instanceTailscaleMemberId`, `appTailscaleMemberId`,
 * `databaseTailscaleMemberId`).
 */
export type TunnelMember = TunnelMemberRef

// An instance's Network tab: each tunnel it's connected to, with its names
// there, and connecting to others. Connecting adds the tunnel's gateway on
// its Relay when there's none yet.
export function InstanceTunnelsSection({
  member,
  title = "Tunnels",
}: {
  member: TunnelMember
  title?: string
}) {
  const { data, error, isPending } = useTunnels()
  const { data: isPlatformAdmin = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })
  const tunnels = React.useMemo(
    () => data.tunnels.filter((tunnel) => !tunnel.cleanup),
    [data.tunnels]
  )
  const connected = React.useMemo(
    () =>
      tunnels.filter((tunnel) =>
        tunnel.bindings.some(
          (binding) =>
            binding.memberId === member.memberId &&
            binding.relayId === member.relayId
        )
      ),
    [member.memberId, member.relayId, tunnels]
  )
  // Someone who sees no tunnel and can't make one has nothing here.
  if (!isPending && tunnels.length === 0 && !isPlatformAdmin) return null

  return (
    <InfoCard>
      <InfoCardHeader
        icon={<TunnelKindIcon />}
        title={title}
        action={
          <ConnectMenu
            canAdd={isPlatformAdmin}
            connected={connected}
            member={member}
            tunnels={tunnels}
          />
        }
      />
      {isPending ? (
        <div className="grid gap-2 px-4 py-3" aria-busy="true">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-2.5 w-48" />
        </div>
      ) : error ? (
        <p
          className="px-4 py-6 text-center text-xs text-destructive"
          role="alert"
        >
          {error.message}
        </p>
      ) : connected.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          Not connected to a tunnel. Connect it to reach it by name from
          anywhere on your tailnet.
        </p>
      ) : (
        <ul className="divide-y divide-border/65">
          {connected.map((tunnel) => (
            <ConnectedTunnel key={tunnel.id} member={member} tunnel={tunnel} />
          ))}
        </ul>
      )}
    </InfoCard>
  )
}

const ConnectedTunnel = React.memo(function ConnectedTunnel({
  member,
  tunnel,
}: {
  member: TunnelMember
  tunnel: TunnelOverview
}) {
  const [disconnecting, setDisconnecting] = React.useState(false)
  const gateway = tunnel.gateways.find(
    ({ relayId }) => relayId === member.relayId
  )
  const binding = tunnel.bindings.find(
    (candidate) =>
      candidate.memberId === member.memberId &&
      candidate.relayId === member.relayId
  )
  const canWrite = tunnel.access.manage
  return (
    <li className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <Link
          to="/tunnel/$tunnelId/connected"
          params={{ tunnelId: tunnel.id }}
          className="block truncate text-xs font-semibold hover:text-primary-ink"
        >
          {tunnel.name}
        </Link>
        <p className="type-meta mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {gateway ? <StatusIndicator status={gatewayStatus(gateway)} /> : null}
          <span className="truncate font-mono">
            {binding?.address || "Address pending"}
          </span>
        </p>
      </div>
      <TunnelMemberNames
        canWrite={canWrite}
        memberId={member.memberId}
        memberName={member.name}
        tunnel={tunnel}
      />
      {canWrite ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="justify-self-end text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
              aria-label={`Disconnect from ${tunnel.name}`}
              onClick={() => setDisconnecting(true)}
            >
              <Unplug />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Disconnect</TooltipContent>
        </Tooltip>
      ) : null}
      {disconnecting ? (
        <DisconnectDialog
          member={member}
          tunnel={tunnel}
          onClose={() => setDisconnecting(false)}
        />
      ) : null}
    </li>
  )
})

function DisconnectDialog({
  member,
  tunnel,
  onClose,
}: {
  member: TunnelMember
  tunnel: TunnelOverview
  onClose: () => void
}) {
  const connection = useTunnelConnection()
  const last = !tunnel.bindings.some(
    (binding) =>
      binding.relayId === member.relayId && binding.memberId !== member.memberId
  )
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect from {tunnel.name}?</DialogTitle>
          <DialogDescription>
            {member.name} leaves {tunnel.name}, and its names there are
            forgotten.
            {last
              ? ` Nothing else on ${member.relayName} connects to it, so its gateway there is removed too.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={connection.isPending}
            onClick={() =>
              connection.mutate(
                { connected: false, member, tunnel },
                { onSuccess: onClose }
              )
            }
          >
            {connection.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Unplug />
            )}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The tunnels it can connect to: every one the viewer manages. One without
 * a gateway on its Relay adds one, which needs the tunnel's Tailscale login.
 */
function ConnectMenu({
  canAdd,
  connected,
  member,
  tunnels,
}: {
  /** Whether they may make a tunnel. */
  canAdd: boolean
  connected: ReadonlyArray<TunnelOverview>
  member: TunnelMember
  tunnels: ReadonlyArray<TunnelOverview>
}) {
  const connection = useTunnelConnection()
  const managed = tunnels.filter(
    (tunnel) => tunnel.access.manage && !connected.includes(tunnel)
  )
  if (managed.length === 0 && (!canAdd || connected.length > 0)) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={connection.isPending}
        >
          {connection.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Plus />
          )}
          Connect
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {managed.length > 0 ? (
          <DropdownMenuLabel>Connect to a tunnel</DropdownMenuLabel>
        ) : null}
        {managed.map((tunnel) => {
          const gateway = tunnel.gateways.some(
            ({ relayId }) => relayId === member.relayId
          )
          const needsLogin = !gateway && tunnel.integration === null
          return (
            <DropdownMenuItem
              key={tunnel.id}
              disabled={needsLogin}
              onSelect={() =>
                connection.mutate({ connected: true, member, tunnel })
              }
            >
              <TunnelKindIcon className="size-3.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{tunnel.name}</span>
                <span className="type-meta block text-muted-foreground">
                  {gateway
                    ? `Through its gateway on ${member.relayName}`
                    : needsLogin
                      ? "Needs its Tailscale login first, on its Info page"
                      : `Adds a gateway on ${member.relayName}`}
                </span>
              </span>
              <span className="type-meta font-mono text-muted-foreground">
                .{tunnel.domains[0]}
              </span>
            </DropdownMenuItem>
          )
        })}
        {managed.length === 0 ? (
          <DropdownMenuItem asChild>
            <Link to="/infra/tunnels">
              <Plus className="size-3.5" />
              Add a tunnel
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
