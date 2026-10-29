import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  appTailscaleMember,
  databaseTailscaleMember,
} from "@workspace/contracts"
import {
  Check,
  CircleAlert,
  EllipsisVertical,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  Settings2,
  Unplug,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { ServerKindIcon } from "@/components/instance-kind-icon"
import { ensuringPromise, forkPromise, recoverPromise } from "@/effect/promise"
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
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Switch } from "@workspace/ui/components/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InstanceCard } from "@/components/instance-card"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { StatusIndicator } from "@/components/status-indicator"
import {
  tailscaleMemberKey,
  useTailscaleMemberDirectory,
  type TailscaleMemberListing,
} from "@/components/tailscale-member-directory"
import { TailscaleRelayUpdateHint } from "@/components/tailscale-relay-update-hint"
import { WorkspaceCopyValueButton } from "@/components/workspace-header"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import type { DataTableSearchStore } from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import { queryKeys, tailscaleStacksQueryOptions } from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { defaultTailscaleHostname } from "@/lib/tailscale-selectors"
import {
  showTailscaleOperationError,
  showTailscaleOperationProgress,
  showTailscaleOperationSuccess,
  tailscaleOperationToastId,
  type TailscaleOperationToast,
} from "@/lib/tailscale-operation-toasts"
import {
  saveTailscaleStack,
  type TailscaleStackOverview,
  type TailscaleStacksResult,
} from "@/server/tailscale"

type StackBinding = TailscaleStackOverview["bindings"][number]

const noTailscaleStacks: TailscaleStacksResult = {
  stacks: [],
  unsupportedRelays: [],
  unavailableRelays: [],
}
type SaveStackInput = Parameters<typeof saveTailscaleStack>[0]["data"]

const emptyMembers: Array<TailscaleMemberListing> = []
const emptyMemberKeys = new Set<string>()

// A member of the selected tailnet: a game server, an App's service, or a
// database, as the table shows it.
type TailscaleMemberRow = {
  binding: StackBinding
  deployment: TailscaleStackOverview["deployments"][number] | undefined
  domain: string
  member: TailscaleMemberListing
  stackId: string
}

type MemberDialog =
  | { kind: "configure"; row: TailscaleMemberRow }
  | { kind: "disconnect"; row: TailscaleMemberRow }

export function TailscaleConnectedMembersTable({
  searchStore,
  stack,
  onAddServers,
  onSetup,
}: {
  searchStore: DataTableSearchStore
  stack: TailscaleStackOverview | null
  onAddServers: () => void
  onSetup: () => void
}) {
  if (!stack) {
    return (
      <TailscaleEmptyTable
        actionLabel="Setup Tailscale"
        description="Set up Tailscale before connecting game servers, Apps, or databases"
        icon="network"
        title="No Tailscale networks"
        onAction={onSetup}
      />
    )
  }
  if (stack.cleanup) {
    return <TailscaleCleanupState stack={stack} />
  }
  return (
    <ConnectedMembersTableContent
      searchStore={searchStore}
      stack={stack}
      onAddServers={onAddServers}
    />
  )
}

