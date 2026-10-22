import {
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import { createDataTableSearchStore } from "@/lib/data-table-search"
import { getRouteApi, Link } from "@tanstack/react-router"
import { Users, ListChecks, Layers } from "lucide-react"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"
import { DataTableWorkspace } from "@/components/data-table-workspace"
import {
  AcceptingInvitationContext,
  ResourcePeopleTable,
  ResourcePresetsTable,
  type Person,
  type Preset,
  type ScopeAccess,
} from "@/components/resource-access-tables"
import { useCursorDataTableSource } from "@/lib/data-table-source"
import {
  memo,
  useState,
  useCallback,
  useMemo,
  useSyncExternalStore,
  useDeferredValue,
} from "react"
import { Result } from "effect"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query"
import {
  expandPermissionSelections,
  type PermissionSelection,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Badge } from "@workspace/ui/components/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import { AdminUsers } from "@/components/admin-users"
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
} from "@/components/permission-editor"
import { UserAccessDialog } from "@/components/user-access-dialog"
import { transferResourceOwnership } from "@/server/access"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import type { ResourceScope } from "@/lib/resource-permissions"
import {
  getAccessResources,
  getResourceAccess,
  updateResourceAccess,
  savePermissionPreset,
  deletePermissionPreset,
  decideResourceInvitation,
} from "@/server/resource-access"

const NO_IDS: Array<string> = []
const errorToast = (error: Error) =>
  showToast({ type: "error", message: error.message })

const accessRoute = getRouteApi("/_app/access")

