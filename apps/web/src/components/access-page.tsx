import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  Activity,
  ChevronDown,
  Clock3,
  Database,
  ListFilter,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  ServerPickerList,
  serverPickerOptionKey,
} from "@/components/server-picker-list"
import type { ServerPickerOption } from "@/components/server-picker-list"
import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import type { AccessRole } from "@/lib/permissions"
import { accessRoleDetails, accessRoles, isAccessRole } from "@/lib/permissions"
import {
  accessCapabilitiesQueryOptions,
  accessOverviewQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import {
  getAccessOverview,
  grantOrInviteAccess,
  removeAccessGrant,
  removePlatformAccess,
  revokeAccessInvitation,
  updateAccessGrant,
} from "@/server/access"
import type { getManagedDatabaseDirectory } from "@/server/databases"

type AccessOverview = Awaited<ReturnType<typeof getAccessOverview>>
type AccessGrant = AccessOverview["grants"][number]
type AccessOwner = AccessOverview["owners"][number]
type ManagedDatabaseDirectory = Awaited<
  ReturnType<typeof getManagedDatabaseDirectory>
>
type AccessType = "platform_admin" | "relay_creator" | "scoped"
type PlatformAccessType = Exclude<AccessType, "scoped">
type AccessDirectoryRole = AccessRole | PlatformAccessType
type AccessDirectoryResourceType =
  | "database"
  | "instance"
  | "platform"
  | "relay"

interface AccessAssignmentDraft {
  accessType: AccessType
  role: AccessRole
  targetKey: string
}

interface AccessTarget extends ServerPickerOption {
  databaseId: string | null
  instanceId: string | null
  resourceName: string
}

interface AccessPageInstance {
  id: string
  name: string
  relayId: string
}

interface AccessDirectoryRowBase {
  createdAt: string
  email: string
  key: string
  relayId: string
  relayName: string
  resourceId: string
  resourceName: string
  resourceType: AccessDirectoryResourceType
  role: AccessDirectoryRole
  userId: string
}

interface ScopedAccessDirectoryRow extends AccessDirectoryRowBase {
  accessType: "scoped"
  grant: AccessGrant | null
  instanceId: string | null
  instanceOwner: boolean
  resourceType: "database" | "instance" | "relay"
  role: AccessRole
}

interface PlatformAccessDirectoryRow extends AccessDirectoryRowBase {
  accessType: PlatformAccessType
  grant: null
  instanceId: null
  instanceOwner: false
  resourceType: "platform"
  role: PlatformAccessType
}

type AccessDirectoryRow = PlatformAccessDirectoryRow | ScopedAccessDirectoryRow

interface ScopedRemoveTarget {
  accessType: "scoped"
  email: string
  grantId: string
  relayId: string
  resourceName: string
}

interface PlatformRemoveTarget {
  accessType: PlatformAccessType
  email: string
  userId: string
}

type RemoveTarget = PlatformRemoveTarget | ScopedRemoveTarget

interface AccessFilters {
  relayId: string
  resourceType: "" | AccessDirectoryResourceType
  role: "" | AccessDirectoryRole
}

const emptyAccessFilters: AccessFilters = {
  relayId: "",
  resourceType: "",
  role: "",
}

const invitationExpiryFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
})