const ConnectedMembersTableContent = React.memo(
  function ConnectedMembersTableContent({
    searchStore,
    stack,
    onAddServers,
  }: {
    searchStore: DataTableSearchStore
    stack: TailscaleStackOverview
    onAddServers: () => void
  }) {
    const directory = useTailscaleMemberDirectory()
    // Reuse a row while its member, binding, and deployment are unchanged, so
    // a save or snapshot update repaints only the rows it touched.
    const [rowCache] = React.useState(
      () => new Map<string, TailscaleMemberRow>()
    )
    const rows = React.useMemo(() => {
      const next: Array<TailscaleMemberRow> = []
      const seen = new Set<string>()
      for (const binding of stack.bindings) {
        const member = directory.listing(binding)
        const deployment = stack.deployments.find(
          (candidate) => candidate.relayId === binding.relayId
        )
        const key = stackBindingKey(binding)
        seen.add(key)
        const cached = rowCache.get(key)
        if (
          cached &&
          cached.member === member &&
          cached.binding === binding &&
          cached.deployment === deployment &&
          cached.domain === stack.domain &&
          cached.stackId === stack.id
        ) {
          next.push(cached)
          continue
        }
        const row = {
          binding,
          deployment,
          domain: stack.domain,
          member,
          stackId: stack.id,
        }
        rowCache.set(key, row)
        next.push(row)
      }
      for (const key of rowCache.keys()) {
        if (!seen.has(key)) rowCache.delete(key)
      }
      return next
    }, [directory, rowCache, stack])
    const save = useStackMembershipMutation()
    const [dialog, setDialog] = React.useState<MemberDialog | null>(null)
    const openConfigure = React.useCallback(
      (row: TailscaleMemberRow) => setDialog({ kind: "configure", row }),
      []
    )
    const openDisconnect = React.useCallback(
      (row: TailscaleMemberRow) => setDialog({ kind: "disconnect", row }),
      []
    )
    const closeDialog = React.useCallback(() => setDialog(null), [])
    // A save that finishes after its dialog was dismissed must not close
    // another dialog opened in the meantime.
    const finishDialog = (target: MemberDialog) =>
      setDialog((current) => (current === target ? null : current))
    // Each save sends the whole binding list, so allow one at a time: a
    // double click lands before `pending` renders, and an older response
    // arriving last would overwrite a newer save.
    const saving = React.useRef(false)
    const saveBindings = async (
      target: MemberDialog,
      bindings: Array<StackBinding>
    ) => {
      if (saving.current) return
      saving.current = true
      await ensuringPromise(
        () => save.mutateAsync({ bindings, stack }),
        () => {
          saving.current = false
        }
      )
      finishDialog(target)
    }
    // Apply only the fields the dialog changed to the current binding, so a
    // change made elsewhere since it opened is kept.
    const updateBinding = (
      target: MemberDialog,
      next: Partial<Pick<StackBinding, "enabled" | "hostname">>
    ) =>
      saveBindings(
        target,
        stack.bindings.map((candidate) =>
          stackBindingKey(candidate) === stackBindingKey(target.row.binding)
            ? { ...candidate, ...next }
            : candidate
        )
      )
    const disconnect = (target: MemberDialog) =>
      saveBindings(
        target,
        stack.bindings.filter(
          (candidate) =>
            stackBindingKey(candidate) !== stackBindingKey(target.row.binding)
        )
      )
    // A dialog belongs to the network it was opened on.
    if (dialog && dialog.row.stackId !== stack.id) setDialog(null)
    // Hide a dialog whose member left the tailnet since it opened.
    const dialogBound = dialog
      ? dialog.row.stackId === stack.id &&
        stack.bindings.some(
          (candidate) =>
            stackBindingKey(candidate) === stackBindingKey(dialog.row.binding)
        )
      : false

    return (
      <>
        {save.error ? (
          <p
            className="shrink-0 border-b border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive light:bg-destructive/10"
            role="alert"
          >
            {errorMessage(save.error)}
          </p>
        ) : null}
        <TailscaleMembersTable
          rows={rows}
          searchStore={searchStore}
          membersPending={directory.pending}
          onAddServers={onAddServers}
          onConfigure={openConfigure}
          onDisconnect={openDisconnect}
        />
        {dialogBound && dialog?.kind === "configure" ? (
          <ConfigureMemberDialog
            pending={save.isPending}
            row={dialog.row}
            onClose={closeDialog}
            onSave={(next) => updateBinding(dialog, next)}
          />
        ) : null}
        {dialogBound && dialog?.kind === "disconnect" ? (
          <DisconnectMemberDialog
            pending={save.isPending}
            row={dialog.row}
            stack={stack}
            onClose={closeDialog}
            onDisconnect={() => disconnect(dialog)}
          />
        ) : null}
      </>
    )
  }
)

