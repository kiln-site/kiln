import { createDataTableSearchStore } from "@/lib/data-table-search"
import { getRouteApi, Link } from "@tanstack/react-router"
import {
  Users,
  ListChecks,
  Server,
  Database,
  Network,
  ArrowLeftRight,
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
  ResourcePeopleTable,
  ResourcePresetsTable,
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
import type { PermissionSelection } from "@workspace/contracts"
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
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@workspace/ui/components/tooltip"
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
          }
        : null,
    [
      search.relayId,
      search.resourceType,
      search.resourceId,
      search.resourceName,
      selectedResource?.name,
    ]
  )
  const platform = !scope && admin && tab === "users"
  const select = (resource: Resource | null) => {
    void navigate({
      search: {
        tab,
        relayId: resource?.relayId,
        resourceType: resource?.resourceType,
        resourceId: resource?.resourceId,
        resourceName: resource?.name,
      },
    })
  }
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
  return "Choose a server, database, or Relay to manage access."
}

const AccessScopeControls = memo(function AccessScopeControls({
  scope,
  admin,
  tab,
  platform,
  select,
}: {
  scope: Resource | null
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
              ? "Server"
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
}: {
  resources: Array<Resource>
  selected: Resource | null
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
}) {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState("")
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <ArrowLeftRight />
          {selected ? "Change instance" : "Choose instance"}
        </Button>
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
                    {resource.resourceId} · {resource.relayId}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {resource.resourceType === "instance"
                    ? "Server"
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
export function ResourceAccessPanel({
  scope,
  tab = "users",
}: {
  scope: ResourceScope & { name?: string }
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
  })
  const source = useCursorDataTableSource({
    query,
    resetKey: `${scopeKey(scope)}:${deferredSearch}`,
    getRowKey: personKey,
  })
  const access = query.data?.pages[0]
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
        <ResourcePeopleTable
          access={access}
          searchStore={searchStore}
          source={source}
          onEdit={setEditing}
          onTransfer={setTransferTarget}
          onRevoke={setRevokeTarget}
          onAccept={accept}
          onInvite={invite}
          accepting={decision.isPending}
        />
      ) : (
        <ResourcePresetsTable
          access={access}
          source={source}
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
          access={access}
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

function linkedPresetSelections(
  access: ScopeAccess,
  presetIds: Array<string>,
  builtinKeys: Array<string>
) {
  const selectedPresets = new Set(presetIds)
  const selectedDefaults = new Set(builtinKeys)
  return [
    ...access.presets.filter((preset) => selectedPresets.has(preset.id)),
    ...access.defaults.filter((preset) => selectedDefaults.has(preset.key)),
  ].flatMap((preset) => preset.selections)
}

function PresetSelections({
  access,
  scopeType,
  presetIds,
  builtinKeys,
  onChange,
  disabled = false,
}: {
  access: ScopeAccess
  scopeType: ResourceScope["resourceType"]
  presetIds: Array<string>
  builtinKeys: Array<string>
  onChange: (presetIds: Array<string>, builtinKeys: Array<string>) => void
  disabled?: boolean
}) {
  const selectedPresets = new Set(presetIds)
  const selectedDefaults = new Set(builtinKeys)
  const available = new Set(access.permissions)
  function unavailableReason(selections: Array<PermissionSelection>) {
    const result = Result.try(() =>
      expandForCopySelections(
        selections,
        scopeType,
        access.supportedCapabilities
      )
    )
    if (Result.isFailure(result))
      return "This preset includes permissions unavailable for this resource."
    if (result.success.some((permission) => !available.has(permission)))
      return "This preset includes permissions you cannot grant."
    return undefined
  }
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Linked presets</legend>
      <div className="flex flex-wrap gap-4">
        {access.defaults.map((preset) => (
          <PresetCheckbox
            key={preset.key}
            name={preset.name}
            checked={selectedDefaults.has(preset.key)}
            unavailable={unavailableReason(preset.selections)}
            onChange={() =>
              onChange(
                presetIds,
                selectedDefaults.has(preset.key)
                  ? builtinKeys.filter((key) => key !== preset.key)
                  : [...builtinKeys, preset.key]
              )
            }
          />
        ))}
        {access.presets.map((preset) => (
          <PresetCheckbox
            key={preset.id}
            name={preset.name}
            checked={selectedPresets.has(preset.id)}
            unavailable={unavailableReason(preset.selections)}
            onChange={() =>
              onChange(
                selectedPresets.has(preset.id)
                  ? presetIds.filter((id) => id !== preset.id)
                  : [...presetIds, preset.id],
                builtinKeys
              )
            }
          />
        ))}
      </div>
    </fieldset>
  )
}

function PresetCheckbox({
  name,
  checked,
  unavailable,
  onChange,
}: {
  name: string
  checked: boolean
  unavailable?: string
  onChange: () => void
}) {
  const label = (
    <label
      className={`flex gap-2 text-sm ${unavailable && !checked ? "text-muted-foreground" : ""}`}
    >
      <input
        type="checkbox"
        className="accent-primary"
        checked={checked}
        disabled={Boolean(unavailable) && !checked}
        onChange={onChange}
      />
      {name}
    </label>
  )
  return unavailable ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{label}</span>
      </TooltipTrigger>
      <TooltipContent>
        {unavailable}
        {checked ? " You can remove this linked preset." : ""}
      </TooltipContent>
    </Tooltip>
  ) : (
    label
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
  const inheritedSelections = useMemo(
    () => linkedPresetSelections(access, presetIds, builtinKeys),
    [access, presetIds, builtinKeys]
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
            Preset changes remain linked. Direct permissions add to those
            presets.
          </DialogDescription>
        </DialogHeader>
        <PresetSelections
          access={access}
          scopeType={scope.resourceType}
          disabled={save.isPending}
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
          inheritedSelections={inheritedSelections}
          disabled={save.isPending}
          onChange={setSelections}
          available={access.permissions}
          capabilities={access.supportedCapabilities}
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
            {save.isPending ? "Saving…" : "Save access"}
          </Button>
        </DialogFooter>
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !invite.isPending) onClose()
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
        <fieldset disabled={invite.isPending} className="space-y-4">
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
              disabled={invite.isPending}
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
                loading={resources.isFetching}
                error={resources.error?.message}
                hasPrevious={offset > 0}
                onPrevious={previousResources}
                hasMore={resources.data?.hasMore}
                onMore={nextResources}
              />
            </div>
          ) : null}
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
            {invite.isPending ? "Sending…" : "Send invitations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const InviteTargetEditor = memo(function InviteTargetEditor({
  target,
  disabled = false,
  onChange,
  onRemove,
}: {
  target: InviteDraft
  disabled?: boolean
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
  const inheritedSelections = useMemo(
    () =>
      query.data
        ? linkedPresetSelections(
            query.data,
            target.presetIds,
            target.builtinKeys
          )
        : [],
    [query.data, target.presetIds, target.builtinKeys]
  )
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
        <Button
          disabled={disabled}
          size="sm"
          variant="outline"
          onClick={() => onRemove(target)}
        >
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
            scopeType={target.resourceType}
            disabled={disabled}
            presetIds={target.presetIds}
            builtinKeys={target.builtinKeys}
            onChange={(presetIds, builtinKeys) =>
              onChange({ ...target, presetIds, builtinKeys })
            }
          />
          <PermissionEditor
            scopeType={target.resourceType}
            selections={target.selections}
            inheritedSelections={inheritedSelections}
            disabled={disabled}
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
        expandForCopy(item, scope.resourceType, access.supportedCapabilities)
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
            scopeType={scope.resourceType}
            selections={selections}
            onChange={setSelections}
            available={access.permissions}
            capabilities={access.supportedCapabilities}
            disabled={!editable || save.isPending}
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
                    ...scope,
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

import { expandPermissionSelections as expandForCopySelections } from "@workspace/contracts"
function expandForCopy(
  selection: PermissionSelection,
  scope: ResourceScope["resourceType"],
  capabilities?: ReadonlyArray<string>
) {
  return expandForCopySelections([selection], scope, capabilities)
}
