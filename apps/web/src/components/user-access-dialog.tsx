import { memo, useCallback, useMemo, useState, type ReactNode } from "react"
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Dialog } from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"
import { copyWithToast, utcTimestamp } from "@/components/access-format"
import {
  contextFor,
  EMPTY_RESOURCES,
  ResourcePicker,
  scopeKey,
  type AccessScope,
  type Resource,
} from "@/components/access-resource-picker"
import { PermissionDialogContent } from "@/components/permission-dialog"
import {
  PermissionEditor,
  type PermissionAssignment,
  type PermissionTarget,
} from "@/components/permission-editor"
import { UserIdentity } from "@/components/user-identity"
import { roleLabel, stateLabel } from "@/lib/managed-user"
import { tryExpandSelections } from "@/lib/permission-nodes"
import { grantOrInviteAccess, removePlatformAccess } from "@/server/access"
import {
  getAccessResources,
  getResourceAccess,
  inviteResourceAccess,
  updateResourceAccess,
} from "@/server/resource-access"
import {
  getUserAccess,
  issueAccountClaim,
  manuallyVerifyUser,
  setUserStatus,
  type ManagedUser,
  type UserAccess,
} from "@/server/users"

type UserAccessGrant = UserAccess["grants"][number]

interface Draft extends PermissionAssignment {
  key: string
  scope: AccessScope
  /** The saved access this draft edits; new drafts send an invitation. */
  grant?: UserAccessGrant
}

const hasEntries = (draft: PermissionAssignment) =>
  draft.selections.length > 0 ||
  draft.presetIds.length > 0 ||
  draft.builtinKeys.length > 0
const assignmentKey = (assignment: PermissionAssignment) =>
  JSON.stringify([
    assignment.selections
      .map((selection) => `${selection.kind}:${selection.key}`)
      .sort(),
    [...assignment.presetIds].sort(),
    [...assignment.builtinKeys].sort(),
  ])
const changed = (draft: Draft) =>
  !draft.grant || assignmentKey(draft) !== assignmentKey(draft.grant)
const emptyDraft = (scope: AccessScope): Draft => ({
  key: scopeKey(scope),
  scope,
  selections: [],
  presetIds: [],
  builtinKeys: [],
})
const grantDraft = (grant: UserAccessGrant): Draft => ({
  key: scopeKey(grant.scope),
  scope: {
    ...grant.scope,
    name: grant.resourceName,
    relayName: grant.relayName,
  },
  grant,
  selections: grant.selections,
  presetIds: grant.presetIds,
  builtinKeys: grant.builtinKeys,
})

function combineAccess(
  results: Array<{
    data?: Awaited<ReturnType<typeof getResourceAccess>>
    error: Error | null
    isPending: boolean
  }>
) {
  return results.map(({ data, error, isPending }) => ({
    data,
    error,
    isPending,
  }))
}

function invalidateAccess(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: ["users"] })
  void client.invalidateQueries({ queryKey: ["user-access"] })
  void client.invalidateQueries({ queryKey: ["resource-access"] })
  void client.invalidateQueries({ queryKey: ["access"] })
}

/**
 * A person's access as permission entries, each on a Relay, game server, or
 * database. With `userId` it edits what they hold everywhere; without it, it
 * invites someone. Contexts they don't have yet are sent as invitations.
 */
