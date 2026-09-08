import { recoverPromise } from "@/effect/promise"
import { memo, useMemo, useState, useSyncExternalStore } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { EllipsisVertical, Mail, Plus, Users } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Badge } from "@workspace/ui/components/badge"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { showToast } from "@workspace/ui/components/sonner"
import { DataTable } from "@/components/data-table-view"
import { DataTableEmptyState, DataTableTextCell } from "@/components/data-table"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  createDataTableSearchStore,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import {
  issueAccountClaim,
  listUsers,
  manuallyVerifyUser,
  setUserStatus,
  type ManagedUser,
} from "@/server/users"
import {
  grantOrInviteAccess,
  removePlatformAccess,
  listPendingPlatformInvitations,
  revokeAccessInvitation,
} from "@/server/access"

const pageSize = 25
const EMPTY_USERS: Array<ManagedUser> = []
const helper = createDataTableColumnHelper<ManagedUser>()
const userDefinition = defineDataTable({
  ariaLabel: "Platform users",
  columns: helper.columns([
    helper.accessor("name", {
      header: "User",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{row.original.name}</p>
            <Badge
              variant="outline"
              className="h-4 px-1 text-[10px] capitalize sm:hidden"
            >
              {row.original.status}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {row.original.email}
          </p>
        </div>
      ),
      meta: dataTableColumnMeta({ width: "minmax(0,1.5fr)" }),
    }),
    helper.accessor("status", {
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <Badge variant="outline" className="capitalize">
            {row.original.status}
          </Badge>
        </div>
      ),
      meta: dataTableColumnMeta({ hideBelow: "sm", width: "7rem" }),
    }),
    helper.accessor("role", {
      header: "Platform role",
      enableSorting: false,
      cell: ({ row }) => (
        <DataTableTextCell value={roleLabel(row.original.role)} />
      ),
      meta: dataTableColumnMeta({
        hideBelow: "lg",
        width: "minmax(10rem,1fr)",
      }),
    }),
    helper.display({
      id: "verification",
      header: "Verification",
      cell: ({ row }) => (
        <DataTableTextCell
          value={
            !row.original.hasCredential
              ? "Awaiting claim"
              : verificationLabel(row.original)
          }
        />
      ),
      meta: dataTableColumnMeta({ hideBelow: "md", width: "minmax(8rem,1fr)" }),
    }),
    helper.accessor("createdAt", {
      header: "Created",
      enableSorting: false,
      cell: ({ row }) => (
        <DataTableTextCell value={date(row.original.createdAt)} />
      ),
      meta: dataTableColumnMeta({ hideBelow: "xl", width: "12rem" }),
    }),
    helper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => <UserActions user={row.original} />,
      meta: dataTableColumnMeta({ width: "3.5rem" }),
    }),
  ]),
  getRowId: (user) => user.id,
})

export const AdminUsers = memo(function AdminUsers() {
  const [searchStore] = useState(() => createDataTableSearchStore())
  return (
    <DataTableWorkspace
      toolbar={
        <DataTableToolbar
          search={{
            ariaLabel: "Search users",
            placeholder: "Search users",
            store: searchStore,
          }}
          actions={<AdminUserToolbarActions />}
        />
      }
    >
      <UserTable searchStore={searchStore} />
    </DataTableWorkspace>
  )
})

