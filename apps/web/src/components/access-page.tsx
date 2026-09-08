import { memo, useState, useCallback, useMemo } from "react"
import { Effect, Result } from "effect"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PermissionSelection } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Badge } from "@workspace/ui/components/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import { AdminUsers } from "@/components/admin-users"
import { PermissionEditor } from "@/components/permission-editor"
import { transferInstanceOwnership } from "@/server/access"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import type { ResourceScope } from "@/lib/resource-permissions"
import {
  getAccessResources,
  getResourceAccess,
  inviteResourceAccess,
  updateResourceAccess,
  savePermissionPreset,
  deletePermissionPreset,
  decideResourceInvitation,
} from "@/server/resource-access"

type ScopeAccess = Awaited<ReturnType<typeof getResourceAccess>>
type Person = ScopeAccess["people"][number]
type Preset = ScopeAccess["presets"][number]
type Resource = Awaited<
  ReturnType<typeof getAccessResources>
>["resources"][number]
const EMPTY_RESOURCES: Array<Resource> = []
const errorToast = (error: Error) =>
  showToast({ type: "error", message: error.message })

export function AccessPage() {
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const [scope, setScope] = useState<Resource | null>(null)
  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const resources = useQuery({
    queryKey: ["access-resources", search, offset],
    queryFn: () => getAccessResources({ data: { search, offset } }),
  })
  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold">Users & access</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage accounts, invitations, and the permissions people have on each
          resource.
        </p>
      </header>
      {capabilities?.user.role === "admin" ||
      capabilities?.user.isDevelopmentBypass ? (
        <AdminUsers />
      ) : null}
      <section className="space-y-4">
        <header>
          <h2 className="text-lg font-semibold">Resource access</h2>
          <p className="text-sm text-muted-foreground">
            Presets belong to a resource. Updating one applies to everyone
            assigned to it.
          </p>
        </header>
        <ResourcePicker
          resources={resources.data?.resources ?? EMPTY_RESOURCES}
          selected={scope}
          onSelect={setScope}
          onSearch={(value) => {
            setSearch(value)
            setOffset(0)
          }}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous resources
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!resources.data?.hasMore}
            onClick={() => setOffset(offset + 50)}
          >
            More resources
          </Button>
        </div>
        {resources.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {resources.error.message}
          </p>
        ) : null}
        {scope ? (
          <ResourceAccessPanel key={scope.resourceId} scope={scope} />
        ) : (
          <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
            Choose a resource to view its access and presets.
          </p>
        )}
      </section>
    </div>
  )
}

const ResourcePicker = memo(function ResourcePicker({
  resources,
  selected,
  onSelect,
  onSearch,
}: {
  resources: Array<Resource>
  selected: Resource | null
  onSelect: (resource: Resource) => void
  onSearch: (search: string) => void
}) {
  const [draft, setDraft] = useState("")
  return (
    <div className="flex flex-wrap gap-2">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          onSearch(draft)
        }}
      >
        <Input
          aria-label="Find resources"
          placeholder="Find a resource…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button variant="outline">Search</Button>
      </form>
      <select
        aria-label="Resource"
        className="min-w-64 rounded-md border bg-background p-2 text-sm"
        value={
          selected
            ? JSON.stringify([
                selected.relayId,
                selected.resourceType,
                selected.resourceId,
              ])
            : ""
        }
        onChange={(event) => {
          const match = resources.find(
            (resource) =>
              JSON.stringify([
                resource.relayId,
                resource.resourceType,
                resource.resourceId,
              ]) === event.target.value
          )
          if (match) onSelect(match)
        }}
      >
        <option value="" disabled>
          Choose a resource
        </option>
        {selected &&
        !resources.some(
          (resource) => resource.resourceId === selected.resourceId
        ) ? (
          <option
            value={JSON.stringify([
              selected.relayId,
              selected.resourceType,
              selected.resourceId,
            ])}
          >
            {selected.name}
          </option>
        ) : null}
        {resources.map((resource) => (
          <option
            key={`${resource.relayId}:${resource.resourceType}:${resource.resourceId}`}
            value={JSON.stringify([
              resource.relayId,
              resource.resourceType,
              resource.resourceId,
            ])}
          >
            {resource.name} · {resource.resourceType}
          </option>
        ))}
      </select>
    </div>
  )
})

