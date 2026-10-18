import { createDataTableSearchStore } from "@/lib/data-table-search"
import { getRouteApi, Link } from "@tanstack/react-router"
import {
  Users,
  ListChecks,
  Server,
  Database,
  Network,
  ArrowLeftRight,
  ChevronDown,
} from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@workspace/ui/components/command"
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
  type ReactNode,
  useState,
  useCallback,
  useMemo,
  useSyncExternalStore,
  useDeferredValue,
} from "react"
import { Result } from "effect"
import {
  useMutation,
  useQueries,
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
  ContextChips,
  PermissionEditor,
  type PermissionAssignment,
  type PermissionContext,
  type PermissionTarget,
} from "@/components/permission-editor"
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

type Resource = Awaited<
  ReturnType<typeof getAccessResources>
>["resources"][number]
const EMPTY_RESOURCES: Array<Resource> = []
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
    type === "relay" ? Network : type === "database" ? Database : Server
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

const ResourcePicker = memo(function ResourcePicker({
  resources,
  selected,
  onSelect,
  onSearch,
  platform,
  onPlatform,
  loading,
  error,
  hasMore,
  onMore,
  onPrevious,
  hasPrevious,
  trigger,
}: {
  resources: Array<Resource>
  selected: AccessScope | null
  onSelect: (resource: Resource) => void
  onSearch: (search: string) => void
  platform?: boolean
  onPlatform?: () => void
  loading?: boolean
  error?: string
  hasMore?: boolean
  onMore?: () => void
  onPrevious?: () => void
  hasPrevious?: boolean
  trigger?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState("")
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="outline" size="sm">
            <ArrowLeftRight />
            {selected ? "Change instance" : "Choose instance"}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(32rem,calc(100vw-2rem))] p-1.5"
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label="Find instances"
            placeholder="Search by name or ID…"
            value={searchValue}
            onValueChange={(value) => {
              setSearchValue(value)
              onSearch(value)
            }}
          />
          <CommandList aria-label="Instances">
            {platform ? (
              <CommandItem
                value="platform"
                onSelect={() => {
                  onPlatform?.()
                  setOpen(false)
                }}
              >
                <Users />
                Platform users
              </CommandItem>
            ) : null}
            {resources.map((resource) => (
              <CommandItem
                key={scopeKey(resource)}
                value={scopeKey(resource)}
                onSelect={() => {
                  onSelect(resource)
                  setOpen(false)
                }}
              >
                {resource.resourceType === "relay" ? (
                  <Network />
                ) : resource.resourceType === "database" ? (
                  <Database />
                ) : (
                  <Server />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{resource.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {resource.resourceType === "relay"
                      ? resource.resourceId
                      : `${resource.resourceId} · ${resource.relayName}`}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {resource.resourceType === "instance"
                    ? "Game Server"
                    : resource.resourceType}
                </span>
              </CommandItem>
            ))}
            <CommandEmpty>
              {loading
                ? "Loading instances…"
                : (error ?? "No instances found.")}
            </CommandEmpty>
          </CommandList>
          {hasPrevious ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={onPrevious}
            >
              Previous instances
            </Button>
          ) : null}
          {hasMore ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={onMore}
            >
              Load more instances
            </Button>
          ) : null}
          {error && resources.length ? (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
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
      showToast({ type: "success", message: "Invitation accepted for user" })
    },
  })
  const transfer = useMutation({
    mutationFn: transferInstanceOwnership,
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
  const accept = useCallback(
    (person: Person) =>
      decision.mutate({
        data: { id: person.invitationId!, decision: "accept", force: true },
      }),
    [decision.mutate]
  )
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
              {transferTarget?.name} will become the only owner of this server.
              Your remaining access follows your assignments.
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
                    instanceId: scope.resourceId,
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
            <DialogTitle>Revoke access?</DialogTitle>
            <DialogDescription>
              {revokeTarget?.name} will lose their direct access to this
              instance. Access inherited from a Relay will still apply.
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
              Revoke access
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
        <InviteEditor
          scope={scope}
          onClose={() => setInviting(false)}
          onSaved={refresh}
        />
      ) : null}
      {access && editing ? (
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

type AccessScope = ResourceScope & { name?: string; relayName?: string }

/** The context chips for a scope, from whichever names are known. */
function contextFor(scope: AccessScope): PermissionContext {
  return {
    scope: {
      relayId: scope.relayId,
      resourceType: scope.resourceType,
      resourceId: scope.resourceId,
    },
    relayName:
      scope.relayName ??
      (scope.resourceType === "relay" ? scope.name : undefined),
    resourceName: scope.resourceType === "relay" ? undefined : scope.name,
  }
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Edit access for {person.name}</DialogTitle>
          <DialogDescription>
            Linked presets stay in sync when the preset changes. Permissions add
            to them.
          </DialogDescription>
        </DialogHeader>
        <PermissionEditor
          targets={targets}
          onChange={change}
          presets
          disabled={save.isPending}
        />
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface InviteDraft extends AccessScope, PermissionAssignment {}
const scopeKey = (scope: ResourceScope) =>
  `${scope.relayId}:${scope.resourceType}:${scope.resourceId}`
const hasEntries = (draft: PermissionAssignment) =>
  draft.selections.length > 0 ||
  draft.presetIds.length > 0 ||
  draft.builtinKeys.length > 0
const emptyDraft = (scope: AccessScope): InviteDraft => ({
  ...scope,
  selections: [],
  presetIds: [],
  builtinKeys: [],
})
function combineAccess(
  results: Array<{
    data?: ScopeAccess
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

function InviteEditor({
  scope,
  onClose,
  onSaved,
}: {
  scope: AccessScope
  onClose: () => void
  onSaved: () => void
}) {
  const [email, setEmail] = useState("")
  const [drafts, setDrafts] = useState<Array<InviteDraft>>(() => [
    emptyDraft(scope),
  ])
  const [addKey, setAddKey] = useState(() => scopeKey(scope))
  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const resources = useQuery({
    queryKey: ["access-resources", search, offset],
    queryFn: () => getAccessResources({ data: { search, offset } }),
  })
  const access = useQueries({
    queries: drafts.map((draft) => ({
      queryKey: [
        "resource-access",
        draft.relayId,
        draft.resourceType,
        draft.resourceId,
      ],
      queryFn: () =>
        getResourceAccess({
          data: {
            relayId: draft.relayId,
            resourceType: draft.resourceType,
            resourceId: draft.resourceId,
          },
        }),
    })),
    combine: combineAccess,
  })
  const targets = useMemo<Array<PermissionTarget>>(
    () =>
      drafts.map((draft, index) => {
        const result = access[index]
        return {
          key: scopeKey(draft),
          context: contextFor(draft),
          access: result?.data,
          notice:
            !result || result.isPending
              ? "Loading permissions…"
              : result.error
                ? result.error.message
                : !result.data?.canInvite
                  ? "You can't invite people to this resource."
                  : undefined,
          selections: draft.selections,
          presetIds: draft.presetIds,
          builtinKeys: draft.builtinKeys,
        }
      }),
    [drafts, access]
  )
  const addTarget = targets.find((target) => target.key === addKey)
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
  const change = useCallback(
    (key: string, assignment: PermissionAssignment) =>
      setDrafts((current) =>
        current.map((draft) =>
          scopeKey(draft) === key ? { ...draft, ...assignment } : draft
        )
      ),
    []
  )
  // Switching context keeps every resource that has entries and drops ones
  // that were picked but never used.
  const pickContext = useCallback((resource: Resource) => {
    const key = scopeKey(resource)
    setDrafts((current) => {
      const kept = current.filter(
        (draft) => hasEntries(draft) || scopeKey(draft) === key
      )
      return kept.some((draft) => scopeKey(draft) === key) || kept.length >= 25
        ? kept
        : [...kept, emptyDraft(resource)]
    })
    setAddKey(key)
  }, [])
  const previousResources = useCallback(
    () => setOffset((current) => Math.max(0, current - 50)),
    []
  )
  const nextResources = useCallback(
    () => setOffset((current) => current + 50),
    []
  )
  const searchResources = useCallback((value: string) => {
    setSearch(value)
    setOffset(0)
  }, [])
  const submitted = drafts.filter(hasEntries)
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
        <Button
          type="button"
          variant="outline"
          aria-label="Context for new entries"
          className="h-10 max-w-full min-w-0 justify-start gap-2 px-2.5 sm:max-w-[24rem]"
        >
          <span className="type-meta shrink-0 text-muted-foreground">in</span>
          {addTarget ? <ContextChips context={addTarget.context} /> : null}
          <ChevronDown className="ml-auto text-muted-foreground" />
        </Button>
      }
    />
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !invite.isPending) onClose()
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
          <DialogDescription>
            Add permissions and presets, each on a Relay, game server, or
            database. The user verifies their account, then accepts each
            resource&apos;s invitation.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={invite.isPending} className="min-w-0 space-y-4">
          <Input
            type="email"
            aria-label="Email address"
            placeholder="person@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PermissionEditor
            targets={targets}
            onChange={change}
            addTarget={addKey}
            contextPicker={contextPicker}
            showContexts
            presets
            disabled={invite.isPending}
            emptyMessage="Nothing to invite to yet. Add a permission or preset above."
          />
        </fieldset>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={invite.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={invite.isPending || !email.trim() || !submitted.length}
            onClick={() =>
              invite.mutate({
                data: {
                  email,
                  targets: submitted.map((draft) => ({
                    relayId: draft.relayId,
                    resourceType: draft.resourceType,
                    resourceId: draft.resourceId,
                    selections: draft.selections,
                    presetIds: draft.presetIds,
                    builtinKeys: draft.builtinKeys,
                  })),
                },
              })
            }
          >
            {invite.isPending
              ? "Sending…"
              : submitted.length > 1
                ? `Send ${submitted.length} invitations`
                : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{preset ? preset.name : "Create preset"}</DialogTitle>
          <DialogDescription>
            {preset
              ? `Changes apply to ${preset.assignmentCount} assignments on this resource.`
              : "Copy a template or choose permissions. This creates an independent preset on this resource."}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={save.isPending || !editable} className="space-y-4">
          <Input
            aria-label="Preset name"
            placeholder="Preset name"
            value={name}
            disabled={!editable || save.isPending}
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
                loading={resources.isFetching}
                error={resources.error?.message}
                hasPrevious={sourceOffset > 0}
                onPrevious={previousSources}
                hasMore={resources.data?.hasMore}
                onMore={nextSources}
              />

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
            targets={targets}
            onChange={editable ? changeSelections : undefined}
            disabled={save.isPending}
          />
        </fieldset>
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
