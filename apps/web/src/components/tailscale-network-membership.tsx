import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  Unplug,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { Switch } from "@workspace/ui/components/switch"
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
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
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
} from "@/server/tailscale"

type StackBinding = TailscaleStackOverview["bindings"][number]
type SaveStackInput = Parameters<typeof saveTailscaleStack>[0]["data"]

const emptyServers: Array<TailscaleServer> = []

export function TailscaleConnectedServersTable({
  searchStore,
  stack,
}: {
  searchStore: WorkspaceTableSearchStore
  stack: TailscaleStackOverview | null
}) {
  if (!stack) {
    return (
      <CenteredNetworkState>Select a Tailscale network.</CenteredNetworkState>
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
    <ConnectedServersTableContent searchStore={searchStore} stack={stack} />
  )
}

const ConnectedServersTableContent = React.memo(
  function ConnectedServersTableContent({
    searchStore,
    stack,
  }: {
    searchStore: WorkspaceTableSearchStore
    stack: TailscaleStackOverview
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
          emptyMessage="No servers are connected to this network."
          pending={save.isPending}
          searchStore={searchStore}
          servers={connectedServers}
          serversPending={serversPending}
          stack={stack}
          onSave={(bindings, authKey) =>
            save.mutateAsync({ authKey, bindings, stack })
          }
        />
      </>
    )
  }
)

export const TailscaleAddServersDialog = React.memo(
  function TailscaleAddServersDialog({
    open,
    stack,
    onOpenChange,
  }: {
    open: boolean
    stack: TailscaleStackOverview
    onOpenChange: (open: boolean) => void
  }) {
    const [searchStore] = React.useState(createWorkspaceTableSearchStore)
    const { data: servers = emptyServers, isPending: serversPending } =
      useQuery({
        ...relaySnapshotQueryOptions(),
        notifyOnChangeProps: ["data", "isPending"],
        select: selectTailscaleServers,
      })
    const availableServers = React.useMemo(
      () => servers.filter((server) => !findBinding(stack, server)),
      [servers, stack]
    )
    const save = useStackMembershipMutation()

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="border-b px-5 py-4 sm:px-6">
            <DialogTitle>Add servers to {stack.name}</DialogTitle>
            <DialogDescription>
              Choose servers and assign the private hostname they will use on
              this tailnet.
            </DialogDescription>
          </DialogHeader>
          <MembershipToolbar searchStore={searchStore} stackName={stack.name} />
          {save.error ? (
            <p
              className="border-b border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive"
              role="alert"
            >
              {errorMessage(save.error)}
            </p>
          ) : null}
          <div className="min-h-0 overflow-auto">
            <TailscaleMembershipTable
              emptyMessage="Every available server is already connected."
              pending={save.isPending}
              searchStore={searchStore}
              servers={availableServers}
              serversPending={serversPending}
              stack={stack}
              onSave={(bindings, authKey) =>
                save.mutateAsync({ authKey, bindings, stack })
              }
            />
          </div>
          <DialogFooter className="border-t px-5 py-3 sm:px-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

const MembershipToolbar = React.memo(function MembershipToolbar({
  searchStore,
  stackName,
}: {
  searchStore: WorkspaceTableSearchStore
  stackName: string
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <TailscaleMembershipSyncButton />
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="search"
          defaultValue={searchStore.getServerSnapshot()}
          onChange={(event) => searchStore.set(event.currentTarget.value)}
          placeholder="Search servers"
          aria-label={`Search servers in ${stackName}`}
          className="pl-9 text-base md:text-sm"
        />
      </div>
      <span className="ml-auto hidden truncate px-2 text-xs font-semibold sm:block">
        {stackName}
      </span>
    </div>
  )
})

const TailscaleMembershipSyncButton = React.memo(
  function TailscaleMembershipSyncButton() {
    const queryClient = useQueryClient()
    const [syncing, setSyncing] = React.useState(false)

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Refresh servers"
            aria-busy={syncing}
            disabled={syncing}
            onClick={() => {
              setSyncing(true)
              forkPromise(() =>
                ensuringPromise(
                  () =>
                    Promise.all([
                      queryClient.invalidateQueries({
                        queryKey: queryKeys.tailscaleStacks,
                      }),
                      queryClient.invalidateQueries({
                        queryKey: queryKeys.relay.snapshot,
                      }),
                    ]),
                  () => setSyncing(false)
                )
              )
            }}
          >
            <RefreshCw className={syncing ? "animate-spin" : undefined} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Refresh servers</TooltipContent>
      </Tooltip>
    )
  }
)

const TailscaleMembershipTable = React.memo(function TailscaleMembershipTable({
  emptyMessage,
  pending,
  searchStore,
  servers,
  serversPending,
  stack,
  onSave,
}: {
  emptyMessage: string
  pending: boolean
  searchStore: WorkspaceTableSearchStore
  servers: Array<TailscaleServer>
  serversPending: boolean
  stack: TailscaleStackOverview
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
      <div className="grid min-h-52 place-items-center px-6 text-center text-xs text-muted-foreground">
        {serversPending
          ? "Loading servers…"
          : searchActive
            ? "No servers match your search."
            : emptyMessage}
      </div>
    ),
    [emptyMessage, serversPending]
  )
  const getRowKey = React.useCallback(
    (server: TailscaleServer) =>
      `${stack.id}:${serverRowKey(server)}:${findBinding(stack, server)?.hostname ?? ""}`,
    [stack]
  )

  return (
    <WorkspaceDataTable
      getRowKey={getRowKey}
      getSearchText={serverSearchText}
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
      <WorkspaceTableHeading className="w-auto sm:w-[32%]">
        Server
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[20%] sm:table-cell">
        Node
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-[44%] sm:w-[36%]">
        Hostname
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-16 text-center sm:w-24">
        Connected
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
  const initialHostname = binding?.hostname ?? defaultTailscaleHostname(server)
  const [hostname, setHostname] = React.useState(initialHostname)
  const [authOpen, setAuthOpen] = React.useState(false)
  const deploymentExists = stack.deployments.some(
    (deployment) => deployment.relayId === server.relayId
  )
  const disabled = pending || !server.tailscaleSupported
  const dirty = Boolean(binding && hostname.trim() !== binding.hostname)

  const enable = async (authKey?: string) => {
    await onSave(
      [
        ...stack.bindings,
        {
          address: "",
          hostname: hostname.trim(),
          instanceId: server.id,
          relayId: server.relayId,
          relayName: server.relayName,
        },
      ],
      authKey
    )
    setAuthOpen(false)
  }

  return (
    <>
      <tr className="group transition-colors hover:bg-accent/25">
        <WorkspaceTableCell>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-xs font-semibold">{server.name}</p>
              <span className="grid size-4 shrink-0 place-items-center sm:hidden">
                {!server.tailscaleSupported ? (
                  <TailscaleRelayUpdateHint relayName={server.relayName} />
                ) : null}
              </span>
            </div>
            <p className="type-meta truncate font-mono text-muted-foreground">
              {server.shortId}
            </p>
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell className="hidden sm:table-cell">
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
        <WorkspaceTableCell>
          <div className="flex min-w-0 items-center gap-1.5">
            <Input
              value={hostname}
              disabled={disabled}
              onChange={(event) => setHostname(event.target.value)}
              aria-label={`Hostname for ${server.name}`}
              className="h-8 min-w-0 font-mono text-xs"
            />
            <span className="type-meta hidden shrink-0 font-mono text-muted-foreground lg:inline">
              .{stack.domain}
            </span>
            {dirty ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !hostname.trim()}
                onClick={() =>
                  void onSave(
                    stack.bindings.map((candidate) =>
                      candidate.relayId === server.relayId &&
                      candidate.instanceId === server.id
                        ? { ...candidate, hostname: hostname.trim() }
                        : candidate
                    )
                  )
                }
              >
                Save
              </Button>
            ) : null}
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell className="text-center">
          <Switch
            checked={Boolean(binding)}
            disabled={disabled || !hostname.trim()}
            aria-label={`${binding ? "Disconnect" : "Connect"} ${server.name}`}
            onCheckedChange={(checked) => {
              if (!checked) {
                void onSave(
                  stack.bindings.filter(
                    (candidate) =>
                      candidate.relayId !== server.relayId ||
                      candidate.instanceId !== server.id
                  )
                )
                return
              }
              if (deploymentExists || stack.integration) void enable()
              else setAuthOpen(true)
            }}
          />
        </WorkspaceTableCell>
      </tr>
      {authOpen ? (
        <AuthKeyDialog
          networkName={stack.name}
          open
          pending={pending}
          onOpenChange={setAuthOpen}
          onSubmit={enable}
        />
      ) : null}
    </>
  )
})

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

