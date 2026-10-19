import {
  createContext,
  memo,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  Activity,
  ArrowRightLeft,
  EllipsisVertical,
  KeyRound,
  MailCheck,
  Plus,
  Shield,
  Trash2,
  Users,
} from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { Dialog } from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { utcTimestamp } from "@/components/access-format"
import { DataTable } from "@/components/data-table-view"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableTextCell,
} from "@/components/data-table"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { PermissionDialogContent } from "@/components/permission-dialog"
import {
  PermissionEditor,
  type PermissionTarget,
} from "@/components/permission-editor"
import {
  UserActionButton,
  UserProfilesContext,
  UserRowIdentity,
} from "@/components/user-table-parts"
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
import type { getResourceAccess } from "@/server/resource-access"
import { getUserMinecraftProfiles } from "@/server/users"

export type ScopeAccess = Awaited<ReturnType<typeof getResourceAccess>>
export type Person = ScopeAccess["people"][number]
export type Preset = ScopeAccess["presets"][number]
type DefaultPreset = ScopeAccess["defaults"][number]
const personHelper = createDataTableColumnHelper<Person>()

// The accept-for-user mutation only disables one dropdown item, so it is read
// from context instead of a prop: a pending accept must not rebuild the column
// definitions and re-render every row behind the open menu.
export const AcceptingInvitationContext = createContext(false)

interface PeopleProps {
  searchStore: DataTableSearchStore
  access?: ScopeAccess
  source: DataTableSource<Person>
  onEdit: (person: Person) => void
  onTransfer: (person: Person) => void
  onRevoke: (person: Person) => void
  onAccept: (person: Person) => void
  onInvite: () => void
}
type PersonHandlers = Pick<
  PeopleProps,
  "access" | "onEdit" | "onTransfer" | "onRevoke" | "onAccept"
> & { onView: (person: Person) => void }

const NO_PROFILES: Record<string, string> = {}

export const ResourcePeopleTable = memo(function ResourcePeopleTable({
  access,
  source,
  onInvite,
  searchStore,
  onEdit,
  onTransfer,
  onRevoke,
  onAccept,
}: PeopleProps) {
  const search = useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getNormalizedSnapshot,
    searchStore.getNormalizedServerSnapshot
  )
  const [viewing, setViewing] = useState<Person | null>(null)
  const scope = access?.scope
  const userIds = useMemo(
    () => [
      ...new Set(
        source.rows.flatMap((person) => (person.userId ? [person.userId] : []))
      ),
    ],
    [source.rows]
  )
  const profiles = useQuery({
    queryKey: [
      "users",
      "minecraft-profiles",
      scope?.relayId,
      scope?.resourceType,
      scope?.resourceId,
      userIds.join(","),
    ],
    queryFn: () =>
      getUserMinecraftProfiles({
        data: { userIds: userIds.slice(0, 100), scope: scope! },
      }),
    enabled: !!scope && userIds.length > 0,
    staleTime: 60 * 60_000,
  })
  const definition = useMemo(() => {
    const names = new Map([
      ...(access?.defaults.map(
        (preset) => [preset.key, preset.name] as const
      ) ?? []),
      ...(access?.presets.map((preset) => [preset.id, preset.name] as const) ??
        []),
    ])
    const handlers: PersonHandlers = {
      access,
      onEdit,
      onTransfer,
      onRevoke,
      onAccept,
      onView: setViewing,
    }
    return defineDataTable({
      ariaLabel: "Resource users",
      columns: personHelper.columns([
        personHelper.accessor("name", {
          header: "User",
          sortFn: "text",
          cell: ({ row }) => (
            <PersonIdentity person={row.original} {...handlers} />
          ),
          meta: dataTableColumnMeta({ width: "minmax(0,1.4fr)" }),
        }),
        personHelper.accessor((person) => personStatus(person), {
          id: "status",
          header: "Access",
          sortFn: "text",
          cell: ({ row }) => (
            <div className="min-w-0">
              <Badge variant="outline">{personStatus(row.original)}</Badge>
            </div>
          ),
          meta: dataTableColumnMeta({ hideBelow: "sm", width: "11rem" }),
        }),
        personHelper.display({
          id: "presets",
          header: "Presets",
          cell: ({ row }) => (
            <DataTableTextCell
              value={
                [
                  ...row.original.builtinKeys.map(
                    (key) => names.get(key) ?? key
                  ),
                  ...row.original.presetIds.map(
                    (id) => names.get(id) ?? "Relay preset"
                  ),
                  ...(row.original.selections.length
                    ? ["Custom permissions"]
                    : []),
                ].join(", ") || "None"
              }
            />
          ),
          meta: dataTableColumnMeta({
            hideBelow: "md",
            width: "minmax(9rem,1fr)",
          }),
        }),
        personHelper.accessor("updatedAt", {
          header: "Updated",
          sortFn: "text",
          cell: ({ row }) => (
            <DataTableTextCell value={utcTimestamp(row.original.updatedAt)} />
          ),
          meta: dataTableColumnMeta({ hideBelow: "xl", width: "12rem" }),
        }),
        personHelper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          enableSorting: false,
          cell: ({ row }) => (
            <PersonActions person={row.original} {...handlers} />
          ),
          // Above the row's open button, so a near miss on an action doesn't
          // open the person instead.
          meta: dataTableColumnMeta(
            { width: { base: "7.25rem" } },
            { cellClassName: "relative z-10 px-2" }
          ),
        }),
      ]),
      getRowId: (person) => person.id,
      getRowClassName: () => "relative cursor-pointer",
    })
  }, [access, onEdit, onTransfer, onRevoke, onAccept])
  return (
    <DataTableWorkspace
      toolbar={
        <DataTableToolbar
          search={{
            ariaLabel: "Search resource users",
            placeholder: "Search users",
            store: searchStore,
          }}
          leading={
            access?.owner ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="max-w-40 truncate text-xs text-muted-foreground">
                    Owner: {access.owner.name}
                  </span>
                </TooltipTrigger>
                <TooltipContent>Owner: {access.owner.name}</TooltipContent>
              </Tooltip>
            ) : null
          }
          actions={
            access?.canInvite ? (
              <Button aria-label="Add user" onClick={onInvite}>
                <Plus />
                <span className="hidden sm:inline">Add user</span>
              </Button>
            ) : null
          }
        />
      }
    >
      <UserProfilesContext.Provider value={profiles.data ?? NO_PROFILES}>
        <DataTable
          definition={definition}
          source={source}
          emptyState={
            <DataTableEmptyState
              icon={<Users className="size-6 text-muted-foreground/45" />}
              title={
                search ? "No users match your search" : "No additional users"
              }
              description={
                search
                  ? "Try a name or email address."
                  : "Invite someone to share access to this resource."
              }
            />
          }
        />
      </UserProfilesContext.Provider>
      {viewing ? (
        <PersonPermissionsDialog
          person={viewing}
          access={access}
          viewing
          onOpenChange={(open) => {
            if (!open) setViewing(null)
          }}
        />
      ) : null}
    </DataTableWorkspace>
  )
})