function ResourcePeopleTable({
  access,
  onEdit,
  onTransfer,
  onRevoke,
  onAccept,
  revoking,
  accepting,
}: {
  access: ScopeAccess
  onEdit: (person: Person) => void
  onTransfer: (person: Person) => void
  onRevoke: (person: Person) => void
  onAccept: (person: Person) => void
  revoking: boolean
  accepting: boolean
}) {
  const defaultNames = new Map(
    access.defaults.map((preset) => [preset.key, preset.name])
  )
  const presetNames = new Map(
    access.presets.map((preset) => [preset.id, preset.name])
  )
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/30">
          <tr>
            <th className="p-3">User</th>
            <th className="p-3">Access</th>
            <th className="p-3">Presets</th>
            <th className="p-3">Updated</th>
            <th className="p-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {access.people.map((person) => (
            <tr key={person.id} className="border-t">
              <td className="p-3">
                <div>{person.name}</div>
                <div className="text-xs text-muted-foreground">
                  {person.email}
                </div>
              </td>
              <td className="p-3">
                <Badge variant="outline">
                  {person.state === "pending"
                    ? person.invitationId
                      ? "Pending invitation"
                      : "Invitation ended"
                    : person.inherited
                      ? "From Relay"
                      : "Active"}
                </Badge>
              </td>
              <td className="p-3 text-xs">
                {[
                  ...person.builtinKeys.map(
                    (key) => defaultNames.get(key) ?? key
                  ),
                  ...person.presetIds.map(
                    (id) => presetNames.get(id) ?? "Relay preset"
                  ),
                  ...(person.selections.length ? ["Custom permissions"] : []),
                ].join(", ") || "No selections"}
              </td>
              <td className="p-3 text-xs text-muted-foreground">
                {person.updatedAt
                  .replace("T", " ")
                  .replace(/\.\d{3}Z$/, " UTC")}
              </td>
              <td className="p-3">
                <div className="flex flex-wrap gap-2">
                  {!person.inherited && !person.isOwner && access.canManage ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onEdit(person)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={revoking}
                        onClick={() => onRevoke(person)}
                      >
                        Revoke
                      </Button>
                    </>
                  ) : null}
                  {access.canTransferOwnership &&
                  !person.isOwner &&
                  !person.inherited &&
                  person.state === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onTransfer(person)}
                    >
                      Transfer ownership
                    </Button>
                  ) : null}
                  {person.invitationId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void Effect.runPromise(
                          Effect.tryPromise(() =>
                            navigator.clipboard.writeText(
                              new URL(
                                `/invite?id=${encodeURIComponent(person.invitationId!)}`,
                                window.location.origin
                              ).toString()
                            )
                          ).pipe(
                            Effect.match({
                              onSuccess: () =>
                                showToast({
                                  type: "success",
                                  message: "Invitation link copied",
                                }),
                              onFailure: () =>
                                showToast({
                                  type: "error",
                                  message: "Could not copy invitation link",
                                }),
                            })
                          )
                        )
                      }}
                    >
                      Copy invitation link
                    </Button>
                  ) : null}
                  {person.invitationId && access.isPlatformAdmin ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={accepting}
                      onClick={() => onAccept(person)}
                    >
                      Accept for user
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!access.people.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          No additional users on this resource.
        </p>
      ) : null}
    </div>
  )
}