const AdminUserToolbarActions = memo(function AdminUserToolbarActions() {
  const [dialog, setDialog] = useState<"add" | "invitations" | null>(null)
  const [pending, setPending] = useState(false)
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            aria-label="Pending platform invitations"
            onClick={() => setDialog("invitations")}
          >
            <Mail />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Pending platform invitations</TooltipContent>
      </Tooltip>
      <Button aria-label="Add user" onClick={() => setDialog("add")}>
        <Plus />
        <span className="hidden sm:inline">Add user</span>
      </Button>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDialog(null)
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog === "add" ? "Add user" : "Pending platform invitations"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "add"
                ? "Choose the platform access this user should receive."
                : "Review or cancel invitations that have not been accepted."}
            </DialogDescription>
          </DialogHeader>
          {dialog === "add" ? (
            <PlatformInvitationForm onPendingChange={setPending} />
          ) : dialog === "invitations" ? (
            <PendingPlatformInvitations onPendingChange={setPending} />
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDialog(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

const UserTable = memo(function UserTable({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  const search = useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getNormalizedSnapshot,
    searchStore.getNormalizedServerSnapshot
  )
  return <UserTablePage key={search} search={search} />
})
function UserTablePage({ search }: { search: string }) {
  const [offset, setOffset] = useState(0)
  const query = useQuery({
    queryKey: ["users", search, offset],
    queryFn: () => listUsers({ data: { search, offset, limit: pageSize } }),
    refetchInterval: 15_000,
  })
  const source = useMemo<DataTableSource<ManagedUser>>(
    () => ({
      rows: query.data?.users ?? EMPTY_USERS,
      refreshing: query.isFetching && !query.isPending,
      body: query.isPending
        ? { kind: "loading" }
        : query.isError
          ? {
              kind: "error",
              error: query.error,
              retry: () => {
                void query.refetch()
              },
            }
          : { kind: "ready" },
      resetKey: `${search}:${offset}`,
    }),
    [
      query.data,
      query.isFetching,
      query.isPending,
      query.isError,
      query.error,
      query.refetch,
      search,
      offset,
    ]
  )
  return (
    <>
      <DataTable
        definition={userDefinition}
        source={source}
        emptyState={
          <DataTableEmptyState
            icon={<Users className="size-6 text-muted-foreground/45" />}
            title={search ? "No users match your search" : "No users"}
            description={
              search
                ? "Try a name or email address."
                : "Add a user to manage their account and access."
            }
          />
        }
      />
      <div className="flex shrink-0 items-center justify-between gap-3 p-3 text-xs text-muted-foreground">
        <span>{query.data?.total ?? 0} users</span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!offset || query.isPending}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              !query.data ||
              offset + pageSize >= query.data.total ||
              query.isPending
            }
            onClick={() => setOffset(offset + pageSize)}
          >
            Next
          </Button>
        </div>
      </div>
    </>
  )
}

const UserActions = memo(function UserActions({ user }: { user: ManagedUser }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  return (
    <div className="flex justify-end px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${user.email}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            Manage user
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next)
        }}
      >
        {open ? (
          <UserManagement
            user={user}
            pending={pending}
            onPendingChange={setPending}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </div>
  )
})
function UserManagement({
  user,
  onClose,
  pending,
  onPendingChange,
}: {
  pending: boolean
  onPendingChange: (pending: boolean) => void
  user: ManagedUser
  onClose: () => void
}) {
  const client = useQueryClient()
  const [claim, setClaim] = useState<{
    claimUrl: string
    expiresAt: string
  } | null>(null)
  const mutation = useMutation({
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    mutationFn: async (action: "status" | "verify" | "claim") => {
      if (action === "status")
        await setUserStatus({
          data: {
            userId: user.id,
            status: user.status === "enabled" ? "disabled" : "enabled",
          },
        })
      else if (action === "verify")
        await manuallyVerifyUser({ data: { userId: user.id } })
      else setClaim(await issueAccountClaim({ data: { userId: user.id } }))
      return action
    },
    onSuccess: (action) => {
      showToast({
        type: "success",
        message:
          action === "claim"
            ? "Manual claim link created"
            : action === "verify"
              ? "Account manually verified"
              : "Account status updated",
      })
      void client.invalidateQueries({ queryKey: ["users"] })
    },
    onError: (cause) => showToast({ type: "error", message: cause.message }),
  })
  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{user.name}</DialogTitle>
        <DialogDescription className="break-all">
          {user.email}
        </DialogDescription>
      </DialogHeader>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Account status</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="capitalize">{user.status}</dd>
          <dt className="text-muted-foreground">Changed</dt>
          <dd>{date(user.statusChangedAt)}</dd>
          {user.statusExpiresAt ? (
            <>
              <dt className="text-muted-foreground">Until</dt>
              <dd>{date(user.statusExpiresAt)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Created</dt>
          <dd>{date(user.createdAt)}</dd>
        </dl>
        {user.statusReason ? (
          <p className="text-sm text-muted-foreground">{user.statusReason}</p>
        ) : null}
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => mutation.mutate("status")}
        >
          {user.status === "enabled" ? "Disable account" : "Enable account"}
        </Button>
      </section>
      <section className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">Verification</h3>
        <p className="text-sm">{verificationLabel(user)}</p>
        {user.emailVerifiedAt ? (
          <p className="text-xs text-muted-foreground">
            Email verified {date(user.emailVerifiedAt)}
          </p>
        ) : null}
        {user.manuallyVerifiedAt ? (
          <p className="text-xs text-muted-foreground">
            Manually verified {date(user.manuallyVerifiedAt)}
          </p>
        ) : null}
        {user.legacyVerificationRecordedAt ? (
          <p className="text-xs text-muted-foreground">
            Legacy trust recorded {date(user.legacyVerificationRecordedAt)};
            original method unknown.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {!user.manuallyVerifiedAt ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => mutation.mutate("verify")}
            >
              Verify manually
            </Button>
          ) : null}
          {!user.hasCredential ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => mutation.mutate("claim")}
            >
              Issue manual claim
            </Button>
          ) : null}
        </div>
        {claim ? (
          <div className="space-y-2">
            <Input
              readOnly
              aria-label={`Manual claim link for ${user.email}`}
              value={claim.claimUrl}
            />
            <p className="text-xs text-muted-foreground">
              Redeeming this link verifies the account manually. Expires{" "}
              {date(claim.expiresAt)}.
            </p>
            <Button
              variant="outline"
              onClick={() =>
                void recoverPromise(
                  async () => {
                    await navigator.clipboard.writeText(claim.claimUrl)
                    showToast({ type: "success", message: "Claim link copied" })
                  },
                  () =>
                    showToast({
                      type: "error",
                      message: "Could not copy the link",
                    })
                )
              }
            >
              Copy link
            </Button>
          </div>
        ) : null}
      </section>
      <section className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">Platform role</h3>
        <PlatformRoleControl
          key={user.role}
          user={user}
          pending={pending}
          onPendingChange={onPendingChange}
        />
      </section>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
function date(value: string | null) {
  return value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "—"
}
function roleLabel(role: string | null) {
  return role === "admin"
    ? "Platform administrator"
    : role === "relay_creator"
      ? "Relay creator"
      : "None"
}
function verificationLabel(user: ManagedUser) {
  return (
    [
      user.emailVerifiedAt && "Email",
      user.manuallyVerifiedAt && "Manual",
      user.legacyVerificationRecordedAt && "Legacy trust",
    ]
      .filter(Boolean)
      .join(" + ") || "Unverified"
  )
}

const PlatformRoleControl = memo(function PlatformRoleControl({
  user,
  pending,
  onPendingChange,
}: {
  user: ManagedUser
  pending: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const client = useQueryClient()
  const initial =
    user.role === "admin" || user.role === "relay_creator" ? user.role : "user"
  const [role, setRole] = useState(initial)
  const mutation = useMutation({
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    mutationFn: async () => {
      if (role === "user")
        await removePlatformAccess({ data: { userId: user.id } })
      else
        await grantOrInviteAccess({
          data: {
            userId: user.id,
            email: user.email,
            accessType: role === "admin" ? "platform_admin" : "relay_creator",
          },
        })
    },
    onSuccess: () => {
      showToast({ type: "success", message: "Platform role updated" })
      void client.invalidateQueries({ queryKey: ["users"] })
      void client.invalidateQueries({ queryKey: ["access"] })
      void client.invalidateQueries({ queryKey: ["auth"] })
    },
    onError: (error) => showToast({ type: "error", message: error.message }),
  })
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Select
        value={role}
        onValueChange={(value) => setRole(value as typeof role)}
        disabled={pending}
      >
        <SelectTrigger aria-label={`Platform role for ${user.email}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="user">No platform role</SelectItem>
          <SelectItem value="relay_creator">Relay creator</SelectItem>
          <SelectItem value="admin">Platform administrator</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || role === initial}
        onClick={() => mutation.mutate()}
      >
        Save role
      </Button>
    </div>
  )
})

const PlatformInvitationForm = memo(function PlatformInvitationForm({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void
}) {
  const client = useQueryClient()
  const [email, setEmail] = useState("")
  const [accessType, setAccessType] = useState<
    "platform_admin" | "relay_creator"
  >("relay_creator")
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const mutation = useMutation({
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    mutationFn: () => grantOrInviteAccess({ data: { email, accessType } }),
    onSuccess: (result) => {
      setInviteUrl(result.inviteUrl)
      void client.invalidateQueries({ queryKey: ["platform-invitations"] })
      showToast({
        type: "success",
        message:
          result.kind === "invitation"
            ? "Platform invitation created"
            : "Platform role updated",
      })
      void client.invalidateQueries({ queryKey: ["users"] })
      void client.invalidateQueries({ queryKey: ["access"] })
    },
    onError: (error) => showToast({ type: "error", message: error.message }),
  })
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Existing accounts receive the selected role. New accounts must verify
        their identity and accept an invitation.
      </p>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!mutation.isPending) mutation.mutate()
        }}
      >
        <label htmlFor="platform-user-email" className="text-sm font-medium">
          Email address
        </label>
        <Input
          disabled={mutation.isPending}
          id="platform-user-email"
          className="w-full"
          type="email"
          required
          aria-label="Platform access email"
          placeholder="Email address"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="platform-user-role" className="text-sm font-medium">
          Platform role
        </label>
        <Select
          value={accessType}
          onValueChange={(value) => setAccessType(value as typeof accessType)}
          disabled={mutation.isPending}
        >
          <SelectTrigger
            id="platform-user-role"
            aria-label="Platform access role"
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="relay_creator">Relay creator</SelectItem>
            <SelectItem value="platform_admin">
              Platform administrator
            </SelectItem>
          </SelectContent>
        </Select>
        <Button disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Add user"}
        </Button>
      </form>
      {inviteUrl ? (
        <div className="flex gap-2">
          <Input
            readOnly
            aria-label="Platform invitation link"
            value={inviteUrl}
          />
          <Button
            variant="outline"
            onClick={() =>
              void recoverPromise(
                async () => {
                  await navigator.clipboard.writeText(inviteUrl)
                  showToast({
                    type: "success",
                    message: "Invitation link copied",
                  })
                },
                () =>
                  showToast({
                    type: "error",
                    message: "Could not copy the link",
                  })
              )
            }
          >
            Copy invitation
          </Button>
        </div>
      ) : null}
    </div>
  )
})

const PendingPlatformInvitations = memo(function PendingPlatformInvitations({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void
}) {
  const [offset, setOffset] = useState(0)
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ["platform-invitations", offset],
    queryFn: () =>
      listPendingPlatformInvitations({ data: { offset, limit: 10 } }),
  })
  const cancel = useMutation({
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    mutationFn: (id: string) =>
      revokeAccessInvitation({ data: { id, relayId: null } }),
    onSuccess: () => {
      showToast({ type: "success", message: "Platform invitation cancelled" })
      void client.invalidateQueries({ queryKey: ["platform-invitations"] })
    },
    onError: (error) => showToast({ type: "error", message: error.message }),
  })
  return (
    <section
      className="space-y-3"
      aria-labelledby="platform-invitations-heading"
    >
      <h3 id="platform-invitations-heading" className="sr-only">
        Pending platform invitations
      </h3>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      ) : null}
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading invitations…</p>
      ) : null}
      {query.data?.invitations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending invitations.</p>
      ) : null}
      <ul className="divide-y">
        {query.data?.invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <p className="text-sm break-all">{invitation.email}</p>
              <p className="text-xs text-muted-foreground">
                {invitation.accessType === "platform_admin"
                  ? "Platform administrator"
                  : "Relay creator"}{" "}
                · Expires {date(invitation.expiresAt)}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Cancel platform invitation for ${invitation.email}`}
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(invitation.id)}
            >
              Cancel invitation
            </Button>
          </li>
        ))}
      </ul>
      {offset > 0 || query.data?.hasMore ? (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 10))}
          >
            Previous invitations
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!query.data?.hasMore}
            onClick={() => setOffset(offset + 10)}
          >
            Next invitations
          </Button>
        </div>
      ) : null}
    </section>
  )
})
