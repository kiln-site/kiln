import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Copy,
  EllipsisVertical,
  KeyRound,
  LoaderCircle,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  Server,
  Settings2,
  Unplug,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { forkPromise } from "@/effect/promise"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import {
  ServerPickerList,
  serverPickerOptionKey,
  type ServerPickerOption,
} from "@/components/server-picker-list"
import { TailscaleRelayUpdateHint } from "@/components/tailscale-relay-update-hint"
import {
  queryKeys,
  relaySnapshotQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  defaultTailscaleHostname,
  selectTailscaleServers,
  tailscaleServerKey,
} from "@/lib/tailscale-selectors"
import type { TailscaleServer } from "@/lib/tailscale-selectors"
import {
  showTailscaleOperationError,
  showTailscaleOperationProgress,
  showTailscaleOperationSuccess,
  tailscaleOperationToastId,
  type TailscaleOperation,
} from "@/lib/tailscale-operation-toasts"
import {
  saveTailscaleStack,
  type TailscaleStackOverview,
  type TailscaleStacksResult,
} from "@/server/tailscale"

type StackBinding = TailscaleStackOverview["bindings"][number]
type SaveStackInput = Parameters<typeof saveTailscaleStack>[0]["data"]

const emptyServers: Array<TailscaleServer> = []
const emptyServerKeys = new Set<string>()

export function TailscaleConnectedServersTable({
  searchStore,
  stack,
  onAddServers,
  onSetup,
}: {
  searchStore: WorkspaceTableSearchStore
  stack: TailscaleStackOverview | null
  onAddServers: () => void
  onSetup: () => void
}) {
  if (!stack) {
    return (
      <TailscaleEmptyTable
        actionLabel="Setup Tailscale"
        description="Setup Tailscale before connecting servers"
        icon="network"
        title="No Tailscale networks"
        onAction={onSetup}
      />
    )
  }
  if (stack.cleanup) {
    return (
      <CenteredNetworkState>
        Removing {stack.name}. Cleanup will continue automatically.
      </CenteredNetworkState>
    )
  }
  return (
    <ConnectedServersTableContent
      searchStore={searchStore}
      stack={stack}
      onAddServers={onAddServers}
    />
  )
}

const ConnectedServersTableContent = React.memo(
  function ConnectedServersTableContent({
    searchStore,
    stack,
    onAddServers,
  }: {
    searchStore: WorkspaceTableSearchStore
    stack: TailscaleStackOverview
    onAddServers: () => void
  }) {
    const { data: servers = emptyServers, isPending: serversPending } =
      useQuery({
        ...relaySnapshotQueryOptions(),
        notifyOnChangeProps: ["data", "isPending"],
        select: selectTailscaleServers,
      })
    const connectedServers = React.useMemo(
      () => servers.filter((server) => Boolean(findBinding(stack, server))),
      [servers, stack]
    )
    const save = useStackMembershipMutation()

    return (
      <>
        {save.error ? (
          <p
            className="border-b border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive"
            role="alert"
          >
            {errorMessage(save.error)}
          </p>
        ) : null}
        <TailscaleMembershipTable
          emptyActionLabel="Connect Servers"
          emptyDescription="Add a server to reach it through this tailnet"
          emptyMessage="No connected servers"
          pending={save.isPending}
          searchStore={searchStore}
          servers={connectedServers}
          serversPending={serversPending}
          stack={stack}
          onSave={(bindings, authKey) =>
            save.mutateAsync({ authKey, bindings, stack })
          }
          onEmptyAction={onAddServers}
        />
      </>
    )
  }
)

