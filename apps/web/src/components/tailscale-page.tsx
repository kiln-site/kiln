import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  ArrowLeft,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
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
import { TailscaleNetworkMembershipPage } from "@/components/tailscale-network-membership"
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
  highlightedServerKey,
  selectedNetworkId,
  onCreateOpenChange,
}: {
  createOpen: boolean
  highlightedServerKey?: string
  selectedNetworkId?: string
  onCreateOpenChange: (open: boolean) => void
}) {
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const { data } = useSuspenseQuery(tailscaleStacksQueryOptions())
  const { stacks } = data
  const editingStack = stacks.find((stack) => stack.id === editingId) ?? null
  const removingStack = stacks.find((stack) => stack.id === removingId) ?? null

  if (selectedNetworkId) {
    return (
      <div>
        <div className="mx-auto w-full max-w-[90rem] px-3 sm:px-5">
          <Button asChild type="button" size="sm" variant="ghost">
            <Link to="/infra/tailscale" search={{}}>
              <ArrowLeft />
              All networks
            </Link>
          </Button>
        </div>
        <TailscaleNetworkMembershipPage
          highlightedServerKey={highlightedServerKey}
          stackId={selectedNetworkId}
        />
      </div>
    )
  }

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
          onRemove={setRemovingId}
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
  onRemove,
}: {
  searchStore: WorkspaceTableSearchStore
  stacks: Array<TailscaleStackOverview>
  onAdd: () => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const renderRow = React.useCallback(
    (stack: TailscaleStackOverview) => (
      <TailscaleTableRow stack={stack} onEdit={onEdit} onRemove={onRemove} />
    ),
    [onEdit, onRemove]
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
      <WorkspaceTableHeading className="w-40 px-2 text-right sm:w-44 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const TailscaleTableRow = React.memo(function TailscaleTableRow({
  stack,
  onEdit,
  onRemove,
}: {
  stack: TailscaleStackOverview
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const copyNetworkId = React.useCallback(() => {
    forkPromise(
      async () => {
        await navigator.clipboard.writeText(stack.id)
        showToast({ message: "Network ID copied", type: "success" })
      },
      () =>
        showToast({
          message: "The network ID could not be copied",
          type: "error",
        })
    )
  }, [stack.id])

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-primary">
            <Network className="size-3.5" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-xs font-semibold text-foreground">
                {stack.name}
              </p>
              {stack.cleanup ? (
                <Badge
                  variant="outline"
                  className="shrink-0 text-amber-400"
                  title={
                    stack.cleanup.lastError ??
                    "Cleanup will continue automatically"
                  }
                >
                  Removing · {stack.cleanup.pendingRelays} pending
                </Badge>
              ) : null}
            </div>
            <p className="type-meta font-mono text-muted-foreground sm:hidden">
              {stack.deployments.length} nodes · {stack.bindings.length} servers
              · .{stack.domain}
            </p>
          </div>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden sm:table-cell">
        <span className="type-code text-foreground">
          {stack.cleanup?.pendingRelays ?? stack.deployments.length}
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
                disabled={Boolean(stack.cleanup)}
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
                asChild={!stack.cleanup}
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={Boolean(stack.cleanup)}
                aria-label={`Configure ${stack.name}`}
              >
                {!stack.cleanup ? (
                  <Link to="/infra/tailscale" search={{ network: stack.id }}>
                    <Settings2 />
                  </Link>
                ) : (
                  <Settings2 />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Configure</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={Boolean(stack.cleanup)}
                aria-label={`Delete ${stack.name}`}
                className="text-destructive hover:text-destructive"
                onClick={() => onRemove(stack.id)}
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Delete</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`More actions for ${stack.name}`}
                  >
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="left">More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuItem onSelect={copyNetworkId}>
                <Copy />
                Copy ID
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