export function AccessPage({
  instances,
}: {
  instances: Array<AccessPageInstance>
}) {
  const queryClient = useQueryClient()
  const { data: overview } = useSuspenseQuery(accessOverviewQueryOptions())
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { data: databases } = useSuspenseQuery(
    managedDatabaseDirectoryQueryOptions()
  )
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [addOpen, setAddOpen] = React.useState(false)
  const [editTarget, setEditTarget] =
    React.useState<ScopedAccessDirectoryRow | null>(null)
  const [pendingOpen, setPendingOpen] = React.useState(false)
  const [filters, setFilters] =
    React.useState<AccessFilters>(emptyAccessFilters)
  const [removeTarget, setRemoveTarget] = React.useState<RemoveTarget | null>(
    null
  )
  const ownerRelayIds = React.useMemo(
    () => new Set(overview.ownerRelayIds),
    [overview.ownerRelayIds]
  )
  const targets = React.useMemo(
    () => accessTargets(overview, instances, databases),
    [databases, instances, overview]
  )
  const rows = React.useMemo(
    () => accessDirectoryRows(overview, instances, databases),
    [databases, instances, overview]
  )
  const platformAdminIds = overview.platformUsers.flatMap((platformUser) =>
    platformUser.accessType === "platform_admin" ? [platformUser.id] : []
  )
  const solePlatformAdminId =
    platformAdminIds.length === 1 ? platformAdminIds[0] : undefined
  const filteredRows = React.useMemo(
    () =>
      rows.filter(
        (row) =>
          (!filters.relayId || row.relayId === filters.relayId) &&
          (!filters.resourceType ||
            row.resourceType === filters.resourceType) &&
          (!filters.role || row.role === filters.role)
      ),
    [filters, rows]
  )
  const activeFilterCount =
    Number(Boolean(filters.relayId)) +
    Number(Boolean(filters.resourceType)) +
    Number(Boolean(filters.role))
  const updateFilters = React.useCallback(
    (change: Partial<AccessFilters>) =>
      setFilters((current) => ({ ...current, ...change })),
    []
  )
  const openAddDialog = React.useCallback(() => setAddOpen(true), [])
  const openPendingDialog = React.useCallback(() => setPendingOpen(true), [])
  const completeAddUser = React.useCallback(
    (result: Awaited<ReturnType<typeof grantOrInviteAccess>>) => {
      setAddOpen(false)
      showAccessAssignmentToast(result)
      void invalidateAccessQueries(queryClient)
    },
    [queryClient]
  )
  const completeEditUser = React.useCallback(async () => {
    setEditTarget(null)
    showToast({ message: "Access updated", type: "success" })
    await invalidateAccessQueries(queryClient)
  }, [queryClient])

  const updateGrantMutation = useMutation({
    mutationFn: updateAccessGrant,
    onSuccess: () => invalidateAccessQueries(queryClient),
  })
  const updateGrant = updateGrantMutation.mutateAsync
  const removeGrantMutation = useMutation({
    mutationFn: removeAccessGrant,
    onSuccess: async () => {
      setRemoveTarget(null)
      showToast({ message: "Access removed", type: "success" })
      await invalidateAccessQueries(queryClient)
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "Could not remove access"),
        type: "error",
      }),
  })
  const removePlatformMutation = useMutation({
    mutationFn: removePlatformAccess,
    onSuccess: async () => {
      setRemoveTarget(null)
      showToast({ message: "Platform access removed", type: "success" })
      await invalidateAccessQueries(queryClient)
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "Could not remove platform access"),
        type: "error",
      }),
  })
  const revokeInvitationMutation = useMutation({
    mutationFn: revokeAccessInvitation,
    onSuccess: async () => {
      showToast({ message: "Invitation revoked", type: "success" })
      await invalidateAccessQueries(queryClient)
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "Could not revoke invitation"),
        type: "error",
      }),
  })

  const changeRole = React.useCallback(
    async (grant: AccessGrant, role: AccessRole) => {
      await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            updateGrant({
              data: {
                databaseId:
                  grant.resourceType === "database" ? grant.resourceId : null,
                id: grant.id,
                instanceId:
                  grant.resourceType === "instance" ? grant.resourceId : null,
                relayId: grant.relayId,
                role,
                targetRelayId: grant.relayId,
              },
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() =>
              showToast({
                message: errorMessage(cause, "Could not update access"),
                type: "error",
              })
            )
          )
        )
      )
    },
    [updateGrant]
  )
  const selectRemoveTarget = React.useCallback((row: AccessDirectoryRow) => {
    if (row.accessType !== "scoped") {
      setRemoveTarget({
        accessType: row.accessType,
        email: row.email,
        userId: row.userId,
      })
      return
    }
    if (!row.grant) return
    setRemoveTarget({
      accessType: "scoped",
      email: row.email,
      grantId: row.grant.id,
      relayId: row.relayId,
      resourceName: row.resourceName,
    })
  }, [])
  const changeRowRole = React.useCallback(
    (row: AccessDirectoryRow, role: AccessRole) => {
      if (row.grant) void changeRole(row.grant, role)
    },
    [changeRole]
  )

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pt-4 pb-10 sm:px-5">
      <section
        data-slot="access-workspace"
        className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]"
      >
        <AccessToolbar
          activeFilterCount={activeFilterCount}
          filters={filters}
          invitationCount={overview.invitations.length}
          platformAccessVisible={capabilities.isPlatformAdmin}
          relays={overview.relays}
          searchStore={searchStore}
          onAdd={openAddDialog}
          onFiltersChange={updateFilters}
          onPending={openPendingDialog}
        />
        <AccessDirectoryTable
          filtersActive={activeFilterCount > 0}
          ownerRelayIds={ownerRelayIds}
          solePlatformAdminId={solePlatformAdminId}
          pendingGrantId={
            updateGrantMutation.isPending
              ? updateGrantMutation.variables?.data.id
              : undefined
          }
          rows={filteredRows}
          searchStore={searchStore}
          onEdit={setEditTarget}
          onRemove={selectRemoveTarget}
          onRoleChange={changeRowRole}
        />
      </section>

      {pendingOpen ? (
        <PendingInvitationsDialog
          open
          databases={databases}
          invitations={overview.invitations}
          instances={instances}
          ownerRelayIds={ownerRelayIds}
          pendingId={
            revokeInvitationMutation.isPending
              ? revokeInvitationMutation.variables?.data.id
              : undefined
          }
          onOpenChange={setPendingOpen}
          onRevoke={(id, relayId) => {
            revokeInvitationMutation.mutate({ data: { id, relayId } })
          }}
        />
      ) : null}

      {addOpen ? (
        <AddUserDialog
          open
          canAssignPlatformAccess={capabilities.isPlatformAdmin}
          ownerRelayIds={ownerRelayIds}
          targets={targets}
          onComplete={completeAddUser}
          onOpenChange={setAddOpen}
        />
      ) : null}

      {editTarget ? (
        <EditUserAccessDialog
          open
          ownerRelayIds={ownerRelayIds}
          row={editTarget}
          targets={targets}
          onComplete={completeEditUser}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null)
          }}
        />
      ) : null}

      <RemoveAccessDialog
        pending={
          removeGrantMutation.isPending || removePlatformMutation.isPending
        }
        target={removeTarget}
        onConfirm={(target) => {
          if (target.accessType === "scoped") {
            removeGrantMutation.mutate({
              data: { id: target.grantId, relayId: target.relayId },
            })
            return
          }
          removePlatformMutation.mutate({ data: { userId: target.userId } })
        }}
        onOpenChange={(open) => {
          if (
            !open &&
            !removeGrantMutation.isPending &&
            !removePlatformMutation.isPending
          ) {
            setRemoveTarget(null)
            removeGrantMutation.reset()
            removePlatformMutation.reset()
          }
        }}
      />
    </div>
  )
}

const AccessToolbar = React.memo(function AccessToolbar({
  activeFilterCount,
  filters,
  invitationCount,
  platformAccessVisible,
  relays,
  searchStore,
  onAdd,
  onFiltersChange,
  onPending,
}: {
  activeFilterCount: number
  filters: AccessFilters
  invitationCount: number
  platformAccessVisible: boolean
  relays: AccessOverview["relays"]
  searchStore: WorkspaceTableSearchStore
  onAdd: () => void
  onFiltersChange: (change: Partial<AccessFilters>) => void
  onPending: () => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b bg-background/25 p-3">
      <AccessSyncButton />

      <div className="relative min-w-48 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          aria-label="Search user access"
          className="pl-9 text-base md:text-sm"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search emails or scopes"
          type="search"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <AccessFilterSelect
          ariaLabel="Filter access by role"
          icon={<UserRound />}
          value={filters.role}
          onChange={(role) =>
            onFiltersChange({ role: accessRoleFilterFromValue(role) })
          }
        >
          <SelectItem value={accessFilterAllValue}>
            All roles and types
          </SelectItem>
          {platformAccessVisible ? (
            <>
              <SelectItem value="platform_admin">Platform Admin</SelectItem>
              <SelectItem value="relay_creator">
                Bring Your Own Relays
              </SelectItem>
            </>
          ) : null}
          {accessRoles.map((role) => (
            <SelectItem key={role} value={role}>
              {accessRoleDetails[role].label}
            </SelectItem>
          ))}
        </AccessFilterSelect>

        <AccessFilterSelect
          ariaLabel="Filter access by scope"
          icon={<ListFilter />}
          value={filters.resourceType}
          onChange={(resourceType) =>
            onFiltersChange({
              resourceType: accessResourceFilterFromValue(resourceType),
            })
          }
        >
          <SelectItem value={accessFilterAllValue}>All scopes</SelectItem>
          {platformAccessVisible ? (
            <SelectItem value="platform">Platform</SelectItem>
          ) : null}
          <SelectItem value="relay">Relays</SelectItem>
          <SelectItem value="instance">Servers</SelectItem>
          <SelectItem value="database">Databases</SelectItem>
        </AccessFilterSelect>

        {relays.length > 1 ? (
          <AccessFilterSelect
            ariaLabel="Filter access by Relay"
            icon={<Network />}
            value={filters.relayId}
            onChange={(relayId) => onFiltersChange({ relayId })}
          >
            <SelectItem value={accessFilterAllValue}>All Relays</SelectItem>
            {relays.map((relay) => (
              <SelectItem key={relay.id} value={relay.id}>
                {relay.name}
              </SelectItem>
            ))}
          </AccessFilterSelect>
        ) : null}

        {activeFilterCount > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onFiltersChange(emptyAccessFilters)}
          >
            <X />
            Clear {activeFilterCount}
          </Button>
        ) : null}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-label={`Pending invitations, ${invitationCount}`}
              onClick={onPending}
            >
              <Clock3 />
              <span className="hidden sm:inline">Pending</span>
              <Badge
                variant="outline"
                className="type-meta h-5 min-w-5 justify-center border-border/80 px-1 font-mono"
              >
                {invitationCount}
              </Badge>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Pending invitations</TooltipContent>
        </Tooltip>
        <Button type="button" className="shrink-0" onClick={onAdd}>
          <Plus />
          <span className="hidden sm:inline">Add user</span>
          <span className="sm:hidden">Add</span>
        </Button>
      </div>
    </div>
  )
})