export const TailscaleConnectServersPopover = React.memo(
  function TailscaleConnectServersPopover({
    open,
    stack,
    onOpenChange,
  }: {
    open: boolean
    stack: TailscaleStackOverview | null
    onOpenChange: (open: boolean) => void
  }) {
    const { data: servers = emptyServers, isPending: serversPending } =
      useQuery({
        ...relaySnapshotQueryOptions(),
        notifyOnChangeProps: ["data", "isPending"],
        select: selectTailscaleServers,
      })
    const availableServers = React.useMemo(
      () =>
        stack
          ? servers.filter((server) => !findBinding(stack, server))
          : emptyServers,
      [servers, stack]
    )
    const options = React.useMemo<Array<ServerPickerOption>>(
      () =>
        availableServers.map((server) => ({
          description: `${server.relayName} · ${server.shortId}`,
          disabled: !server.tailscaleSupported,
          id: server.id,
          kind: "server",
          name: server.name,
          relayId: server.relayId,
          relayName: server.relayName,
        })),
      [availableServers]
    )
    const save = useStackMembershipMutation()
    const pendingBinding =
      stack && save.variables
        ? save.variables.bindings.find(
            (binding) =>
              !stack.bindings.some(
                (candidate) =>
                  stackBindingKey(candidate) === stackBindingKey(binding)
              )
          )
        : undefined
    const pendingKey = pendingBinding
      ? serverPickerOptionKey({
          id: pendingBinding.instanceId,
          name: "",
          relayId: pendingBinding.relayId,
          relayName: "",
          kind: "server",
        })
      : undefined

    const connectServer = React.useCallback(
      (option: ServerPickerOption) => {
        if (!stack) return
        const server = availableServers.find(
          (candidate) =>
            candidate.id === option.id && candidate.relayId === option.relayId
        )
        if (!server) return
        const hostname = uniqueHostname(stack, server)
        save.mutate({
          bindings: [
            ...stack.bindings,
            {
              address: "",
              enabled: true,
              hostname,
              instanceId: server.id,
              relayId: server.relayId,
              relayName: server.relayName,
            },
          ],
          stack,
        })
        onOpenChange(false)
      },
      [availableServers, onOpenChange, save, stack]
    )

    return (
      <Popover open={open && Boolean(stack)} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            disabled={!stack || Boolean(stack.cleanup) || save.isPending}
          >
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Plus />
            )}
            Connect Servers
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(28rem,calc(100vw-2rem))] p-1.5"
        >
          <ServerPickerList
            ariaLabel="Servers available to connect"
            emptyMessage={
              serversPending
                ? "Loading servers…"
                : "Every available server is already connected."
            }
            pendingKey={pendingKey}
            searchPlaceholder="Search servers"
            selectedKeys={emptyServerKeys}
            servers={options}
            onSelect={connectServer}
          />
          {save.error ? (
            <p className="px-2.5 py-2 text-xs text-destructive" role="alert">
              {errorMessage(save.error)}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    )
  }
)

