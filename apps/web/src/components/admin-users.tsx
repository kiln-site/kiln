import {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Activity,
  Ban,
  EllipsisVertical,
  KeyRound,
  Mail,
  MailCheck,
  Plus,
  Trash2,
  UserCheck,
  Users,
} from "lucide-react"
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
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { InstanceKindCounts } from "@/components/instance-kind-counts"
import { RelativeTime } from "@/components/relative-time"
import { UserAccessDialog } from "@/components/user-access-dialog"
import {
  UserActionButton,
  UserRowIdentity,
} from "@/components/user-table-parts"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  createDataTableSearchStore,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import { useCursorDataTableSource } from "@/lib/data-table-source"
import { roleLabel, roleRank, stateLabel } from "@/lib/managed-user"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import {
  grantOrInviteAccess,
  removePlatformAccess,
  revokeAccessInvitation,
} from "@/server/access"
import {
  decideResourceInvitation,
  updateResourceAccess,
} from "@/server/resource-access"
import {
  getUserAccess,
  listUsers,
  setUserStatus,
  type ManagedUser,
} from "@/server/users"

const pageSize = 50
const helper = createDataTableColumnHelper<ManagedUser>()
const userKey = (user: ManagedUser) => user.id
const initialTableState = { sorting: [{ id: "role", desc: false }] }

type UserAction =
  | { kind: "manage"; userId: string }
  | { kind: "add" }
  | { kind: "remove"; user: ManagedUser }
  | { kind: "status"; user: ManagedUser }
  | { kind: "accept"; user: ManagedUser }

export const AdminUsers = memo(function AdminUsers() {
  const [searchStore] = useState(() => createDataTableSearchStore())
  const [action, setAction] = useState<UserAction | null>(null)
  const add = useCallback(() => setAction({ kind: "add" }), [])
  const close = useCallback(() => setAction(null), [])
  return (
    <DataTableWorkspace
      toolbar={
        <DataTableToolbar
          search={{
            ariaLabel: "Search users",
            placeholder: "Search users",
            store: searchStore,
          }}
          actions={
            <Button aria-label="Add user" onClick={add}>
              <Plus />
              <span className="hidden sm:inline">Add user</span>
            </Button>
          }
        />
      }
    >
      <UserTable searchStore={searchStore} onAction={setAction} />
      {action?.kind === "manage" || action?.kind === "add" ? (
        <UserAccessDialog
          userId={action.kind === "manage" ? action.userId : undefined}
          platform
          onClose={close}
        />
      ) : action?.kind === "remove" ? (
        <RemoveUserDialog user={action.user} onClose={close} />
      ) : action?.kind === "status" ? (
        <UserStatusDialog user={action.user} onClose={close} />
      ) : action?.kind === "accept" ? (
        <AcceptInvitationsDialog user={action.user} onClose={close} />
      ) : null}
    </DataTableWorkspace>
  )
})