const canEditPerson = (person: Person, access?: ScopeAccess) =>
  !!access?.canManage && !person.inherited && !person.isOwner

const PersonIdentity = memo(function PersonIdentity({
  person,
  access,
  onEdit,
  onView,
}: PersonHandlers & { person: Person }) {
  const canEdit = canEditPerson(person, access)
  return (
    <UserRowIdentity
      userId={person.userId}
      name={person.name}
      email={person.email}
      openLabel={`${canEdit ? "Edit" : "View"} access for ${person.name}`}
      onOpen={() => (canEdit ? onEdit(person) : onView(person))}
      accessory={
        <Badge variant="outline" className="h-4 px-1 text-[10px] sm:hidden">
          {personStatus(person)}
        </Badge>
      }
    />
  )
})

const PersonActions = memo(function PersonActions({
  person,
  access,
  onEdit,
  onView,
  onTransfer,
  onRevoke,
  onAccept,
}: PersonHandlers & { person: Person }) {
  const accepting = useContext(AcceptingInvitationContext)
  const canEdit = canEditPerson(person, access)
  const canAccept = !!person.invitationId && !!access?.isPlatformAdmin
  return (
    <DataTableActionGroup>
      {canAccept ? (
        <UserActionButton
          icon={MailCheck}
          tone="success"
          label={`Accept invitation for ${person.name}`}
          tooltip="Accept invitation for them"
          disabled={accepting}
          onClick={() => onAccept(person)}
        />
      ) : null}
      {canEdit ? (
        <UserActionButton
          icon={Trash2}
          tone="danger"
          label={`Revoke access for ${person.name}`}
          tooltip={
            person.state === "pending" ? "Cancel invitation" : "Revoke access"
          }
          onClick={() => onRevoke(person)}
        />
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`More actions for ${person.name}`}
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem
            onSelect={() => (canEdit ? onEdit(person) : onView(person))}
          >
            <KeyRound />
            {canEdit ? "Edit permissions" : "View permissions"}
          </DropdownMenuItem>
          {person.userId &&
          access?.scope.resourceType !== "database" &&
          access?.permissions.includes("instance.read") ? (
            <DropdownMenuItem asChild>
              <Link
                to="/activity"
                search={{
                  user: person.userId,
                  relay: access.scope.relayId,
                  ...(access.scope.resourceType === "instance"
                    ? { server: access.scope.resourceId }
                    : {}),
                }}
              >
                <Activity /> View activity
              </Link>
            </DropdownMenuItem>
          ) : null}
          {canAccept ? (
            <DropdownMenuItem
              disabled={accepting}
              onSelect={() => onAccept(person)}
            >
              <MailCheck /> Accept invitation
            </DropdownMenuItem>
          ) : null}
          {access?.canTransferOwnership &&
          !person.isOwner &&
          !person.inherited &&
          person.state === "active" ? (
            <DropdownMenuItem onSelect={() => onTransfer(person)}>
              <ArrowRightLeft /> Transfer ownership
            </DropdownMenuItem>
          ) : null}
          {person.invitationId ? (
            <CopyIdentifierMenuItem
              label="Invitation Link"
              value={new URL(
                `/invite?id=${encodeURIComponent(person.invitationId)}`,
                window.location.origin
              ).toString()}
            />
          ) : null}
          <CopyIdentifierMenuItem label="Email" value={person.email} />
          {person.userId ? (
            <CopyIdentifierMenuItem label="User ID" value={person.userId} />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

function PersonPermissionsDialog({
  person,
  access,
  viewing,
  onOpenChange,
}: {
  person: Person
  access?: ScopeAccess
  viewing: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={viewing} onOpenChange={onOpenChange}>
      {access ? (
        <PermissionDialogContent
          title={`${person.name} permissions`}
          description={
            person.inherited
              ? "These permissions are inherited from the Relay."
              : "Effective permissions from this assignment and its linked presets."
          }
          footer={
            <Button
              variant="outline"
              className="sm:ml-auto"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          }
        >
          <PermissionEditor targets={personTargets(person, access)} presets />
        </PermissionDialogContent>
      ) : null}
    </Dialog>
  )
}

interface PresetRow {
  id: string
  name: string
  builtin: DefaultPreset | null
  custom: Preset | null
}
const presetHelper = createDataTableColumnHelper<PresetRow>()
interface PresetsProps {
  access?: ScopeAccess
  error: Error | null
  loading: boolean
  refreshing: boolean
  onRetry: () => void
  onEdit: (preset: Preset) => void
  onDelete: (preset: Preset) => void
  onCreate: () => void
}
export const ResourcePresetsTable = memo(function ResourcePresetsTable({
  access,
  error,
  loading,
  refreshing,
  onRetry,
  onEdit,
  onDelete,
  onCreate,
}: PresetsProps) {
  const [searchStore] = useState(() => createDataTableSearchStore())
  const rows = useMemo<Array<PresetRow>>(
    () => [
      ...(access?.defaults.map((preset) => ({
        id: `builtin:${preset.key}`,
        name: preset.name,
        builtin: preset,
        custom: null,
      })) ?? []),
      ...(access?.presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        builtin: null,
        custom: preset,
      })) ?? []),
    ],
    [access?.defaults, access?.presets]
  )
  // Presets load from their own request, so people-table pagination and search
  // no longer flash this table through a loading state it never entered.
  const presetSource = useMemo<DataTableSource<PresetRow>>(
    () => ({
      body: loading
        ? { kind: "loading" }
        : error
          ? { kind: "error", error, retry: onRetry }
          : { kind: "ready" },
      refreshing,
      resetKey: access
        ? `${access.scope.relayId}:${access.scope.resourceId}`
        : undefined,
      rows,
    }),
    [loading, error, onRetry, refreshing, access, rows]
  )
  const definition = useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Permission presets",
        columns: presetHelper.columns([
          presetHelper.accessor("name", {
            header: "Preset",
            sortFn: "text",
            cell: ({ row }) => (
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.original.name}
                </p>
                {row.original.builtin ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {row.original.builtin.description}
                  </p>
                ) : null}
              </div>
            ),
            meta: dataTableColumnMeta({ width: "minmax(0,1.5fr)" }),
          }),
          presetHelper.display({
            id: "type",
            header: "Type",
            cell: ({ row }) => (
              <div className="min-w-0">
                <Badge variant="outline">
                  {row.original.builtin ? "Kiln default" : "Custom"}
                </Badge>
              </div>
            ),
            meta: dataTableColumnMeta({ hideBelow: "sm", width: "8rem" }),
          }),
          presetHelper.display({
            id: "assignments",
            header: "Assignments",
            cell: ({ row }) => (
              <DataTableTextCell
                value={
                  row.original.custom
                    ? String(row.original.custom.assignmentCount)
                    : "—"
                }
              />
            ),
            meta: dataTableColumnMeta({ hideBelow: "md", width: "8rem" }),
          }),
          presetHelper.display({
            id: "updated",
            header: "Updated",
            cell: ({ row }) => (
              <DataTableTextCell
                value={
                  row.original.custom
                    ? utcTimestamp(row.original.custom.updatedAt)
                    : "—"
                }
              />
            ),
            meta: dataTableColumnMeta({ hideBelow: "xl", width: "12rem" }),
          }),
          presetHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            cell: ({ row }) => (
              <PresetActions
                row={row.original}
                access={access}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ),
            meta: dataTableColumnMeta({ width: "3.5rem" }),
          }),
        ]),
        getRowId: (row) => row.id,
        search: {
          fields: [(row) => row.name, (row) => row.builtin?.description ?? ""],
        },
      }),
    [access, onEdit, onDelete]
  )
  return (
    <DataTableWorkspace
      toolbar={
        <DataTableToolbar
          search={{
            ariaLabel: "Search presets",
            placeholder: "Search presets",
            store: searchStore,
          }}
          actions={
            access?.canCreatePreset ? (
              <Button aria-label="Create preset" onClick={onCreate}>
                <Plus />
                <span className="hidden sm:inline">Create preset</span>
              </Button>
            ) : null
          }
        />
      }
    >
      <DataTable
        definition={definition}
        source={presetSource}
        searchStore={searchStore}
        emptyState={
          <DataTableEmptyState
            icon={<Shield className="size-6 text-muted-foreground/45" />}
            title="No presets match your search"
            description="Try a different preset name."
          />
        }
      />
    </DataTableWorkspace>
  )
})