export function GameServerTailscaleSection({
  server,
}: {
  server: InstanceWorkspaceInstance
}) {
  const { data } = useSuspenseQuery(tailscaleStacksQueryOptions())
  const { stacks, unsupportedRelays } = data
  const availableStacks = React.useMemo(
    () => stacks.filter((stack) => !stack.cleanup),
    [stacks]
  )
  const relayUnsupported = unsupportedRelays.some(
    ({ id }) => id === server.relayId
  )
  const save = useStackMembershipMutation()
  const [joiningStackId, setJoiningStackId] = React.useState<string | null>(
    null
  )
  const openJoinDialog = React.useCallback((stackId: string) => {
    setJoiningStackId(stackId)
  }, [])
  const joiningStack = stacks.find(({ id }) => id === joiningStackId)
  const joiningBinding = joiningStack
    ? findBinding(joiningStack, server)
    : undefined
  const closeJoinDialog = React.useCallback((open: boolean) => {
    if (!open) setJoiningStackId(null)
  }, [])
  const joinNetwork = React.useCallback(
    async (hostname: string, authKey?: string) => {
      if (!joiningStack) return
      await save.mutateAsync({
        authKey,
        bindings: joiningBinding
          ? joiningStack.bindings.map((binding) =>
              binding.relayId === server.relayId &&
              binding.instanceId === server.id
                ? { ...binding, hostname }
                : binding
            )
          : [
              ...joiningStack.bindings,
              {
                address: "",
                enabled: true,
                hostname,
                instanceId: server.id,
                relayId: server.relayId,
                relayName: server.relayName,
              },
            ],
        stack: joiningStack,
      })
      setJoiningStackId(null)
    },
    [joiningBinding, joiningStack, save, server]
  )

  return (
    <section className="overflow-hidden border border-border/80 bg-card/45">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Network className="size-4 shrink-0 text-primary" />
          <h2 className="truncate text-sm font-semibold">Tailscale networks</h2>
          <span className="grid size-4 shrink-0 place-items-center">
            {relayUnsupported ? (
              <TailscaleRelayUpdateHint relayName={server.relayName} />
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button asChild size="sm" variant="ghost">
            <Link to="/infra/tailscale">
              <Settings2 />
              Manage
            </Link>
          </Button>
        </div>
      </div>
      {availableStacks.length ? (
        <div className="divide-y divide-border/65">
          {availableStacks.map((stack) => {
            const binding = findBinding(stack, server)
            return (
              <GameServerMembershipRow
                key={stack.id}
                binding={binding}
                disabled={
                  save.isPending || (relayUnsupported && Boolean(binding))
                }
                joinDisabled={relayUnsupported}
                pending={
                  save.isPending && save.variables?.stack.id === stack.id
                }
                stack={stack}
                relayId={server.relayId}
                serverId={server.id}
                onJoin={openJoinDialog}
                onSave={save.mutateAsync}
              />
            )
          })}
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No Tailscale networks are available.
        </p>
      )}
      {save.error ? (
        <p
          className="border-t border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive"
          role="alert"
        >
          {errorMessage(save.error)}
        </p>
      ) : null}
      {joiningStack ? (
        <JoinNetworkDialog
          key={joiningStack.id}
          network={joiningStack}
          initialHostname={joiningBinding?.hostname}
          open
          pending={save.isPending}
          server={server}
          onOpenChange={closeJoinDialog}
          onJoin={joinNetwork}
        />
      ) : null}
    </section>
  )
}

const TailscaleMembershipTable = React.memo(function TailscaleMembershipTable({
  emptyActionLabel,
  emptyDescription,
  emptyMessage,
  pending,
  searchStore,
  servers,
  serversPending,
  stack,
  onEmptyAction,
  onSave,
}: {
  emptyActionLabel?: string
  emptyDescription: string
  emptyMessage: string
  pending: boolean
  searchStore: WorkspaceTableSearchStore
  servers: Array<TailscaleServer>
  serversPending: boolean
  stack: TailscaleStackOverview
  onEmptyAction?: () => void
  onSave: (bindings: Array<StackBinding>, authKey?: string) => Promise<unknown>
}) {
  const renderRow = React.useCallback(
    (server: TailscaleServer) => (
      <TailscaleMembershipRow
        pending={pending}
        server={server}
        stack={stack}
        onSave={onSave}
      />
    ),
    [onSave, pending, stack]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <TailscaleEmptyTable
        actionLabel={
          searchActive || serversPending ? undefined : emptyActionLabel
        }
        description={
          serversPending
            ? "Loading the server inventory."
            : searchActive
              ? "Try a server name, short ID, or Relay."
              : emptyDescription
        }
        icon="server"
        title={
          serversPending
            ? "Loading servers…"
            : searchActive
              ? "No servers match your search"
              : emptyMessage
        }
        onAction={searchActive || serversPending ? undefined : onEmptyAction}
      />
    ),
    [
      emptyActionLabel,
      emptyDescription,
      emptyMessage,
      onEmptyAction,
      serversPending,
    ]
  )
  const getRowKey = React.useCallback(
    (server: TailscaleServer) =>
      `${stack.id}:${serverRowKey(server)}:${findBinding(stack, server)?.hostname ?? ""}:${findBinding(stack, server)?.enabled ?? true}`,
    [stack]
  )
  const getSearchText = React.useCallback(
    (server: TailscaleServer) => {
      const binding = findBinding(stack, server)
      return `${serverSearchText(server)} ${binding?.hostname ?? ""} ${binding?.enabled === false ? "paused" : "connected"}`
    },
    [stack]
  )

  return (
    <WorkspaceDataTable
      getRowKey={getRowKey}
      getSearchText={getSearchText}
      head={<MembershipTableHead />}
      items={servers}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const MembershipTableHead = React.memo(function MembershipTableHead() {
  return (
    <WorkspaceTableHead className="sticky top-0 z-10">
      <WorkspaceTableHeading className="w-32">Status</WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[28%]">
        Server name
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[22%] md:table-cell">
        Relay name
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[30%] sm:table-cell">
        Hostname
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-32 text-right">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const TailscaleMembershipRow = React.memo(function TailscaleMembershipRow({
  pending,
  server,
  stack,
  onSave,
}: {
  pending: boolean
  server: TailscaleServer
  stack: TailscaleStackOverview
  onSave: (bindings: Array<StackBinding>, authKey?: string) => Promise<unknown>
}) {
  const binding = findBinding(stack, server)
  const [hostname, setHostname] = React.useState(binding?.hostname ?? "")
  const deployment = stack.deployments.find(
    (deployment) => deployment.relayId === server.relayId
  )
  const disabled = pending || !server.tailscaleSupported
  const dirty = Boolean(binding && hostname.trim() !== binding.hostname)
  const status = tailscaleMembershipStatus(binding, deployment, server)

  if (!binding) return null

  const updateBinding = (next: Partial<StackBinding>) =>
    onSave(
      stack.bindings.map((candidate) =>
        stackBindingKey(candidate) === stackBindingKey(binding)
          ? { ...candidate, ...next }
          : candidate
      )
    )

  const saveHostname = () => {
    const nextHostname = hostname.trim()
    if (!dirty || !nextHostname || disabled) return
    forkPromise(() => updateBinding({ hostname: nextHostname }))
  }

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell>
        <div className="flex items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${status.dotClass}`}
          />
          <span className="truncate text-xs font-medium">{status.label}</span>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-xs font-semibold">{server.name}</p>
            <span className="grid size-4 shrink-0 place-items-center md:hidden">
              {!server.tailscaleSupported ? (
                <TailscaleRelayUpdateHint relayName={server.relayName} />
              ) : null}
            </span>
          </div>
          <p className="type-meta truncate text-muted-foreground md:hidden">
            {server.relayName}
          </p>
          <p className="type-meta truncate font-mono text-muted-foreground sm:hidden">
            {binding.hostname}.{stack.domain}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-muted-foreground">
            {server.relayName}
          </span>
          <span className="grid size-4 shrink-0 place-items-center">
            {!server.tailscaleSupported ? (
              <TailscaleRelayUpdateHint relayName={server.relayName} />
            ) : null}
          </span>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden sm:table-cell">
        <div className="flex min-w-0 items-center gap-1.5">
          <Input
            value={hostname}
            disabled={disabled}
            onBlur={saveHostname}
            onChange={(event) => setHostname(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur()
              if (event.key === "Escape") {
                setHostname(binding.hostname)
                event.currentTarget.blur()
              }
            }}
            aria-label={`Hostname for ${server.name}`}
            className="h-8 min-w-0 font-mono text-xs"
          />
          <span className="type-meta hidden shrink-0 font-mono text-muted-foreground lg:inline">
            .{stack.domain}
          </span>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <div className="flex items-center justify-end gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`${binding.enabled ? "Pause" : "Resume"} ${server.name}`}
                onClick={() =>
                  forkPromise(() =>
                    updateBinding({ enabled: !binding.enabled })
                  )
                }
              >
                {pending ? (
                  <LoaderCircle className="animate-spin" />
                ) : binding.enabled ? (
                  <Pause />
                ) : (
                  <Play />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {binding.enabled ? "Pause connection" : "Resume connection"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`Disconnect ${server.name} from ${stack.name}`}
                onClick={() =>
                  forkPromise(() =>
                    onSave(
                      stack.bindings.filter(
                        (candidate) =>
                          stackBindingKey(candidate) !==
                          stackBindingKey(binding)
                      )
                    )
                  )
                }
              >
                <Unplug />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Disconnect server</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`More actions for ${server.name}`}
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <CopyIdentifierMenuItem label="server ID" value={server.id} />
              <CopyIdentifierMenuItem label="Relay ID" value={server.relayId} />
              <CopyIdentifierMenuItem label="tailnet ID" value={stack.id} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

function CopyIdentifierMenuItem({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <DropdownMenuItem
      onSelect={() => {
        forkPromise(async () => {
          await navigator.clipboard.writeText(value)
          showToast({ message: `Copied ${label}`, type: "success" })
        })
      }}
    >
      <Copy />
      Copy {label}
    </DropdownMenuItem>
  )
}

const GameServerMembershipRow = React.memo(function GameServerMembershipRow({
  binding,
  disabled,
  joinDisabled,
  pending,
  relayId,
  serverId,
  stack,
  onJoin,
  onSave,
}: {
  binding?: StackBinding
  disabled: boolean
  joinDisabled: boolean
  pending: boolean
  relayId: string
  serverId: string
  stack: TailscaleStackOverview
  onJoin: (stackId: string) => void
  onSave: ReturnType<typeof useStackMembershipMutation>["mutateAsync"]
}) {
  return (
    <div className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold">{stack.name}</p>
        <p className="type-meta mt-0.5 truncate font-mono text-muted-foreground">
          {binding ? binding.address : `*.${stack.domain}`}
        </p>
      </div>
      <p className="type-code min-w-0 truncate text-muted-foreground">
        {binding ? `${binding.hostname}.${stack.domain}` : "Not connected"}
      </p>
      <div className="flex items-center justify-end gap-1">
        {binding ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Edit ${binding.hostname}.${stack.domain}`}
                  onClick={() => onJoin(stack.id)}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Edit hostname</TooltipContent>
            </Tooltip>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                forkPromise(() =>
                  onSave({
                    bindings: stack.bindings.filter(
                      (candidate) =>
                        candidate.relayId !== relayId ||
                        candidate.instanceId !== serverId
                    ),
                    stack,
                  })
                )
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Unplug />}
              Leave
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || joinDisabled}
            onClick={() => onJoin(stack.id)}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Network />}
            Join
          </Button>
        )}
      </div>
    </div>
  )
})

const JoinNetworkDialog = React.memo(function JoinNetworkDialog({
  initialHostname,
  network,
  open,
  pending,
  server,
  onOpenChange,
  onJoin,
}: {
  initialHostname?: string
  network: TailscaleStackOverview
  open: boolean
  pending: boolean
  server: InstanceWorkspaceInstance
  onOpenChange: (open: boolean) => void
  onJoin: (hostname: string, authKey?: string) => Promise<void>
}) {
  const [hostname, setHostname] = React.useState(
    () => initialHostname ?? defaultTailscaleHostname(server)
  )
  const [authKey, setAuthKey] = React.useState("")
  const needsAuth = Boolean(
    !initialHostname &&
    !network.integration &&
    !network.deployments.some(
      (deployment) => deployment.relayId === server.relayId
    )
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initialHostname ? "Edit hostname" : `Join ${network.name}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Hostname</span>
            <div className="flex items-center">
              <Input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                className="min-w-0 rounded-r-none font-mono"
              />
              <span className="flex h-9 shrink-0 items-center border border-l-0 border-input bg-muted/30 px-3 font-mono text-xs text-muted-foreground">
                .{network.domain}
              </span>
            </div>
          </label>
          {needsAuth ? (
            <label className="block">
              <span className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <KeyRound className="size-3.5" />
                Auth key for this node
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={authKey}
                onChange={(event) => setAuthKey(event.target.value)}
                placeholder="tskey-auth-…"
                className="font-mono"
              />
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              pending || !hostname.trim() || (needsAuth && !authKey.trim())
            }
            onClick={() =>
              forkPromise(() =>
                onJoin(hostname.trim(), needsAuth ? authKey.trim() : undefined)
              )
            }
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Network />}
            {initialHostname ? "Save hostname" : "Join"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

function useStackMembershipMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      authKey,
      bindings,
      stack,
    }: {
      authKey?: string
      bindings: Array<StackBinding>
      stack: TailscaleStackOverview
    }) => {
      try {
        return {
          data: await saveTailscaleStack({
            data: stackSaveInput(stack, bindings, authKey),
          }),
          reconcile: false,
        }
      } catch (cause) {
        if (!isFailedFetch(cause)) throw cause
        const pending = queryClient.getQueryData<TailscaleStacksResult>(
          queryKeys.tailscaleStacks
        )
        if (pending) {
          return { data: pending, reconcile: true }
        }
        throw cause
      }
    },
    onMutate: async ({ bindings, stack }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tailscaleStacks })
      const previous = queryClient.getQueryData<TailscaleStacksResult>(
        queryKeys.tailscaleStacks
      )
      queryClient.setQueryData<TailscaleStacksResult>(
        queryKeys.tailscaleStacks,
        (current) =>
          current
            ? {
                ...current,
                stacks: current.stacks.map((candidate) =>
                  candidate.id === stack.id
                    ? { ...candidate, bindings }
                    : candidate
                ),
              }
            : current
      )
      const toast = membershipOperationToast(stack, bindings)
      showTailscaleOperationProgress(toast)
      return { previous, toast }
    },
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next.data)
      forkPromise(async () => {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.relay.snapshot,
        })
        if (next.reconcile) {
          await new Promise((resolve) => setTimeout(resolve, 1_500))
          await queryClient.invalidateQueries({
            queryKey: queryKeys.tailscaleStacks,
          })
        }
      })
    },
    onError: (cause, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.tailscaleStacks, context.previous)
      }
      if (context?.toast) {
        showTailscaleOperationError(context.toast, cause)
      }
      forkPromise(() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.tailscaleStacks })
      )
    },
    onSettled: (_data, error, _input, context) => {
      if (!error && context?.toast) {
        showTailscaleOperationSuccess(context.toast)
      }
    },
  })
}

