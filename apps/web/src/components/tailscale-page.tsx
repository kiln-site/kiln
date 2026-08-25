import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  Check,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { MAXIMUM_INSTANCE_NAME_LENGTH } from "@workspace/contracts"

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
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import {
  queryKeys,
  relaySnapshotQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
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
} from "@/lib/tailscale-operation-toasts"
import {
  removeTailscaleStack,
  saveTailscaleStack,
  type TailscaleStackOverview,
} from "@/server/tailscale"

type SaveStackInput = Parameters<typeof saveTailscaleStack>[0]["data"]

const emptyServers: Array<TailscaleServer> = []

export const TailscalePage = React.memo(function TailscalePage({
  createOpen,
  onCreateOpenChange,
}: {
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
}) {
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const { data } = useSuspenseQuery(tailscaleStacksQueryOptions())
  const { stacks } = data
  const editingStack = stacks.find((stack) => stack.id === editingId) ?? null
  const removingStack = stacks.find((stack) => stack.id === removingId) ?? null

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <TailscaleToolbar
          searchStore={searchStore}
          onAdd={() => onCreateOpenChange(true)}
        />
        <TailscaleTable
          searchStore={searchStore}
          stacks={stacks}
          onAdd={() => onCreateOpenChange(true)}
          onEdit={setEditingId}
        />
      </section>

      <CreateNetworkDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
      />
      {editingStack ? (
        <EditNetworkDialog
          key={editingStack.id}
          open
          stack={editingStack}
          onOpenChange={(open) => {
            if (!open) setEditingId(null)
          }}
          onRemove={() => {
            setEditingId(null)
            setRemovingId(editingStack.id)
          }}
        />
      ) : null}
      {removingStack ? (
        <RemoveNetworkDialog
          open
          stack={removingStack}
          onOpenChange={(open) => {
            if (!open) setRemovingId(null)
          }}
        />
      ) : null}
    </div>
  )
})

const TailscaleToolbar = React.memo(function TailscaleToolbar({
  searchStore,
  onAdd,
}: {
  searchStore: WorkspaceTableSearchStore
  onAdd: () => void
}) {
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(false)
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (mobileSearchOpen) searchInputRef.current?.focus()
  }, [mobileSearchOpen])

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <TailscaleSyncButton />

      {!mobileSearchOpen ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Search Tailscale networks"
              className="sm:hidden"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Search networks</TooltipContent>
        </Tooltip>
      ) : null}

      <div
        className={`${mobileSearchOpen ? "block" : "hidden"} min-w-0 flex-1 sm:block sm:max-w-md`}
      >
        <TailscaleSearchInput inputRef={searchInputRef} store={searchStore} />
      </div>

      {mobileSearchOpen ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Close network search"
          className="sm:hidden"
          onClick={() => {
            searchStore.set("")
            setMobileSearchOpen(false)
          }}
        >
          <X />
        </Button>
      ) : null}

      <Button
        type="button"
        className={`${mobileSearchOpen ? "hidden sm:inline-flex" : ""} ml-auto`}
        onClick={onAdd}
      >
        <Plus />
        Add Network
      </Button>
    </div>
  )
})

const TailscaleSyncButton = React.memo(function TailscaleSyncButton() {
  const queryClient = useQueryClient()
  const [syncing, setSyncing] = React.useState(false)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync Tailscale networks"
          aria-busy={syncing}
          disabled={syncing}
          onClick={() => {
            setSyncing(true)
            forkPromise(() =>
              ensuringPromise(
                () =>
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.tailscaleStacks,
                  }),
                () => setSyncing(false)
              )
            )
          }}
        >
          <RefreshCw className={syncing ? "animate-spin" : undefined} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Sync networks</TooltipContent>
    </Tooltip>
  )
})

const TailscaleSearchInput = React.memo(function TailscaleSearchInput({
  inputRef,
  store,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  store: WorkspaceTableSearchStore
}) {
  useWorkspaceTableSearchInput(inputRef, store)

  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="search"
        defaultValue={store.getServerSnapshot()}
        onChange={(event) => store.set(event.currentTarget.value)}
        placeholder="Search networks"
        aria-label="Search Tailscale networks"
        className="pl-9 text-base md:text-sm"
      />
    </div>
  )
})

