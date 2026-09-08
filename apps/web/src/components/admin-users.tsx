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
