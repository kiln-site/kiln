import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  ArrowLeftRight,
  Check,
  CircleAlert,
  Copy,
  EllipsisVertical,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
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
import { MAXIMUM_INSTANCE_NAME_LENGTH } from "@workspace/contracts"

import {
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import {
  TailscaleAddServersDialog,
  TailscaleConnectedServersTable,
} from "@/components/tailscale-network-membership"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"
import { queryKeys, tailscaleStacksQueryOptions } from "@/lib/query-options"
import {
  configureTailscaleIntegration,
  createTailscaleNetwork,
  removeTailscaleStack,
  saveTailscaleStack,
  type TailscaleStackOverview,
} from "@/server/tailscale"

type SaveStackInput = Parameters<typeof saveTailscaleStack>[0]["data"]

const tailscaleCredentialPermissions = [
  { group: "General", permission: "DNS" },
  { group: "Devices", permission: "Core" },
  { group: "Devices", permission: "Routes" },
  { group: "Keys", permission: "Auth Keys" },
] as const

export const TailscalePage = React.memo(function TailscalePage({
  createOpen,
  onCreateOpenChange,
}: {
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
}) {
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [selectedNetworkId, setSelectedNetworkId] = React.useState<
    string | null
  >(null)
  const [addServersOpen, setAddServersOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const { data } = useSuspenseQuery(tailscaleStacksQueryOptions())
  const { stacks } = data
  const selectedStack =
    stacks.find((stack) => stack.id === selectedNetworkId) ?? stacks[0] ?? null
  const editingStack = stacks.find((stack) => stack.id === editingId) ?? null
  const removingStack = stacks.find((stack) => stack.id === removingId) ?? null
  const openCreate = React.useCallback(
    () => onCreateOpenChange(true),
    [onCreateOpenChange]
  )
  const openAddServers = React.useCallback(() => setAddServersOpen(true), [])
  const selectNetwork = React.useCallback(
    (id: string) => {
      searchStore.set("")
      setSelectedNetworkId(id)
    },
    [searchStore]
  )

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <TailscaleNetworkPicker
        selectedStack={selectedStack}
        stacks={stacks}
        onAdd={openCreate}
        onEdit={setEditingId}
        onRemove={setRemovingId}
        onSelect={selectNetwork}
      />

      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <TailscaleToolbar
          canAddServer={Boolean(selectedStack && !selectedStack.cleanup)}
          searchStore={searchStore}
          onAddNetwork={openCreate}
          onAddServer={openAddServers}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          <TailscaleConnectedServersTable
            searchStore={searchStore}
            stack={selectedStack}
            onAddServers={openAddServers}
            onSetup={openCreate}
          />
        </div>
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
        />
      ) : null}
      {selectedStack && addServersOpen ? (
        <TailscaleAddServersDialog
          key={selectedStack.id}
          open
          stack={selectedStack}
          onOpenChange={setAddServersOpen}
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

const TailscaleNetworkPicker = React.memo(function TailscaleNetworkPicker({
  selectedStack,
  stacks,
  onAdd,
  onEdit,
  onRemove,
  onSelect,
}: {
  selectedStack: TailscaleStackOverview | null
  stacks: Array<TailscaleStackOverview>
  onAdd: () => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const visibleStacks = React.useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return stacks
    return stacks.filter((stack) =>
      `${stack.name} ${stack.domain} ${stack.id}`
        .toLowerCase()
        .includes(normalized)
    )
  }, [query, stacks])
  const copySelectedId = React.useCallback(() => {
    if (!selectedStack) return
    forkPromise(
      async () => {
        await navigator.clipboard.writeText(selectedStack.id)
        showToast({ message: "Network ID copied", type: "success" })
      },
      () =>
        showToast({
          message: "The network ID could not be copied",
          type: "error",
        })
    )
  }, [selectedStack])

  return (
    <div className="mb-3">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (!nextOpen) setQuery("")
        }}
      >
        <WorkspaceSummaryCard
          action={
            <div className="flex shrink-0 items-center gap-1.5">
              {selectedStack ? (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={Boolean(selectedStack.cleanup)}
                        aria-label={`Edit ${selectedStack.name}`}
                        onClick={() => onEdit(selectedStack.id)}
                      >
                        <Pencil />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Edit network</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={Boolean(selectedStack.cleanup)}
                        aria-label={`Delete ${selectedStack.name}`}
                        className="text-destructive hover:text-destructive"
                        onClick={() => onRemove(selectedStack.id)}
                      >
                        <Trash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      Delete network
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        aria-label={`More actions for ${selectedStack.name}`}
                      >
                        <EllipsisVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={copySelectedId}>
                        <Copy />
                        Copy ID
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : null}
              {stacks.length > 0 ? (
                <PopoverTrigger asChild>
                  <Button type="button" size="sm" variant="outline">
                    <ArrowLeftRight />
                    {selectedStack ? "Change network" : "Choose network"}
                  </Button>
                </PopoverTrigger>
              ) : (
                <Button type="button" size="sm" onClick={onAdd}>
                  <Plus />
                  Add Network
                </Button>
              )}
            </div>
          }
          icon={<Network className="size-5" />}
          iconClassName={selectedStack ? "text-primary" : undefined}
          title={
            selectedStack
              ? selectedStack.name
              : stacks.length > 0
                ? "Select a Tailscale network"
                : "No Tailscale networks"
          }
          titleAccessory={
            selectedStack ? (
              <Badge variant="outline" className="type-meta font-mono">
                .{selectedStack.domain}
              </Badge>
            ) : null
          }
        >
          <p className="type-meta mt-1 truncate font-mono text-muted-foreground">
            {selectedStack
              ? `${selectedStack.bindings.length} connected ${selectedStack.bindings.length === 1 ? "server" : "servers"} · ${selectedStack.deployments.length} ${selectedStack.deployments.length === 1 ? "node" : "nodes"}`
              : stacks.length > 0
                ? `${stacks.length} networks available`
                : "Add a network before connecting servers"}
          </p>
        </WorkspaceSummaryCard>
        <PopoverContent
          align="end"
          className="w-[min(32rem,calc(100vw-2rem))] p-1.5"
        >
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              aria-label="Search Tailscale networks"
              className="h-8 pl-8"
              placeholder="Search networks"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div
            role="listbox"
            aria-label="Tailscale networks"
            className="no-scrollbar max-h-72 space-y-0.5 overflow-y-auto overscroll-contain"
          >
            {visibleStacks.map((stack) => (
              <button
                key={stack.id}
                type="button"
                role="option"
                aria-selected={stack.id === selectedStack?.id}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150 ${
                  stack.id === selectedStack?.id
                    ? "bg-primary/14 ring-1 ring-primary/35"
                    : "hover:bg-accent/55"
                }`}
                onClick={() => {
                  onSelect(stack.id)
                  setOpen(false)
                }}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/70 text-muted-foreground">
                  <Network className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold tracking-tight">
                    {stack.name}
                  </span>
                  <span className="type-support mt-0.5 block truncate font-mono text-muted-foreground">
                    .{stack.domain} · {stack.bindings.length} connected
                  </span>
                </span>
                {stack.id === selectedStack?.id ? (
                  <Check className="size-4 shrink-0 text-primary" />
                ) : null}
              </button>
            ))}
            {visibleStacks.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No networks match your search.
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
})

const TailscaleToolbar = React.memo(function TailscaleToolbar({
  canAddServer,
  searchStore,
  onAddNetwork,
  onAddServer,
}: {
  canAddServer: boolean
  searchStore: WorkspaceTableSearchStore
  onAddNetwork: () => void
  onAddServer: () => void
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
              aria-label="Search connected servers"
              className="sm:hidden"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Search servers</TooltipContent>
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
          aria-label="Close server search"
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
        variant="outline"
        className={`${mobileSearchOpen ? "hidden lg:inline-flex" : ""} ml-auto`}
        onClick={onAddNetwork}
      >
        <Plus />
        Add Network
      </Button>
      <Button
        type="button"
        disabled={!canAddServer}
        className={mobileSearchOpen ? "hidden sm:inline-flex" : ""}
        onClick={onAddServer}
      >
        <Server />
        Add Server
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
          aria-label="Refresh Tailscale servers"
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
        placeholder="Search connected servers"
        aria-label="Search connected servers"
        className="pl-9 text-base md:text-sm"
      />
    </div>
  )
})

const EditNetworkDialog = React.memo(function EditNetworkDialog({
  open,
  stack,
  onOpenChange,
}: {
  open: boolean
  stack: TailscaleStackOverview
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">Edit Tailscale network</DialogTitle>
        <NetworkForm stack={stack} onDone={() => onOpenChange(false)} />
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
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next)
      showToast({
        message: `Removing ${stack.name} in the background`,
        type: "success",
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
          Tailscale, CoreDNS, and the private Docker network will be removed
          from every node. Offline Relays will clean up automatically when they
          reconnect.
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
            Remove network
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">Add Tailscale network</DialogTitle>
        {open ? <NetworkForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
})

const NetworkForm = React.memo(function NetworkForm({
  onDone,
  stack,
}: {
  onDone: () => void
  stack?: TailscaleStackOverview
}) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState(stack?.name ?? "Private Network")
  const [domain, setDomain] = React.useState(stack?.domain ?? "")
  const [clientId, setClientId] = React.useState(
    stack?.integration?.clientId ?? ""
  )
  const [clientSecret, setClientSecret] = React.useState("")
  const [tag, setTag] = React.useState(
    stack?.integration?.tags[0] ?? "tag:kiln"
  )
  const save = useMutation({
    mutationFn: async () => {
      const input = {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        domain: normalizeTailscaleDomain(domain),
        name: name.trim(),
        tag: tag.trim(),
      }
      if (!stack) return createTailscaleNetwork({ data: input })

      const configured = await configureTailscaleIntegration({
        data: {
          clientId: input.clientId,
          clientSecret: input.clientSecret || undefined,
          domain: stack.domain,
          id: stack.id,
          previousDomain: stack.domain,
          tag: input.tag,
        },
      })
      if (input.name !== stack.name || input.domain !== stack.domain) {
        return saveTailscaleStack({
          data: stackSaveInput(stack, {
            domain: input.domain,
            name: input.name,
          }),
        })
      }
      return configured.stacks
    },
    onSuccess: async (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next)
      if (stack) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.relay.snapshot,
        })
      }
      showToast({
        message: stack
          ? `${name.trim()} was updated`
          : `${name.trim()} is ready for servers`,
        type: "success",
      })
      onDone()
    },
    onError: async () => {
      if (!stack) return
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.tailscaleStacks,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.relay.snapshot,
        }),
      ])
    },
  })
  const canSubmit =
    name.trim() &&
    domain.trim() &&
    clientId.trim() &&
    (!stack || !clientSecret.trim() || clientSecret.trim().length >= 20) &&
    tag.trim()
  const displayedTag = tag.trim().startsWith("tag:")
    ? tag.trim()
    : `tag:${tag.trim() || "kiln"}`

  return (
    <form
      className="grid min-h-0 md:grid-cols-[minmax(0,1fr)_17rem]"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <section className="min-w-0 p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border bg-background text-primary">
            <Network className="size-4" />
          </span>
          <h2 className="font-heading text-lg font-semibold">
            {stack ? "Edit tailnet" : "Connect a tailnet"}
          </h2>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
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
            <span className="mb-2 block text-xs font-medium">
              Private domain
            </span>
            <Input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder=".kiln"
              className="font-mono"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">
              OAuth client ID
            </span>
            <Input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              placeholder="kAbCdEfGh123CNTRL"
              className="font-mono"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Device tag</span>
            <Input
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              placeholder="tag:kiln"
              className="font-mono"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-2 block text-xs font-medium">
              OAuth client secret
            </span>
            <Input
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              placeholder={
                stack
                  ? "••••••••••••••••••••••••"
                  : "tskey-client-kAbCdEfGh123CNTRL-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"
              }
              className="font-mono"
            />
          </label>
        </div>

        {save.error ? (
          <p
            className="mt-4 border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive"
            role="alert"
          >
            {save.error.message}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || save.isPending}>
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <KeyRound />
            )}
            {save.isPending
              ? "Validating…"
              : stack
                ? "Validate and update"
                : "Validate and connect"}
          </Button>
        </div>
      </section>

      <aside className="border-t bg-muted/15 p-5 md:border-t-0 md:border-l">
        <h3 className="text-xs font-semibold">Tailscale access</h3>
        <Button
          asChild
          type="button"
          size="sm"
          variant="outline"
          className="mt-3 w-full"
        >
          <a
            href="https://console.tailscale.com/admin/settings/trust-credentials/add"
            target="_blank"
            rel="noreferrer"
          >
            Create credential
            <ExternalLink />
          </a>
        </Button>
        <ul className="mt-3 divide-y divide-border/70 border border-border/70">
          {tailscaleCredentialPermissions.map(({ group, permission }) => (
            <li
              key={`${group}:${permission}`}
              className="flex items-center justify-between gap-3 px-2.5 py-2"
            >
              <span className="flex min-w-0 items-baseline gap-1">
                <span className="type-technical-label shrink-0 text-muted-foreground">
                  {group} /
                </span>
                <span className="truncate text-xs font-medium">
                  {permission}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <input
                  type="checkbox"
                  checked
                  readOnly
                  tabIndex={-1}
                  aria-hidden="true"
                  className="pointer-events-none size-3.5 accent-primary"
                />
                <span className="type-technical-label text-primary">Write</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="type-meta mt-3 leading-relaxed text-muted-foreground">
          For Devices → Core and Keys → Auth Keys, select{" "}
          <span className="font-mono text-foreground">{displayedTag}</span>{" "}
          under Tags.
        </p>
      </aside>
    </form>
  )
})

function normalizeTailscaleDomain(value: string): string {
  return value
    .trim()
    .replace(/^[.]+|[.]+$/gu, "")
    .toLowerCase()
}

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