function membershipOperationToast(
  stack: TailscaleStackOverview,
  bindings: Array<StackBinding>
) {
  const currentBindingKeys = new Set(stack.bindings.map(stackBindingKey))
  const nextBindingKeys = new Set(bindings.map(stackBindingKey))
  const added = bindings.some(
    (binding) => !currentBindingKeys.has(stackBindingKey(binding))
  )
  const removed = stack.bindings.some(
    (binding) => !nextBindingKeys.has(stackBindingKey(binding))
  )
  const deployedRelayIds = new Set(
    stack.deployments.map(({ relayId }) => relayId)
  )
  const newRelayIds = new Set<string>()
  for (const { relayId } of bindings) {
    if (!deployedRelayIds.has(relayId)) {
      newRelayIds.add(relayId)
    }
  }
  const operation: TailscaleOperation =
    newRelayIds.size > 0
      ? "install"
      : added
        ? "connect"
        : removed
          ? "disconnect"
          : "update"

  return {
    id: tailscaleOperationToastId(stack.id),
    networkName: stack.name,
    nodeCount: operation === "install" ? newRelayIds.size : undefined,
    operation,
  }
}

function stackBindingKey({
  instanceId,
  relayId,
}: Pick<StackBinding, "instanceId" | "relayId">): string {
  return `${relayId}:${instanceId}`
}