export const UserAccessDialog = memo(function UserAccessDialog({
  userId,
  profileId,
  initialScope,
  platform,
  onClose,
}: {
  userId?: string
  /** Their Minecraft head, when the caller already resolved it. */
  profileId?: string
  initialScope?: AccessScope
  /** A platform administrator: account controls and platform roles. */
  platform: boolean
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  // Read once per opening: a refetch mid-edit would reset the form, and
  // saving checks each grant's revision, so a stale copy can't overwrite.
  const access = useQuery({
    queryKey: ["user-access", userId],
    queryFn: () => getUserAccess({ data: { userId: userId! } }),
    enabled: !!userId,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      {!userId ? (
        <AccessForm
          initialScope={initialScope}
          platform={platform}
          onBusyChange={setBusy}
          onClose={onClose}
        />
      ) : access.data ? (
        <AccessForm
          access={access.data}
          profileId={profileId}
          platform={platform}
          onBusyChange={setBusy}
          onClose={onClose}
        />
      ) : (
        <PermissionDialogContent
          title="Manage user"
          description="Loading their access."
          footer={
            <Button variant="outline" className="sm:ml-auto" onClick={onClose}>
              Close
            </Button>
          }
        >
          {access.error ? (
            <p role="alert" className="type-support p-5 text-destructive">
              {access.error.message}
            </p>
          ) : (
            <div className="space-y-2 p-4" aria-label="Loading access">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          )}
        </PermissionDialogContent>
      )}
    </Dialog>
  )
})

function AccessForm({
  access,
  profileId,
  initialScope,
  platform,
  onBusyChange,
  onClose,
}: {
  access?: UserAccess
  profileId?: string
  initialScope?: AccessScope
  platform: boolean
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const user = access?.user
  const [tab, setTab] = useState<"permissions" | "account">("permissions")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<"none" | "platform_admin" | "relay_creator">(
    "none"
  )
  const [drafts, setDrafts] = useState<Array<Draft>>(() => [
    ...(initialScope &&
    !access?.grants.some(
      (grant) =>
        grant.relayEnabled && scopeKey(grant.scope) === scopeKey(initialScope)
    )
      ? [emptyDraft(initialScope)]
      : []),
    // Disabled Relays can't load what's grantable; removal still covers them.
    ...(access?.grants.filter((grant) => grant.relayEnabled).map(grantDraft) ??
      []),
  ])
  const [removed, setRemoved] = useState<Array<UserAccessGrant>>([])
  const [activeKey, setActiveKey] = useState<string | undefined>(() =>
    initialScope ? scopeKey(initialScope) : drafts[0]?.key
  )

  const grantable = useQueries({
    queries: drafts.map((draft) => ({
      queryKey: [
        "resource-access",
        draft.scope.relayId,
        draft.scope.resourceType,
        draft.scope.resourceId,
        "grantable",
      ],
      queryFn: () =>
        getResourceAccess({
          data: {
            relayId: draft.scope.relayId,
            resourceType: draft.scope.resourceType,
            resourceId: draft.scope.resourceId,
            includePeople: false,
          },
        }),
      staleTime: 30_000,
    })),
    combine: combineAccess,
  })
  const ownedTargets = useMemo<Array<PermissionTarget>>(
    () =>
      (access?.owned ?? []).map((resource) => ({
        key: `owned:${scopeKey(resource.scope)}`,
        context: contextFor({
          ...resource.scope,
          name: resource.resourceName,
          relayName: resource.relayName,
        }),
        status: { label: "Owner", tone: "neutral" },
        locked:
          resource.scope.resourceType === "app"
            ? "An app's owner can see it and its logs, delete it, and transfer it. Configuring it takes app permissions on its Relay. Transfer ownership to change this."
            : `Owners hold every permission on their ${
                resource.scope.resourceType === "instance"
                  ? "game server"
                  : resource.scope.resourceType === "database"
                    ? "database"
                    : "Relay"
              }. Transfer ownership to change this.`,
        selections: [],
        presetIds: [],
        builtinKeys: [],
      })),
    [access?.owned]
  )
  const targets = useMemo<Array<PermissionTarget>>(
    () => [
      ...drafts.map((draft, index): PermissionTarget => {
        const result = grantable[index]
        return {
          key: draft.key,
          context: contextFor(draft.scope),
          access: result?.data,
          notice:
            !result || result.isPending
              ? "Loading permissions…"
              : result.error
                ? result.error.message
                : !draft.grant && !result.data?.canInvite
                  ? "You can't invite people to this resource."
                  : draft.grant && !result.data?.canManage
                    ? "You can't change access on this resource."
                    : undefined,
          status: !draft.grant
            ? { label: "New · sends an invitation", tone: "info" }
            : draft.grant.state === "pending"
              ? { label: "Invitation pending", tone: "warning" }
              : undefined,
          selections: draft.selections,
          presetIds: draft.presetIds,
          builtinKeys: draft.builtinKeys,
        }
      }),
      ...ownedTargets,
    ],
    [drafts, grantable, ownedTargets]
  )

  const change = useCallback(
    (key: string, assignment: PermissionAssignment) =>
      setDrafts((current) =>
        current.map((draft) =>
          draft.key === key ? { ...draft, ...assignment } : draft
        )
      ),
    []
  )
  const removeTarget = useCallback((key: string) => {
    setDrafts((current) => {
      const draft = current.find((entry) => entry.key === key)
      if (draft?.grant)
        setRemoved((list) => [...list, draft.grant as UserAccessGrant])
      return current.filter((entry) => entry.key !== key)
    })
    setActiveKey((current) => (current === key ? undefined : current))
  }, [])
  // New contexts go on top, where they're visible. Picking one that was
  // removed brings its saved access back; unused new ones are dropped.
  const pickContext = useCallback(
    (resource: Resource) => {
      const key = scopeKey(resource)
      const restored = removed.find((grant) => scopeKey(grant.scope) === key)
      if (restored)
        setRemoved((list) => list.filter((grant) => grant !== restored))
      setDrafts((current) => {
        if (current.some((draft) => draft.key === key)) return current
        const kept = current.filter((draft) => draft.grant || hasEntries(draft))
        if (kept.filter((draft) => !draft.grant).length >= 25) return kept
        return [restored ? grantDraft(restored) : emptyDraft(resource), ...kept]
      })
      setActiveKey(key)
    },
    [removed]
  )

  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const resources = useQuery({
    queryKey: ["access-resources", search, offset],
    queryFn: () => getAccessResources({ data: { search, offset } }),
  })
  const searchResources = useCallback((value: string) => {
    setSearch(value)
    setOffset(0)
  }, [])
  const previousResources = useCallback(
    () => setOffset((current) => Math.max(0, current - 50)),
    []
  )
  const nextResources = useCallback(
    () => setOffset((current) => current + 50),
    []
  )
  const contextPicker = (
    <ResourcePicker
      resources={resources.data?.resources ?? EMPTY_RESOURCES}
      selected={null}
      onSelect={pickContext}
      onSearch={searchResources}
      loading={resources.isFetching}
      error={resources.error?.message}
      hasPrevious={offset > 0}
      onPrevious={previousResources}
      hasMore={resources.data?.hasMore}
      onMore={nextResources}
      trigger={
        <Button type="button" variant="outline" size="sm" className="shrink-0">
          <Plus />
          Add resource
        </Button>
      }
    />
  )

  const invites = drafts.filter((draft) => !draft.grant && hasEntries(draft))
  const revokes = [
    ...removed,
    ...drafts.flatMap((draft) =>
      draft.grant && !hasEntries(draft) ? [draft.grant] : []
    ),
  ]
  const updates = drafts.filter(
    (draft) => draft.grant && hasEntries(draft) && changed(draft)
  )
  // A saved entry its resource no longer supports must go before saving.
  const blocked = targets.some(
    (target) =>
      target.access &&
      target.selections.some(
        (selection) =>
          tryExpandSelections(
            [selection],
            target.context.scope.resourceType,
            target.access?.supportedCapabilities
          ) === null
      )
  )
  const changeCount =
    invites.length + revokes.length + updates.length + (role !== "none" ? 1 : 0)

  const save = useMutation({
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    mutationFn: async () => {
      const recipient = user?.email ?? email.trim()
      for (const grant of revokes)
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
      for (const draft of updates)
        await updateResourceAccess({
          data: {
            ...draft.grant!.scope,
            id: draft.grant!.id,
            revision: draft.grant!.revision,
            selections: draft.selections,
            presetIds: draft.presetIds,
            builtinKeys: draft.builtinKeys,
          },
        })
      const invited = invites.length
        ? await inviteResourceAccess({
            data: {
              email: recipient,
              targets: invites.map((draft) => ({
                relayId: draft.scope.relayId,
                resourceType: draft.scope.resourceType,
                resourceId: draft.scope.resourceId,
                selections: draft.selections,
                presetIds: draft.presetIds,
                builtinKeys: draft.builtinKeys,
              })),
            },
          })
        : null
      if (role !== "none")
        await grantOrInviteAccess({
          data: { email: recipient, accessType: role },
        })
      const results = invited?.invitations ?? []
      return {
        sent: results.filter((invitation) => !invitation.existing).length,
        // Resources they already have access to, or own, are skipped by the
        // server and keep their current permissions.
        skipped: results.flatMap((invitation) =>
          invitation.existing ? [invitation.resourceName] : []
        ),
        roleChanged: role !== "none",
      }
    },
    onSuccess: ({ sent, skipped, roleChanged }) => {
      invalidateAccess(client)
      const skippedNote = skipped.length
        ? `${skipped.length === 1 ? skipped[0] : `${skipped.length} resources`}: they already have access there, so nothing changed. Edit it from the Users table.`
        : null
      if (!sent && !roleChanged && !updates.length && !revokes.length) {
        // Nothing happened; keep the dialog so they can adjust it.
        showToast({
          type: "error",
          message: skippedNote ?? "Nothing was sent",
        })
        return
      }
      showToast({
        type: skippedNote ? "info" : "success",
        message: [
          user
            ? sent
              ? `Access updated. ${sent} invitation${sent === 1 ? "" : "s"} sent.`
              : "Access updated."
            : sent
              ? `${sent} invitation${sent === 1 ? "" : "s"} sent. Each resource is accepted separately.`
              : "Platform role updated.",
          skippedNote,
        ]
          .filter(Boolean)
          .join(" "),
      })
      onClose()
    },
    onError: (error) => {
      invalidateAccess(client)
      showToast({ type: "error", message: error.message })
    },
  })

  const header = user ? (
    <UserHeader
      user={user}
      profileId={profileId}
      tab={tab}
      onTab={platform ? setTab : undefined}
    />
  ) : (
    <div className="space-y-3">
      <div>
        <h2 className="type-dialog-title">Add user</h2>
        <p className="type-support mt-1 text-muted-foreground">
          They verify their account, then accept each resource&apos;s
          invitation.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          data-dialog-focus
          aria-label="Email address"
          placeholder="person@example.com"
          className="sm:max-w-sm"
          value={email}
          disabled={save.isPending}
          onChange={(event) => setEmail(event.target.value)}
        />
        {platform ? (
          <Select
            value={role}
            onValueChange={(value) => setRole(value as typeof role)}
            disabled={save.isPending}
          >
            <SelectTrigger aria-label="Platform role" className="sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">User</SelectItem>
              <SelectItem value="relay_creator">Relay Creator</SelectItem>
              <SelectItem value="platform_admin">Kiln Admin</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </div>
  )

  return (
    <PermissionDialogContent
      title={user ? `Manage ${user.name}` : "Add user"}
      description={
        user
          ? `Permissions ${user.name} holds on Relays, game servers, and databases.`
          : "Invite someone and choose what they can do on each resource."
      }
      header={header}
      footer={
        tab === "permissions" ? (
          <>
            <p className="type-meta mr-auto text-muted-foreground">
              {saveSummary(invites.length, updates.length, revokes.length)}
            </p>
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={
                save.isPending ||
                blocked ||
                !changeCount ||
                (!user && !email.trim())
              }
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? "Saving…"
                : user
                  ? "Save changes"
                  : invites.length > 1
                    ? `Send ${invites.length} invitations`
                    : "Send invitation"}
            </Button>
          </>
        ) : (
          <Button variant="outline" className="sm:ml-auto" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {tab === "account" && user ? (
        <AccountPanel
          user={user}
          platformInvitationIds={access?.platformInvitationIds ?? []}
          onBusyChange={onBusyChange}
        />
      ) : (
        <PermissionEditor
          targets={targets}
          onChange={change}
          activeTarget={activeKey}
          onActiveTargetChange={setActiveKey}
          onRemoveTarget={removeTarget}
          contextPicker={contextPicker}
          grouped
          presets
          disabled={save.isPending}
          emptyMessage={user ? "No access yet." : "No resources yet."}
        />
      )}
    </PermissionDialogContent>
  )
}

function saveSummary(invites: number, updates: number, revokes: number) {
  const parts = [
    updates ? `${updates} updated` : null,
    revokes ? `${revokes} removed` : null,
    invites ? `${invites} invitation${invites === 1 ? "" : "s"} to send` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : "No changes"
}

function UserHeader({
  user,
  profileId,
  tab,
  onTab,
}: {
  user: ManagedUser
  profileId?: string
  tab: "permissions" | "account"
  onTab?: (tab: "permissions" | "account") => void
}) {
  return (
    <div className="space-y-3">
      <UserIdentity
        name={user.name}
        email={user.email}
        profileId={profileId}
        avatarClassName="size-10"
        nameClassName="text-base"
        accessory={<UserBadges user={user} />}
      />
      {onTab ? (
        <div
          role="tablist"
          aria-label="Manage user"
          className="-mb-3 flex gap-1"
        >
          {(["permissions", "account"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => onTab(value)}
              className={cn(
                "relative h-9 px-3 text-sm font-medium after:absolute after:inset-x-2 after:bottom-0 after:h-0.5",
                tab === value
                  ? "text-foreground after:bg-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {value === "permissions" ? "Permissions" : "Account"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Status and platform role beside a person's name. */
export const UserBadges = memo(function UserBadges({
  user,
}: {
  user: Pick<ManagedUser, "role" | "invitedRole">
}) {
  const role =
    user.role === "admin" || user.role === "relay_creator"
      ? roleLabel(user.role)
      : user.invitedRole
        ? `Invited as ${roleLabel(user.invitedRole)}`
        : null
  return role ? (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0",
        user.role === "admin" && "border-primary/40 text-primary-ink"
      )}
    >
      {role}
    </Badge>
  ) : null
})

function AccountPanel({
  user,
  platformInvitationIds,
  onBusyChange,
}: {
  user: ManagedUser
  platformInvitationIds: ReadonlyArray<string>
  onBusyChange: (busy: boolean) => void
}) {
  const client = useQueryClient()
  const [claim, setClaim] = useState<{
    claimUrl: string
    expiresAt: string
  } | null>(null)
  const mutation = useMutation({
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
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
      invalidateAccess(client)
    },
    onError: (cause) => showToast({ type: "error", message: cause.message }),
  })
  const pending = mutation.isPending
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid max-w-3xl gap-6 p-5 md:grid-cols-2">
        <AccountSection title="Status">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Account</dt>
            <dd>{stateLabel(user)}</dd>
            <dt className="text-muted-foreground">Changed</dt>
            <dd>{utcTimestamp(user.statusChangedAt)}</dd>
            {user.statusExpiresAt ? (
              <>
                <dt className="text-muted-foreground">Until</dt>
                <dd>{utcTimestamp(user.statusExpiresAt)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Created</dt>
            <dd>{utcTimestamp(user.createdAt)}</dd>
          </dl>
          {user.statusReason ? (
            <p className="type-support text-muted-foreground">
              {user.statusReason}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => mutation.mutate("status")}
          >
            {user.status === "enabled" ? "Disable account" : "Enable account"}
          </Button>
        </AccountSection>
        <AccountSection title="Verification">
          <p className="text-sm">
            {!user.hasCredential
              ? "Hasn't signed in yet"
              : verificationLabel(user)}
          </p>
          {user.emailVerifiedAt ? (
            <p className="type-meta text-muted-foreground">
              Email verified {utcTimestamp(user.emailVerifiedAt)}
            </p>
          ) : null}
          {user.manuallyVerifiedAt ? (
            <p className="type-meta text-muted-foreground">
              Manually verified {utcTimestamp(user.manuallyVerifiedAt)}
            </p>
          ) : null}
          {user.legacyVerificationRecordedAt ? (
            <p className="type-meta text-muted-foreground">
              Legacy trust recorded{" "}
              {utcTimestamp(user.legacyVerificationRecordedAt)}; original method
              unknown.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!user.manuallyVerifiedAt ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => mutation.mutate("verify")}
              >
                Verify manually
              </Button>
            ) : null}
            {!user.hasCredential ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => mutation.mutate("claim")}
              >
                Issue claim link
              </Button>
            ) : null}
          </div>
          {claim ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label={`Manual claim link for ${user.email}`}
                  value={claim.claimUrl}
                />
                <Button
                  variant="outline"
                  onClick={() => copyWithToast(claim.claimUrl, "Claim link")}
                >
                  Copy
                </Button>
              </div>
              <p className="type-meta text-muted-foreground">
                Redeeming this link verifies the account manually. Expires{" "}
                {utcTimestamp(claim.expiresAt)}.
              </p>
            </div>
          ) : null}
        </AccountSection>
        <AccountSection title="Platform role">
          <p className="type-support text-muted-foreground">
            Kiln Admins manage everything in Kiln. Relay Creators can pair new
            Relays. Users only have the access granted to them.
          </p>
          <PlatformRoleControl
            key={`${user.role}:${platformInvitationIds.join()}`}
            user={user}
            onBusyChange={onBusyChange}
          />
        </AccountSection>
      </div>
    </div>
  )
}

function AccountSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <h3 className="type-card-title">{title}</h3>
      {children}
    </section>
  )
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

function PlatformRoleControl({
  user,
  onBusyChange,
}: {
  user: ManagedUser
  onBusyChange: (busy: boolean) => void
}) {
  const client = useQueryClient()
  const initial: "none" | "platform_admin" | "relay_creator" =
    user.role === "admin"
      ? "platform_admin"
      : user.role === "relay_creator"
        ? "relay_creator"
        : "none"
  const [role, setRole] = useState(initial)
  const mutation = useMutation({
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    mutationFn: async () => {
      if (role === "none")
        await removePlatformAccess({ data: { userId: user.id } })
      else
        await grantOrInviteAccess({
          data: { userId: user.id, email: user.email, accessType: role },
        })
    },
    onSuccess: () => {
      showToast({ type: "success", message: "Platform role updated" })
      invalidateAccess(client)
      void client.invalidateQueries({ queryKey: ["auth"] })
    },
    onError: (error) => showToast({ type: "error", message: error.message }),
  })
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={role}
        onValueChange={(value) => setRole(value as typeof role)}
        disabled={mutation.isPending}
      >
        <SelectTrigger
          aria-label={`Platform role for ${user.email}`}
          className="w-56"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">User</SelectItem>
          <SelectItem value="relay_creator">Relay Creator</SelectItem>
          <SelectItem value="platform_admin">Kiln Admin</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        className="h-9"
        disabled={mutation.isPending || role === initial}
        onClick={() => mutation.mutate()}
      >
        Save role
      </Button>
    </div>
  )
}
