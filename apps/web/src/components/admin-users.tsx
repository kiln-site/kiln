import { recoverPromise } from "@/effect/promise"
import { memo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

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
export function AdminUsers() {
  const [search, setSearch] = useState("")
  const [draft, setDraft] = useState("")
  const [offset, setOffset] = useState(0)
  const query = useQuery({
    queryKey: ["users", search, offset],
    queryFn: () => listUsers({ data: { search, offset, limit: pageSize } }),
    refetchInterval: 15_000,
  })
  return (
    <section className="space-y-4" aria-labelledby="users-heading">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="users-heading" className="text-lg font-semibold">
            Users
          </h2>
          <p className="text-sm text-muted-foreground">
            Account availability and verification are separate from resource
            access.
          </p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setSearch(draft)
            setOffset(0)
          }}
        >
          <Input
            aria-label="Find users by name or email"
            placeholder="Name or email"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button variant="outline">Search</Button>
        </form>
      </header>
      <PlatformInvitationForm />
      <PendingPlatformInvitations />
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      ) : null}
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading users…</p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">User</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">Verification</th>
              <th className="p-3 font-medium">Created</th>
              <th className="p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.users.map((user) => (
              <ManagedUserRow key={user.id} user={user} />
            ))}
          </tbody>
        </table>
        {query.data?.users.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No matching users.
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{query.data?.total ?? 0} users</span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!query.data || offset + pageSize >= query.data.total}
            onClick={() => setOffset(offset + pageSize)}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  )
}

const ManagedUserRow = memo(function ManagedUserRow({
  user,
}: {
  user: ManagedUser
}) {
  const client = useQueryClient()
  const [claim, setClaim] = useState<{
    claimUrl: string
    expiresAt: string
  } | null>(null)
  const mutation = useMutation({
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
    <tr className="border-t align-top">
      <td className="p-3">
        <p className="font-medium">{user.name}</p>
        <p className="text-xs text-muted-foreground">{user.email}</p>
        {user.role === "admin" || user.role === "relay_creator" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {user.role === "admin" ? "Platform administrator" : "Relay creator"}
          </p>
        ) : null}
        <PlatformRoleControl key={user.role} user={user} />
        {!user.hasCredential ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Account awaiting claim
          </p>
        ) : null}
      </td>
      <td className="p-3">
        <p className="capitalize">{user.status}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {date(user.statusChangedAt)}
        </p>
        {user.statusExpiresAt ? (
          <p className="text-xs text-muted-foreground">
            Until {date(user.statusExpiresAt)}
          </p>
        ) : null}
        {user.statusReason ? (
          <p className="mt-1 max-w-48 text-xs text-muted-foreground">
            {user.statusReason}
          </p>
        ) : null}
      </td>
      <UserVerification user={user} />
      <td className="p-3 text-xs text-muted-foreground">
        {date(user.createdAt)}
      </td>
      <td className="p-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("status")}
          >
            {user.status === "enabled" ? "Disable" : "Enable"}
          </Button>
          {!user.manuallyVerifiedAt ? (
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate("verify")}
            >
              Verify manually
            </Button>
          ) : null}
          {!user.hasCredential ? (
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate("claim")}
            >
              Issue manual claim
            </Button>
          ) : null}
        </div>
        {claim ? (
          <div className="mt-3 max-w-72 space-y-2">
            <Input
              aria-label={`Manual claim link for ${user.email}`}
              readOnly
              value={claim.claimUrl}
            />
            <p className="text-xs text-muted-foreground">
              Redeeming this link verifies the account manually. Expires{" "}
              {date(claim.expiresAt)}.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await recoverPromise(
                  async () => {
                    await navigator.clipboard.writeText(claim.claimUrl)
                    showToast({ type: "success", message: "Claim link copied" })
                  },
                  () => {
                    showToast({
                      type: "error",
                      message: "Could not copy the link",
                    })
                  }
                )
              }}
            >
              Copy link
            </Button>
          </div>
        ) : null}
      </td>
    </tr>
  )
})
function date(value: string | null) {
  return value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "—"
}

function UserVerification({ user }: { user: ManagedUser }) {
  const verification =
    [
      user.emailVerifiedAt && "Email",
      user.manuallyVerifiedAt && "Manual",
      user.legacyVerificationRecordedAt && "Legacy trust",
    ]
      .filter(Boolean)
      .join(" + ") || "Unverified"
  return (
    <td className="p-3">
      <p>{verification}</p>
      {user.emailVerifiedAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Email: {date(user.emailVerifiedAt)}
        </p>
      ) : null}
      {user.manuallyVerifiedAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Manual: {date(user.manuallyVerifiedAt)}
        </p>
      ) : null}
      {user.legacyVerificationRecordedAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Recorded {date(user.legacyVerificationRecordedAt)}; original method
          unknown.
        </p>
      ) : null}
    </td>
  )
}

const PlatformRoleControl = memo(function PlatformRoleControl({
  user,
}: {
  user: ManagedUser
}) {
  const client = useQueryClient()
  const initial =
    user.role === "admin" || user.role === "relay_creator" ? user.role : "user"
  const [role, setRole] = useState(initial)
  const mutation = useMutation({
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
      <select
        aria-label={`Platform role for ${user.email}`}
        className="h-8 rounded-md border bg-background px-2 text-xs"
        value={role}
        onChange={(event) => setRole(event.target.value as typeof role)}
        disabled={mutation.isPending}
      >
        <option value="user">No platform role</option>
        <option value="relay_creator">Relay creator</option>
        <option value="admin">Platform administrator</option>
      </select>
      <Button
        size="sm"
        variant="outline"
        disabled={mutation.isPending || role === initial}
        onClick={() => mutation.mutate()}
      >
        Save role
      </Button>
    </div>
  )
})

const PlatformInvitationForm = memo(function PlatformInvitationForm() {
  const client = useQueryClient()
  const [email, setEmail] = useState("")
  const [accessType, setAccessType] = useState<
    "platform_admin" | "relay_creator"
  >("relay_creator")
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const mutation = useMutation({
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
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">Grant platform access</p>
      <p className="text-xs text-muted-foreground">
        Existing accounts receive the selected role. New accounts must verify
        their identity and accept an invitation.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        <Input
          className="w-64"
          type="email"
          required
          aria-label="Platform access email"
          placeholder="Email address"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <select
          aria-label="Platform access role"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={accessType}
          onChange={(event) =>
            setAccessType(event.target.value as typeof accessType)
          }
        >
          <option value="relay_creator">Relay creator</option>
          <option value="platform_admin">Platform administrator</option>
        </select>
        <Button disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Grant access"}
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

const PendingPlatformInvitations = memo(function PendingPlatformInvitations() {
  const [offset, setOffset] = useState(0)
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ["platform-invitations", offset],
    queryFn: () =>
      listPendingPlatformInvitations({ data: { offset, limit: 10 } }),
    refetchInterval: 15_000,
  })
  const cancel = useMutation({
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
      className="space-y-3 rounded-lg border p-4"
      aria-labelledby="platform-invitations-heading"
    >
      <h3 id="platform-invitations-heading" className="text-sm font-medium">
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
              <p className="text-sm">{invitation.email}</p>
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