export const TailscaleConnectMembersPopover = React.memo(
  function TailscaleConnectMembersPopover({
    open,
    stack,
    onOpenChange,
  }: {
    open: boolean
    stack: TailscaleStackOverview | null
    onOpenChange: (open: boolean) => void
  }) {
    const directory = useTailscaleMemberDirectory()
    const available = React.useMemo(
      () =>
        stack
          ? [...directory.joinable.values()].filter(
              (member) => !findBinding(stack, member.relayId, member.memberId)
            )
          : emptyMembers,
      [directory.joinable, stack]
    )
    const options = React.useMemo(
      () =>
        available
          .map((member): InstancePickerItem => ({
            disabled: !member.tailscaleSupported,
            identity: member.identity,
            key: tailscaleMemberKey(member.relayId, member.memberId),
            meta: member.tailscaleSupported
              ? `${member.relayName} · ${member.meta}`
              : `${member.relayName} · Relay update needed`,
            name: member.name,
            searchText: `${member.identity.id} ${member.relayName}`,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      [available]
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
      ? tailscaleMemberKey(pendingBinding.relayId, pendingBinding.memberId)
      : undefined

    const connectMember = React.useCallback(
      (option: InstancePickerItem) => {
        if (!stack) return
        const member = directory.joinable.get(option.key)
        if (!member) return
        save.mutate({
          bindings: [
            ...stack.bindings,
            {
              address: "",
              enabled: true,
              hostname: uniqueHostname(stack, member),
              memberId: member.memberId,
              relayId: member.relayId,
              relayName: member.relayName,
            },
          ],
          stack,
        })
        onOpenChange(false)
      },
      [directory.joinable, onOpenChange, save, stack]
    )

    return (
      <DrawerPopover open={open && Boolean(stack)} onOpenChange={onOpenChange}>
        <DrawerPopoverTrigger asChild>
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
                : "Every available game server and database is already connected."
            }
            items={options}
            pendingKey={pendingKey}
            selectedKeys={emptyMemberKeys}
            onSelect={connectMember}
          />
          <p className="border-t border-border/70 px-3.5 py-2 text-xs text-muted-foreground">
            An App's services join from the App's Network page.
          </p>
          {save.error ? (
            <p
              className="border-t border-border/70 px-3.5 py-2 text-xs text-destructive"
              role="alert"
            >
              {errorMessage(save.error)}
            </p>
          ) : null}
        </DrawerPopoverContent>
      </DrawerPopover>
    )
  }
)

// A game server's, an App service's, or a database's Tailscale networks:
// which it has joined, under what hostname, and joining or leaving others.
// The member is named by its member ID (`instanceTailscaleMemberId`,
// `appTailscaleMemberId`, `databaseTailscaleMemberId`).
export type TailscaleMember = Pick<
  InstanceWorkspaceInstance,
  "name" | "relayId" | "relayName" | "shortId"
> & { memberId: string }

export function TailscaleMembershipSection({
  member: server,
  noun = "server",
  title = "Tailscale networks",
}: {
  member: TailscaleMember
  // Lowercase, as in "disconnects this server".
  noun?: string
  title?: string
}) {
  // Not suspended: the section waits for its networks, not the whole page.
  const stacksQuery = useQuery(tailscaleStacksQueryOptions())
  const { stacks, unsupportedRelays } = stacksQuery.data ?? noTailscaleStacks
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
    ? findBinding(joiningStack, server.relayId, server.memberId)
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
              binding.memberId === server.memberId
                ? { ...binding, hostname }
                : binding
            )
          : [
              ...joiningStack.bindings,
              {
                address: "",
                enabled: true,
                hostname,
                memberId: server.memberId,
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
          <Network className="size-4 shrink-0 text-primary-ink" />
          <h2 className="truncate text-sm font-semibold">{title}</h2>
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
      {!stacksQuery.data ? (
        stacksQuery.isError ? (
          <p
            className="px-4 py-8 text-center text-xs text-destructive"
            role="alert"
          >
            {errorMessage(stacksQuery.error)}
          </p>
        ) : (
          <div
            className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            aria-busy="true"
          >
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2.5 w-40" />
            </div>
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-8 w-16" />
          </div>
        )
      ) : availableStacks.length ? (
        <div className="divide-y divide-border/65">
          {availableStacks.map((stack) => {
            const binding = findBinding(stack, server.relayId, server.memberId)
            return (
              <MembershipRow
                key={stack.id}
                noun={noun}
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
                memberId={server.memberId}
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
          className="border-t border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive light:bg-destructive/10"
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

const memberColumnHelper = createDataTableColumnHelper<TailscaleMemberRow>()
const memberSearchFields = [memberSearchText] as const
const memberTableInitialState = {
  sorting: [{ desc: false, id: "instance" }],
}

const TailscaleMembersTable = React.memo(function TailscaleMembersTable({
  rows,
  searchStore,
  membersPending,
  onAddServers,
  onConfigure,
  onDisconnect,
}: {
  rows: Array<TailscaleMemberRow>
  searchStore: DataTableSearchStore
  membersPending: boolean
  onAddServers: () => void
  onConfigure: (row: TailscaleMemberRow) => void
  onDisconnect: (row: TailscaleMemberRow) => void
}) {
  const source = React.useMemo(
    (): DataTableSource<TailscaleMemberRow> => ({
      body: membersPending ? { kind: "loading" } : { kind: "ready" },
      refreshing: false,
      rows,
    }),
    [rows, membersPending]
  )
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Connected instances",
        columns: memberColumnHelper.columns([
          memberColumnHelper.accessor((row) => memberStatus(row).label, {
            id: "status",
            header: () => (
              <span className="sr-only sm:not-sr-only">Status</span>
            ),
            sortFn: "text",
            cell: ({ row }) => (
              <StatusIndicator status={memberStatus(row.original)} />
            ),
            meta: dataTableColumnMeta(
              { width: { base: "2.5rem", sm: statusColumnWidth } },
              {
                cellClassName: "px-2 sm:px-3",
                headerClassName: "px-2 sm:px-3",
                headerLabelClassName: "shrink-0 overflow-visible text-clip",
              }
            ),
          }),
          memberColumnHelper.accessor((row) => row.member.name, {
            id: "instance",
            header: "Instance",
            sortFn: "text",
            cell: ({ row }) => <MemberInstance row={row.original} />,
            meta: dataTableColumnMeta(
              { width: { base: "minmax(0,1fr)", md: "minmax(0,1.2fr)" } },
              { cellClassName: "px-0" }
            ),
          }),
          memberColumnHelper.accessor((row) => row.member.relayName, {
            id: "relay",
            header: "Relay",
            sortFn: "text",
            cell: ({ row }) => <MemberRelay member={row.original.member} />,
            meta: dataTableColumnMeta({
              hideBelow: "md",
              width: "minmax(0,0.8fr)",
            }),
          }),
          memberColumnHelper.accessor(memberHostname, {
            id: "hostname",
            header: "Hostname",
            sortFn: "text",
            cell: ({ row }) => (
              <div className="type-meta flex w-full min-w-0">
                <WorkspaceCopyValueButton
                  label="hostname"
                  value={memberHostname(row.original)}
                />
              </div>
            ),
            meta: dataTableColumnMeta({
              hideBelow: "sm",
              width: "minmax(0,1fr)",
            }),
          }),
          memberColumnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <MemberActions
                row={row.original}
                onConfigure={onConfigure}
                onDisconnect={onDisconnect}
              />
            ),
            meta: dataTableColumnMeta(
              { width: { base: "7rem", sm: "7.5rem" } },
              {
                cellClassName: "px-1 sm:px-2",
                headerClassName: "px-1 sm:px-2",
              }
            ),
          }),
        ]),
        getRowId: memberRowKey,
        model: { initialState: memberTableInitialState },
        search: { fields: memberSearchFields },
        virtualization: true,
      }),
    [onConfigure, onDisconnect]
  )
  const emptyState = React.useCallback(
    ({ searchActive }: { searchActive: boolean }) => (
      <DataTableEmptyState
        action={
          searchActive ? undefined : (
            <Button type="button" size="sm" onClick={onAddServers}>
              <Plus /> Connect
            </Button>
          )
        }
        description={
          <span className="block max-w-sm">
            {searchActive
              ? "Try a name, short ID, Relay, or hostname."
              : "Connect a game server, App service, or database to reach it through this tailnet."}
          </span>
        }
        icon={
          <ServerKindIcon className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
        }
        title={
          searchActive ? "Nothing matches your search" : "Nothing is connected"
        }
      />
    ),
    [onAddServers]
  )

  return (
    <DataTable
      definition={definition}
      emptyState={emptyState}
      searchStore={searchStore}
      source={source}
    />
  )
})

const MemberInstance = React.memo(function MemberInstance({
  row,
}: {
  row: TailscaleMemberRow
}) {
  const { member } = row
  const card = (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={member.identity}
      // Narrow screens hide the Relay and hostname columns; show them here.
      meta={
        <>
          <span className="sm:hidden">{memberHostname(row)} · </span>
          <span className="md:hidden">{member.relayName}</span>
          <span className="hidden sm:inline md:hidden"> · </span>
          <span className="hidden sm:inline">{member.meta}</span>
        </>
      }
      metaClassName="font-mono"
      name={member.name}
      nameAccessory={
        member.tailscaleSupported ? undefined : (
          <span className="flex md:hidden">
            <TailscaleRelayUpdateHint relayName={member.relayName} />
          </span>
        )
      }
      nameClassName="transition-colors group-hover/member-link:text-primary-ink"
      showFavorite={false}
    />
  )
  const className =
    "group/member-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
  if (!member.routeId) return <div className={className}>{card}</div>
  switch (member.kind) {
    case "server":
      return (
        <Link
          to="/server/$serverId/console"
          params={{ serverId: member.routeId }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    case "app":
      return (
        <Link
          to="/app/$appId/network"
          params={{ appId: member.routeId }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    case "database":
      return (
        <Link
          to="/db/$databaseId/network"
          params={{ databaseId: member.routeId }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
  }
})

const MemberRelay = React.memo(function MemberRelay({
  member: server,
}: {
  member: TailscaleMemberListing
}) {
  return (
    <Link
      to="/relay/$relayId"
      params={{ relayId: server.relayId }}
      className="group/relay-link flex max-w-full min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <InstanceCard
        instance={{
          id: server.relayId,
          kind: "relay",
          relayId: server.relayId,
        }}
        meta={server.relayId.slice(0, 8)}
        metaClassName="font-mono"
        name={server.relayName}
        nameAccessory={
          server.tailscaleSupported ? undefined : (
            <TailscaleRelayUpdateHint relayName={server.relayName} />
          )
        }
        nameClassName="transition-colors group-hover/relay-link:text-primary-ink"
        showFavorite={false}
      />
    </Link>
  )
})

const MemberActions = React.memo(function MemberActions({
  row,
  onConfigure,
  onDisconnect,
}: {
  row: TailscaleMemberRow
  onConfigure: (row: TailscaleMemberRow) => void
  onDisconnect: (row: TailscaleMemberRow) => void
}) {
  const { member } = row
  // A Relay that predates staged removal can't change its memberships.
  const disabled = !member.tailscaleSupported
  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Configure ${member.name}`}
            disabled={disabled}
            onClick={() => onConfigure(row)}
          >
            <Settings2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Configure
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
            aria-label={`Disconnect ${member.name}`}
            disabled={disabled}
            onClick={() => onDisconnect(row)}
          >
            <Unplug />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Disconnect
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`More actions for ${member.name}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <CopyIdentifierMenuItem
            label={memberIdLabels[member.kind]}
            value={member.identity.id}
          />
          <CopyIdentifierMenuItem label="Relay ID" value={member.relayId} />
          <CopyIdentifierMenuItem label="Tailnet ID" value={row.stackId} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

const ConfigureMemberDialog = React.memo(function ConfigureMemberDialog({
  pending,
  row,
  onClose,
  onSave,
}: {
  pending: boolean
  row: TailscaleMemberRow
  onClose: () => void
  onSave: (
    next: Partial<Pick<StackBinding, "enabled" | "hostname">>
  ) => Promise<unknown>
}) {
  const { binding, domain, member } = row
  const [hostname, setHostname] = React.useState(binding.hostname)
  const [enabled, setEnabled] = React.useState(binding.enabled)
  const nextHostname = hostname.trim()
  const hostnameChanged = nextHostname !== binding.hostname
  const enabledChanged = enabled !== binding.enabled
  const canSave =
    !pending && nextHostname.length > 0 && (hostnameChanged || enabledChanged)
  const connectionLabelId = React.useId()

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSave) return
            forkPromise(() =>
              onSave({
                ...(enabledChanged ? { enabled } : {}),
                ...(hostnameChanged ? { hostname: nextHostname } : {}),
              })
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>Configure {member.name}</DialogTitle>
          </DialogHeader>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Hostname</span>
            <div className="flex items-center">
              <Input
                autoFocus
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                className="min-w-0 rounded-r-none font-mono"
              />
              <span className="flex h-8 shrink-0 items-center border border-l-0 border-input bg-muted/30 px-3 font-mono text-xs text-muted-foreground">
                .{domain}
              </span>
            </div>
          </label>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5">
            <div className="min-w-0">
              <p id={connectionLabelId} className="text-xs font-medium">
                Connected
              </p>
              <p className="type-meta mt-0.5 text-muted-foreground">
                Turn off to pause the connection and keep the hostname.
              </p>
            </div>
            <Switch
              aria-labelledby={connectionLabelId}
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})

const DisconnectMemberDialog = React.memo(function DisconnectMemberDialog({
  pending,
  row,
  stack,
  onClose,
  onDisconnect,
}: {
  pending: boolean
  row: TailscaleMemberRow
  stack: TailscaleStackOverview
  onClose: () => void
  onDisconnect: () => Promise<unknown>
}) {
  const { member } = row
  const onlyBindingOnRelay =
    stack.bindings.filter((candidate) => candidate.relayId === member.relayId)
      .length === 1

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {member.name}?</DialogTitle>
          <DialogDescription>
            {onlyBindingOnRelay
              ? `This removes ${member.name} from ${stack.name}. Because nothing else on ${member.relayName} is connected, Tailscale will also be removed from that Relay in the background.`
              : `This removes ${member.name} from ${stack.name}. Tailscale will stay installed on ${member.relayName} for what else is connected there.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => forkPromise(onDisconnect)}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Unplug />}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

const MembershipRow = React.memo(function MembershipRow({
  binding,
  disabled,
  joinDisabled,
  memberId,
  noun,
  pending,
  relayId,
  stack,
  onJoin,
  onSave,
}: {
  binding?: StackBinding
  disabled: boolean
  joinDisabled: boolean
  memberId: string
  noun: string
  pending: boolean
  relayId: string
  stack: TailscaleStackOverview
  onJoin: (stackId: string) => void
  onSave: ReturnType<typeof useStackMembershipMutation>["mutateAsync"]
}) {
  const [leaveOpen, setLeaveOpen] = React.useState(false)
  const onlyBindingOnRelay =
    stack.bindings.filter((candidate) => candidate.relayId === relayId)
      .length === 1
  const leave = React.useCallback(
    () =>
      onSave({
        bindings: stack.bindings.filter(
          (candidate) =>
            candidate.relayId !== relayId || candidate.memberId !== memberId
        ),
        stack,
      }),
    [memberId, onSave, relayId, stack]
  )

  return (
    <>
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
                className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
                disabled={disabled}
                onClick={() => setLeaveOpen(true)}
              >
                {pending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Unplug />
                )}
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
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Network />
              )}
              Join
            </Button>
          )}
        </div>
      </div>
      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Leave {stack.name}?</DialogTitle>
            <DialogDescription>
              {onlyBindingOnRelay
                ? `This disconnects this ${noun} from ${stack.name}. Because it is the last member on this Relay, Tailscale will also be removed from the Relay in the background.`
                : `This disconnects this ${noun} from ${stack.name}. Tailscale will remain installed on the Relay for its other members.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setLeaveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() =>
                forkPromise(async () => {
                  await leave()
                  setLeaveOpen(false)
                })
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Unplug />}
              Leave Tailnet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
  server: TailscaleMember
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
              <span className="flex h-8 shrink-0 items-center border border-l-0 border-input bg-muted/30 px-3 font-mono text-xs text-muted-foreground">
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
      return recoverPromise(
        async () => ({
          data: await saveTailscaleStack({
            data: stackSaveInput(stack, bindings, authKey),
          }),
          reconcile: false,
        }),
        (cause) => {
          if (!isFailedFetch(cause)) throw cause
          const pending = queryClient.getQueryData<TailscaleStacksResult>(
            queryKeys.tailscaleStacks
          )
          if (pending) {
            return { data: pending, reconcile: true }
          }
          throw cause
        }
      )
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
): TailscaleOperationToast {
  const currentBindingKeys = new Set(stack.bindings.map(stackBindingKey))
  const nextBindingKeys = new Set(bindings.map(stackBindingKey))
  const added = bindings.find(
    (binding) => !currentBindingKeys.has(stackBindingKey(binding))
  )
  const removed = stack.bindings.find(
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
  const operation: TailscaleOperationToast["operation"] =
    newRelayIds.size > 0
      ? "install"
      : added
        ? "connect"
        : removed
          ? "disconnect"
          : "update"
  const changedBinding = added ?? removed

  return {
    id: tailscaleOperationToastId(stack.id),
    memberKind: !changedBinding
      ? "server"
      : appTailscaleMember(changedBinding.memberId)
        ? "app"
        : databaseTailscaleMember(changedBinding.memberId)
          ? "database"
          : "server",
    networkName: stack.name,
    nodeCount: operation === "install" ? newRelayIds.size : undefined,
    operation,
  }
}

function stackBindingKey({
  memberId,
  relayId,
}: Pick<StackBinding, "memberId" | "relayId">): string {
  return `${relayId}:${memberId}`
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
    bindings: bindings.map(({ enabled, hostname, memberId, relayId }) => ({
      enabled,
      hostname,
      memberId,
      relayId,
    })),
    domain,
    id: stack.id,
    name: stack.name,
  }
}

function findBinding(
  stack: TailscaleStackOverview,
  relayId: string,
  memberId: string
) {
  return stack.bindings.find(
    (binding) => binding.relayId === relayId && binding.memberId === memberId
  )
}

function uniqueHostname(
  stack: TailscaleStackOverview,
  server: { name: string; shortId: string }
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

function memberStatus({
  binding,
  deployment,
  member: server,
}: TailscaleMemberRow): IdentityStatusPresentation {
  if (!binding.enabled) return { label: "Paused", tone: "neutral" }
  if (!server.tailscaleSupported) {
    return {
      detail: `Update ${server.relayName} before changing Tailscale memberships`,
      label: "Update required",
      tone: "warning",
    }
  }
  if (!deployment) return { label: "Provisioning", pulse: true, tone: "info" }
  if (
    deployment.status.connected &&
    deployment.components.coreDnsRunning &&
    deployment.components.tailscaleRunning
  ) {
    return { label: "Connected", tone: "success" }
  }
  if (deployment.status.message) {
    return {
      detail: deployment.status.message,
      label: "Needs attention",
      tone: "danger",
    }
  }
  return { label: "Connecting", pulse: true, tone: "warning" }
}

function memberHostname({ binding, domain }: TailscaleMemberRow) {
  return `${binding.hostname}.${domain}`
}

function memberRowKey({ binding }: TailscaleMemberRow) {
  return stackBindingKey(binding)
}

const memberIdLabels = {
  app: "App ID",
  database: "Database ID",
  server: "Game server ID",
} as const

function memberSearchText(row: TailscaleMemberRow) {
  const { member } = row
  return `${member.name} ${member.shortId} ${member.meta} ${member.relayName} ${memberHostname(row)} ${memberStatus(row).label}`
}

const cleanupRetryFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function TailscaleCleanupState({ stack }: { stack: TailscaleStackOverview }) {
  const cleanup = stack.cleanup
  if (!cleanup) return null
  const pendingRelays = `${cleanup.pendingRelays} ${cleanup.pendingRelays === 1 ? "Relay" : "Relays"} pending`
  const nextAttemptAt = cleanup.nextAttemptAt
    ? cleanupRetryFormatter.format(new Date(cleanup.nextAttemptAt))
    : null

  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <LoaderCircle className="size-6 animate-spin text-primary-ink" />
      <p className="mt-3 text-sm font-semibold">Removing {stack.name}</p>
      <p className="type-support mt-1 text-muted-foreground">
        {pendingRelays}. Cleanup will continue automatically.
      </p>
      {cleanup.lastError ? (
        <div
          className="mt-4 flex max-w-lg items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-left light:bg-destructive/10"
          role="status"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-xs break-words text-destructive">
              {cleanup.lastError}
            </p>
            <p className="type-meta mt-1 text-muted-foreground">
              {nextAttemptAt
                ? `Next automatic retry: ${nextAttemptAt}`
                : "The next retry is queued automatically"}
              {cleanup.attempts > 0
                ? ` · ${cleanup.attempts} ${cleanup.attempts === 1 ? "attempt" : "attempts"}`
                : ""}
            </p>
          </div>
        </div>
      ) : null}
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
  const Icon = icon === "network" ? Network : ServerKindIcon

  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
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