function isFailedFetch(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    cause.message === "Failed to fetch"
  )
}

function stackSaveInput(
  stack: TailscaleStackOverview,
  bindings: Array<StackBinding>,
  authKey?: string,
  domain = stack.domain
): SaveStackInput {
  return {
    ...(authKey ? { authKey } : {}),
    bindings: bindings.map(({ enabled, hostname, instanceId, relayId }) => ({
      enabled,
      hostname,
      instanceId,
      relayId,
    })),
    domain,
    id: stack.id,
    name: stack.name,
  }
}

function findBinding(
  stack: TailscaleStackOverview,
  server: Pick<TailscaleServer, "id" | "relayId">
) {
  return stack.bindings.find(
    (binding) =>
      binding.relayId === server.relayId && binding.instanceId === server.id
  )
}

function uniqueHostname(
  stack: TailscaleStackOverview,
  server: TailscaleServer
): string {
  const base = defaultTailscaleHostname(server)
  const hostnames = new Set(
    stack.bindings.map((binding) => binding.hostname.toLowerCase())
  )
  if (!hostnames.has(base.toLowerCase())) return base
  const suffix = server.shortId.toLowerCase().replace(/[^a-z0-9-]/gu, "")
  const candidate = `${base}-${suffix}`
  if (!hostnames.has(candidate)) return candidate
  for (let index = 2; index < 1_000; index += 1) {
    const indexedCandidate = `${candidate}-${index}`
    if (!hostnames.has(indexedCandidate)) return indexedCandidate
  }
  return `${candidate}-${Date.now().toString(36)}`
}

