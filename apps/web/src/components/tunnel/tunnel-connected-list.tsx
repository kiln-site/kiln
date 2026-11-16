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
  useTailnetSave,
  type TailnetBinding,
  type TailnetOverview,
} from "@/components/tunnel/tailnet-data"
import { TunnelMemberNames } from "@/components/tunnel/tunnel-member-names"
import {
  tunnelMemberKey,
  useTunnelMemberDirectory,
  type TunnelMemberListing,
} from "@/components/tunnel/tunnel-members"

// What a tailnet connects, through its tunnels or one of them: each game
// server, App service and database, its address on its tunnel, and its
// names. Connecting and disconnecting save the tailnet whole.

const noKeys: ReadonlySet<string> = new Set()

export const TunnelConnectedList = React.memo(function TunnelConnectedList({
  canWrite,
  relayId,
  tailnet,
}: {
  canWrite: boolean
  /** One tunnel's Relay, for its own page; every tunnel's without. */
  relayId?: string
  tailnet: TailnetOverview
}) {
  const directory = useTunnelMemberDirectory()
  const bindings = React.useMemo(
    () =>
      tailnet.bindings
        .filter((binding) => !relayId || binding.relayId === relayId)
        .map((binding) => ({ binding, member: directory.listing(binding) }))
        .sort((left, right) =>
          left.member.name.localeCompare(right.member.name)
        ),
    [directory, relayId, tailnet.bindings]
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
          anywhere on {tailnet.name}.
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
            showRelay={!relayId}
            tailnet={tailnet}
            onDisconnect={setDisconnecting}
          />
        ))}
      </ul>
      {disconnecting ? (
        <DisconnectDialog
          member={disconnecting}
          tailnet={tailnet}
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
  showRelay,
  tailnet,
  onDisconnect,
}: {
  binding: TailnetBinding
  canWrite: boolean
  member: TunnelMemberListing
  showRelay: boolean
  tailnet: TailnetOverview
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
              {showRelay ? ` · ${member.relayName}` : ""}
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
  tailnet,
  onClose,
}: {
  member: TunnelMemberListing
  tailnet: TailnetOverview
  onClose: () => void
}) {
  const save = useTailnetSave()
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {member.name}?</DialogTitle>
          <DialogDescription>
            {member.name} leaves {tailnet.name}, and its names there are
            forgotten. Its tunnel on {member.relayName} stays for what else it
            connects.
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
                        binding.relayId !== member.relayId ||
                        binding.memberId !== member.memberId
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
 * Connects a game server or database through the tailnet's tunnel on its
 * Relay; it's named as it connects. An App's services connect from its
 * Network page, which knows them.
 */
export const TunnelConnectPicker = React.memo(function TunnelConnectPicker({
  relayId,
  tailnet,
}: {
  /** One tunnel's Relay; every Relay the tailnet has a tunnel on without. */
  relayId?: string
  tailnet: TailnetOverview
}) {
  const [open, setOpen] = React.useState(false)
  const directory = useTunnelMemberDirectory()
  const save = useTailnetSave()
  const options = React.useMemo(() => {
    const relays = new Set(
      tailnet.deployments
        .map((deployment) => deployment.relayId)
        .filter((candidate) => !relayId || candidate === relayId)
    )
    const connected = new Set(
      tailnet.bindings.map((binding) =>
        tunnelMemberKey(binding.relayId, binding.memberId)
      )
    )
    return [...directory.joinable.entries()]
      .filter(
        ([key, member]) => relays.has(member.relayId) && !connected.has(key)
      )
      .map(([key, member]): InstancePickerItem => ({
        identity: member.identity,
        key,
        meta: `${member.relayName} · ${member.meta}`,
        name: member.name,
        searchText: `${member.identity.id} ${member.relayName}`,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [directory.joinable, relayId, tailnet.bindings, tailnet.deployments])
  const connect = React.useCallback(
    (option: InstancePickerItem) => {
      const member = directory.joinable.get(option.key)
      if (!member) return
      setOpen(false)
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
    },
    [directory.joinable, save, tailnet]
  )
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          disabled={tailnet.deployments.length === 0 || save.isPending}
        >
          {save.isPending ? (
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
              : "Everything on its Relays is already connected."
          }
          items={options}
          selectedKeys={noKeys}
          onSelect={connect}
        />
        <p className="border-t border-border/70 px-3.5 py-2 text-xs text-muted-foreground">
          An App's services connect from the App's Network page.
        </p>
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})