export function AccessPage() {
  const search = accessRoute.useSearch()
  const navigate = accessRoute.useNavigate()
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const selectedQuery = useQuery({
    queryKey: ["access-resources", "selected", search.resourceId],
    queryFn: () => getAccessResources({ data: { search: search.resourceId! } }),
    enabled: !!search.resourceId,
  })
  const selectedResource = selectedQuery.data?.resources.find(
    (resource) =>
      resource.relayId === search.relayId &&
      resource.resourceType === search.resourceType &&
      resource.resourceId === search.resourceId
  )
  const tab = search.tab ?? "users"
  const admin = capabilities?.isPlatformAdmin ?? false
  const scope = useMemo(
    () =>
      search.relayId && search.resourceType && search.resourceId
        ? {
            relayId: search.relayId,
            resourceType: search.resourceType,
            resourceId: search.resourceId,
            name:
              selectedResource?.name ??
              search.resourceName ??
              search.resourceId,
            relayName: selectedResource?.relayName,
          }
        : null,
    [
      search.relayId,
      search.resourceType,
      search.resourceId,
      search.resourceName,
      selectedResource?.name,
      selectedResource?.relayName,
    ]
  )
  const platform = !scope && admin && tab === "users"
  // A fresh closure here defeats the memo on AccessScopeControls, which owns an
  // infinite resource query and a popover.
  const select = useCallback(
    (resource: Resource | null) => {
      void navigate({
        search: {
          tab,
          relayId: resource?.relayId,
          resourceType: resource?.resourceType,
          resourceId: resource?.resourceId,
          resourceName: resource?.name,
        },
      })
    },
    [navigate, tab]
  )
  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <nav
        aria-label="Access views"
        className="mb-3 flex shrink-0 gap-1 border-b"
      >
        {(["users", "presets"] as const).map((view) => (
          <Link
            key={view}
            to="/access"
            search={{ ...search, tab: view }}
            aria-current={tab === view ? "page" : undefined}
            className={`relative flex h-11 items-center gap-2 px-3 text-sm font-medium after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 ${tab === view ? "text-foreground after:bg-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            {view === "users" ? (
              <Users className="size-4" />
            ) : (
              <ListChecks className="size-4" />
            )}
            {view === "users" ? "Users" : "Presets"}
          </Link>
        ))}
      </nav>
      <AccessScopeControls
        scope={scope}
        admin={admin}
        tab={tab}
        platform={platform}
        select={select}
      />
      {scope ? (
        <ResourceAccessPanel key={scopeKey(scope)} scope={scope} tab={tab} />
      ) : platform ? (
        <AdminUsers />
      ) : (
        <DataTableWorkspace toolbar={null}>
          <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted-foreground">
            Choose an instance to view its {tab}.
          </div>
        </DataTableWorkspace>
      )}
    </div>
  )
}

function ScopeIcon({ type }: { type?: ResourceScope["resourceType"] }) {
  const Icon =
    type === "relay"
      ? RelayKindIcon
      : type === "database"
        ? DatabaseKindIcon
        : type === "instance"
          ? ServerKindIcon
          : Layers
  return <Icon className="size-5" />
}
function scopeDescription(scope: ResourceScope | null, platform: boolean) {
  if (scope?.resourceType === "relay")
    return "Applies to all current and future instances on this Relay."
  if (platform)
    return "Account status, verification, and platform administrators."
  if (scope) return "Manage users and linked permission presets."
  return "Choose a game server, database, or Relay to manage access."
}

const AccessScopeControls = memo(function AccessScopeControls({
  scope,
  admin,
  tab,
  platform,
  select,
}: {
  scope: (AccessScope & { name: string }) | null
  admin: boolean
  tab: "users" | "presets"
  platform: boolean
  select: (resource: Resource | null) => void
}) {
  const [resourceSearch, setResourceSearch] = useState("")
  const resources = useInfiniteQuery({
    queryKey: ["access-resources", "picker", resourceSearch],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getAccessResources({
        data: { search: resourceSearch, offset: pageParam },
      }),
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.length * 50 : undefined,
  })
  const options = useMemo(
    () =>
      resources.data?.pages.flatMap((page) => page.resources) ??
      EMPTY_RESOURCES,
    [resources.data]
  )
  return (
    <WorkspaceSummaryCard
      className="mb-3 shrink-0"
      icon={<ScopeIcon type={scope?.resourceType} />}
      title={scope?.name ?? (platform ? "Platform" : "Choose an instance")}
      titleAccessory={
        scope ? (
          <Badge variant="outline">
            {scope.resourceType === "instance"
              ? "Game Server"
              : scope.resourceType === "relay"
                ? "Relay"
                : "Database"}
          </Badge>
        ) : undefined
      }
      action={
        <ResourcePicker
          resources={options}
          selected={scope}
          onSelect={select}
          onSearch={setResourceSearch}
          platform={admin && tab === "users"}
          onPlatform={() => select(null)}
          loading={resources.isFetching}
          error={resources.error?.message}
          hasMore={resources.hasNextPage}
          onMore={() => {
            void resources.fetchNextPage()
          }}
        />
      }
    >
      <p className="type-meta mt-1 truncate text-muted-foreground">
        {scopeDescription(scope, platform)}
      </p>
    </WorkspaceSummaryCard>
  )
})

const personKey = (person: Person) => person.id
function ResourceAccessPanel({
  scope,
  tab = "users",
}: {
  scope: AccessScope
  tab?: "users" | "presets"
}) {
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<Person | null>(null)
  const [preset, setPreset] = useState<Preset | "new" | null>(null)
  const [transferTarget, setTransferTarget] = useState<Person | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<Person | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Preset | null>(null)
  const [searchStore] = useState(() => createDataTableSearchStore())
  const userSearch = useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getNormalizedSnapshot,
    searchStore.getNormalizedServerSnapshot
  )
  const deferredSearch = useDeferredValue(userSearch)
  const queryClient = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: [
      "resource-access",
      scope.relayId,
      scope.resourceType,
      scope.resourceId,
      "people",
      deferredSearch,
    ],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const access = await getResourceAccess({
        data: { ...scope, offset: pageParam, search: deferredSearch },
      })
      return {
        ...access,
        items: access.people,
        nextCursor: access.hasMore ? pageParam + 100 : null,
      }
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: tab === "users",
  })
  // Presets are scope-level, so they load from their own request instead of
  // riding the people query's search and pagination state. Only one of the two
  // runs at a time because only one tab is mounted.
  const presetsQuery = useQuery({
    queryKey: [
      "resource-access",
      scope.relayId,
      scope.resourceType,
      scope.resourceId,
      "presets",
    ],
    queryFn: () => getResourceAccess({ data: { ...scope, offset: 0 } }),
    enabled: tab === "presets",
  })
  const source = useCursorDataTableSource({
    query,
    resetKey: `${scopeKey(scope)}:${deferredSearch}`,
    getRowKey: personKey,
  })
  const access: ScopeAccess | undefined =
    tab === "presets"
      ? (presetsQuery.data ?? query.data?.pages[0])
      : (query.data?.pages[0] ?? presetsQuery.data)
  const retryPresets = useCallback(() => {
    void presetsQuery.refetch()
  }, [presetsQuery.refetch])
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["resource-access"] })
    void queryClient.invalidateQueries({ queryKey: ["access"] })
  }, [queryClient])
  const decision = useMutation({
    mutationFn: decideResourceInvitation,
    onError: errorToast,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["resource-access"] })
      void queryClient.invalidateQueries({ queryKey: ["access"] })
      setAcceptTarget(null)
      showToast({ type: "success", message: "Invitation accepted for user" })
    },
  })
  const transfer = useMutation({
    mutationFn: transferResourceOwnership,
    onError: errorToast,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["resource-access"] })
      void queryClient.invalidateQueries({ queryKey: ["access"] })
      setTransferTarget(null)
      showToast({ type: "success", message: "Ownership transferred" })
    },
  })
  const removePreset = useMutation({
    mutationFn: deletePermissionPreset,
    onError: errorToast,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["resource-access"] })
      void queryClient.invalidateQueries({ queryKey: ["access"] })
      setDeleteTarget(null)
      showToast({ type: "success", message: "Preset deleted" })
    },
  })
  const remove = useMutation({
    mutationFn: updateResourceAccess,
    onError: errorToast,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["resource-access"] })
      void queryClient.invalidateQueries({ queryKey: ["access"] })
      setRevokeTarget(null)
      showToast({
        type: result.inheritedAccessRemains ? "info" : "success",
        message: result.inheritedAccessRemains
          ? "Direct access revoked. Relay access still applies."
          : "Access revoked",
      })
    },
  })
  const invite = useCallback(() => setInviting(true), [])
  const createPreset = useCallback(() => setPreset("new"), [])
  const [acceptTarget, setAcceptTarget] = useState<Person | null>(null)
  const accept = setAcceptTarget
  return (
    <>
      {tab === "users" ? (
        <AcceptingInvitationContext.Provider value={decision.isPending}>
          <ResourcePeopleTable
            access={access}
            searchStore={searchStore}
            source={source}
            onEdit={setEditing}
            onTransfer={setTransferTarget}
            onRevoke={setRevokeTarget}
            onAccept={accept}
            onInvite={invite}
          />
        </AcceptingInvitationContext.Provider>
      ) : (
        <ResourcePresetsTable
          access={access}
          error={presetsQuery.error}
          loading={presetsQuery.isPending}
          refreshing={presetsQuery.isFetching && !presetsQuery.isPending}
          onRetry={retryPresets}
          onEdit={setPreset}
          onDelete={setDeleteTarget}
          onCreate={createPreset}
        />
      )}
      <Dialog
        open={!!transferTarget}
        onOpenChange={(open) => {
          if (!open && !transfer.isPending) setTransferTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer ownership?</DialogTitle>
            <DialogDescription>
              {transferTarget?.name} will become the only owner of this{" "}
              {scope.resourceType === "instance"
                ? "game server"
                : scope.resourceType === "database"
                  ? "database"
                  : "Relay"}
              . Your remaining access follows your assignments.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={transfer.isPending}
              onClick={() => setTransferTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={transfer.isPending}
              onClick={() =>
                transferTarget &&
                transfer.mutate({
                  data: {
                    relayId: scope.relayId,
                    resourceType: scope.resourceType,
                    resourceId: scope.resourceId,
                    userId: transferTarget.userId,
                  },
                })
              }
            >
              Transfer ownership
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRevokeTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {revokeTarget?.state === "pending"
                ? "Cancel invitation?"
                : "Revoke access?"}
            </DialogTitle>
            <DialogDescription>
              {revokeTarget?.state === "pending"
                ? `${revokeTarget.name}'s invitation to this resource is cancelled.`
                : `${revokeTarget?.name} will lose their direct access to this resource. Access inherited from a Relay will still apply.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setRevokeTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                revokeTarget &&
                remove.mutate({
                  data: {
                    ...scope,
                    id: revokeTarget.id,
                    revision: revokeTarget.revision,
                    revoke: true,
                    selections: [],
                    presetIds: [],
                    builtinKeys: [],
                  },
                })
              }
            >
              {revokeTarget?.state === "pending"
                ? "Cancel invitation"
                : "Revoke access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!acceptTarget}
        onOpenChange={(open) => {
          if (!open && !decision.isPending) setAcceptTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Accept invitation for {acceptTarget?.name}?
            </DialogTitle>
            <DialogDescription>
              They get this access right away, without accepting it themselves.
              The invitation is recorded as accepted by you.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={decision.isPending}
              onClick={() => setAcceptTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={decision.isPending}
              onClick={() =>
                acceptTarget?.invitationId &&
                decision.mutate({
                  data: {
                    id: acceptTarget.invitationId,
                    decision: "accept",
                    force: true,
                  },
                })
              }
            >
              {decision.isPending ? "Accepting…" : "Accept invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !removePreset.isPending) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete preset?</DialogTitle>
            <DialogDescription>
              Delete {deleteTarget?.name}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removePreset.isPending}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removePreset.isPending}
              onClick={() =>
                deleteTarget &&
                removePreset.mutate({
                  data: {
                    ...scope,
                    id: deleteTarget.id,
                    revision: deleteTarget.revision,
                  },
                })
              }
            >
              Delete preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {access && inviting ? (
        <UserAccessDialog
          initialScope={scope}
          platform={access.isPlatformAdmin}
          onClose={() => setInviting(false)}
        />
      ) : null}
      {access && editing && access.isPlatformAdmin ? (
        <UserAccessDialog
          userId={editing.userId}
          initialScope={scope}
          platform
          onClose={() => setEditing(null)}
        />
      ) : access && editing ? (
        <AssignmentEditor
          person={editing}
          scope={scope}
          access={access}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
      {access && preset ? (
        <PresetEditor
          preset={preset === "new" ? null : preset}
          scope={scope}
          access={access}
          onClose={() => setPreset(null)}
          onSaved={refresh}
        />
      ) : null}
    </>
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
  scope: AccessScope
  access: ScopeAccess
  onClose: () => void
  onSaved: () => void
}) {
  const [assignment, setAssignment] = useState<PermissionAssignment>({
    selections: person.selections,
    presetIds: person.presetIds,
    builtinKeys: person.builtinKeys,
  })
  const targets = useMemo(
    () => [
      {
        key: scopeKey(scope),
        context: contextFor(scope),
        access,
        ...assignment,
      },
    ],
    [scope, access, assignment]
  )
  const change = useCallback(
    (_key: string, next: PermissionAssignment) => setAssignment(next),
    []
  )
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
        if (!open && !save.isPending) onClose()
      }}
    >
      <PermissionDialogContent
        title={`Edit access for ${person.name}`}
        description="Linked presets stay in sync when the preset changes. Permissions add to them."
        footer={
          <>
            <Button
              variant="outline"
              className="sm:ml-auto"
              disabled={save.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  data: {
                    relayId: scope.relayId,
                    resourceType: scope.resourceType,
                    resourceId: scope.resourceId,
                    id: person.id,
                    revision: person.revision,
                    ...assignment,
                  },
                })
              }
            >
              {save.isPending ? "Saving…" : "Save access"}
            </Button>
          </>
        }
      >
        <PermissionEditor
          targets={targets}
          onChange={change}
          presets
          disabled={save.isPending}
        />
      </PermissionDialogContent>
    </Dialog>
  )
}

function PresetEditor({
  preset,
  scope,
  access,
  onClose,
  onSaved,
}: {
  preset: Preset | null
  scope: AccessScope
  access: ScopeAccess
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(preset?.name ?? ""),
    [selections, setSelections] = useState<Array<PermissionSelection>>(
      preset?.selections ?? []
    )
  const targets = useMemo(
    () => [
      {
        key: scopeKey(scope),
        context: contextFor(scope),
        access,
        selections,
        presetIds: NO_IDS,
        builtinKeys: NO_IDS,
      },
    ],
    [scope, access, selections]
  )
  const changeSelections = useCallback(
    (_key: string, next: PermissionAssignment) =>
      setSelections(next.selections),
    []
  )
  const [source, setSource] = useState<Resource | null>(null)
  const [sourceSearch, setSourceSearch] = useState("")
  const [sourceOffset, setSourceOffset] = useState(0)
  const previousSources = useCallback(
    () => setSourceOffset((current) => Math.max(0, current - 50)),
    []
  )
  const nextSources = useCallback(
    () => setSourceOffset((current) => current + 50),
    []
  )
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
    const available = new Set(access.permissions)
    const supported = items.filter((item) => {
      const expanded = Result.try(() =>
        expandPermissionSelections(
          [item],
          scope.resourceType,
          access.supportedCapabilities
        )
      )
      return (
        Result.isSuccess(expanded) &&
        expanded.success.every((permission) => available.has(permission))
      )
    })
    setSelections(supported)
    if (supported.length !== items.length)
      showToast({
        type: "info",
        message:
          "Selections with unavailable permissions or permissions you cannot grant were omitted from this copy",
      })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose()
      }}
    >
      <PermissionDialogContent
        title={preset ? preset.name : "Create preset"}
        description={
          preset
            ? `Changes apply to ${preset.assignmentCount} assignments on this resource.`
            : "Copy a template or choose permissions. This creates an independent preset on this resource."
        }
        header={
          <fieldset
            disabled={save.isPending || !editable}
            className="min-w-0 space-y-3"
          >
            <div>
              <h2 className="type-dialog-title">
                {preset ? preset.name : "Create preset"}
              </h2>
              <p className="type-support mt-1 text-muted-foreground">
                {preset
                  ? `Changes apply to ${preset.assignmentCount} assignments on this resource.`
                  : "Copy a template or choose permissions. This creates an independent preset on this resource."}
              </p>
            </div>
            <Input
              aria-label="Preset name"
              placeholder="Preset name"
              className="sm:max-w-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {!preset ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="type-meta text-muted-foreground">Copy</span>
                {access.defaults.map((entry) => (
                  <Button
                    key={entry.key}
                    variant="outline"
                    size="sm"
                    onClick={() => copy(entry.selections)}
                  >
                    {entry.name}
                  </Button>
                ))}
                {sourcePresets.data?.presets.map((entry) => (
                  <Button
                    key={entry.id}
                    variant="outline"
                    size="sm"
                    onClick={() => copy(entry.selections)}
                  >
                    {entry.name}
                  </Button>
                ))}
                <ResourcePicker
                  resources={resources.data?.resources ?? EMPTY_RESOURCES}
                  selected={source}
                  onSelect={setSource}
                  onSearch={searchSources}
                  loading={resources.isFetching}
                  error={resources.error?.message}
                  hasPrevious={sourceOffset > 0}
                  onPrevious={previousSources}
                  hasMore={resources.data?.hasMore}
                  onMore={nextSources}
                  trigger={
                    <Button type="button" variant="ghost" size="sm">
                      {source
                        ? `Presets from ${source.name}`
                        : "From another resource…"}
                    </Button>
                  }
                />
              </div>
            ) : null}
          </fieldset>
        }
        footer={
          <>
            <Button
              variant="outline"
              className="sm:ml-auto"
              disabled={save.isPending}
              onClick={onClose}
            >
              {editable ? "Cancel" : "Close"}
            </Button>
            {editable ? (
              <Button
                disabled={!name.trim() || save.isPending}
                onClick={() =>
                  save.mutate({
                    data: {
                      relayId: scope.relayId,
                      resourceType: scope.resourceType,
                      resourceId: scope.resourceId,
                      id: preset?.id,
                      revision: preset?.revision,
                      name,
                      selections,
                    },
                  })
                }
              >
                {save.isPending ? "Saving…" : "Save preset"}
              </Button>
            ) : null}
          </>
        }
      >
        <PermissionEditor
          targets={targets}
          onChange={editable ? changeSelections : undefined}
          disabled={save.isPending}
        />
      </PermissionDialogContent>
    </Dialog>
  )
}