const UserTable = memo(function UserTable({
  searchStore,
  onAction,
}: {
  searchStore: DataTableSearchStore
  onAction: (action: UserAction) => void
}) {
  const search = useDeferredValue(
    useSyncExternalStore(
      searchStore.subscribe,
      searchStore.getNormalizedSnapshot,
      searchStore.getNormalizedServerSnapshot
    )
  )
  const query = useInfiniteQuery({
    queryKey: ["users", "list", search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      listUsers({ data: { search, offset: pageParam, limit: pageSize } }),
    getNextPageParam: (last) => last.nextCursor,
    // The realtime access topic invalidates the users prefix, so this list
    // stays fresh without a poll.
    placeholderData: keepPreviousData,
  })
  const source = useCursorDataTableSource({
    query,
    resetKey: search,
    getRowKey: userKey,
  })
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const selfId = capabilities?.user.id
  const definition = useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Users",
        columns: helper.columns([
          helper.accessor((user) => stateLabel(user), {
            id: "status",
            header: () => (
              <span className="sr-only sm:not-sr-only">Status</span>
            ),
            sortFn: "text",
            cell: ({ row }) => <UserState user={row.original} />,
            meta: dataTableColumnMeta(
              { width: { base: "2rem", sm: "7rem" } },
              { cellClassName: "pr-0", headerClassName: "pr-0" }
            ),
          }),
          helper.accessor("name", {
            header: "User",
            sortFn: "text",
            cell: ({ row }) => (
              <UserCell user={row.original} onAction={onAction} />
            ),
            meta: dataTableColumnMeta({
              width: { base: "minmax(0,1fr)", md: "minmax(0,1.5fr)" },
            }),
          }),
          // Labels sort Kiln Admin, Relay Creator, User, so the default
          // ascending sort puts admins first.
          helper.accessor((user) => roleLabel(user.role), {
            id: "role",
            header: "Role",
            sortFn: "text",
            cell: ({ row }) => <UserRole user={row.original} />,
            meta: dataTableColumnMeta({ hideBelow: "sm", width: "9rem" }),
          }),
          helper.display({
            id: "instances",
            header: "Instances",
            enableSorting: false,
            cell: ({ row }) => (
              <UserHoldings user={row.original} onAction={onAction} />
            ),
            meta: dataTableColumnMeta({
              hideBelow: "md",
              width: "minmax(13rem,1.2fr)",
            }),
          }),
          helper.accessor("createdAt", {
            header: "Added",
            sortFn: "text",
            cell: ({ row }) => (
              <UserAdded user={row.original} onAction={onAction} />
            ),
            meta: dataTableColumnMeta({ hideBelow: "xl", width: "8rem" }),
          }),
          helper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <UserActions
                user={row.original}
                self={row.original.id === selfId}
                onAction={onAction}
              />
            ),
            // The whole cell sits above the row's manage button, so a click
            // that misses an action doesn't open the dialog instead.
            meta: dataTableColumnMeta(
              { width: { base: "7.25rem" } },
              { cellClassName: "relative z-10 px-2" }
            ),
          }),
        ]),
        getRowId: userKey,
        getRowClassName: () => "relative cursor-pointer",
        model: { initialState: initialTableState },
        virtualization: true,
      }),
    [onAction, selfId]
  )
  return (
    <DataTable
        definition={definition}
        source={source}
        emptyState={
          <DataTableEmptyState
            icon={
              <Users className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
            }
            title={search ? "No users match your search" : "No users"}
            description={
              search
                ? "Try a name or email address."
                : "Add a user to invite them to Kiln."
            }
          />
        }
      />
  )
})

const UserCell = memo(function UserCell({
  user,
  onAction,
}: {
  user: ManagedUser
  onAction: (action: UserAction) => void
}) {
  return (
    <UserRowIdentity
      userId={user.id}
      name={user.name}
      email={user.email}
      openLabel={`Manage ${user.name}`}
      onOpen={() => onAction({ kind: "manage", userId: user.id })}
    />
  )
})

// Positioned so its full date shows on hover above the row's manage button;
// a click still manages the user.
const UserAdded = memo(function UserAdded({
  user,
  onAction,
}: {
  user: ManagedUser
  onAction: (action: UserAction) => void
}) {
  return (
    <span
      className="relative cursor-pointer"
      onClick={() => onAction({ kind: "manage", userId: user.id })}
    >
      <RelativeTime
        className="type-meta text-foreground"
        timestamp={Date.parse(user.createdAt)}
      />
    </span>
  )
})

const UserRole = memo(function UserRole({ user }: { user: ManagedUser }) {
  return (
    <span className="min-w-0">
      <span
        className={cn(
          "type-meta block truncate",
          user.role === "admin"
            ? "font-medium text-primary-ink"
            : "text-foreground"
        )}
      >
        {roleLabel(user.role)}
      </span>
      {user.invitedRole && user.role !== "admin" ? (
        <span className="type-meta block truncate text-muted-foreground">
          Invited as {roleLabel(user.invitedRole)}
        </span>
      ) : null}
    </span>
  )
})

const stateDot: Record<ManagedUser["state"], string> = {
  active: "bg-emerald-400",
  pending: "bg-amber-400",
  disabled: "bg-destructive",
}