function tailscaleMembershipStatus(
  binding: StackBinding | undefined,
  deployment: TailscaleStackOverview["deployments"][number] | undefined,
  server: TailscaleServer
) {
  if (!binding?.enabled) {
    return { dotClass: "bg-muted-foreground/55", label: "Paused" }
  }
  if (!server.tailscaleSupported) {
    return { dotClass: "bg-amber-400", label: "Update required" }
  }
  if (!deployment) {
    return { dotClass: "animate-pulse bg-primary", label: "Provisioning" }
  }
  if (
    deployment.status.connected &&
    deployment.components.coreDnsRunning &&
    deployment.components.tailscaleRunning
  ) {
    return { dotClass: "bg-emerald-400", label: "Connected" }
  }
  if (deployment.status.message) {
    return { dotClass: "bg-destructive", label: "Needs attention" }
  }
  return { dotClass: "bg-amber-400", label: "Connecting" }
}

function serverRowKey(server: TailscaleServer) {
  return tailscaleServerKey(server.relayId, server.id)
}

function serverSearchText(server: TailscaleServer) {
  return `${server.name} ${server.shortId} ${server.relayName}`
}

function CenteredNetworkState({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-64 place-items-center px-6 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

function TailscaleEmptyTable({
  actionLabel,
  description,
  icon,
  title,
  onAction,
}: {
  actionLabel?: string
  description: string
  icon: "network" | "server"
  title: string
  onAction?: () => void
}) {
  const Icon = icon === "network" ? Network : Server

  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="type-support mt-1 max-w-sm text-muted-foreground">
        {description}
      </p>
      {actionLabel && onAction ? (
        <Button type="button" size="sm" className="mt-4" onClick={onAction}>
          <Plus /> {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The Tailscale network could not be updated."
}