export function ResourceAccessPanel({
  scope,
}: {
  scope: ResourceScope & { name?: string }
}) {
  const [offset, setOffset] = useState(0),
    [inviting, setInviting] = useState(false),
    [editing, setEditing] = useState<Person | null>(null),
    [preset, setPreset] = useState<Preset | "new" | null>(null)
  const queryClient = useQueryClient()
  const [transferTarget, setTransferTarget] = useState<Person | null>(null)
  const query = useQuery({
    queryKey: [
      "resource-access",
      scope.relayId,
      scope.resourceType,
      scope.resourceId,
      offset,
    ],
    queryFn: () => getResourceAccess({ data: { ...scope, offset } }),
  })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["resource-access"] })
    void queryClient.invalidateQueries({ queryKey: ["access"] })
  }
  const decision = useMutation({
    mutationFn: decideResourceInvitation,
    onError: errorToast,
    onSuccess: () => {
      refresh()
      showToast({ type: "success", message: "Invitation updated" })
    },
  })
  const transfer = useMutation({
    mutationFn: transferInstanceOwnership,
    onError: errorToast,
    onSuccess: () => {
      refresh()
      setTransferTarget(null)
      showToast({ type: "success", message: "Ownership transferred" })
    },
  })
  const removePreset = useMutation({
    mutationFn: deletePermissionPreset,
    onError: errorToast,
    onSuccess: () => {
      refresh()
      showToast({ type: "success", message: "Preset deleted" })
    },
  })
  const remove = useMutation({
    mutationFn: updateResourceAccess,
    onError: errorToast,
    onSuccess: (result) => {
      refresh()
      showToast({
        type: result.inheritedAccessRemains ? "info" : "success",
        message: result.inheritedAccessRemains
          ? "Direct access revoked. Relay access still applies."
          : "Access revoked",
      })
    },
  })
  if (query.isPending)
    return <p className="text-sm text-muted-foreground">Loading access…</p>
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {query.error.message}
      </p>
    )
  const access = query.data
  return (
    <div className="space-y-6">
      {access.owner ? (
        <p className="text-sm text-muted-foreground">
          Owner: {access.owner.name}
        </p>
      ) : null}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{scope.name ?? "Access"}</h3>
          {scope.resourceType === "relay" ? (
            <p className="text-xs text-muted-foreground">
              Assignments apply to current and future resources on this Relay.
            </p>
          ) : null}
          {access.authorizationSource === "platform-admin" ? (
            <p className="text-xs text-muted-foreground">
              Viewing with platform administrator access.
            </p>
          ) : null}
        </div>
        {access.canInvite ? (
          <Button onClick={() => setInviting(true)}>Invite users</Button>
        ) : null}
      </header>
      <ResourcePeopleTable
        access={access}
        onEdit={setEditing}
        onTransfer={setTransferTarget}
        revoking={remove.isPending}
        accepting={decision.isPending}
        onRevoke={(person) =>
          remove.mutate({
            data: {
              ...scope,
              id: person.id,
              revision: person.revision,
              revoke: true,
              selections: [],
              presetIds: [],
              builtinKeys: [],
            },
          })
        }
        onAccept={(person) =>
          decision.mutate({
            data: { id: person.invitationId!, decision: "accept", force: true },
          })
        }
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 100))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!access.hasMore}
          onClick={() => setOffset(offset + 100)}
        >
          Next
        </Button>
      </div>
      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <h3 className="font-semibold">Presets</h3>
          {access.canCreatePreset ? (
            <Button variant="outline" onClick={() => setPreset("new")}>
              Create preset
            </Button>
          ) : null}
        </header>
        <div className="grid gap-3 md:grid-cols-3">
          {access.defaults.map((preset) => (
            <article key={preset.key} className="rounded-lg border p-3">
              <div className="flex items-center justify-between text-sm font-medium">
                {preset.name}
                <Badge variant="outline">Kiln default</Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {preset.description}
              </p>
            </article>
          ))}
        </div>
        {access.presets.map((preset) => (
          <div
            key={preset.id}
            className="flex items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div>
              <span className="text-sm font-medium">{preset.name}</span>
              <p className="text-xs text-muted-foreground">
                {preset.assignmentCount} assignments · Updated{" "}
                {preset.updatedAt
                  .replace("T", " ")
                  .replace(/\.\d{3}Z$/, " UTC")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPreset(preset)}
              >
                {access.canManagePresets ? "Edit" : "View"}
              </Button>
              {access.canManagePresets ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    preset.assignmentCount > 0 || removePreset.isPending
                  }
                  onClick={() =>
                    removePreset.mutate({
                      data: {
                        ...scope,
                        id: preset.id,
                        revision: preset.revision,
                      },
                    })
                  }
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      {transferTarget ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setTransferTarget(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Transfer ownership?</DialogTitle>
              <DialogDescription>
                {transferTarget.name} will become the only owner of this server.
                Your remaining access follows your assignments.
              </DialogDescription>
            </DialogHeader>
            <Button
              variant="destructive"
              disabled={transfer.isPending}
              onClick={() =>
                transfer.mutate({
                  data: {
                    relayId: scope.relayId,
                    instanceId: scope.resourceId,
                    userId: transferTarget.userId,
                  },
                })
              }
            >
              Transfer ownership
            </Button>
          </DialogContent>
        </Dialog>
      ) : null}
      {inviting ? (
        <InviteEditor
          scope={scope}
          access={access}
          onClose={() => setInviting(false)}
          onSaved={refresh}
        />
      ) : null}
      {editing ? (
        <AssignmentEditor
          person={editing}
          scope={scope}
          access={access}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
      {preset ? (
        <PresetEditor
          preset={preset === "new" ? null : preset}
          scope={scope}
          access={access}
          onClose={() => setPreset(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  )
}

function PresetSelections({
  access,
  presetIds,
  builtinKeys,
  onChange,
}: {
  access: ScopeAccess
  presetIds: Array<string>
  builtinKeys: Array<string>
  onChange: (presetIds: Array<string>, builtinKeys: Array<string>) => void
}) {
  const selectedPresets = new Set(presetIds)
  const selectedDefaults = new Set(builtinKeys)
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Linked presets</legend>
      <div className="flex flex-wrap gap-4">
        {access.defaults.map((preset) => (
          <label key={preset.key} className="flex gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              checked={selectedDefaults.has(preset.key)}
              onChange={() =>
                onChange(
                  presetIds,
                  selectedDefaults.has(preset.key)
                    ? builtinKeys.filter((key) => key !== preset.key)
                    : [...builtinKeys, preset.key]
                )
              }
            />
            {preset.name}
          </label>
        ))}
        {access.presets.map((preset) => (
          <label key={preset.id} className="flex gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              checked={selectedPresets.has(preset.id)}
              onChange={() =>
                onChange(
                  selectedPresets.has(preset.id)
                    ? presetIds.filter((id) => id !== preset.id)
                    : [...presetIds, preset.id],
                  builtinKeys
                )
              }
            />
            {preset.name}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function AssignmentEditor({
  person,
  scope,
  access,
  onClose,
  onSaved,
}: {
  person: Person
  scope: ResourceScope
  access: ScopeAccess
  onClose: () => void
  onSaved: () => void
}) {
  const [selections, setSelections] = useState(person.selections),
    [presetIds, setPresetIds] = useState(person.presetIds),
    [builtinKeys, setBuiltinKeys] = useState(person.builtinKeys)
  const save = useMutation({
    mutationFn: updateResourceAccess,
    onError: errorToast,
    onSuccess: () => {
      onSaved()
      onClose()
      showToast({ type: "success", message: "Access updated" })
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Edit access for {person.name}</DialogTitle>
          <DialogDescription>
            Preset changes remain linked. Direct permissions add to those
            presets.
          </DialogDescription>
        </DialogHeader>
        <PresetSelections
          access={access}
          presetIds={presetIds}
          builtinKeys={builtinKeys}
          onChange={(ids, keys) => {
            setPresetIds(ids)
            setBuiltinKeys(keys)
          }}
        />
        <PermissionEditor
          scopeType={scope.resourceType}
          selections={selections}
          onChange={setSelections}
          available={access.permissions}
          capabilities={access.supportedCapabilities}
        />
        <Button
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              data: {
                ...scope,
                id: person.id,
                revision: person.revision,
                selections,
                presetIds,
                builtinKeys,
              },
            })
          }
        >
          Save access
        </Button>
      </DialogContent>
    </Dialog>
  )
}

interface InviteDraft extends ResourceScope {
  name?: string
  selections: Array<PermissionSelection>
  presetIds: Array<string>
  builtinKeys: Array<string>
}
const scopeKey = (scope: ResourceScope) =>
  `${scope.relayId}:${scope.resourceType}:${scope.resourceId}`

function InviteEditor({
  scope,
  onClose,
  onSaved,
}: {
  scope: ResourceScope & { name?: string }
  access: ScopeAccess
  onClose: () => void
  onSaved: () => void
}) {
  const [email, setEmail] = useState("")
  const [targets, setTargets] = useState<Array<InviteDraft>>([
    { ...scope, selections: [], presetIds: [], builtinKeys: [] },
  ])
  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const resources = useQuery({
    queryKey: ["access-resources", search, offset],
    queryFn: () => getAccessResources({ data: { search, offset } }),
  })
  const invite = useMutation({
    mutationFn: inviteResourceAccess,
    onError: errorToast,
    onSuccess: (result) => {
      onSaved()
      const created = result.invitations.filter(
        (invitation) => !invitation.existing
      ).length
      showToast({
        type: "success",
        message: `${created} invitation${created === 1 ? "" : "s"} created. Each resource is accepted separately.`,
      })
      onClose()
    },
  })
  const changeTarget = useCallback(
    (target: InviteDraft) =>
      setTargets((current) =>
        current.map((item) =>
          scopeKey(item) === scopeKey(target) ? target : item
        )
      ),
    []
  )
  const removeTarget = useCallback(
    (target: InviteDraft) =>
      setTargets((current) =>
        current.filter((item) => scopeKey(item) !== scopeKey(target))
      ),
    []
  )
  const remainingResources = useMemo(() => {
    const selected = new Set(targets.map(scopeKey))
    return (resources.data?.resources ?? EMPTY_RESOURCES).filter(
      (resource) => !selected.has(scopeKey(resource))
    )
  }, [resources.data?.resources, targets])
  const addTarget = useCallback(
    (resource: Resource) =>
      setTargets((current) => [
        ...current,
        { ...resource, selections: [], presetIds: [], builtinKeys: [] },
      ]),
    []
  )
  const searchResources = useCallback((value: string) => {
    setSearch(value)
    setOffset(0)
  }, [])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Invite to resources</DialogTitle>
          <DialogDescription>
            The user verifies their account, then accepts each invitation.
            Existing users also accept.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="email"
          aria-label="Email address"
          placeholder="person@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {targets.map((target) => (
          <InviteTargetEditor
            key={scopeKey(target)}
            target={target}
            onChange={changeTarget}
            onRemove={removeTarget}
          />
        ))}
        {targets.length < 25 ? (
          <div className="space-y-2 rounded-lg border p-3">
            <h3 className="text-sm font-medium">Add another resource</h3>
            <ResourcePicker
              resources={remainingResources}
              selected={null}
              onSelect={addTarget}
              onSearch={searchResources}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!resources.data?.hasMore}
                onClick={() => setOffset(offset + 50)}
              >
                More resources
              </Button>
            </div>
          </div>
        ) : null}
        <Button
          disabled={
            invite.isPending ||
            !email.trim() ||
            !targets.length ||
            targets.some(
              (target) =>
                !target.selections.length &&
                !target.presetIds.length &&
                !target.builtinKeys.length
            )
          }
          onClick={() => invite.mutate({ data: { email, targets } })}
        >
          Send invitations
        </Button>
      </DialogContent>
    </Dialog>
  )
}

const InviteTargetEditor = memo(function InviteTargetEditor({
  target,
  onChange,
  onRemove,
}: {
  target: InviteDraft
  onChange: (target: InviteDraft) => void
  onRemove: (target: InviteDraft) => void
}) {
  const query = useQuery({
    queryKey: [
      "resource-access",
      target.relayId,
      target.resourceType,
      target.resourceId,
    ],
    queryFn: () => getResourceAccess({ data: target }),
  })
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{target.name ?? target.resourceId}</h3>
          <p className="text-xs text-muted-foreground">
            {target.resourceType === "relay"
              ? "Relay · includes current and future resources"
              : target.resourceType}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => onRemove(target)}>
          Remove
        </Button>
      </header>
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading permissions…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      ) : !query.data.canInvite ? (
        <p className="text-sm text-muted-foreground">
          You cannot invite users to this resource.
        </p>
      ) : (
        <>
          <PresetSelections
            access={query.data}
            presetIds={target.presetIds}
            builtinKeys={target.builtinKeys}
            onChange={(presetIds, builtinKeys) =>
              onChange({ ...target, presetIds, builtinKeys })
            }
          />
          <PermissionEditor
            scopeType={target.resourceType}
            selections={target.selections}
            onChange={(selections) => onChange({ ...target, selections })}
            available={query.data.permissions}
            capabilities={query.data.supportedCapabilities}
          />
        </>
      )}
    </section>
  )
})

function PresetEditor({
  preset,
  scope,
  access,
  onClose,
  onSaved,
}: {
  preset: Preset | null
  scope: ResourceScope
  access: ScopeAccess
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(preset?.name ?? ""),
    [selections, setSelections] = useState<Array<PermissionSelection>>(
      preset?.selections ?? []
    )
  const [source, setSource] = useState<Resource | null>(null)
  const [sourceSearch, setSourceSearch] = useState("")
  const [sourceOffset, setSourceOffset] = useState(0)
  const searchSources = useCallback((value: string) => {
    setSourceSearch(value)
    setSourceOffset(0)
  }, [])
  const resources = useQuery({
    queryKey: ["access-resources", sourceSearch, sourceOffset],
    queryFn: () =>
      getAccessResources({
        data: { search: sourceSearch, offset: sourceOffset },
      }),
    enabled: !preset,
  })
  const sourcePresets = useQuery({
    queryKey: [
      "resource-access",
      source?.relayId,
      source?.resourceType,
      source?.resourceId,
    ],
    queryFn: () => getResourceAccess({ data: source! }),
    enabled: Boolean(source),
  })
  const editable = preset ? access.canManagePresets : access.canCreatePreset
  const save = useMutation({
    mutationFn: savePermissionPreset,
    onError: errorToast,
    onSuccess: () => {
      onSaved()
      onClose()
      showToast({
        type: "success",
        message: preset
          ? "Preset updated for all assignments"
          : "Preset created",
      })
    },
  })
  function copy(items: Array<PermissionSelection>) {
    const supported = items.filter((item) =>
      Result.isSuccess(
        Result.try(() =>
          expandForCopy(item, scope.resourceType, access.supportedCapabilities)
        )
      )
    )
    setSelections(supported)
    if (supported.length !== items.length)
      showToast({
        type: "info",
        message: "Unsupported permissions were omitted from this copy",
      })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{preset ? preset.name : "Create preset"}</DialogTitle>
          <DialogDescription>
            {preset
              ? `Changes apply to ${preset.assignmentCount} assignments on this resource.`
              : "Copy a template or choose permissions. This creates an independent preset on this resource."}
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Preset name"
          placeholder="Preset name"
          value={name}
          disabled={!editable}
          onChange={(event) => setName(event.target.value)}
        />
        {!preset ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {access.defaults.map((entry) => (
                <Button
                  key={entry.key}
                  variant="outline"
                  size="sm"
                  onClick={() => copy(entry.selections)}
                >
                  Copy {entry.name}
                </Button>
              ))}
            </div>
            <ResourcePicker
              resources={resources.data?.resources ?? EMPTY_RESOURCES}
              selected={source}
              onSelect={setSource}
              onSearch={searchSources}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!sourceOffset}
                onClick={() => setSourceOffset(Math.max(0, sourceOffset - 50))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!resources.data?.hasMore}
                onClick={() => setSourceOffset(sourceOffset + 50)}
              >
                Next
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {sourcePresets.data?.presets.map((entry) => (
                <Button
                  key={entry.id}
                  variant="outline"
                  size="sm"
                  onClick={() => copy(entry.selections)}
                >
                  Copy {entry.name}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <PermissionEditor
          scopeType={scope.resourceType}
          selections={selections}
          onChange={setSelections}
          available={access.permissions}
          capabilities={access.supportedCapabilities}
          disabled={!editable}
        />
        {editable ? (
          <Button
            disabled={!name.trim() || save.isPending}
            onClick={() =>
              save.mutate({
                data: {
                  ...scope,
                  id: preset?.id,
                  revision: preset?.revision,
                  name,
                  selections,
                },
              })
            }
          >
            Save preset
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

import { expandPermissionSelections as expandForCopySelections } from "@workspace/contracts"
function expandForCopy(
  selection: PermissionSelection,
  scope: ResourceScope["resourceType"],
  capabilities?: ReadonlyArray<string>
) {
  return expandForCopySelections([selection], scope, capabilities)
}