const PresetActions = memo(function PresetActions({
  row,
  access,
  onEdit,
  onDelete,
}: Pick<PresetsProps, "access" | "onEdit" | "onDelete"> & { row: PresetRow }) {
  const [viewing, setViewing] = useState(false)
  return (
    <div className="flex justify-end px-2">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${row.name}`}
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Preset actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() =>
              row.custom ? onEdit(row.custom) : setViewing(true)
            }
          >
            {row.custom && access?.canManagePresets
              ? "Edit preset"
              : "View permissions"}
          </DropdownMenuItem>
          {row.custom && access?.canManagePresets ? (
            <DropdownMenuItem
              disabled={row.custom.assignmentCount > 0}
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                if (row.custom) onDelete(row.custom)
              }}
            >
              {row.custom.assignmentCount > 0
                ? "In use — remove assignments first"
                : "Delete preset"}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={viewing} onOpenChange={setViewing}>
        {row.builtin && access ? (
          <PermissionDialogContent
            title={row.name}
            description={`${row.builtin.description} Kiln defaults cannot be edited.`}
            footer={
              <Button
                variant="outline"
                className="sm:ml-auto"
                onClick={() => setViewing(false)}
              >
                Close
              </Button>
            }
          >
            <PermissionEditor
              targets={[
                {
                  key: row.id,
                  context: { scope: access.scope },
                  access,
                  selections: row.builtin.selections,
                  presetIds: [],
                  builtinKeys: [],
                },
              ]}
            />
          </PermissionDialogContent>
        ) : null}
      </Dialog>
    </div>
  )
})
function personStatus(person: Person) {
  return person.isOwner
    ? "Owner"
    : person.state === "pending"
      ? person.invitationId
        ? "Pending invitation"
        : "Invitation ended"
      : person.inherited
        ? "From Relay"
        : "Active"
}
/**
 * A person's own entries. Relay access seen from one of its resources is shown
 * as the permissions it grants, since its presets belong to the Relay.
 */
function personTargets(
  person: Person,
  access: ScopeAccess
): Array<PermissionTarget> {
  return [
    {
      key: person.id,
      context: { scope: person.scope },
      access,
      ...(person.inherited
        ? {
            selections: person.permissions.map((key) => ({
              kind: "permission" as const,
              key,
            })),
            presetIds: [],
            builtinKeys: [],
          }
        : {
            selections: person.selections,
            presetIds: person.presetIds,
            builtinKeys: person.builtinKeys,
          }),
    },
  ]
}