const AccessSyncButton = React.memo(function AccessSyncButton() {
  const queryClient = useQueryClient()
  const syncMutation = useMutation({
    mutationFn: () =>
      queryClient.refetchQueries(
        { exact: true, queryKey: queryKeys.access.overview },
        { throwOnError: true }
      ),
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "Could not sync access"),
        type: "error",
      }),
  })
  const syncing = syncMutation.isPending

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync access"
          aria-busy={syncing}
          disabled={syncing}
          onClick={() => syncMutation.mutate()}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync access
      </TooltipContent>
    </Tooltip>
  )
})

const accessFilterAllValue = "__all__"

function AccessFilterSelect({
  ariaLabel,
  children,
  icon,
  onChange,
  value,
}: {
  ariaLabel: string
  children: React.ReactNode
  icon: React.ReactNode
  onChange: (value: string) => void
  value: string
}) {
  return (
    <Select
      value={value || accessFilterAllValue}
      onValueChange={(nextValue) =>
        onChange(nextValue === accessFilterAllValue ? "" : nextValue)
      }
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={`h-8 min-w-0 gap-1.5 rounded-none px-2 text-xs hover:border-primary/35 hover:bg-accent/70 [&>svg:last-child]:size-3 ${
          value ? "border-primary/35 bg-primary/7" : "border-input/90"
        }`}
      >
        <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-max min-w-(--radix-select-trigger-width)">
        {children}
      </SelectContent>
    </Select>
  )
}

