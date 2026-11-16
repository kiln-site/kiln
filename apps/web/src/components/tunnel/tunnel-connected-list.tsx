import * as React from "react"
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { InstanceCard } from "@/components/instance-card"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { ServerKindIcon } from "@/components/instance-kind-icon"
import {
  useTunnelConnection,
  type TunnelBinding,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import { TunnelMemberNames } from "@/components/tunnel/tunnel-member-names"
import {
  tunnelMemberKey,
  useTunnelMemberDirectory,
  type TunnelMemberListing,
} from "@/components/tunnel/tunnel-members"

// What a tunnel connects: each game server, App service and database, the
// Relay it's on, its address on the gateway there, and its names. Connecting
// the first thing on a Relay adds the tunnel's gateway there; the last to
// leave takes it away.

const noKeys: ReadonlySet<string> = new Set()

export const TunnelConnectedList = React.memo(function TunnelConnectedList({
  canWrite,
  tunnel,
}: {
  canWrite: boolean
  tunnel: TunnelOverview
}) {
  const directory = useTunnelMemberDirectory()
  const bindings = React.useMemo(
    () =>
      tunnel.bindings
        .map((binding) => ({ binding, member: directory.listing(binding) }))
        .sort((left, right) =>
          left.member.name.localeCompare(right.member.name)
        ),
    [directory, tunnel.bindings]
  )
  const [disconnecting, setDisconnecting] =
    React.useState<TunnelMemberListing | null>(null)

  if (bindings.length === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <ServerKindIcon className="mx-auto size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
        <p className="mt-3 text-sm font-semibold">Nothing is connected</p>
        <p className="type-support mx-auto mt-1 max-w-sm text-muted-foreground">
          Connect a game server, App or database to reach it by name from
          anywhere on {tunnel.name}. Kiln adds a gateway on its Relay.
        </p>
      </div>
    )
  }
  return (
    <>
      <ul className="divide-y divide-border/65">
        {bindings.map(({ binding, member }) => (
          <ConnectedRow
            key={tunnelMemberKey(binding.relayId, binding.memberId)}
            binding={binding}
            canWrite={canWrite}
            member={member}
            tunnel={tunnel}
            onDisconnect={setDisconnecting}
          />
        ))}
      </ul>
      {disconnecting ? (
        <DisconnectDialog
          member={disconnecting}
          tunnel={tunnel}
          onClose={() => setDisconnecting(null)}
        />
      ) : null}
    </>
  )
})

const ConnectedRow = React.memo(function ConnectedRow({
  binding,
  canWrite,
  member,
  tunnel,
  onDisconnect,
}: {
  binding: TunnelBinding
  canWrite: boolean
  member: TunnelMemberListing
  tunnel: TunnelOverview
  onDisconnect: (member: TunnelMemberListing) => void
}) {
  return (
    <li className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center">
      <MemberLink member={member}>
        <InstanceCard
          className="min-w-0 flex-1"
          instance={member.identity}
          meta={
            <>
              {binding.address || "Address pending"}
              {` · ${member.relayName}`}
              {binding.enabled ? "" : " · Paused"}
            </>
          }
          metaClassName="font-mono"
          name={member.name}
          nameClassName="transition-colors group-hover/member-link:text-primary-ink"
          showFavorite={false}
          // A member's own state shows on its own page.
          showStatus={false}
        />
      </MemberLink>
      <TunnelMemberNames
        canWrite={canWrite}
        memberId={binding.memberId}
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
              aria-label={`Disconnect ${member.name}`}
              onClick={() => onDisconnect(member)}
            >
              <Unplug />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Disconnect</TooltipContent>
        </Tooltip>
      ) : null}
    </li>
  )
})

function MemberLink({
  children,
  member,
}: {
  children: React.ReactNode
  member: TunnelMemberListing
}) {
  const className =
    "group/member-link flex min-w-0 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
  if (!member.linked) return <div className={className}>{children}</div>
  switch (member.kind) {
    case "server":
      return (
        <Link
          to="/server/$serverId/network"
          params={{ serverId: member.id }}
          preload="intent"
          className={className}
        >
          {children}
        </Link>
      )
    case "app":
      return (
        <Link
          to="/app/$appId/network"
          params={{ appId: member.id }}
          preload="intent"
          className={className}
        >
          {children}
        </Link>
      )
    case "database":
      return (
        <Link
          to="/db/$databaseId/network"
          params={{ databaseId: member.id }}
          preload="intent"
          className={className}
        >
          {children}
        </Link>
      )
  }
}

function DisconnectDialog({
  member,
  tunnel,
  onClose,
}: {
  member: TunnelMemberListing
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
          <DialogTitle>Disconnect {member.name}?</DialogTitle>
          <DialogDescription>
            {member.name} leaves {tunnel.name}, and its names there are
            forgotten.{" "}
            {last
              ? `Nothing else on ${member.relayName} connects to it, so its gateway there is removed too.`
              : `Its gateway on ${member.relayName} stays for what else connects through it.`}
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
 * Connects a game server or database to the tunnel, through its gateway on
 * the thing's Relay, which is added if the tunnel has none there. It's named
 * as it connects. An App's services connect from its Network page, which
 * knows them.
 */
export const TunnelConnectPicker = React.memo(function TunnelConnectPicker({
  tunnel,
}: {
  tunnel: TunnelOverview
}) {
  const [open, setOpen] = React.useState(false)
  const directory = useTunnelMemberDirectory()
  const connection = useTunnelConnection()
  const gatewayRelays = React.useMemo(
    () => new Set(tunnel.gateways.map(({ relayId }) => relayId)),
    [tunnel.gateways]
  )
  const options = React.useMemo(() => {
    const connected = new Set(
      tunnel.bindings.map((binding) =>
        tunnelMemberKey(binding.relayId, binding.memberId)
      )
    )
    return [...directory.joinable.entries()]
      .filter(([key]) => !connected.has(key))
      .map(([key, member]): InstancePickerItem => ({
        identity: member.identity,
        key,
        meta: `${member.relayName} · ${member.meta}${
          gatewayRelays.has(member.relayId) ? "" : " · adds a gateway"
        }`,
        name: member.name,
        searchText: `${member.identity.id} ${member.relayName}`,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [directory.joinable, gatewayRelays, tunnel.bindings])
  const connect = React.useCallback(
    (option: InstancePickerItem) => {
      const member = directory.joinable.get(option.key)
      if (!member) return
      setOpen(false)
      connection.mutate({ connected: true, member, tunnel })
    },
    [connection, directory.joinable, tunnel]
  )
  // A gateway it adds logs in with a key made with the tunnel's login.
  const needsLogin = tunnel.integration === null
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          disabled={connection.isPending || tunnel.cleanup !== null}
        >
          {connection.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Plus />
          )}
          Connect
        </Button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="Connect game servers and databases"
        align="end"
        className="w-[min(28rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <InstancePickerContent
          ariaLabel="Game servers and databases"
          emptyMessage={
            directory.pending
              ? "Loading…"
              : "Every game server and database is already connected."
          }
          items={options}
          selectedKeys={noKeys}
          onSelect={connect}
        />
        <p className="border-t border-border/70 px-3.5 py-2 text-xs text-muted-foreground">
          {needsLogin
            ? `Something on a Relay ${tunnel.name} has no gateway on needs its Tailscale login first, on its Info page. `
            : ""}
          An App's services connect from the App's Network page.
        </p>
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})
