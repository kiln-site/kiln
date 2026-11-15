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
  DropdownMenuSeparator,
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
  tunnelStatus,
  useTailnetSave,
  useTailnets,
  type TailnetOverview,
} from "@/components/tunnel/tailnet-data"
import { TunnelMemberNames } from "@/components/tunnel/tunnel-member-names"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

/**
 * A game server, a database, or an App's service, as it connects to
 * tailnets: through each one's tunnel on its own Relay. Named by its member
 * ID (`instanceTailscaleMemberId`, `appTailscaleMemberId`,
 * `databaseTailscaleMemberId`).
 */
export interface TunnelMember {
  memberId: string
  name: string
  relayId: string
  relayName: string
}

// An instance's Network tab: each tailnet it's connected to, with its
// names there, and connecting to others with a tunnel on its Relay.
export function InstanceTunnelsSection({
  member,
  title = "Tunnels",
}: {
  member: TunnelMember
  title?: string
}) {
  const { data, error, isPending } = useTailnets()
  const { data: isPlatformAdmin = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })
  const tailnets = React.useMemo(
    () => data.stacks.filter((tailnet) => !tailnet.cleanup),
    [data.stacks]
  )
  const connected = React.useMemo(
    () =>
      tailnets.filter((tailnet) =>
        tailnet.bindings.some(
          (binding) =>
            binding.memberId === member.memberId &&
            binding.relayId === member.relayId
        )
      ),
    [member.memberId, member.relayId, tailnets]
  )
  // Someone who sees no tailnet and can't make one has nothing here.
  if (!isPending && tailnets.length === 0 && !isPlatformAdmin) return null

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
            tailnets={tailnets}
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
          Not connected to a tailnet. Connect it to reach it by name from
          anywhere on one.
        </p>
      ) : (
        <ul className="divide-y divide-border/65">
          {connected.map((tailnet) => (
            <ConnectedTailnet
              key={tailnet.id}
              member={member}
              tailnet={tailnet}
            />
          ))}
        </ul>
      )}
    </InfoCard>
  )
}

const ConnectedTailnet = React.memo(function ConnectedTailnet({
  member,
  tailnet,
}: {
  member: TunnelMember
  tailnet: TailnetOverview
}) {
  const [disconnecting, setDisconnecting] = React.useState(false)
  const tunnel = tailnet.deployments.find(
    (deployment) => deployment.relayId === member.relayId
  )
  const binding = tailnet.bindings.find(
    (candidate) =>
      candidate.memberId === member.memberId &&
      candidate.relayId === member.relayId
  )
  const canWrite = tailnet.access.manage
  return (
    <li className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <Link
          to="/tailnet/$tailnetId"
          params={{ tailnetId: tailnet.id }}
          className="block truncate text-xs font-semibold hover:text-primary-ink"
        >
          {tailnet.name}
        </Link>
        <p className="type-meta mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {tunnel ? <StatusIndicator status={tunnelStatus(tunnel)} /> : null}
          <span className="truncate font-mono">
            {binding?.address || "Address pending"}
          </span>
        </p>
      </div>
      <TunnelMemberNames
        canWrite={canWrite}
        memberId={member.memberId}
        memberName={member.name}
        tailnet={tailnet}
      />
      {canWrite ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="justify-self-end text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
              aria-label={`Disconnect from ${tailnet.name}`}
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
          tailnet={tailnet}
          onClose={() => setDisconnecting(false)}
        />
      ) : null}
    </li>
  )
})

function DisconnectDialog({
  member,
  tailnet,
  onClose,
}: {
  member: TunnelMember
  tailnet: TailnetOverview
  onClose: () => void
}) {
  const save = useTailnetSave()
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect from {tailnet.name}?</DialogTitle>
          <DialogDescription>
            {member.name} leaves {tailnet.name}, and its names there are
            forgotten.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  change: {
                    bindings: tailnet.bindings.filter(
                      (binding) =>
                        binding.memberId !== member.memberId ||
                        binding.relayId !== member.relayId
                    ),
                  },
                  doing: `Disconnecting ${member.name}`,
                  done: `${member.name} is disconnected`,
                  tailnet,
                },
                { onSuccess: onClose }
              )
            }
          >
            {save.isPending ? (
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
 * The tailnets it can connect to: those with a tunnel on its Relay. One
 * without points to adding a tunnel there.
 */
function ConnectMenu({
  canAdd,
  connected,
  member,
  tailnets,
}: {
  /** Whether they may add a tailnet's first tunnel. */
  canAdd: boolean
  connected: ReadonlyArray<TailnetOverview>
  member: TunnelMember
  tailnets: ReadonlyArray<TailnetOverview>
}) {
  const save = useTailnetSave()
  const managed = tailnets.filter(
    (tailnet) => tailnet.access.manage && !connected.includes(tailnet)
  )
  const reachable = managed.filter((tailnet) =>
    tailnet.deployments.some(({ relayId }) => relayId === member.relayId)
  )
  const unreachable = managed.filter((tailnet) => !reachable.includes(tailnet))
  if (managed.length === 0 && (!canAdd || connected.length > 0)) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={save.isPending}
        >
          {save.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Plus />
          )}
          Connect
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {reachable.length > 0 ? (
          <DropdownMenuLabel>
            Through its tunnel on {member.relayName}
          </DropdownMenuLabel>
        ) : null}
        {reachable.map((tailnet) => (
          <DropdownMenuItem
            key={tailnet.id}
            onSelect={() =>
              save.mutate({
                change: {
                  bindings: [
                    ...tailnet.bindings,
                    {
                      enabled: true,
                      memberId: member.memberId,
                      relayId: member.relayId,
                    },
                  ],
                },
                doing: `Connecting ${member.name}`,
                done: `${member.name} is connected`,
                tailnet,
              })
            }
          >
            <TunnelKindIcon className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{tailnet.name}</span>
            <span className="type-meta font-mono text-muted-foreground">
              .{tailnet.domains[0]}
            </span>
          </DropdownMenuItem>
        ))}
        {reachable.length > 0 && unreachable.length > 0 ? (
          <DropdownMenuSeparator />
        ) : null}
        {unreachable.length > 0 ? (
          <DropdownMenuLabel>
            No tunnel on {member.relayName} yet
          </DropdownMenuLabel>
        ) : null}
        {unreachable.map((tailnet) => (
          <DropdownMenuItem key={tailnet.id} asChild>
            <Link to="/tailnet/$tailnetId" params={{ tailnetId: tailnet.id }}>
              <Plus className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                Add one to {tailnet.name}
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
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