const AccessDirectoryTable = React.memo(function AccessDirectoryTable({
  filtersActive,
  ownerRelayIds,
  pendingGrantId,
  rows,
  searchStore,
  solePlatformAdminId,
  onEdit,
  onRemove,
  onRoleChange,
}: {
  filtersActive: boolean
  ownerRelayIds: ReadonlySet<string>
  pendingGrantId?: string
  rows: Array<AccessDirectoryRow>
  searchStore: WorkspaceTableSearchStore
  solePlatformAdminId?: string
  onEdit: (row: ScopedAccessDirectoryRow) => void
  onRemove: (row: AccessDirectoryRow) => void
  onRoleChange: (row: AccessDirectoryRow, role: AccessRole) => void
}) {
  const renderRow = React.useCallback(
    (row: AccessDirectoryRow) => (
      <AccessDirectoryTableRow
        ownerRelayIds={ownerRelayIds}
        pending={row.grant?.id === pendingGrantId}
        protectedPlatformAdmin={row.userId === solePlatformAdminId}
        row={row}
        onEdit={onEdit}
        onRemove={onRemove}
        onRoleChange={onRoleChange}
      />
    ),
    [
      onEdit,
      onRemove,
      onRoleChange,
      ownerRelayIds,
      pendingGrantId,
      solePlatformAdminId,
    ]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <div className="grid min-h-52 place-items-center px-5 text-center">
        <div>
          <Users className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">
            {searchActive || filtersActive
              ? "No matching access"
              : "No users yet"}
          </p>
          <p className="type-support mt-1 text-muted-foreground">
            {searchActive || filtersActive
              ? "Try another email, scope, Relay, or role."
              : "Add a user to grant platform or scoped access."}
          </p>
        </div>
      </div>
    ),
    [filtersActive]
  )

  return (
    <WorkspaceDataTable
      getRowKey={accessDirectoryRowKey}
      getSearchText={accessDirectorySearchText}
      head={<AccessDirectoryTableHead />}
      items={rows}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const AccessDirectoryTableHead = React.memo(
  function AccessDirectoryTableHead() {
    return (
      <WorkspaceTableHead>
        <WorkspaceTableHeading className="w-auto sm:w-[27%]">
          User
        </WorkspaceTableHeading>
        <WorkspaceTableHeading className="w-[34%] sm:w-[28%]">
          Scope
        </WorkspaceTableHeading>
        <WorkspaceTableHeading className="hidden w-[18%] lg:table-cell">
          Relay
        </WorkspaceTableHeading>
        <WorkspaceTableHeading className="w-28 sm:w-32">
          Role
        </WorkspaceTableHeading>
        <WorkspaceTableHeading className="hidden w-24 xl:table-cell">
          Added
        </WorkspaceTableHeading>
        <WorkspaceTableHeading className="w-20 px-1 text-right sm:w-24 sm:px-3">
          Actions
        </WorkspaceTableHeading>
      </WorkspaceTableHead>
    )
  }
)

const AccessDirectoryTableRow = React.memo(function AccessDirectoryTableRow({
  ownerRelayIds,
  pending,
  protectedPlatformAdmin,
  row,
  onEdit,
  onRemove,
  onRoleChange,
}: {
  ownerRelayIds: ReadonlySet<string>
  pending: boolean
  protectedPlatformAdmin: boolean
  row: AccessDirectoryRow
  onEdit: (row: ScopedAccessDirectoryRow) => void
  onRemove: (row: AccessDirectoryRow) => void
  onRoleChange: (row: AccessDirectoryRow, role: AccessRole) => void
}) {
  if (row.accessType !== "scoped") {
    return (
      <PlatformAccessDirectoryTableRow
        protectedAdmin={protectedPlatformAdmin}
        row={row}
        onRemove={onRemove}
      />
    )
  }
  const ownerActionAllowed =
    row.role !== "owner" || ownerRelayIds.has(row.relayId)
  const canRepairOwnerRole =
    row.instanceOwner &&
    row.grant !== null &&
    row.role !== "owner" &&
    ownerRelayIds.has(row.relayId)
  const roles: ReadonlyArray<AccessRole> = row.instanceOwner
    ? canRepairOwnerRole
      ? [row.role, "owner"]
      : [row.role]
    : rolesForRelay(ownerRelayIds, row.relayId, row.role)
  const roleChangeAllowed =
    row.grant !== null &&
    ownerActionAllowed &&
    (!row.instanceOwner || canRepairOwnerRole)
  const removeAllowed =
    row.grant !== null &&
    ownerActionAllowed &&
    !row.grant.protectedInstanceOwnerGrant
  const editAllowed =
    row.grant !== null &&
    ownerActionAllowed &&
    !row.grant.protectedInstanceOwnerGrant
  const roleSelect = (
    <Select
      disabled={pending || !roleChangeAllowed}
      value={row.role}
      onValueChange={(value) => onRoleChange(row, accessRoleFromValue(value))}
    >
      <SelectTrigger
        aria-label={`Role for ${row.email} on ${row.resourceName}`}
        className="type-control-sm h-8 w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => (
          <SelectItem key={role} value={role}>
            {accessRoleDetails[role].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-muted-foreground">
            <UserRound className="size-3.5" />
          </span>
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-xs font-medium">{row.email}</p>
          </div>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2">
          <ScopeIcon resourceType={row.resourceType} />
          <div className="min-w-0">
            <p className="type-label truncate text-foreground">
              {row.resourceName}
            </p>
            <p className="type-technical-label truncate text-muted-foreground">
              {row.resourceType === "instance" ? "Server" : row.resourceType}
              {row.instanceOwner ? " · owner" : ""}
            </p>
          </div>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <p className="type-meta truncate text-foreground">{row.relayName}</p>
        <p className="type-meta truncate font-mono text-muted-foreground">
          {row.relayId}
        </p>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        {row.instanceOwner && !canRepairOwnerRole ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label="Why this role cannot be changed"
                className="block w-full"
                tabIndex={0}
              >
                {roleSelect}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Transfer ownership before changing this role
            </TooltipContent>
          </Tooltip>
        ) : (
          roleSelect
        )}
      </WorkspaceTableCell>
      <WorkspaceTableCell className="type-meta hidden font-mono text-muted-foreground xl:table-cell">
        <HydratedDate value={row.createdAt} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3">
        <div className="flex items-center justify-end gap-0.5">
          {row.instanceId ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="icon-sm" variant="ghost">
                  <Link
                    aria-label={`View ${row.email} activity`}
                    search={{ server: row.instanceId, user: row.userId }}
                    to="/activity"
                  >
                    <Activity />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">View activity</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Edit access for ${row.email} on ${row.resourceName}`}
                  disabled={pending || !editAllowed}
                  onClick={() => onEdit(row)}
                >
                  <Pencil />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {row.instanceOwner
                ? "Transfer ownership before changing this access"
                : row.grant
                  ? "Edit role and scope"
                  : "Owner access is managed by transfer"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${row.email} from ${row.resourceName}`}
                  disabled={pending || !removeAllowed}
                  onClick={() => onRemove(row)}
                >
                  {pending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {row.instanceOwner
                ? "Transfer ownership before removing"
                : row.grant
                  ? "Remove this access only"
                  : "Owner access is managed by transfer"}
            </TooltipContent>
          </Tooltip>
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

const PlatformAccessDirectoryTableRow = React.memo(
  function PlatformAccessDirectoryTableRow({
    protectedAdmin,
    row,
    onRemove,
  }: {
    protectedAdmin: boolean
    row: PlatformAccessDirectoryRow
    onRemove: (row: AccessDirectoryRow) => void
  }) {
    const label =
      row.accessType === "platform_admin"
        ? "Platform Admin"
        : "Bring Your Own Relays"

    return (
      <tr className="group transition-colors hover:bg-accent/25">
        <WorkspaceTableCell>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-primary/25 bg-primary/10 text-primary">
              <UserRound className="size-3.5" />
            </span>
            <p className="truncate text-xs font-medium">{row.email}</p>
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell>
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-primary/25 bg-primary/10 text-primary">
              <ShieldCheck className="size-3.5" />
            </span>
            <div className="min-w-0">
              <p className="type-label truncate text-foreground">
                {row.resourceName}
              </p>
              <p className="type-technical-label truncate text-muted-foreground">
                Platform
              </p>
            </div>
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell className="hidden lg:table-cell">
          <p className="type-meta truncate text-foreground">
            {row.accessType === "platform_admin" ? "All Relays" : "Own Relays"}
          </p>
          <p className="type-meta truncate font-mono text-muted-foreground">
            —
          </p>
        </WorkspaceTableCell>
        <WorkspaceTableCell>
          <div className="type-label flex h-8 w-full items-center rounded-md border border-primary/25 bg-primary/10 px-3 text-primary">
            {label}
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell className="type-meta hidden font-mono text-muted-foreground xl:table-cell">
          <HydratedDate value={row.createdAt} />
        </WorkspaceTableCell>
        <WorkspaceTableCell className="px-1 sm:px-3">
          <div className="flex items-center justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove platform access for ${row.email}`}
                    disabled={protectedAdmin}
                    onClick={() => onRemove(row)}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {protectedAdmin
                  ? "At least one Platform Admin is required"
                  : "Remove platform access"}
              </TooltipContent>
            </Tooltip>
          </div>
        </WorkspaceTableCell>
      </tr>
    )
  }
)

const AddUserDialog = React.memo(function AddUserDialog({
  open,
  canAssignPlatformAccess,
  ownerRelayIds,
  targets,
  onComplete,
  onOpenChange,
}: {
  open: boolean
  canAssignPlatformAccess: boolean
  ownerRelayIds: ReadonlySet<string>
  targets: Array<AccessTarget>
  onComplete: (result: Awaited<ReturnType<typeof grantOrInviteAccess>>) => void
  onOpenChange: (open: boolean) => void
}) {
  const assignmentRef = React.useRef<AccessAssignmentDraft>({
    accessType: "scoped",
    role: "operator",
    targetKey: targets[0] ? serverPickerOptionKey(targets[0]) : "",
  })
  const mutation = useMutation({
    mutationFn: grantOrInviteAccess,
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "Could not add user access"),
        type: "error",
      }),
    onSuccess: onComplete,
  })

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutation.isPending) return
    const formData = new FormData(event.currentTarget)
    const email = formData.get("email")
    if (typeof email !== "string" || !email) return
    const assignment = assignmentRef.current
    const selectedTarget = targets.find(
      (target) => serverPickerOptionKey(target) === assignment.targetKey
    )
    if (assignment.accessType === "scoped" && !selectedTarget) {
      showToast({ message: "Choose an access scope", type: "error" })
      return
    }
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          mutation.mutateAsync({
            data:
              assignment.accessType === "scoped" && selectedTarget
                ? {
                    accessType: assignment.accessType,
                    databaseId: selectedTarget.databaseId,
                    email,
                    instanceId: selectedTarget.instanceId,
                    relayId: selectedTarget.relayId,
                    resourceName: selectedTarget.resourceName,
                    role: assignment.role,
                  }
                : assignment.accessType === "platform_admin"
                  ? { accessType: "platform_admin", email }
                  : { accessType: "relay_creator", email },
          }),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.void))
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="overflow-visible sm:max-w-xl"
        showCloseButton={!mutation.isPending}
      >
        <DialogHeader>
          <DialogTitle>Add User</DialogTitle>
          <DialogDescription className="sr-only">
            Add a user and choose their access.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <Field label="Email">
            <Input
              autoFocus
              required
              name="email"
              type="email"
              autoComplete="email"
              placeholder="operator@example.com"
            />
          </Field>

          <AccessConfigurationFields
            assignmentRef={assignmentRef}
            canAssignPlatformAccess={canAssignPlatformAccess}
            disabled={mutation.isPending}
            ownerRelayIds={ownerRelayIds}
            targets={targets}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              Add User
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})

