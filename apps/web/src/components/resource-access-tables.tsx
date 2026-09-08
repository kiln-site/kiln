import { memo, useMemo, useState, useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { EllipsisVertical, Plus, Shield, Users } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
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
import { PermissionEditor } from "@/components/permission-editor"
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
import { recoverPromise } from "@/effect/promise"
import type { getResourceAccess } from "@/server/resource-access"

export type ScopeAccess = Awaited<ReturnType<typeof getResourceAccess>>
export type Person = ScopeAccess["people"][number]
export type Preset = ScopeAccess["presets"][number]
type DefaultPreset = ScopeAccess["defaults"][number]
const personHelper = createDataTableColumnHelper<Person>()
interface PeopleProps {
  searchStore: DataTableSearchStore
  access?: ScopeAccess
  source: DataTableSource<Person>
  onEdit: (person: Person) => void
  onTransfer: (person: Person) => void
  onRevoke: (person: Person) => void
  onAccept: (person: Person) => void
  onInvite: () => void
  accepting: boolean
}

export const ResourcePeopleTable = memo(function ResourcePeopleTable({
  access,
  source,
  onInvite,
  searchStore,
  onEdit,
  onTransfer,
  onRevoke,
  onAccept,
  accepting,
}: PeopleProps) {
  const search = useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getNormalizedSnapshot,
    searchStore.getNormalizedServerSnapshot
  )
  const definition = useMemo(() => {
    const names = new Map([
      ...(access?.defaults.map(
        (preset) => [preset.key, preset.name] as const
      ) ?? []),
      ...(access?.presets.map((preset) => [preset.id, preset.name] as const) ??
        []),
    ])
    return defineDataTable({
      ariaLabel: "Resource users",
      columns: personHelper.columns([
        personHelper.accessor("name", {
          header: "User",
          sortFn: "text",
          cell: ({ row }) => (
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">
                  {row.original.name}
                </p>
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[10px] sm:hidden"
                >
                  {personStatus(row.original)}
                </Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {row.original.email}
              </p>
            </div>
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
            <DataTableTextCell value={date(row.original.updatedAt)} />
          ),
          meta: dataTableColumnMeta({ hideBelow: "xl", width: "12rem" }),
        }),
        personHelper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => (
            <PersonActions
              person={row.original}
              access={access}
              onEdit={onEdit}
              onTransfer={onTransfer}
              onRevoke={onRevoke}
              onAccept={onAccept}
              accepting={accepting}
            />
          ),
          meta: dataTableColumnMeta({ width: "3.5rem" }),
        }),
      ]),
      getRowId: (person) => person.id,
    })
  }, [access, onEdit, onTransfer, onRevoke, onAccept, accepting])
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
    </DataTableWorkspace>
  )
})

const PersonActions = memo(function PersonActions({
  person,
  access,
  onEdit,
  onTransfer,
  onRevoke,
  onAccept,
  accepting,
}: Pick<
  PeopleProps,
  "access" | "onEdit" | "onTransfer" | "onRevoke" | "onAccept" | "accepting"
> & { person: Person }) {
  const [viewing, setViewing] = useState(false)
  const canEdit = access?.canManage && !person.inherited && !person.isOwner
  return (
    <div className="flex justify-end px-2">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${person.email}`}
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>User actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => (canEdit ? onEdit(person) : setViewing(true))}
          >
            {canEdit ? "Edit permissions" : "View permissions"}
          </DropdownMenuItem>
          <PersonActivityItem person={person} access={access} />
          <PersonInvitationItems
            person={person}
            access={access}
            accepting={accepting}
            onAccept={onAccept}
          />
          {access?.canTransferOwnership &&
          !person.isOwner &&
          !person.inherited &&
          person.state === "active" ? (
            <DropdownMenuItem onSelect={() => onTransfer(person)}>
              Transfer ownership
            </DropdownMenuItem>
          ) : null}
          {canEdit ? (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onRevoke(person)}
            >
              Revoke access
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <PersonPermissionsDialog
        person={person}
        access={access}
        viewing={viewing}
        onOpenChange={setViewing}
      />
    </div>
  )
})

function PersonActivityItem({
  person,
  access,
}: {
  person: Person
  access?: ScopeAccess
}) {
  return (
    <>
      {" "}
      {person.userId &&
      access?.scope.resourceType !== "database" &&
      access?.permissions.includes("instance.read") ? (
        <DropdownMenuItem asChild>
          <Link
            to="/activity"
            search={{
              user: person.userId,
              relay: access.scope.relayId,
              ...(access?.scope.resourceType === "instance"
                ? { server: access.scope.resourceId }
                : {}),
            }}
          >
            View activity
          </Link>
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
function PersonInvitationItems({
  person,
  access,
  accepting,
  onAccept,
}: Pick<PeopleProps, "access" | "accepting" | "onAccept"> & {
  person: Person
}) {
  return (
    <>
      {" "}
      {person.invitationId ? (
        <DropdownMenuItem
          onSelect={() => {
            void recoverPromise(
              async () => {
                await navigator.clipboard.writeText(
                  new URL(
                    `/invite?id=${encodeURIComponent(person.invitationId!)}`,
                    window.location.origin
                  ).toString()
                )
                showToast({
                  type: "success",
                  message: "Invitation link copied",
                })
              },
              () =>
                showToast({
                  type: "error",
                  message: "Could not copy invitation link",
                })
            )
          }}
        >
          Copy invitation link
        </DropdownMenuItem>
      ) : null}
      {person.invitationId && access?.isPlatformAdmin ? (
        <DropdownMenuItem
          disabled={accepting}
          onSelect={() => onAccept(person)}
        >
          Accept for user
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
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
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{person.name} permissions</DialogTitle>
            <DialogDescription>
              {person.inherited
                ? "These permissions are inherited from the Relay."
                : "Effective permissions from this assignment and its linked presets."}
            </DialogDescription>
          </DialogHeader>
          <PermissionEditor
            disabled
            scopeType={person.scope.resourceType}
            capabilities={access.supportedCapabilities}
            selections={person.permissions.map((key) => ({
              kind: "permission",
              key,
            }))}
            onChange={ignoreSelections}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
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
  source: DataTableSource<Person>
  onEdit: (preset: Preset) => void
  onDelete: (preset: Preset) => void
  onCreate: () => void
}
export const ResourcePresetsTable = memo(function ResourcePresetsTable({
  access,
  source,
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
  const presetSource = useMemo<DataTableSource<PresetRow>>(
    () => ({
      body: source.body,
      refreshing: source.refreshing,
      resetKey: source.resetKey,
      rows,
    }),
    [source.body, source.refreshing, source.resetKey, rows]
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
                    ? date(row.original.custom.updatedAt)
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
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>{row.name}</DialogTitle>
              <DialogDescription>
                {row.builtin.description} Kiln defaults cannot be edited.
              </DialogDescription>
            </DialogHeader>
            <PermissionEditor
              disabled
              scopeType={access.scope.resourceType}
              capabilities={access.supportedCapabilities}
              selections={row.builtin.selections}
              onChange={ignoreSelections}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewing(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
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
function date(value: string) {
  return `${value.slice(0, 16).replace("T", " ")} UTC`
}
function ignoreSelections() {}