const UserState = memo(function UserState({ user }: { user: ManagedUser }) {
  return (
    <span className="type-meta inline-flex min-w-0 items-center gap-2 text-foreground">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", stateDot[user.state])}
      />
      <span className="sr-only truncate sm:not-sr-only">
        {stateLabel(user)}
      </span>
    </span>
  )
})

const UserHoldings = memo(function UserHoldings({
  user,
  onAction,
}: {
  user: ManagedUser
  onAction: (action: UserAction) => void
}) {
  const pending = user.access.pending + (user.invitedRole ? 1 : 0)
  return (
    <span className="type-meta flex min-w-0 items-center gap-3 text-muted-foreground">
      <InstanceKindCounts counts={user.access} />
      {pending ? (
        <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
      ) : null}
      {pending ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Above the row's manage button, so it can be clicked on its own. */}
            <button
              type="button"
              aria-label={`Accept ${pending} invitation${pending === 1 ? "" : "s"} for ${user.name}`}
              className="relative z-10 -mx-1 flex h-7 items-center gap-1 rounded-md px-1 text-amber-700 tabular-nums transition-colors hover:bg-amber-500/10 dark:text-amber-300 light:hover:bg-amber-500/20"
              onClick={() => onAction({ kind: "accept", user })}
            >
              <Mail className="size-3.5" aria-hidden="true" />
              {pending}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {pending} unanswered invitation{pending === 1 ? "" : "s"}. Click to
            accept for them.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
})

const UserActions = memo(function UserActions({
  user,
  self,
  onAction,
}: {
  user: ManagedUser
  self: boolean
  onAction: (action: UserAction) => void
}) {
  const enabled = user.status === "enabled"
  const invitations = user.access.pending + (user.invitedRole ? 1 : 0)
  const removeBlocked = self
    ? "You can't remove yourself"
    : user.access.owned
      ? "Transfer what they own first"
      : null
  return (
    <DataTableActionGroup>
      {self ? null : (
        <UserActionButton
          icon={enabled ? Ban : UserCheck}
          tone={enabled ? "warning" : "success"}
          label={`${enabled ? "Disable" : "Enable"} ${user.name}`}
          tooltip={enabled ? "Disable account" : "Enable account"}
          onClick={() => onAction({ kind: "status", user })}
        />
      )}
      <UserActionButton
        icon={Trash2}
        tone="danger"
        label={`Remove ${user.name}`}
        tooltip={removeBlocked ?? "Remove from Kiln"}
        disabled={!!removeBlocked}
        onClick={() => onAction({ kind: "remove", user })}
      />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`More actions for ${user.name}`}
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem
            onSelect={() => onAction({ kind: "manage", userId: user.id })}
          >
            <KeyRound /> Manage access
          </DropdownMenuItem>
          {user.hasCredential ? (
            <DropdownMenuItem asChild>
              <Link to="/activity" search={{ user: user.id }}>
                <Activity /> View activity
              </Link>
            </DropdownMenuItem>
          ) : null}
          {invitations ? (
            <DropdownMenuItem
              onSelect={() => onAction({ kind: "accept", user })}
            >
              <MailCheck />
              {invitations === 1 ? "Accept invitation" : "Accept invitations"}
            </DropdownMenuItem>
          ) : null}
          <CopyIdentifierMenuItem label="Email" value={user.email} />
          <CopyIdentifierMenuItem label="User ID" value={user.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

function invalidateUsers(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: ["users"] })
  void client.invalidateQueries({ queryKey: ["resource-access"] })
  void client.invalidateQueries({ queryKey: ["access"] })
}

function RemoveUserDialog({
  user,
  onClose,
}: {
  user: ManagedUser
  onClose: () => void
}) {
  const client = useQueryClient()
  const remove = useMutation({
    // Every grant is revoked through the same path as the Access page, so
    // each Relay hears about it; then platform access and invitations go.
    mutationFn: async () => {
      const access = await getUserAccess({ data: { userId: user.id } })
      // Ownership can arrive after the table loaded, and removal would leave
      // it in place, so check again before changing anything.
      if (access.user.access.owned)
        throw new Error(
          `${user.name} owns resources now. Transfer them before removing.`
        )
      for (const grant of access.grants)
        await updateResourceAccess({
          data: {
            ...grant.scope,
            id: grant.id,
            revision: grant.revision,
            revoke: true,
            selections: [],
            presetIds: [],
            builtinKeys: [],
          },
        })
      for (const id of access.platformInvitationIds)
        await revokeAccessInvitation({ data: { id } })
      if (access.user.role === "admin" || access.user.role === "relay_creator")
        await removePlatformAccess({ data: { userId: user.id } })
    },
    onSuccess: () => {
      invalidateUsers(client)
      showToast({ type: "success", message: `${user.name} removed` })
      onClose()
    },
    onError: (error) => {
      invalidateUsers(client)
      showToast({ type: "error", message: error.message })
    },
  })
  const pending = user.state === "pending"
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {user.name}?</DialogTitle>
          <DialogDescription>
            {pending
              ? "Their invitations are cancelled and they're taken off this list. You can invite them again later."
              : "They lose access to every Relay, game server, and database, and their platform role and open invitations are removed. Their account stays, so they can still sign in; disable it to stop that."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UserStatusDialog({
  user,
  onClose,
}: {
  user: ManagedUser
  onClose: () => void
}) {
  const client = useQueryClient()
  const enabled = user.status === "enabled"
  const update = useMutation({
    mutationFn: () =>
      setUserStatus({
        data: { userId: user.id, status: enabled ? "disabled" : "enabled" },
      }),
    onSuccess: () => {
      invalidateUsers(client)
      showToast({
        type: "success",
        message: `${user.name} ${enabled ? "disabled" : "enabled"}`,
      })
      onClose()
    },
    onError: (error) => showToast({ type: "error", message: error.message }),
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !update.isPending) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {enabled ? "Disable" : "Enable"} {user.name}?
          </DialogTitle>
          <DialogDescription>
            {enabled
              ? "They're signed out and can't sign in until you enable them again. Their access is kept."
              : "They can sign in again with the access they had."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={update.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant={enabled ? "destructive" : "default"}
            disabled={update.isPending}
            onClick={() => update.mutate()}
          >
            {enabled ? "Disable account" : "Enable account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AcceptInvitationsDialog({
  user,
  onClose,
}: {
  user: ManagedUser
  onClose: () => void
}) {
  const client = useQueryClient()
  const count = user.access.pending + (user.invitedRole ? 1 : 0)
  const accept = useMutation({
    // Resource invitations are accepted for them and recorded as accepted by
    // you. A platform role has no accept path, so it is assigned and its
    // invitation cancelled.
    mutationFn: async () => {
      const access = await getUserAccess({ data: { userId: user.id } })
      let accepted = 0
      for (const grant of access.grants)
        if (
          grant.relayEnabled &&
          grant.state === "pending" &&
          grant.invitationId
        ) {
          await decideResourceInvitation({
            data: { id: grant.invitationId, decision: "accept", force: true },
          })
          accepted += 1
        }
      const invited = access.user.invitedRole
      if (invited) {
        // Like accepting it themselves, never trade a stronger role they
        // already hold for the one the invitation offered.
        if (roleRank(invited) > roleRank(access.user.role))
          await grantOrInviteAccess({
            data: { userId: user.id, email: user.email, accessType: invited },
          })
        for (const id of access.platformInvitationIds)
          await revokeAccessInvitation({ data: { id } })
        accepted += 1
      }
      return accepted
    },
    onSuccess: (accepted) => {
      invalidateUsers(client)
      showToast({
        type: accepted ? "success" : "info",
        message: accepted
          ? `Accepted for ${user.name}`
          : `${user.name} has no open invitations left`,
      })
      onClose()
    },
    onError: (error) => {
      invalidateUsers(client)
      showToast({ type: "error", message: error.message })
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !accept.isPending) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Accept {count === 1 ? "invitation" : `${count} invitations`} for{" "}
            {user.name}?
          </DialogTitle>
          <DialogDescription>
            They get this access right away, without accepting it themselves.
            {user.invitedRole
              ? ` That includes the ${roleLabel(user.invitedRole)} role.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={accept.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
            {accept.isPending
              ? "Accepting…"
              : count === 1
                ? "Accept invitation"
                : "Accept invitations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
