import {
  createContext,
  memo,
  useCallback,
  useContext,
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
  Boxes,
  Database,
  EllipsisVertical,
  KeyRound,
  Mail,
  Plus,
  RadioTower,
  Server,
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
  DropdownMenuSeparator,
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
  DataTableTextCell,
} from "@/components/data-table"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { UserAccessDialog, UserBadges } from "@/components/user-access-dialog"
import { UserIdentity } from "@/components/user-identity"
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
import { stateLabel } from "@/lib/managed-user"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import { removePlatformAccess, revokeAccessInvitation } from "@/server/access"
import { updateResourceAccess } from "@/server/resource-access"
import {
  getUserAccess,
  getUserMinecraftProfiles,
  listUsers,
  setUserStatus,
  type ManagedUser,
} from "@/server/users"

const pageSize = 50
const helper = createDataTableColumnHelper<ManagedUser>()
const userKey = (user: ManagedUser) => user.id
const NO_PROFILES: Record<string, string> = {}

type UserAction =
  | { kind: "manage"; userId: string; profileId?: string }
  | { kind: "add" }
  | { kind: "remove"; user: ManagedUser }
  | { kind: "status"; user: ManagedUser }

// Minecraft heads load after the rows. Reading them from context re-renders
// only the identity cells when they arrive, not every row and its actions.
const UserProfilesContext = createContext(NO_PROFILES)

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
          profileId={action.kind === "manage" ? action.profileId : undefined}
          platform
          onClose={close}
        />
      ) : action?.kind === "remove" ? (
        <RemoveUserDialog user={action.user} onClose={close} />
      ) : action?.kind === "status" ? (
        <UserStatusDialog user={action.user} onClose={close} />
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
  const userIds = useMemo(
    () => source.rows.flatMap((user) => (user.hasCredential ? [user.id] : [])),
    [source.rows]
  )
  const profiles = useQuery({
    queryKey: ["users", "minecraft-profiles", userIds.join(",")],
    queryFn: () =>
      getUserMinecraftProfiles({ data: { userIds: userIds.slice(0, 100) } }),
    enabled: userIds.length > 0,
    staleTime: 60 * 60_000,
  })
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const selfId = capabilities?.user.id
  const definition = useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Users",
        columns: helper.columns([
          helper.accessor("name", {
            header: "User",
            sortFn: "text",
            cell: ({ row }) => (
              <UserCell user={row.original} onAction={onAction} />
            ),
            meta: dataTableColumnMeta({
              width: { base: "minmax(0,1fr)", md: "minmax(0,1.6fr)" },
            }),
          }),
          helper.accessor((user) => stateLabel(user), {
            id: "status",
            header: "Status",
            sortFn: "text",
            cell: ({ row }) => <UserState user={row.original} />,
            meta: dataTableColumnMeta({ hideBelow: "sm", width: "8.5rem" }),
          }),
          helper.display({
            id: "instances",
            header: "Instances",
            enableSorting: false,
            cell: ({ row }) => <UserHoldings user={row.original} />,
            meta: dataTableColumnMeta({
              hideBelow: "md",
              width: "minmax(11rem,1.2fr)",
            }),
          }),
          helper.accessor("createdAt", {
            header: "Added",
            sortFn: "text",
            cell: ({ row }) => (
              <DataTableTextCell value={row.original.createdAt.slice(0, 10)} />
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
        virtualization: true,
      }),
    [onAction, selfId]
  )
  return (
    <UserProfilesContext.Provider value={profiles.data ?? NO_PROFILES}>
      <DataTable
        definition={definition}
        source={source}
        emptyState={
          <DataTableEmptyState
            icon={<Users className="size-6 text-muted-foreground/45" />}
            title={search ? "No users match your search" : "No users"}
            description={
              search
                ? "Try a name or email address."
                : "Add a user to invite them to Kiln."
            }
          />
        }
      />
    </UserProfilesContext.Provider>
  )
})

const UserCell = memo(function UserCell({
  user,
  onAction,
}: {
  user: ManagedUser
  onAction: (action: UserAction) => void
}) {
  const profileId = useContext(UserProfilesContext)[user.id]
  return (
    <>
      {/* Covers the row: clicking anywhere but an action manages the user. */}
      <button
        type="button"
        aria-label={`Manage ${user.name}`}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        onClick={() => onAction({ kind: "manage", userId: user.id, profileId })}
      />
      <UserIdentity
        className="pointer-events-none relative w-full"
        emailClassName="pointer-events-auto relative"
        name={user.name}
        email={user.email}
        profileId={profileId}
        accessory={
          <>
            <UserBadges user={user} />
            {/* The Status column is hidden on phones. */}
            {user.state === "active" ? null : (
              <span className="sm:hidden">
                <UserState user={user} />
              </span>
            )}
          </>
        }
      />
    </>
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
      <span className="truncate">{stateLabel(user)}</span>
    </span>
  )
})

// The same icons and colours as the infrastructure map's Relay cards.
const holdingKinds = [
  {
    key: "relays",
    icon: RadioTower,
    tone: "text-primary",
    one: "Relay",
    other: "Relays",
  },
  {
    key: "instances",
    icon: Server,
    tone: "text-emerald-300",
    one: "game server",
    other: "game servers",
  },
  {
    key: "apps",
    icon: Boxes,
    tone: "text-red-300",
    one: "app",
    other: "apps",
  },
  {
    key: "databases",
    icon: Database,
    tone: "text-blue-300",
    one: "database",
    other: "databases",
  },
] as const

const UserHoldings = memo(function UserHoldings({
  user,
}: {
  user: ManagedUser
}) {
  const { pending } = user.access
  return (
    <span className="type-meta flex min-w-0 items-center gap-3 text-muted-foreground">
      {holdingKinds.map(({ key, icon: Icon, tone, one, other }) => {
        const count = user.access[key]
        const label = `${count} ${count === 1 ? one : other}`
        return (
          <span
            key={key}
            title={label}
            className={cn(
              "flex items-center gap-1 tabular-nums",
              count ? "text-foreground" : "opacity-40"
            )}
          >
            <Icon className={cn("size-3.5", tone)} aria-hidden="true" />
            {count}
            <span className="sr-only">{count === 1 ? one : other}</span>
          </span>
        )
      })}
      {pending ? (
        <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
      ) : null}
      {pending ? (
        <span
          title={`${pending} unanswered invitation${pending === 1 ? "" : "s"}`}
          className="flex items-center gap-1 text-amber-700 tabular-nums dark:text-amber-300"
        >
          <Mail className="size-3.5" aria-hidden="true" />
          {pending}
          <span className="sr-only">invited</span>
        </span>
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
  const removeBlocked = self
    ? "You can't remove yourself"
    : user.access.owned
      ? "Transfer what they own first"
      : null
  return (
    <DataTableActionGroup>
      {self ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`${enabled ? "Disable" : "Enable"} ${user.name}`}
              className={cn(
                "text-muted-foreground",
                enabled ? "hover:text-amber-500" : "hover:text-emerald-500"
              )}
              onClick={() => onAction({ kind: "status", user })}
            >
              {enabled ? <Ban /> : <UserCheck />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {enabled ? "Disable account" : "Enable account"}
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events, so the tooltip hangs on its wrapper. */}
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${user.name}`}
              disabled={!!removeBlocked}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onAction({ kind: "remove", user })}
            >
              <Trash2 />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {removeBlocked ?? "Remove from Kiln"}
        </TooltipContent>
      </Tooltip>
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
        <DropdownMenuContent align="end" className="min-w-44">
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
          <DropdownMenuSeparator />
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