const EditUserAccessDialog = React.memo(function EditUserAccessDialog({
  open,
  ownerRelayIds,
  row,
  targets,
  onComplete,
  onOpenChange,
}: {
  open: boolean
  ownerRelayIds: ReadonlySet<string>
  row: ScopedAccessDirectoryRow
  targets: Array<AccessTarget>
  onComplete: () => void | Promise<void>
  onOpenChange: (open: boolean) => void
}) {
  const assignmentRef = React.useRef<AccessAssignmentDraft>({
    accessType: "scoped",
    role: row.role,
    targetKey: accessTargetKey(row, targets),
  })
  const mutation = useMutation({
    mutationFn: updateAccessGrant,
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "Could not update access"),
        type: "error",
      }),
    onSuccess: onComplete,
  })

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutation.isPending || !row.grant) return
    const grant = row.grant
    const assignment = assignmentRef.current
    const selectedTarget = targets.find(
      (target) => serverPickerOptionKey(target) === assignment.targetKey
    )
    if (!selectedTarget) {
      showToast({ message: "Choose an access scope", type: "error" })
      return
    }
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          mutation.mutateAsync({
            data: {
              databaseId: selectedTarget.databaseId,
              id: grant.id,
              instanceId: selectedTarget.instanceId,
              relayId: grant.relayId,
              role: assignment.role,
              targetRelayId: selectedTarget.relayId,
            },
          }),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.void))
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="overflow-visible sm:max-w-xl"
        showCloseButton={!mutation.isPending}
      >
        <DialogHeader>
          <DialogTitle>Edit User Access</DialogTitle>
          <DialogDescription className="sr-only">
            Change this user&apos;s role and access scope.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <Field label="Email">
            <Input
              readOnly
              aria-readonly="true"
              className="bg-muted/30 text-muted-foreground"
              name="email"
              type="email"
              value={row.email}
            />
          </Field>

          <AccessConfigurationFields
            assignmentRef={assignmentRef}
            canAssignPlatformAccess={false}
            disabled={mutation.isPending}
            ownerRelayIds={ownerRelayIds}
            targets={targets}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Pencil />
              )}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})

const AccessConfigurationFields = React.memo(
  function AccessConfigurationFields({
    assignmentRef,
    canAssignPlatformAccess,
    disabled,
    ownerRelayIds,
    targets,
  }: {
    assignmentRef: React.RefObject<AccessAssignmentDraft>
    canAssignPlatformAccess: boolean
    disabled: boolean
    ownerRelayIds: ReadonlySet<string>
    targets: Array<AccessTarget>
  }) {
    const [accessType, setAccessType] = React.useState<AccessType>("scoped")
    const selectAccessType = React.useCallback(
      (nextAccessType: AccessType) => {
        assignmentRef.current.accessType = nextAccessType
        setAccessType(nextAccessType)
      },
      [assignmentRef]
    )

    return (
      <>
        {canAssignPlatformAccess ? (
          <div className="type-label text-muted-foreground">
            <span className="mb-1.5 block">Type</span>
            <AccessTypePicker
              accessType={accessType}
              disabled={disabled}
              onSelect={selectAccessType}
            />
          </div>
        ) : null}

        {accessType === "scoped" ? (
          <ScopedAccessFields
            assignmentRef={assignmentRef}
            disabled={disabled}
            ownerRelayIds={ownerRelayIds}
            targets={targets}
          />
        ) : (
          <PresetAccessField accessType={accessType} />
        )}
      </>
    )
  }
)

const PresetAccessField = React.memo(function PresetAccessField({
  accessType,
}: {
  accessType: Exclude<AccessType, "scoped">
}) {
  return (
    <Field label="Access">
      <div className="type-input flex h-10 w-full items-center rounded-md border border-input/90 bg-input/20 px-3 text-foreground">
        {accessType === "platform_admin" ? "Hearth + all Relays" : "Own Relays"}
      </div>
    </Field>
  )
})

interface AccessRoleFieldHandle {
  setRole: (role: AccessRole) => void
}