const AuthKeyDialog = React.memo(function AuthKeyDialog({
  networkName,
  open,
  pending,
  onOpenChange,
  onSubmit,
}: {
  networkName: string
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (authKey: string) => Promise<unknown>
}) {
  const [authKey, setAuthKey] = React.useState("")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a node to {networkName}</DialogTitle>
        </DialogHeader>
        <label className="block py-2">
          <span className="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <KeyRound className="size-3.5" />
            Auth key
          </span>
          <Input
            type="password"
            autoComplete="off"
            value={authKey}
            onChange={(event) => setAuthKey(event.target.value)}
            placeholder="tskey-auth-…"
            className="font-mono"
            autoFocus
          />
        </label>
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
            disabled={pending || !authKey.trim()}
            onClick={() => forkPromise(() => onSubmit(authKey.trim()))}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Network />}
            Add node
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

function useStackMembershipMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      authKey,
      bindings,
      stack,
    }: {
      authKey?: string
      bindings: Array<StackBinding>
      stack: TailscaleStackOverview
    }) =>
      saveTailscaleStack({
        data: stackSaveInput(stack, bindings, authKey),
      }),
    onMutate: ({ bindings, stack }) => {
      const toast = membershipOperationToast(stack, bindings)
      showTailscaleOperationProgress(toast)
      return toast
    },
    onSuccess: async (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.relay.snapshot,
      })
    },
    onError: (cause, _input, toast) => {
      if (toast) showTailscaleOperationError(toast, cause)
    },
    onSettled: (_data, error, _input, toast) => {
      if (!error && toast) showTailscaleOperationSuccess(toast)
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

function stackSaveInput(
  stack: TailscaleStackOverview,
  bindings: Array<StackBinding>,
  authKey?: string,
  domain = stack.domain
): SaveStackInput {
  return {
    ...(authKey ? { authKey } : {}),
    bindings: bindings.map(({ hostname, instanceId, relayId }) => ({
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

function serverRowKey(server: TailscaleServer) {
  return tailscaleServerKey(server.relayId, server.id)
}

function serverSearchText(server: TailscaleServer) {
  return `${server.name} ${server.shortId} ${server.relayName}`
}

function CenteredNetworkState({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-64 place-items-center bg-background/55 px-6 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The Tailscale network could not be updated."
}