const TailscaleTable = React.memo(function TailscaleTable({
  searchStore,
  stacks,
  onAdd,
  onEdit,
}: {
  searchStore: WorkspaceTableSearchStore
  stacks: Array<TailscaleStackOverview>
  onAdd: () => void
  onEdit: (id: string) => void
}) {
  const renderRow = React.useCallback(
    (stack: TailscaleStackOverview) => (
      <TailscaleTableRow stack={stack} onEdit={onEdit} />
    ),
    [onEdit]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <EmptyTailscaleTable searchActive={searchActive} onAdd={onAdd} />
    ),
    [onAdd]
  )

  return (
    <WorkspaceDataTable
      getRowKey={tailscaleRowKey}
      getSearchText={tailscaleSearchText}
      head={<TailscaleTableHead />}
      items={stacks}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const TailscaleTableHead = React.memo(function TailscaleTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-auto sm:w-[34%]">
        Network Name
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] sm:table-cell">
        Number of nodes
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] md:table-cell">
        Number of servers
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[18%] lg:table-cell">
        Network TLD
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-28 px-2 sm:w-32 sm:px-3">
        Options
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const TailscaleTableRow = React.memo(function TailscaleTableRow({
  stack,
  onEdit,
}: {
  stack: TailscaleStackOverview
  onEdit: (id: string) => void
}) {
  const deployment = stack.deployments[0]
  const routeId = deployment
    ? relayInstanceRouteId(deployment.relayId, deployment.instance.shortId)
    : null

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-primary">
            <Network className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">
              {stack.name}
            </p>
            <p className="type-meta font-mono text-muted-foreground sm:hidden">
              {stack.deployments.length} nodes · {stack.bindings.length} servers
              · .{stack.domain}
            </p>
          </div>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden sm:table-cell">
        <span className="type-code text-foreground">
          {stack.deployments.length}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <span className="type-code text-foreground">
          {stack.bindings.length}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <span className="type-code text-foreground">{stack.domain}</span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-2 sm:px-3">
        <div className="flex items-center justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Edit ${stack.name}`}
                onClick={() => onEdit(stack.id)}
              >
                <Pencil />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild={Boolean(routeId)}
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={!routeId}
                aria-label={`Configure ${stack.name}`}
              >
                {routeId ? (
                  <Link
                    to="/server/$serverId/network"
                    params={{ serverId: routeId }}
                  >
                    <Settings2 />
                  </Link>
                ) : (
                  <Settings2 />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Configure</TooltipContent>
          </Tooltip>
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

function EmptyTailscaleTable({
  searchActive,
  onAdd,
}: {
  searchActive: boolean
  onAdd: () => void
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Network className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">
        {searchActive
          ? "No networks match your search"
          : "No Tailscale networks"}
      </p>
      {!searchActive ? (
        <Button type="button" size="sm" className="mt-4" onClick={onAdd}>
          <Plus />
          Add Network
        </Button>
      ) : null}
    </div>
  )
}

const EditNetworkDialog = React.memo(function EditNetworkDialog({
  open,
  stack,
  onOpenChange,
  onRemove,
}: {
  open: boolean
  stack: TailscaleStackOverview
  onOpenChange: (open: boolean) => void
  onRemove: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState(stack.name)
  const [domain, setDomain] = React.useState(stack.domain)
  const update = useMutation({
    mutationFn: () =>
      saveTailscaleStack({
        data: stackSaveInput(stack, {
          domain: domain.trim(),
          name: name.trim(),
        }),
      }),
    onSuccess: async (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.relay.snapshot,
      })
      onOpenChange(false)
    },
  })
  const unchanged = name.trim() === stack.name && domain.trim() === stack.domain

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit network</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Network name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Network TLD</span>
            <Input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="font-mono"
            />
          </label>
          {update.error ? (
            <p className="text-xs text-destructive">{update.error.message}</p>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 />
            Remove
          </Button>
          <div className="flex justify-end gap-2">
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
                update.isPending || unchanged || !name.trim() || !domain.trim()
              }
              onClick={() => update.mutate()}
            >
              {update.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

const RemoveNetworkDialog = React.memo(function RemoveNetworkDialog({
  open,
  stack,
  onOpenChange,
}: {
  open: boolean
  stack: TailscaleStackOverview
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => removeTailscaleStack({ data: { id: stack.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tailscaleStacks,
      })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.relay.snapshot,
      })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {stack.name}?</DialogTitle>
        </DialogHeader>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          Tailscale and CoreDNS will be removed from all{" "}
          {stack.deployments.length} nodes.
        </div>
        {remove.error ? (
          <p className="text-xs text-destructive">{remove.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

const CreateNetworkDialog = React.memo(function CreateNetworkDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(42rem,calc(100dvh-2rem))] max-h-none gap-0 overflow-hidden p-0 sm:max-w-[min(62rem,calc(100%-2rem))]">
        <DialogTitle className="sr-only">Add Tailscale network</DialogTitle>
        {open ? <CreateNetworkForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
})

const CreateNetworkForm = React.memo(function CreateNetworkForm({
  onDone,
}: {
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [id] = React.useState(randomStackId)
  const [name, setName] = React.useState("Private Network")
  const [domain, setDomain] = React.useState("test")
  const [authKey, setAuthKey] = React.useState("")
  const [search, setSearch] = React.useState("")
  const [bindings, setBindings] = React.useState<
    Map<string, { hostname: string; relayId: string }>
  >(new Map())
  const { data: servers = emptyServers, isPending } = useQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data", "isPending"],
    select: selectTailscaleServers,
  })
  const visible = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return servers
    return servers.filter((server) =>
      `${server.name} ${server.shortId} ${server.relayName}`
        .toLowerCase()
        .includes(query)
    )
  }, [search, servers])
  const supportedServerKeys = React.useMemo(
    () =>
      new Set(
        servers.flatMap((server) =>
          server.tailscaleSupported
            ? [tailscaleServerKey(server.relayId, server.id)]
            : []
        )
      ),
    [servers]
  )
  const install = useMutation({
    mutationFn: (input: SaveStackInput) => saveTailscaleStack({ data: input }),
    onMutate: (input) => {
      const toast = {
        id: tailscaleOperationToastId(input.id ?? id),
        networkName: input.name,
        nodeCount: new Set(input.bindings.map(({ relayId }) => relayId)).size,
        operation: "install" as const,
      }
      showTailscaleOperationProgress(toast)
      return toast
    },
    onSuccess: async (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.relay.snapshot,
      })
      onDone()
    },
    onError: (cause, _input, toast) => {
      if (toast) showTailscaleOperationError(toast, cause)
    },
    onSettled: (_data, error, _input, toast) => {
      if (!error && toast) showTailscaleOperationSuccess(toast)
    },
  })
  const toggle = React.useCallback((server: TailscaleServer) => {
    const key = tailscaleServerKey(server.relayId, server.id)
    setBindings((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else if (server.tailscaleSupported)
        next.set(key, {
          hostname: defaultTailscaleHostname(server),
          relayId: server.relayId,
        })
      return next
    })
  }, [])
  const updateHostname = React.useCallback(
    (server: TailscaleServer, hostname: string) => {
      const key = tailscaleServerKey(server.relayId, server.id)
      setBindings((current) => {
        const existing = current.get(key)
        if (!existing) return current
        const next = new Map(current)
        next.set(key, { ...existing, hostname })
        return next
      })
    },
    []
  )
  const selectedRelayCount = new Set(
    [...bindings.values()].map(({ relayId }) => relayId)
  ).size
  const canSubmit =
    name.trim() &&
    domain.trim() &&
    authKey.trim() &&
    bindings.size > 0 &&
    selectedRelayCount === 1 &&
    [...bindings.keys()].every((key) => supportedServerKeys.has(key)) &&
    [...bindings.values()].every((binding) => binding.hostname.trim())

  return (
    <form
      className="grid h-full min-h-0 md:grid-cols-[18rem_minmax(0,1fr)]"
      onSubmit={(event) => {
        event.preventDefault()
        install.mutate({
          authKey: authKey.trim(),
          bindings: [...bindings.entries()].map(([key, binding]) => ({
            hostname: binding.hostname,
            instanceId: key.split(":")[1] ?? "",
            relayId: binding.relayId,
          })),
          domain: domain.trim(),
          id,
          name: name.trim(),
        })
      }}
    >
      <aside className="flex min-h-0 flex-col border-b bg-muted/15 md:border-r md:border-b-0">
        <div className="border-b p-5">
          <div className="grid size-10 place-items-center rounded-lg border bg-background text-primary">
            <Network className="size-4" />
          </div>
          <h2 className="mt-4 font-heading text-lg font-semibold">
            Add Tailscale
          </h2>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Network name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Network TLD</span>
            <Input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="font-mono"
            />
          </label>
          <label className="block">
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
            />
            {selectedRelayCount > 1 ? (
              <span className="type-meta mt-2 flex gap-1.5 text-amber-400">
                <CircleAlert className="mt-0.5 size-3 shrink-0" />
                Manual auth installs one Relay at a time. Select servers on one
                Relay, then connect Kiln to Tailscale before adding more.
              </span>
            ) : null}
          </label>
        </div>
        <div className="border-t p-4">
          {install.error ? (
            <p className="mb-3 text-xs text-destructive">
              {install.error.message}
            </p>
          ) : null}
          <Button
            type="submit"
            className="w-full"
            disabled={!canSubmit || install.isPending}
          >
            {install.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Network />
            )}
            Install
          </Button>
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col">
        <div className="border-b p-4">
          <div className="flex items-center justify-between gap-4">
            <h3 className="font-heading font-semibold">Servers</h3>
            <Badge variant="outline" className="type-meta font-mono">
              {bindings.size} selected
            </Badge>
          </div>
          <label className="relative mt-3 block">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search servers"
              className="pl-8"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {isPending ? (
            <div className="grid h-full place-items-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            visible.map((server) => (
              <CreateNetworkServerRow
                key={server.routeId}
                binding={bindings.get(
                  tailscaleServerKey(server.relayId, server.id)
                )}
                domain={domain}
                server={server}
                onHostnameChange={updateHostname}
                onToggle={toggle}
              />
            ))
          )}
        </div>
      </section>
    </form>
  )
})

const CreateNetworkServerRow = React.memo(function CreateNetworkServerRow({
  binding,
  domain,
  server,
  onHostnameChange,
  onToggle,
}: {
  binding: { hostname: string; relayId: string } | undefined
  domain: string
  server: TailscaleServer
  onHostnameChange: (server: TailscaleServer, hostname: string) => void
  onToggle: (server: TailscaleServer) => void
}) {
  return (
    <div
      className={cn(
        "mb-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-lg border px-3 py-2.5 transition-colors",
        binding
          ? "border-primary/25 bg-primary/6"
          : server.tailscaleSupported
            ? "border-transparent hover:bg-accent/35"
            : "border-transparent opacity-60"
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-label={`${binding ? "Remove" : "Add"} ${server.name}`}
        aria-checked={Boolean(binding)}
        disabled={!server.tailscaleSupported && !binding}
        onClick={() => onToggle(server)}
        className={cn(
          "mt-0.5 grid size-5 place-items-center rounded border",
          binding
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background"
        )}
      >
        {binding ? <Check className="size-3.5" /> : null}
      </button>
      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-1.5">
          <button
            type="button"
            disabled={!server.tailscaleSupported && !binding}
            className="block min-w-0 flex-1 text-left disabled:cursor-not-allowed"
            onClick={() => onToggle(server)}
          >
            <span className="block truncate text-sm font-medium">
              {server.name}
            </span>
            <span className="type-code block truncate text-muted-foreground">
              {server.shortId} · {server.relayName}
            </span>
          </button>
          <span className="grid size-4 shrink-0 place-items-center">
            {!server.tailscaleSupported ? (
              <TailscaleRelayUpdateHint relayName={server.relayName} />
            ) : null}
          </span>
        </div>
        {binding ? (
          <div className="mt-2 flex">
            <Input
              value={binding.hostname}
              onChange={(event) => onHostnameChange(server, event.target.value)}
              className="h-8 rounded-r-none font-mono text-xs"
              aria-label={`${server.name} hostname`}
            />
            <span className="type-code flex h-8 items-center rounded-r-md border border-l-0 bg-muted/45 px-2 text-muted-foreground">
              .{domain || "test"}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
})

function stackSaveInput(
  stack: TailscaleStackOverview,
  overrides: { domain?: string; name?: string } = {}
): SaveStackInput {
  return {
    bindings: stack.bindings.map(({ hostname, instanceId, relayId }) => ({
      hostname,
      instanceId,
      relayId,
    })),
    domain: overrides.domain ?? stack.domain,
    id: stack.id,
    name: overrides.name ?? stack.name,
  }
}

function tailscaleRowKey(stack: TailscaleStackOverview): string {
  return stack.id
}

function tailscaleSearchText(stack: TailscaleStackOverview): string {
  return [
    stack.name,
    stack.domain,
    String(stack.deployments.length),
    String(stack.bindings.length),
    ...stack.deployments.map((deployment) => deployment.relayName),
  ]
    .join(" ")
    .toLowerCase()
}

function randomStackId(): string {
  const bytes = new Uint8Array(20)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    ""
  )
}