const AccessRoleField = React.memo(
  React.forwardRef<
    AccessRoleFieldHandle,
    {
      disabled: boolean
      initialRole: AccessRole
      onRoleChange: (role: AccessRole) => void
      roles: ReadonlyArray<AccessRole>
    }
  >(function AccessRoleField(
    { disabled, initialRole, onRoleChange, roles },
    ref
  ) {
    const [role, setRole] = React.useState(initialRole)
    React.useImperativeHandle(ref, () => ({ setRole }), [])

    const updateRole = React.useCallback(
      (value: string) => {
        const nextRole = accessRoleFromValue(value)
        setRole(nextRole)
        onRoleChange(nextRole)
      },
      [onRoleChange]
    )

    return (
      <Field label="Role">
        <Select disabled={disabled} value={role} onValueChange={updateRole}>
          <SelectTrigger aria-label="Role" className="h-10 w-full px-3 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[70]">
            {roles.map((accessRole) => (
              <SelectItem key={accessRole} value={accessRole}>
                {accessRoleDetails[accessRole].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    )
  })
)

const AccessScopeField = React.memo(function AccessScopeField({
  disabled,
  onSelect,
  selectedTarget,
  targetKey,
  targets,
}: {
  disabled: boolean
  onSelect: (option: ServerPickerOption) => void
  selectedTarget: AccessTarget | undefined
  targetKey: string
  targets: Array<AccessTarget>
}) {
  const [open, setOpen] = React.useState(false)
  const selectedKeys = React.useMemo(
    () => new Set(targetKey ? [targetKey] : []),
    [targetKey]
  )
  const selectTarget = React.useCallback(
    (option: ServerPickerOption) => {
      onSelect(option)
      setOpen(false)
    },
    [onSelect]
  )

  return (
    <Field label="Access">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full justify-between px-3 text-left"
            disabled={disabled}
          >
            {selectedTarget ? (
              <span className="flex min-w-0 items-center gap-2.5">
                <ScopeIcon
                  resourceType={
                    selectedTarget.kind === "server"
                      ? "instance"
                      : (selectedTarget.kind ?? "relay")
                  }
                />
                <span className="min-w-0 truncate text-xs font-semibold">
                  {selectedTarget.name}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">Choose scope</span>
            )}
            <ChevronDown className="ml-3 size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="z-[70] w-[min(34rem,calc(100vw-3rem))] p-1.5"
        >
          <ServerPickerList
            ariaLabel="Access scopes"
            emptyMessage="No matching Relays, servers, or databases."
            multiple={false}
            searchPlaceholder="Search by server, Relay, database, or ID"
            selectedKeys={selectedKeys}
            servers={targets}
            onSelect={selectTarget}
          />
        </PopoverContent>
      </Popover>
    </Field>
  )
})

const ScopedAccessFields = React.memo(function ScopedAccessFields({
  assignmentRef,
  disabled,
  ownerRelayIds,
  targets,
}: {
  assignmentRef: React.RefObject<AccessAssignmentDraft>
  disabled: boolean
  ownerRelayIds: ReadonlySet<string>
  targets: Array<AccessTarget>
}) {
  const [targetKey, setTargetKey] = React.useState(
    assignmentRef.current.targetKey
  )
  const roleFieldRef = React.useRef<AccessRoleFieldHandle>(null)
  const selectedTarget = targets.find(
    (target) => serverPickerOptionKey(target) === targetKey
  )
  const assignableRoles = React.useMemo(
    () =>
      selectedTarget
        ? rolesForRelay(ownerRelayIds, selectedTarget.relayId)
        : accessRoles.filter((accessRole) => accessRole !== "owner"),
    [ownerRelayIds, selectedTarget]
  )
  const selectTarget = React.useCallback(
    (option: ServerPickerOption) => {
      const nextKey = serverPickerOptionKey(option)
      const nextTarget = targets.find(
        (target) => serverPickerOptionKey(target) === nextKey
      )
      assignmentRef.current.targetKey = nextKey
      setTargetKey(nextKey)
      if (
        assignmentRef.current.role === "owner" &&
        nextTarget &&
        !ownerRelayIds.has(nextTarget.relayId)
      ) {
        assignmentRef.current.role = "operator"
        roleFieldRef.current?.setRole("operator")
      }
    },
    [assignmentRef, ownerRelayIds, targets]
  )
  const updateRole = React.useCallback(
    (role: AccessRole) => {
      assignmentRef.current.role = role
    },
    [assignmentRef]
  )

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
      <AccessScopeField
        disabled={disabled}
        onSelect={selectTarget}
        selectedTarget={selectedTarget}
        targetKey={targetKey}
        targets={targets}
      />
      <AccessRoleField
        ref={roleFieldRef}
        disabled={disabled}
        initialRole={assignmentRef.current.role}
        onRoleChange={updateRole}
        roles={assignableRoles}
      />
    </div>
  )
})

const accessTypeOptions = [
  {
    label: "Platform Admin",
    value: "platform_admin",
  },
  {
    label: "Bring Your Own Relays",
    value: "relay_creator",
  },
  {
    label: "Scoped Access",
    value: "scoped",
  },
] as const

const AccessTypePicker = React.memo(function AccessTypePicker({
  accessType,
  disabled,
  onSelect,
}: {
  accessType: AccessType
  disabled: boolean
  onSelect: (accessType: AccessType) => void
}) {
  return (
    <div
      className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/30 p-1"
      role="group"
      aria-label="Access type"
    >
      {accessTypeOptions.map((option) => (
        <AccessTypeOption
          key={option.value}
          disabled={disabled}
          option={option}
          selected={accessType === option.value}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
})

const AccessTypeOption = React.memo(function AccessTypeOption({
  disabled,
  onSelect,
  option,
  selected,
}: {
  disabled: boolean
  onSelect: (accessType: AccessType) => void
  option: (typeof accessTypeOptions)[number]
  selected: boolean
}) {
  return (
    <button
      aria-pressed={selected}
      className={`type-label min-h-10 rounded-md px-2 py-1.5 text-center transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none ${
        selected
          ? "bg-primary/15 text-primary shadow-sm ring-1 ring-primary/35"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
      } disabled:pointer-events-none disabled:opacity-45`}
      disabled={disabled}
      type="button"
      onClick={() => onSelect(option.value)}
    >
      {option.label}
    </button>
  )
})

function RemoveAccessDialog({
  pending,
  target,
  onConfirm,
  onOpenChange,
}: {
  pending: boolean
  target: RemoveTarget | null
  onConfirm: (target: RemoveTarget) => void
  onOpenChange: (open: boolean) => void
}) {
  const platformTarget = target?.accessType !== "scoped" ? target : null
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {platformTarget ? "Remove platform access?" : "Remove this access?"}
          </DialogTitle>
          <DialogDescription>
            {platformTarget ? (
              platformTarget.accessType === "platform_admin" ? (
                <>
                  {platformTarget.email} will lose access to Hearth and all
                  Relays. Existing server ownership remains.
                </>
              ) : (
                <>
                  {platformTarget.email} will no longer be able to add or manage
                  Relays. Existing scoped access remains.
                </>
              )
            ) : (
              <>
                {target?.email ?? "This user"} will lose access to{" "}
                {target?.accessType === "scoped"
                  ? target.resourceName
                  : "this scope"}
                . Their Kiln account and all other server or Relay access will
                remain intact.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!target || pending}
            onClick={() => {
              if (!target) return
              onConfirm(target)
            }}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Remove access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PendingInvitationsDialog({
  databases,
  invitations,
  instances,
  open,
  ownerRelayIds,
  pendingId,
  onOpenChange,
  onRevoke,
}: {
  databases: ManagedDatabaseDirectory
  invitations: AccessOverview["invitations"]
  instances: Array<AccessPageInstance>
  open: boolean
  ownerRelayIds: ReadonlySet<string>
  pendingId?: string
  onOpenChange: (open: boolean) => void
  onRevoke: (id: string, relayId: string | null) => void
}) {
  const titleRef = React.useRef<HTMLHeadingElement>(null)
  const instanceNames = React.useMemo(
    () =>
      new Map(
        instances.map((instance) => [
          accessResourceKey(instance.relayId, instance.id),
          instance.name,
        ])
      ),
    [instances]
  )
  const databaseNames = React.useMemo(
    () =>
      new Map(
        databases.map((database) => [
          accessResourceKey(database.relayId, database.id),
          database.name,
        ])
      ),
    [databases]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={titleRef}
        className="max-h-[calc(100vh-2rem)] overflow-hidden sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1}>
            Pending invitations
          </DialogTitle>
          <DialogDescription>
            Invitations expire after seven days. Accounts are created only after
            the recipient accepts.
          </DialogDescription>
        </DialogHeader>

        {invitations.length > 0 ? (
          <div className="max-h-[min(32rem,60vh)] overflow-auto rounded-lg border">
            <table className="w-full min-w-[40rem] table-fixed border-collapse text-left">
              <WorkspaceTableHead>
                <WorkspaceTableHeading className="w-[31%]">
                  Email
                </WorkspaceTableHeading>
                <WorkspaceTableHeading className="w-[31%]">
                  Scope
                </WorkspaceTableHeading>
                <WorkspaceTableHeading className="w-28">
                  Role
                </WorkspaceTableHeading>
                <WorkspaceTableHeading className="w-28">
                  Expires
                </WorkspaceTableHeading>
                <WorkspaceTableHeading className="w-20 text-right">
                  Actions
                </WorkspaceTableHeading>
              </WorkspaceTableHead>
              <tbody className="divide-y divide-border/70">
                {invitations.map((invitation) => {
                  const instanceName = invitation.instanceId
                    ? instanceNames.get(
                        accessResourceKey(
                          invitation.relayId,
                          invitation.instanceId
                        )
                      )
                    : undefined
                  const databaseName = invitation.databaseId
                    ? databaseNames.get(
                        accessResourceKey(
                          invitation.relayId,
                          invitation.databaseId
                        )
                      )
                    : undefined
                  const resourceName =
                    databaseName ?? instanceName ?? invitation.relayName
                  const platformInvitation = invitation.accessType !== "scoped"
                  const invitationRole =
                    invitation.accessType === "platform_admin"
                      ? "Platform Admin"
                      : invitation.accessType === "relay_creator"
                        ? "Bring Your Own Relays"
                        : invitation.role
                  return (
                    <tr key={invitation.id} className="hover:bg-accent/25">
                      <WorkspaceTableCell>
                        <p className="truncate text-xs font-medium">
                          {invitation.email}
                        </p>
                      </WorkspaceTableCell>
                      <WorkspaceTableCell>
                        <p className="type-meta truncate">{resourceName}</p>
                        <p className="type-technical-label text-muted-foreground">
                          {platformInvitation
                            ? "Platform"
                            : databaseName
                              ? "Database"
                              : instanceName
                                ? "Server"
                                : "Relay"}
                        </p>
                      </WorkspaceTableCell>
                      <WorkspaceTableCell>
                        <Badge
                          variant="outline"
                          className="type-meta font-mono capitalize"
                        >
                          {invitationRole}
                        </Badge>
                      </WorkspaceTableCell>
                      <WorkspaceTableCell className="type-meta font-mono text-muted-foreground">
                        <HydratedDate value={invitation.expiresAt} />
                      </WorkspaceTableCell>
                      <WorkspaceTableCell>
                        <div className="flex justify-end">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Revoke invitation for ${invitation.email}`}
                                  disabled={
                                    pendingId !== undefined ||
                                    (invitation.role === "owner" &&
                                      invitation.relayId !== null &&
                                      !ownerRelayIds.has(invitation.relayId))
                                  }
                                  onClick={() =>
                                    onRevoke(invitation.id, invitation.relayId)
                                  }
                                >
                                  {pendingId === invitation.id ? (
                                    <LoaderCircle className="animate-spin" />
                                  ) : (
                                    <Trash2 />
                                  )}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                              {invitation.role === "owner" &&
                              invitation.relayId !== null &&
                              !ownerRelayIds.has(invitation.relayId)
                                ? "Only a Relay owner can revoke this invitation"
                                : "Revoke invitation"}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </WorkspaceTableCell>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid min-h-48 place-items-center rounded-lg border border-dashed bg-muted/10 px-5 text-center">
            <div>
              <Clock3 className="mx-auto size-5 text-muted-foreground" />
              <p className="mt-3 text-sm font-semibold">
                No pending invitations
              </p>
              <p className="type-support mt-1 text-muted-foreground">
                New invitations will appear here until they are accepted or
                revoked.
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ScopeIcon({
  resourceType,
}: {
  resourceType: "database" | "instance" | "relay"
}) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-muted-foreground">
      {resourceType === "relay" ? (
        <Network className="size-3.5" />
      ) : resourceType === "database" ? (
        <Database className="size-3.5" />
      ) : (
        <Server className="size-3.5" />
      )}
    </span>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="type-label block text-muted-foreground">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  )
}

function HydratedDate({ value }: { value: string }) {
  return React.useSyncExternalStore(
    subscribeToBrowserLocale,
    () => invitationExpiryFormatter.format(new Date(value)),
    () => "—"
  )
}

function accessTargetKey(
  row: ScopedAccessDirectoryRow,
  targets: Array<AccessTarget>
): string {
  const targetKind =
    row.resourceType === "instance" ? "server" : row.resourceType
  const target = targets.find(
    (candidate) =>
      candidate.kind === targetKind &&
      candidate.relayId === row.relayId &&
      candidate.id === row.resourceId
  )
  return target ? serverPickerOptionKey(target) : ""
}

function accessTargets(
  overview: AccessOverview,
  instances: Array<AccessPageInstance>,
  databases: ManagedDatabaseDirectory
): Array<AccessTarget> {
  const instancesByRelay = new Map<string, Array<AccessPageInstance>>()
  for (const instance of instances) {
    const relayInstances = instancesByRelay.get(instance.relayId) ?? []
    relayInstances.push(instance)
    instancesByRelay.set(instance.relayId, relayInstances)
  }
  const databasesByRelay = new Map<
    string,
    Array<ManagedDatabaseDirectory[number]>
  >()
  for (const database of databases) {
    const relayDatabases = databasesByRelay.get(database.relayId) ?? []
    relayDatabases.push(database)
    databasesByRelay.set(database.relayId, relayDatabases)
  }

  return overview.relays.flatMap((relay) => [
    {
      databaseId: null,
      description: "Every server and database on this Relay",
      id: relay.id,
      instanceId: null,
      kind: "relay",
      name: relay.name,
      relayId: relay.id,
      relayName: relay.name,
      resourceName: relay.name,
    },
    ...(instancesByRelay.get(relay.id) ?? []).map(
      (instance) =>
        ({
          databaseId: null,
          description: `${relay.name} · ${instance.id}`,
          id: instance.id,
          instanceId: instance.id,
          kind: "server",
          name: instance.name,
          relayId: relay.id,
          relayName: relay.name,
          resourceName: instance.name,
        }) satisfies AccessTarget
    ),
    ...(databasesByRelay.get(relay.id) ?? []).map(
      (database) =>
        ({
          databaseId: database.id,
          description: `${relay.name} · ${database.id}`,
          id: database.id,
          instanceId: null,
          kind: "database",
          name: database.name,
          relayId: relay.id,
          relayName: relay.name,
          resourceName: database.name,
        }) satisfies AccessTarget
    ),
  ])
}

function accessDirectoryRows(
  overview: AccessOverview,
  instances: Array<AccessPageInstance>,
  databases: ManagedDatabaseDirectory
): Array<AccessDirectoryRow> {
  const instanceNames = new Map(
    instances.map((instance) => [
      accessResourceKey(instance.relayId, instance.id),
      instance.name,
    ])
  )
  const databaseNames = new Map(
    databases.map((database) => [
      accessResourceKey(database.relayId, database.id),
      database.name,
    ])
  )
  const directOwnerKeys = new Set(
    overview.grants.flatMap((grant) =>
      grant.resourceType === "instance"
        ? [`${grant.relayId}:${grant.resourceId}:${grant.userId}`]
        : []
    )
  )
  const grantRows = overview.grants.map((grant) =>
    accessGrantDirectoryRow(grant, instanceNames, databaseNames)
  )
  const ownerRows = overview.owners.flatMap((owner) =>
    directOwnerKeys.has(`${owner.relayId}:${owner.instanceId}:${owner.userId}`)
      ? []
      : [accessOwnerDirectoryRow(owner, instanceNames)]
  )
  const platformRows = overview.platformUsers.map(platformAccessDirectoryRow)
  return [...platformRows, ...grantRows, ...ownerRows].sort((left, right) =>
    `${left.email}\u0000${left.resourceName}`.localeCompare(
      `${right.email}\u0000${right.resourceName}`
    )
  )
}

function accessGrantDirectoryRow(
  grant: AccessGrant,
  instanceNames: ReadonlyMap<string, string>,
  databaseNames: ReadonlyMap<string, string>
): AccessDirectoryRow {
  const resourceKey = accessResourceKey(grant.relayId, grant.resourceId)
  return {
    accessType: "scoped",
    createdAt: grant.createdAt,
    email: grant.email,
    grant,
    instanceId: grant.resourceType === "instance" ? grant.resourceId : null,
    instanceOwner: grant.instanceOwner,
    key: `grant:${grant.id}`,
    relayId: grant.relayId,
    relayName: grant.relayName,
    resourceId: grant.resourceId,
    resourceName:
      grant.resourceType === "relay"
        ? grant.relayName
        : (databaseNames.get(resourceKey) ??
          instanceNames.get(resourceKey) ??
          grant.resourceId),
    resourceType: grant.resourceType,
    role: grant.role,
    userId: grant.userId,
  }
}

function accessOwnerDirectoryRow(
  owner: AccessOwner,
  instanceNames: ReadonlyMap<string, string>
): AccessDirectoryRow {
  return {
    accessType: "scoped",
    createdAt: owner.createdAt,
    email: owner.email,
    grant: null,
    instanceId: owner.instanceId,
    instanceOwner: true,
    key: `owner:${owner.relayId}:${owner.instanceId}:${owner.userId}`,
    relayId: owner.relayId,
    relayName: owner.relayName,
    resourceId: owner.instanceId,
    resourceName:
      instanceNames.get(accessResourceKey(owner.relayId, owner.instanceId)) ??
      owner.instanceId,
    resourceType: "instance",
    role: "owner",
    userId: owner.userId,
  }
}

function platformAccessDirectoryRow(
  platformUser: AccessOverview["platformUsers"][number]
): PlatformAccessDirectoryRow {
  return {
    accessType: platformUser.accessType,
    createdAt: platformUser.createdAt,
    email: platformUser.email,
    grant: null,
    instanceId: null,
    instanceOwner: false,
    key: `platform:${platformUser.id}`,
    relayId: "",
    relayName: "",
    resourceId: platformUser.accessType,
    resourceName:
      platformUser.accessType === "platform_admin"
        ? "Hearth + all Relays"
        : "Own Relays",
    resourceType: "platform",
    role: platformUser.accessType,
    userId: platformUser.id,
  }
}

function accessResourceKey(relayId: string, resourceId: string): string {
  return `${relayId}:${resourceId}`
}

function accessDirectoryRowKey(row: AccessDirectoryRow): string {
  return row.key
}

function accessDirectorySearchText(row: AccessDirectoryRow): string {
  const roleLabel =
    row.role === "platform_admin"
      ? "Platform Admin"
      : row.role === "relay_creator"
        ? "Bring Your Own Relays"
        : accessRoleDetails[row.role].label
  return `${row.email} ${row.resourceName} ${row.resourceId} ${row.resourceType} ${row.relayName} ${row.relayId} ${roleLabel}`
}

function showAccessAssignmentToast(
  result: Awaited<ReturnType<typeof grantOrInviteAccess>>
): void {
  if (result.kind === "granted") {
    const notificationDescription = {
      disabled: "Email delivery is disabled; no notification was sent.",
      failed:
        "Access was granted, but the notification email could not be sent.",
      sent: "A notification email was sent.",
    } satisfies Record<typeof result.notificationStatus, string>
    showToast({
      description: notificationDescription[result.notificationStatus],
      message: `${result.email} now has access`,
      type: "success",
    })
    return
  }

  if (!result.inviteUrl) {
    showToast({ message: "Invitation sent", type: "success" })
    return
  }

  const invitationUrl = result.inviteUrl
  showToast({
    action: {
      label: "Copy link",
      onClick: () => {
        void Effect.runPromise(
          Effect.tryPromise({
            try: () => navigator.clipboard.writeText(invitationUrl),
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: () =>
                showToast({
                  message: "Could not copy the invitation link",
                  type: "error",
                }),
              onSuccess: () =>
                showToast({
                  message: "Invitation link copied",
                  type: "success",
                }),
            })
          )
        )
      },
    },
    description: "Email delivery is disabled locally.",
    duration: Infinity,
    message: "Invitation created",
    type: "success",
  })
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function accessRoleFromValue(value: string): AccessRole {
  return isAccessRole(value) ? value : "viewer"
}

function accessRoleFilterFromValue(value: string): AccessFilters["role"] {
  return isAccessRole(value) ||
    value === "platform_admin" ||
    value === "relay_creator"
    ? value
    : ""
}

function accessResourceFilterFromValue(
  value: string
): AccessFilters["resourceType"] {
  return value === "database" ||
    value === "instance" ||
    value === "platform" ||
    value === "relay"
    ? value
    : ""
}

function rolesForRelay(
  ownerRelayIds: ReadonlySet<string>,
  relayId: string,
  currentRole?: AccessRole
): ReadonlyArray<AccessRole> {
  return ownerRelayIds.has(relayId) || currentRole === "owner"
    ? accessRoles
    : accessRoles.filter((role) => role !== "owner")
}

function subscribeToBrowserLocale(): () => void {
  return () => undefined
}

function invalidateAccessQueries(
  queryClient: ReturnType<typeof useQueryClient>
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.access.overview }),
    queryClient.invalidateQueries({ queryKey: queryKeys.access.capabilities }),
    queryClient.invalidateQueries({ queryKey: ["access", "instances"] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.databases.directory }),
  ])
}
