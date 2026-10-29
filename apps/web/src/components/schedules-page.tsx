import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import {
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CirclePause,
  CirclePlay,
  CircleCheck,
  CircleHelp,
  CircleX,
  Code2,
  Copy,
  EllipsisVertical,
  FolderSync,
  GripVertical,
  History,
  ListTodo,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Timer,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { sortFn_basic } from "@tanstack/react-table"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import cronstrue from "cronstrue"
import { Result } from "effect"

import type {
  ScheduleAction,
  ScheduleTarget,
} from "@workspace/contracts/schedules"
import type { InstanceInventory } from "@workspace/contracts"
import {
  normalizeScheduleCron,
  scheduleActionAppliesToTarget,
  scheduleActionNeedsNamedTarget,
  scheduleActionsForSave,
  scheduleActionSupportsTarget,
  scheduleCronAliases,
  validateScheduleCron,
} from "@workspace/contracts/schedules"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Separator } from "@workspace/ui/components/separator"
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { appServices } from "@/components/app/app-presentation"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableTextCell,
} from "@/components/data-table"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import {
  InstanceKindCounts,
  type InstanceKindCountValues,
} from "@/components/instance-kind-counts"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import { IdentityName } from "@/components/identity-name"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InstanceCard } from "@/components/instance-card"
import {
  useKilnBackupHost,
  type KilnBackupHost,
} from "@/components/kiln/kiln-presentation"
import {
  ServerKindIcon,
  instanceKindIcons,
} from "@/components/instance-kind-icon"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { RelativeTime } from "@/components/relative-time"
import { StatusIndicator } from "@/components/status-indicator"
import {
  BackupConfigurationDialog,
  type BackupConfigurationTarget,
} from "@/components/backup-configuration-dialog"
import { BackupIcon } from "@/components/backup-icon"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import {
  useScheduleScope,
  type ScheduleScope,
} from "@/components/schedule-scope"
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
import type { InstancePickerKind } from "@/lib/instance-picker-filters"
import { scheduleBackupDestination } from "@/lib/schedule-backup-configuration"
import {
  removeScheduleFromCache,
  schedulesCollectionOptions,
  upsertScheduleCache,
} from "@/lib/collections/schedules"
import {
  accessCapabilitiesQueryOptions,
  backupStorageQueryOptions,
  githubSyncRunsQueryOptions,
  queryKeys,
  relaySnapshotQueryOptions,
  scheduleOptionsQueryOptions,
  schedulesQueryOptions,
} from "@/lib/query-options"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { getBackupStorage } from "@/server/backup-storage"
import type { GitHubSyncRunView } from "@/server/github-sync.server"
import { getRelaySnapshot } from "@/server/relay"
import {
  createSchedule,
  deleteSchedule,
  getScheduleOptions,
  getSchedules,
  runScheduleNow,
  updateSchedule,
} from "@/server/schedules"

type Schedule = Awaited<ReturnType<typeof getSchedules>>[number]
type ScheduleOption = Awaited<ReturnType<typeof getScheduleOptions>>[number]
type RelaySnapshot = Awaited<ReturnType<typeof getRelaySnapshot>>
type BackupStorage = Awaited<ReturnType<typeof getBackupStorage>>[number]
type EditorMode = { kind: "create" } | { kind: "edit"; schedule: Schedule }
type ScheduleRun = Schedule["runs"][number]
type ScheduleRunWithRelay = ScheduleRun & { relayId: string }
type ScheduleActionDraft = ScheduleAction | { id: string; type: null }

const relativeFormatter = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
  style: "short",
})
const timestampFormatters = new Map<string, Intl.DateTimeFormat>()
const fullTimestampFormatters = new Map<string, Intl.DateTimeFormat>()
const relativeClockListeners = new Set<() => void>()
let relativeClockSnapshot = Date.now()
let relativeClockTimer: ReturnType<typeof setInterval> | null = null

export const SchedulesPage = React.memo(function SchedulesPage() {
  const { data: schedules } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ schedule: schedulesCollectionOptions })
        .orderBy(({ schedule }) => schedule.updatedAt, "desc")
        .orderBy(({ schedule }) => schedule.id, "desc"),
  })
  const { data: scheduleOptions } = useSuspenseQuery({
    ...scheduleOptionsQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const { data: instances } = useSuspenseQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectScheduleTargetInstances,
  })
  const { data: storage } = useSuspenseQuery({
    ...backupStorageQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const navigate = useNavigate({ from: "/automations/schedules" })
  const selectedScope = useScheduleScope()
  const [searchStore] = React.useState(() => createDataTableSearchStore())
  const [editor, setEditor] = React.useState<EditorMode | null>(null)
  const [deleting, setDeleting] = React.useState<Schedule | null>(null)
  const { data: isPlatformAdmin = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectIsPlatformAdmin,
  })
  const kiln = useKilnBackupHost(isPlatformAdmin)
  const options = React.useMemo(
    () =>
      kilnScheduleOptions(
        scheduleOptionsWithInstanceNames(scheduleOptions, instances),
        kiln,
        schedules
      ),
    [instances, kiln, scheduleOptions, schedules]
  )
  const canCreate = options.some((option) => option.canCreate)
  const optionMap = React.useMemo(
    () => new Map(options.map((option) => [targetKey(option), option])),
    [options]
  )
  const scopedSchedules = React.useMemo(
    () =>
      selectedScope
        ? schedules.filter((schedule) =>
            scheduleMatchesScope(schedule, selectedScope)
          )
        : schedules,
    [schedules, selectedScope]
  )
  const openEdit = React.useCallback(
    (schedule: Schedule) => setEditor({ kind: "edit", schedule }),
    []
  )
  const openDelete = React.useCallback(
    (schedule: Schedule) => setDeleting(schedule),
    []
  )
  const openCreate = React.useCallback(() => setEditor({ kind: "create" }), [])
  const viewHistory = React.useCallback(
    (schedule: Schedule) => {
      void navigate({
        to: "/automations/history",
        search: (previous) => ({
          ...previous,
          run: undefined,
          runRelay: undefined,
          schedule: schedule.id,
        }),
      })
    },
    [navigate]
  )
  const viewRun = React.useCallback(
    (schedule: Schedule, run: ScheduleRunWithRelay) => {
      void navigate({
        to: "/automations/history",
        search: (previous) => ({
          ...previous,
          run: run.id,
          runRelay: run.relayId,
          schedule: schedule.id,
        }),
      })
    },
    [navigate]
  )

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <DataTableWorkspace
        toolbar={
          <ScheduleToolbar
            canCreate={canCreate}
            searchStore={searchStore}
            onCreate={openCreate}
          />
        }
      >
        <ScheduleTable
          canCreate={canCreate}
          optionMap={optionMap}
          schedules={scopedSchedules}
          scope={selectedScope}
          searchStore={searchStore}
          onCreate={openCreate}
          onDelete={openDelete}
          onEdit={openEdit}
          onViewHistory={viewHistory}
          onViewRun={viewRun}
        />
      </DataTableWorkspace>

      {editor ? (
        <ScheduleEditorDialog
          mode={editor}
          options={options}
          storage={storage}
          onClose={() => setEditor(null)}
          onSaved={() => setEditor(null)}
        />
      ) : null}
      <DeleteScheduleDialog
        schedule={deleting}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
})

const ScheduleToolbar = React.memo(function ScheduleToolbar({
  canCreate,
  searchStore,
  onCreate,
}: {
  canCreate: boolean
  searchStore: DataTableSearchStore
  onCreate: () => void
}) {
  const search = React.useMemo(
    () => ({
      ariaLabel: "Search schedules",
      closeMobileWhenEmpty: true,
      id: "schedule-search",
      placeholder: "Search schedules",
      store: searchStore,
    }),
    [searchStore]
  )
  return (
    <DataTableToolbar
      actions={
        canCreate ? (
          <Button aria-label="Create schedule" size="sm" onClick={onCreate}>
            <Plus />
            <span className="hidden sm:inline">Create schedule</span>
          </Button>
        ) : null
      }
      leading={<ScheduleSyncButton />}
      search={search}
    />
  )
})

const ScheduleSyncButton = React.memo(function ScheduleSyncButton() {
  const { fetchStatus, refetch } = useQuery({
    ...schedulesQueryOptions(),
    notifyOnChangeProps: ["fetchStatus"],
  })
  const syncing = fetchStatus === "fetching"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync schedules"
          aria-busy={syncing}
          disabled={syncing}
          onClick={() => void refetch()}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync schedules
      </TooltipContent>
    </Tooltip>
  )
})

/**
 * A schedule with what its row shows that depends on the scope and the
 * caller's access, worked out once per schedule.
 */
interface ScheduleTableItem {
  canDelete: boolean
  canDuplicate: boolean
  canEdit: boolean
  canRun: boolean
  lastRun: ScheduleRunWithRelay | null
  schedule: Schedule
  targetCounts: InstanceKindCountValues
  targets: ReadonlyArray<HistoryTarget>
  targetsAvailable: boolean
}

const scheduleColumnHelper = createDataTableColumnHelper<ScheduleTableItem>()
const scheduleSearchFields = [
  (item: ScheduleTableItem) => scheduleSearchText(item.schedule),
] as const

const ScheduleTable = React.memo(function ScheduleTable({
  canCreate,
  optionMap,
  schedules,
  scope,
  searchStore,
  onCreate,
  onDelete,
  onEdit,
  onViewHistory,
  onViewRun,
}: {
  canCreate: boolean
  optionMap: ReadonlyMap<string, ScheduleOption>
  schedules: Array<Schedule>
  scope: ScheduleScope | null
  searchStore: DataTableSearchStore
  onCreate: () => void
  onDelete: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
  onViewHistory: (schedule: Schedule) => void
  onViewRun: (schedule: Schedule, run: ScheduleRunWithRelay) => void
}) {
  // Items keep their identity while their schedule, the scope, and access
  // stay the same, so an update to one schedule re-renders only its row.
  const itemCache = React.useMemo(
    () => new WeakMap<Schedule, ScheduleTableItem>(),
    [optionMap, scope]
  )
  const source = React.useMemo((): DataTableSource<ScheduleTableItem> => {
    const rows = schedules.map((schedule) => {
      let item = itemCache.get(schedule)
      if (!item) {
        item = scheduleTableItem(schedule, optionMap, scope)
        itemCache.set(schedule, item)
      }
      return item
    })
    return { body: { kind: "ready" }, refreshing: false, rows }
  }, [itemCache, optionMap, schedules, scope])
  // The columns read everything that changes from the row, so they're built
  // once and cells never remount, which would drop a pending action.
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Schedules",
        columns: scheduleColumnHelper.columns([
          scheduleColumnHelper.accessor(
            ({ schedule }) => scheduleStatusPresentation(schedule).label,
            {
              id: "status",
              header: () => (
                <span className="sr-only sm:not-sr-only">Status</span>
              ),
              sortFn: "text",
              cell: ({ row }) => (
                <StatusIndicator
                  status={scheduleStatusPresentation(row.original.schedule)}
                />
              ),
              meta: dataTableColumnMeta(
                { width: { base: "2.5rem", sm: statusColumnWidth } },
                {
                  cellClassName: "px-2 sm:px-3",
                  headerClassName: "px-2 sm:px-3",
                  headerLabelClassName: "shrink-0 overflow-visible text-clip",
                }
              ),
            }
          ),
          scheduleColumnHelper.accessor(({ schedule }) => schedule.name, {
            id: "schedule",
            header: "Schedule",
            sortFn: "text",
            cell: ({ row }) => (
              <ScheduleName
                canEdit={row.original.canEdit}
                schedule={row.original.schedule}
                onEdit={onEdit}
              />
            ),
            meta: dataTableColumnMeta({
              width: { base: "minmax(0,1fr)", md: "minmax(0,1.3fr)" },
            }),
          }),
          scheduleColumnHelper.accessor(({ targets }) => targets.length, {
            id: "targets",
            header: "Targets",
            sortFn: sortFn_basic,
            cell: ({ row }) => (
              <HistoryTargets
                counts={row.original.targetCounts}
                name={row.original.schedule.name}
                relayName=""
                targets={row.original.targets}
              />
            ),
            meta: dataTableColumnMeta({ hideBelow: "xl", width: "11rem" }),
          }),
          scheduleColumnHelper.accessor(
            ({ schedule }) => scheduleNextRun(schedule)?.getTime() ?? Infinity,
            {
              id: "timing",
              header: "Timing",
              sortFn: sortFn_basic,
              cell: ({ row }) => (
                <ScheduleTiming schedule={row.original.schedule} />
              ),
              meta: dataTableColumnMeta({
                hideBelow: "md",
                width: "minmax(7.5rem,0.6fr)",
              }),
            }
          ),
          scheduleColumnHelper.accessor(
            ({ lastRun }) => lastRun?.finishedAt ?? 0,
            {
              id: "latest",
              header: "Latest run",
              sortFn: sortFn_basic,
              cell: ({ row }) => (
                <ScheduleLastRun
                  run={row.original.lastRun}
                  schedule={row.original.schedule}
                  onView={onViewRun}
                />
              ),
              meta: dataTableColumnMeta({ hideBelow: "lg", width: "9rem" }),
            }
          ),
          scheduleColumnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <ScheduleActions
                item={row.original}
                onDelete={onDelete}
                onEdit={onEdit}
                onViewHistory={onViewHistory}
              />
            ),
            meta: dataTableColumnMeta(
              { width: { base: "11.25rem", sm: "11.75rem" } },
              {
                cellClassName: "px-1 sm:px-2",
                headerClassName: "px-1 sm:px-2",
              }
            ),
          }),
        ]),
        getRowId: ({ schedule }) => scheduleRowKey(schedule),
        search: { fields: scheduleSearchFields },
        virtualization: true,
      }),
    [onDelete, onEdit, onViewHistory, onViewRun]
  )
  const emptyState = React.useCallback(
    ({ searchActive }: { searchActive: boolean }) => (
      <DataTableEmptyState
        action={
          !searchActive && canCreate ? (
            <Button type="button" size="sm" onClick={onCreate}>
              <Plus /> Create schedule
            </Button>
          ) : undefined
        }
        description={
          <span className="block max-w-sm">
            {searchActive
              ? "Try a schedule name, cron expression, action, or target."
              : scope
                ? "Choose another scope or create a schedule for it."
                : "Create Relay-owned automation that keeps running when Hearth is offline."}
          </span>
        }
        icon={
          <Play className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
        }
        title={
          searchActive
            ? "No schedules match your search"
            : scope
              ? "No schedules in this scope"
              : "No schedules yet"
        }
      />
    ),
    [canCreate, onCreate, scope]
  )

  return (
    <DataTable
      definition={definition}
      emptyState={emptyState}
      searchStore={searchStore}
      source={source}
    />
  )
})

function scheduleTableItem(
  schedule: Schedule,
  optionMap: ReadonlyMap<string, ScheduleOption>,
  scope: ScheduleScope | null
): ScheduleTableItem {
  const targets = schedule.targets.map((target) =>
    scheduleHistoryTarget(target, optionMap.get(targetKey(target))?.relayName)
  )
  return {
    canDelete: schedule.targets.every(
      (target) => optionMap.get(targetKey(target))?.canDelete
    ),
    canDuplicate: canOperateSchedule(schedule, optionMap, "canCreate"),
    canEdit: canOperateSchedule(schedule, optionMap, "canUpdate"),
    canRun: canOperateSchedule(schedule, optionMap, "canExecute"),
    lastRun: scheduleLastRun(schedule, scope),
    schedule,
    targetCounts: historyTargetCounts(targets),
    targets,
    targetsAvailable: schedule.targets.every(
      (target) => optionMap.get(targetKey(target))?.available
    ),
  }
}

const ScheduleName = React.memo(function ScheduleName({
  canEdit,
  schedule,
  onEdit,
}: {
  canEdit: boolean
  schedule: Schedule
  onEdit: (schedule: Schedule) => void
}) {
  const card = (
    <IdentityName
      icon={<ListTodo className="size-4" aria-hidden="true" />}
      meta={scheduleActionSummary(schedule)}
      name={schedule.name}
      nameClassName={
        canEdit
          ? "transition-colors group-hover/schedule-name:text-primary-ink"
          : undefined
      }
    />
  )
  if (!canEdit) return card
  return (
    <button
      type="button"
      aria-label={`Edit ${schedule.name}`}
      className="group/schedule-name flex max-w-full min-w-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => onEdit(schedule)}
    >
      {card}
    </button>
  )
})

const ScheduleActions = React.memo(function ScheduleActions({
  item,
  onDelete,
  onEdit,
  onViewHistory,
}: {
  item: ScheduleTableItem
  onDelete: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
  onViewHistory: (schedule: Schedule) => void
}) {
  const queryClient = useQueryClient()
  const {
    canDelete,
    canDuplicate,
    canEdit,
    canRun,
    schedule,
    targetsAvailable,
  } = item
  // A virtual row remounts when it scrolls back into view, so pending state
  // comes from the mutation cache rather than this row's observers.
  const pendingActions = useMutationState({
    filters: { mutationKey: scheduleActionKey(schedule.id), status: "pending" },
    select: (mutation) => mutation.options.mutationKey?.[2],
  })
  const runMutation = useMutation({
    mutationKey: scheduleActionKey(schedule.id, "run"),
    mutationFn: () => runScheduleNow({ data: { id: schedule.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.schedules.all,
      })
      showToast({
        message:
          result.started === result.total
            ? "Schedule started"
            : `Schedule started on ${result.started} of ${result.total} Relays`,
        type: result.started === result.total ? "success" : "warning",
      })
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "The schedule could not be started"),
        type: "error",
      }),
  })
  const enabledMutation = useMutation({
    mutationKey: scheduleActionKey(schedule.id, "enabled"),
    mutationFn: (enabled: boolean) =>
      updateSchedule({
        data: {
          ...scheduleInput(schedule),
          enabled,
          id: schedule.id,
          revision: schedule.revision,
        },
      }),
    onSuccess: (updated, enabled) => {
      upsertScheduleCache(queryClient, updated)
      showToast({
        message: enabled ? "Schedule enabled" : "Schedule disabled",
        type: "success",
      })
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "The schedule could not be updated"),
        type: "error",
      }),
  })
  const duplicateMutation = useMutation({
    mutationKey: scheduleActionKey(schedule.id, "duplicate"),
    mutationFn: () =>
      createSchedule({
        data: {
          ...scheduleInput(schedule),
          actions: schedule.actions.map((action) => ({
            ...action,
            id: crypto.randomUUID(),
          })),
          enabled: false,
        },
      }),
    onSuccess: (created) => {
      upsertScheduleCache(queryClient, created)
      showToast({ message: "Schedule duplicated", type: "success" })
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "The schedule could not be duplicated"),
        type: "error",
      }),
  })

  const running = pendingActions.includes("run")
  const updatingEnabled = pendingActions.includes("enabled")
  const duplicating = pendingActions.includes("duplicate")

  return (
    <DataTableActionGroup>
      {canRun ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="px-2 text-xs"
          disabled={running}
          onClick={() => runMutation.mutate()}
        >
          {running ? <LoaderCircle className="animate-spin" /> : <Play />}
          Run now
        </Button>
      ) : null}
      {canEdit ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${schedule.name}`}
              onClick={() => onEdit(schedule)}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Edit schedule
          </TooltipContent>
        </Tooltip>
      ) : null}
      {canDelete ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
              aria-label={`Delete ${schedule.name}`}
              onClick={() => onDelete(schedule)}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Delete schedule
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`More actions for ${schedule.name}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <CopyIdentifierMenuItem label="Schedule ID" value={schedule.id} />
          {canDuplicate ? (
            <DropdownMenuItem
              disabled={duplicating}
              onSelect={() => duplicateMutation.mutate()}
            >
              {duplicating ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Copy />
              )}
              Duplicate schedule
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onViewHistory(schedule)}>
            <History /> View history
          </DropdownMenuItem>
          {canEdit && targetsAvailable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={updatingEnabled}
                onSelect={() => enabledMutation.mutate(!schedule.enabled)}
              >
                {updatingEnabled ? (
                  <LoaderCircle className="animate-spin" />
                ) : schedule.enabled ? (
                  <CirclePause />
                ) : (
                  <CirclePlay />
                )}
                {schedule.enabled ? "Disable schedule" : "Enable schedule"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

function scheduleActionKey(
  scheduleId: string,
  action?: "duplicate" | "enabled" | "run"
) {
  return action
    ? ["schedule-action", scheduleId, action]
    : ["schedule-action", scheduleId]
}

/** The cron as words, with the next run under it. */
const ScheduleTiming = React.memo(function ScheduleTiming({
  schedule,
}: {
  schedule: Schedule
}) {
  const alias = cronAliasLabel(schedule.cron)
  const nextRun = scheduleNextRun(schedule)
  return (
    <span className="flex min-w-0 flex-col items-start">
      {alias ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="max-w-full cursor-default truncate rounded-sm text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {alias}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="font-mono">
            {schedule.cron}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="max-w-full truncate font-mono text-xs text-foreground">
          {schedule.cron}
        </span>
      )}
      {nextRun ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <time
              dateTime={nextRun.toISOString()}
              tabIndex={0}
              className="type-meta max-w-full cursor-default truncate rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              suppressHydrationWarning
            >
              Next <RelativeTimeText date={nextRun} />
            </time>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {fullTimestampLabel(nextRun, schedule.timezone)}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="type-meta text-muted-foreground">Not scheduled</span>
      )}
    </span>
  )
})

const RelativeTimeText = React.memo(function RelativeTimeText({
  date,
}: {
  date: Date
}) {
  const serverSnapshot = React.useMemo(() => Date.now(), [])
  const getServerSnapshot = React.useCallback(
    () => serverSnapshot,
    [serverSnapshot]
  )
  const now = React.useSyncExternalStore(
    subscribeRelativeClock,
    getRelativeClockSnapshot,
    getServerSnapshot
  )
  return relativeTime(date, now)
})

const ScheduleLastRun = React.memo(function ScheduleLastRun({
  run,
  schedule,
  onView,
}: {
  run: ScheduleRunWithRelay | null
  schedule: Schedule
  onView: (schedule: Schedule, run: ScheduleRunWithRelay) => void
}) {
  if (!run) {
    return <span className="type-meta text-muted-foreground">Never</span>
  }
  const result = latestRunResult(run)
  const finishedAt = new Date(run.finishedAt)
  // The tooltip sits on the button, so focusing it shows the full date too.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`View the latest ${schedule.name} run: ${result}`}
          className="group/latest-run type-meta flex max-w-full min-w-0 flex-col items-start rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => onView(schedule, run)}
        >
          <span
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 text-xs font-medium group-hover/latest-run:underline",
              latestRunResultClassName[result]
            )}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                latestRunResultDotClassName[result]
              )}
            />
            {result}
          </span>
          <time
            className="max-w-full truncate text-muted-foreground"
            dateTime={finishedAt.toISOString()}
            suppressHydrationWarning
          >
            <RelativeTimeText date={finishedAt} />
          </time>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {fullTimestampLabel(finishedAt, schedule.timezone)}
      </TooltipContent>
    </Tooltip>
  )
})

const latestRunResultClassName = {
  Failed: "text-destructive",
  Success: "text-emerald-700 dark:text-emerald-300",
} as const satisfies Record<ReturnType<typeof latestRunResult>, string>

const latestRunResultDotClassName = {
  Failed: "bg-destructive",
  Success: "bg-emerald-500 dark:bg-emerald-400",
} as const satisfies Record<ReturnType<typeof latestRunResult>, string>

function latestRunResult(run: ScheduleRunWithRelay) {
  const attempts = [
    ...run.sequenceAttempts,
    ...run.targetRuns.flatMap((targetRun) => targetRun.attempts),
  ]
  const passed = attempts.filter((attempt) => attempt.status === "succeeded")
  const failed = attempts.filter((attempt) =>
    ["failed", "interrupted", "not_run", "skipped_missing", "unknown"].includes(
      attempt.status
    )
  )
  if (passed.length === 0) return "Failed" as const
  if (failed.length > 0) return "Failed" as const
  return "Success" as const
}

export const ScheduleHistoryPage = React.memo(function ScheduleHistoryPage() {
  const { data: schedules } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ schedule: schedulesCollectionOptions })
        .orderBy(({ schedule }) => schedule.updatedAt, "desc")
        .orderBy(({ schedule }) => schedule.id, "desc"),
  })
  const search = useSearch({ from: "/_app/automations" })
  const navigate = useNavigate({ from: "/automations/history" })
  const selectedScope = useScheduleScope()
  const [searchStore] = React.useState(() => createDataTableSearchStore())
  const filteredSchedule = React.useMemo(
    () =>
      search.schedule
        ? (schedules.find((schedule) => schedule.id === search.schedule) ??
          null)
        : null,
    [schedules, search.schedule]
  )
  const { data: syncRuns } = useSuspenseQuery({
    ...githubSyncRunsQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  // A schedule run carries only its Relay's ID; every Relay with a target
  // has its name in the target options.
  const { data: relayNames } = useSuspenseQuery({
    ...scheduleOptionsQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectHistoryRelayNames,
  })
  const runs = React.useMemo(
    () => scheduleHistoryRuns(schedules, selectedScope, search.schedule),
    [schedules, search.schedule, selectedScope]
  )
  const entries = React.useMemo(
    () =>
      automationHistoryEntries(
        runs,
        // A schedule's own history has no syncs in it.
        search.schedule ? [] : syncRuns,
        selectedScope,
        relayNames
      ),
    [relayNames, runs, search.schedule, selectedScope, syncRuns]
  )
  const selectedRun = React.useMemo(
    () =>
      search.run
        ? (runs.find(
            (run) =>
              run.id === search.run &&
              (!search.runRelay || run.relayId === search.runRelay)
          ) ?? null)
        : null,
    [runs, search.run, search.runRelay]
  )
  const clearScheduleFilter = React.useCallback(
    () =>
      void navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          run: undefined,
          runRelay: undefined,
          schedule: undefined,
        }),
      }),
    [navigate]
  )
  const openEntry = React.useCallback(
    (entry: AutomationHistoryEntry) => {
      if (entry.kind === "sync") {
        void navigate({ to: "/automations/sync", search: automationScope })
        return
      }
      void navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          run: entry.run.id,
          runRelay: entry.run.relayId,
        }),
      })
    },
    [navigate]
  )
  const closeRun = React.useCallback(() => {
    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        run: undefined,
        runRelay: undefined,
      }),
    })
  }, [navigate])

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <DataTableWorkspace
        toolbar={
          <HistoryToolbar
            filteredScheduleName={
              search.schedule
                ? (filteredSchedule?.name ?? "Unknown schedule")
                : null
            }
            searchStore={searchStore}
            onClearScheduleFilter={clearScheduleFilter}
          />
        }
      >
        <ScheduleHistoryTable
          entries={entries}
          resetKey={search.schedule ?? ""}
          scopeActive={selectedScope !== null}
          searchStore={searchStore}
          onOpenEntry={openEntry}
        />
      </DataTableWorkspace>
      <ScheduleRunDialog run={selectedRun} onClose={closeRun} />
    </div>
  )
})

type ScheduleHistoryRun = Schedule["runs"][number] & {
  definitionActions: Schedule["actions"]
  scheduleName: string
  timezone: string
}

function scheduleHistoryRuns(
  schedules: ReadonlyArray<Schedule>,
  scope: ScheduleScope | null,
  scheduleId: string | undefined
): Array<ScheduleHistoryRun> {
  const runs: Array<ScheduleHistoryRun> = []
  for (const schedule of schedules) {
    if (scheduleId && schedule.id !== scheduleId) continue
    for (const run of schedule.runs) {
      if (
        scope &&
        !run.targetRuns.some((targetRun) =>
          scheduleTargetMatchesScope(targetRun.target, scope)
        )
      ) {
        continue
      }
      runs.push({
        ...run,
        definitionActions: schedule.actions,
        scheduleName: schedule.name,
        timezone: schedule.timezone,
      })
    }
  }
  return runs.sort((left, right) => right.scheduledAt - left.scheduledAt)
}

/** A schedule or sync target, by the kind the instance picker uses. */
interface HistoryTarget {
  id: string
  kind: InstancePickerKind
  name: string
  /** A schedule's Relay target: Kiln, backed up on that Relay. */
  platform?: boolean
  relayId: string
  /** Falls back to the Relay that ran it. */
  relayName?: string
}

interface HistoryEntryBase {
  durationMs: number
  name: string
  relayId: string
  relayName: string
  startedAt: number
  targetCounts: InstanceKindCountValues
  targets: ReadonlyArray<HistoryTarget>
}

/** Schedule runs and sync runs, newest first. */
type AutomationHistoryEntry =
  | (HistoryEntryBase & { kind: "schedule"; run: ScheduleHistoryRun })
  | (HistoryEntryBase & { kind: "sync"; run: GitHubSyncRunView })

function automationHistoryEntries(
  scheduleRuns: ReadonlyArray<ScheduleHistoryRun>,
  syncRuns: ReadonlyArray<GitHubSyncRunView>,
  scope: ScheduleScope | null,
  relayNames: ReadonlyMap<string, string>
): Array<AutomationHistoryEntry> {
  const entries: Array<AutomationHistoryEntry> = scheduleRuns.map((run) => ({
    ...historyEntryBase(
      run.scheduleName,
      run,
      run.relayId,
      relayNames.get(run.relayId) ?? run.relayId,
      run.targetRuns.map(({ target }) => scheduleHistoryTarget(target))
    ),
    kind: "schedule",
    run,
  }))
  for (const run of syncRuns) {
    if (scope && !syncTargetMatchesScope(run.sync.target, scope)) continue
    const { target } = run.sync
    entries.push({
      ...historyEntryBase(
        syncName(run),
        run,
        target.relayId,
        target.relayName,
        [
          {
            id: target.kind === "relay" ? target.relayId : target.id,
            kind: target.kind,
            name: target.name,
            relayId: target.relayId,
          },
        ]
      ),
      kind: "sync",
      run,
    })
  }
  return entries.sort((left, right) => right.startedAt - left.startedAt)
}

function historyEntryBase(
  name: string,
  run: { finishedAt: number; startedAt: number },
  relayId: string,
  relayName: string,
  targets: ReadonlyArray<HistoryTarget>
): HistoryEntryBase {
  return {
    durationMs: Math.max(0, run.finishedAt - run.startedAt),
    name,
    relayId,
    relayName,
    startedAt: run.startedAt,
    targetCounts: historyTargetCounts(targets),
    targets,
  }
}

function historyTargetCounts(
  targets: ReadonlyArray<HistoryTarget>
): InstanceKindCountValues {
  const counts = { apps: 0, databases: 0, instances: 0, relays: 0 }
  for (const target of targets) {
    if (target.kind === "server") counts.instances += 1
    else if (target.kind === "app") counts.apps += 1
    else if (target.kind === "database") counts.databases += 1
    else counts.relays += 1
  }
  return counts
}

function scheduleHistoryTarget(
  target: ScheduleTarget,
  relayName?: string
): HistoryTarget {
  return {
    id: target.kind === "relay" ? target.relayId : target.id,
    kind: target.kind === "instance" ? "server" : target.kind,
    name: target.kind === "relay" ? "Kiln" : target.name,
    platform: target.kind === "relay",
    relayId: target.relayId,
    relayName,
  }
}

function syncName(run: GitHubSyncRunView) {
  return `${run.sync.repository}${run.sync.sourcePath ? `/${run.sync.sourcePath}` : ""}`
}

function syncTargetMatchesScope(
  target: GitHubSyncRunView["sync"]["target"],
  scope: ScheduleScope
) {
  if (!("id" in scope)) return scope.kind === target.kind
  if (scope.kind === "relay") return target.relayId === scope.relayId
  return (
    scope.kind === target.kind &&
    scope.id === target.id &&
    scope.relayId === target.relayId
  )
}

const syncTriggerLabel = {
  created: "Created",
  manual: "Sync now",
  poll: "New commit",
  push: "Push",
} as const satisfies Record<GitHubSyncRunView["trigger"], string>

// Leaving history keeps the scope picker's choice and drops the run.
function automationScope(previous: {
  kind?: "app" | "database" | "relay" | "server"
  relay?: string
  target?: string
}) {
  // Backups' search can scope to an App, which automations don't.
  return {
    kind: previous.kind === "app" ? undefined : previous.kind,
    relay: previous.relay,
    target: previous.target,
  }
}

const HistoryToolbar = React.memo(function HistoryToolbar({
  filteredScheduleName,
  searchStore,
  onClearScheduleFilter,
}: {
  filteredScheduleName: string | null
  searchStore: DataTableSearchStore
  onClearScheduleFilter: () => void
}) {
  const search = React.useMemo(
    () => ({
      ariaLabel: "Search run history",
      closeMobileWhenEmpty: true,
      id: "schedule-history-search",
      placeholder: "Search run history",
      store: searchStore,
    }),
    [searchStore]
  )
  return (
    <DataTableToolbar
      controls={
        filteredScheduleName ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="type-control-sm flex max-w-32 min-w-0 gap-1.5 px-2 sm:max-w-52"
            aria-label={`Clear history filter for ${filteredScheduleName}`}
            onClick={onClearScheduleFilter}
          >
            <span className="truncate">{filteredScheduleName}</span>
            <X className="shrink-0" />
          </Button>
        ) : null
      }
      leading={<ScheduleSyncButton />}
      search={search}
    />
  )
})

const historyColumnHelper =
  createDataTableColumnHelper<AutomationHistoryEntry>()
const historyTableInitialState = {
  sorting: [{ desc: true, id: "started" }],
}

const ScheduleHistoryTable = React.memo(function ScheduleHistoryTable({
  entries,
  resetKey,
  scopeActive,
  searchStore,
  onOpenEntry,
}: {
  entries: Array<AutomationHistoryEntry>
  resetKey: string
  scopeActive: boolean
  searchStore: DataTableSearchStore
  onOpenEntry: (entry: AutomationHistoryEntry) => void
}) {
  const source = React.useMemo(
    (): DataTableSource<AutomationHistoryEntry> => ({
      body: { kind: "ready" },
      refreshing: false,
      resetKey,
      rows: entries,
    }),
    [entries, resetKey]
  )
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Automation history",
        columns: historyColumnHelper.columns([
          historyColumnHelper.accessor(historyStatus, {
            id: "status",
            header: () => (
              <span className="sr-only sm:not-sr-only">Status</span>
            ),
            sortFn: "text",
            cell: ({ row }) => (
              <>
                <HistoryRowOpen entry={row.original} onOpen={onOpenEntry} />
                <RunStatusDot status={historyStatus(row.original)} />
              </>
            ),
            meta: dataTableColumnMeta(
              { width: { base: "2.5rem", sm: "7rem" } },
              {
                cellClassName: "px-2 sm:px-3",
                headerClassName: "px-2 sm:px-3",
              }
            ),
          }),
          historyColumnHelper.accessor("name", {
            id: "automation",
            header: "Automation",
            sortFn: "text",
            cell: ({ row }) => <HistoryAutomation entry={row.original} />,
            meta: dataTableColumnMeta({
              width: { base: "minmax(0,1fr)", md: "minmax(0,1.4fr)" },
            }),
          }),
          historyColumnHelper.accessor((entry) => entry.targets.length, {
            id: "targets",
            header: "Targets",
            sortFn: sortFn_basic,
            cell: ({ row }) => (
              <HistoryTargets
                counts={row.original.targetCounts}
                name={row.original.name}
                relayName={row.original.relayName}
                targets={row.original.targets}
              />
            ),
            meta: dataTableColumnMeta({ hideBelow: "lg", width: "11rem" }),
          }),
          historyColumnHelper.accessor("startedAt", {
            id: "started",
            header: "Started",
            sortFn: sortFn_basic,
            cell: ({ row }) => (
              <HistoryStarted entry={row.original} onOpen={onOpenEntry} />
            ),
            meta: dataTableColumnMeta({
              width: { base: "7.5rem" },
            }),
          }),
          historyColumnHelper.accessor("durationMs", {
            id: "duration",
            header: "Duration",
            sortFn: sortFn_basic,
            cell: ({ row }) => (
              <DataTableTextCell
                monospace
                value={
                  historyStatus(row.original) === "running"
                    ? "—"
                    : durationLabel(row.original.durationMs)
                }
              />
            ),
            meta: dataTableColumnMeta({ hideBelow: "xl", width: "8rem" }),
          }),
          historyColumnHelper.accessor("relayName", {
            id: "relay",
            header: "Relay",
            sortFn: "text",
            cell: ({ row }) => (
              <HistoryRelay
                relayId={row.original.relayId}
                relayName={row.original.relayName}
              />
            ),
            meta: dataTableColumnMeta({
              hideBelow: "xl",
              width: "minmax(10rem,0.8fr)",
            }),
          }),
          historyColumnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => <HistoryActions entry={row.original} />,
            // The whole cell sits above the row's open button, so a click
            // that misses the menu doesn't open the run instead.
            meta: dataTableColumnMeta(
              { width: { base: "2.5rem", sm: "3rem" } },
              {
                cellClassName: "relative z-10 justify-end px-1 sm:px-2",
                headerClassName: "px-1 sm:px-2",
              }
            ),
          }),
        ]),
        getRowClassName: () => "relative cursor-pointer",
        getRowId: historyRowKey,
        model: { initialState: historyTableInitialState },
        search: { fields: historySearchFields },
        virtualization: true,
      }),
    [onOpenEntry]
  )
  return (
    <DataTable
      definition={definition}
      emptyState={({ searchActive }) => (
        <DataTableEmptyState
          description={
            <span className="block max-w-sm">
              {scopeActive && !searchActive
                ? "Completed and attempted runs in this scope will appear here."
                : "Completed and attempted automation runs will appear here."}
            </span>
          }
          icon={
            <Play className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
          }
          title={
            searchActive
              ? "No runs match your search"
              : scopeActive
                ? "No runs in this scope"
                : "No automation runs yet"
          }
        />
      )}
      searchStore={searchStore}
      source={source}
    />
  )
})

/**
 * Covers the whole row, so a click anywhere but the automation link, the
 * targets, or the start time opens the run. The row is `relative`, and those
 * cells sit above this button.
 */
const HistoryRowOpen = React.memo(function HistoryRowOpen({
  entry,
  onOpen,
}: {
  entry: AutomationHistoryEntry
  onOpen: (entry: AutomationHistoryEntry) => void
}) {
  return (
    <button
      type="button"
      aria-label={
        entry.kind === "schedule"
          ? `View ${entry.name} run from ${timestampLabel(new Date(entry.startedAt), entry.run.timezone)} details`
          : `View the sync from ${entry.name}`
      }
      className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      onClick={() => onOpen(entry)}
    />
  )
})

const HistoryAutomation = React.memo(function HistoryAutomation({
  entry,
}: {
  entry: AutomationHistoryEntry
}) {
  const Icon = entry.kind === "schedule" ? ListTodo : FolderSync
  const meta =
    entry.kind === "schedule"
      ? `Schedule · r${entry.run.revision}`
      : entry.run.status === "error"
        ? entry.run.message
        : [
            `Sync · ${syncTriggerLabel[entry.run.trigger]}`,
            entry.run.changedCount === 0
              ? "up to date"
              : `${entry.run.changedCount} ${entry.run.changedCount === 1 ? "file" : "files"} updated`,
            entry.run.message,
          ]
            .filter(Boolean)
            .join(" · ")
  return (
    <Link
      to={
        entry.kind === "schedule"
          ? "/automations/schedules"
          : "/automations/sync"
      }
      search={automationScope}
      className="group/automation-link relative z-10 flex max-w-full min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <IdentityName
        icon={<Icon className="size-4" aria-hidden="true" />}
        meta={meta}
        name={entry.name}
        nameClassName="transition-colors group-hover/automation-link:text-primary-ink"
      />
    </Link>
  )
})

const HistoryRelay = React.memo(function HistoryRelay({
  relayId,
  relayName,
}: {
  relayId: string
  relayName: string
}) {
  return (
    <Link
      to="/relay/$relayId"
      params={{ relayId }}
      className="group/relay-link relative z-10 flex max-w-full min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <InstanceCard
        instance={{ id: relayId, kind: "relay", relayId }}
        meta={relayId.slice(0, 8)}
        metaClassName="font-mono"
        name={relayName}
        nameClassName="transition-colors group-hover/relay-link:text-primary-ink"
        showFavorite={false}
      />
    </Link>
  )
})

const HistoryActions = React.memo(function HistoryActions({
  entry,
}: {
  entry: AutomationHistoryEntry
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`More actions for ${entry.name}`}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <CopyIdentifierMenuItem label="Run ID" value={entry.run.id} />
        {entry.kind === "schedule" ? (
          <CopyIdentifierMenuItem
            label="Schedule ID"
            value={entry.run.scheduleId}
          />
        ) : (
          <CopyIdentifierMenuItem label="Sync ID" value={entry.run.syncId} />
        )}
        <CopyIdentifierMenuItem label="Relay ID" value={entry.relayId} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

// Positioned so its full date shows on hover above the row's open button; a
// click still opens the run.
const HistoryStarted = React.memo(function HistoryStarted({
  entry,
  onOpen,
}: {
  entry: AutomationHistoryEntry
  onOpen: (entry: AutomationHistoryEntry) => void
}) {
  return (
    <span className="relative min-w-0" onClick={() => onOpen(entry)}>
      <RelativeTime
        className="type-meta block text-foreground"
        timestamp={entry.startedAt}
      />
    </span>
  )
})

const HistoryTargets = React.memo(function HistoryTargets({
  counts,
  name,
  relayName,
  targets,
}: {
  counts: InstanceKindCountValues
  name: string
  relayName: string
  targets: ReadonlyArray<HistoryTarget>
}) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${targets.length} ${targets.length === 1 ? "target" : "targets"} for ${name}`}
          className="type-meta relative z-10 -mx-1.5 flex h-8 min-w-0 items-center gap-3 rounded-md px-1.5 text-muted-foreground transition-colors outline-none hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/55"
        >
          <InstanceKindCounts counts={counts} />
        </button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="Targets"
        aria-label="Targets"
        align="start"
        sideOffset={6}
        className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
      >
        <HistoryTargetPicker
          relayName={relayName}
          targets={targets}
          onNavigate={close}
        />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

const noSelectedTargets: ReadonlySet<string> = new Set()

// A run's targets all sit on the Relay that ran it.
const HistoryTargetPicker = React.memo(function HistoryTargetPicker({
  relayName,
  targets,
  onNavigate,
}: {
  relayName: string
  targets: ReadonlyArray<HistoryTarget>
  onNavigate: () => void
}) {
  const navigate = useNavigate()
  const { data: servers } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectHistoryTargetServers,
  })
  const items = React.useMemo(
    () =>
      targets.map((target) =>
        historyTargetPickerItem(target, servers, relayName)
      ),
    [relayName, servers, targets]
  )
  const select = React.useCallback(
    (item: InstancePickerItem) => {
      onNavigate()
      void navigate({ href: historyTargetHref(item.identity) })
    },
    [navigate, onNavigate]
  )
  return (
    <InstancePickerContent
      ariaLabel="Targets"
      emptyMessage="No targets"
      favoritesFilter={false}
      includeKindGroups={false}
      items={items}
      selectedKeys={noSelectedTargets}
      onSelect={select}
    />
  )
})

function historyTargetPickerItem(
  target: HistoryTarget,
  servers: ReadonlyMap<string, HistoryTargetServer> | undefined,
  runRelayName: string
): InstancePickerItem {
  const server =
    target.kind === "server"
      ? servers?.get(`${target.relayId}:${target.id}`)
      : undefined
  const relayName = server?.relayName ?? target.relayName ?? runRelayName
  const kindLabel =
    target.kind === "server"
      ? "Game Server"
      : target.kind === "database"
        ? "Database"
        : target.kind === "app"
          ? "App"
          : target.platform
            ? "Kiln"
            : "Relay"
  return {
    identity:
      target.kind === "server"
        ? {
            brickId: server?.brickId,
            id: target.id,
            implementation: server?.implementation,
            kind: "server",
            relayId: target.relayId,
          }
        : target.kind === "relay"
          ? {
              id: target.relayId,
              kind: "relay",
              platform: target.platform,
              relayId: target.relayId,
              source: "fleet",
            }
          : { id: target.id, kind: target.kind, relayId: target.relayId },
    key: `${target.kind}:${target.relayId}:${target.id}`,
    meta: target.platform
      ? `On ${relayName}`
      : target.kind === "relay"
        ? "Relay"
        : `${server?.implementation ?? kindLabel} · ${relayName}`,
    name: server?.name ?? target.name,
    searchText: `${kindLabel} ${relayName} ${target.id}`,
  }
}

// Each workspace route takes a full ID and redirects to its short form. A
// game server's Relay-qualified ID names it even where short IDs collide.
function historyTargetHref(identity: InstancePickerItem["identity"]) {
  if (identity.kind === "server") {
    return `/server/${encodeURIComponent(`${identity.relayId}-${identity.id}`)}`
  }
  if (identity.kind === "database") {
    return `/db/${encodeURIComponent(identity.id)}`
  }
  if (identity.kind === "app") return `/app/${encodeURIComponent(identity.id)}`
  if (identity.platform) return "/kiln/info"
  return `/relay/${encodeURIComponent(identity.relayId)}`
}

interface HistoryTargetServer {
  brickId?: string
  implementation: string
  name: string
  relayName: string
}

function selectHistoryTargetServers(snapshot: RelaySnapshot) {
  return new Map<string, HistoryTargetServer>(
    snapshot.instances.map((instance) => [
      `${instance.relayId}:${instance.id}`,
      {
        brickId: instance.brickId,
        implementation: instance.implementation,
        name: instance.name,
        relayName: instance.relayName,
      },
    ])
  )
}

function selectHistoryRelayNames(options: Array<ScheduleOption>) {
  return new Map(options.map((option) => [option.relayId, option.relayName]))
}

function historyStatus(entry: AutomationHistoryEntry): ScheduleRun["status"] {
  if (entry.kind === "schedule") return entry.run.status
  return entry.run.status === "success" ? "succeeded" : "failed"
}

const ScheduleRunDialog = React.memo(function ScheduleRunDialog({
  run,
  onClose,
}: {
  run: ScheduleHistoryRun | null
  onClose: () => void
}) {
  const actionsById = React.useMemo(
    () => new Map(run?.definitionActions.map((action) => [action.id, action])),
    [run]
  )

  return (
    <Dialog open={run !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[min(90dvh,52rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {run ? (
          <>
            <DialogHeader className="border-b px-5 py-4 pr-12">
              <div className="flex items-start gap-3">
                <RunResultIcon
                  status={run.status}
                  className="mt-0.5 size-5 shrink-0"
                />
                <div className="min-w-0">
                  <DialogTitle className="truncate text-base">
                    {run.scheduleName}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    Run details and ordered action audit history
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="min-h-0 overflow-y-auto">
              <section className="grid gap-px border-b bg-border sm:grid-cols-2 lg:grid-cols-4">
                <RunMetadataItem
                  label="Status"
                  value={runStatusLabel(run.status)}
                />
                <RunMetadataItem
                  label="Started"
                  value={timestampLabel(new Date(run.startedAt), run.timezone)}
                  detail={<RelativeTimeText date={new Date(run.startedAt)} />}
                />
                <RunMetadataItem
                  label="Duration"
                  value={
                    run.status === "running"
                      ? "In progress"
                      : durationLabel(run.finishedAt - run.startedAt)
                  }
                />
                <RunMetadataItem label="Relay" value={run.relayId} mono />
              </section>

              <section className="border-b px-5 py-4">
                <h3 className="text-xs font-semibold">Run metadata</h3>
                <dl className="type-meta mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <RunMetadataRow label="Run ID" value={run.id} mono />
                  <RunMetadataRow
                    label="Schedule ID"
                    value={run.scheduleId}
                    mono
                  />
                  <RunMetadataRow
                    label="Revision"
                    value={`r${run.revision}`}
                    mono
                  />
                  <RunMetadataRow
                    label="Scheduled for"
                    value={fullTimestampLabel(
                      new Date(run.scheduledAt),
                      run.timezone
                    )}
                  />
                  <RunMetadataRow
                    label="Completed"
                    value={
                      run.status === "running"
                        ? "Not completed"
                        : fullTimestampLabel(
                            new Date(run.finishedAt),
                            run.timezone
                          )
                    }
                  />
                  <RunMetadataRow
                    label="Targets"
                    value={`${run.targetRuns.length}`}
                    mono
                  />
                </dl>
              </section>

              {run.sequenceAttempts.length > 0 ? (
                <section className="border-b px-5 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-xs font-semibold">
                        Sequence activity
                      </h3>
                      <p className="type-meta mt-0.5 text-muted-foreground">
                        Waits pause the sequence once between target actions.
                      </p>
                    </div>
                    <Badge variant="outline" className="type-meta font-mono">
                      {run.sequenceAttempts.length} attempts
                    </Badge>
                  </div>
                  <div className="mt-4 overflow-hidden rounded-lg border bg-background/35">
                    <ActionAttemptAudit
                      actionsById={actionsById}
                      attempts={run.sequenceAttempts}
                      timezone={run.timezone}
                    />
                  </div>
                </section>
              ) : null}

              <section className="px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xs font-semibold">Target activity</h3>
                    <p className="type-meta mt-0.5 text-muted-foreground">
                      Actions are shown in the order the Relay attempted them.
                    </p>
                  </div>
                  <Badge variant="outline" className="type-meta font-mono">
                    {run.targetRuns.reduce(
                      (count, targetRun) => count + targetRun.attempts.length,
                      0
                    )}{" "}
                    attempts
                  </Badge>
                </div>

                {run.targetRuns.length === 0 ? (
                  <div className="mt-4 rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
                    No targets were attempted for this run.
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {run.targetRuns.map((targetRun) => (
                      <TargetRunAudit
                        key={targetRun.id}
                        actionsById={actionsById}
                        run={targetRun}
                        timezone={run.timezone}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
})

function RunMetadataItem({
  label,
  value,
  detail,
  mono = false,
}: {
  label: string
  value: string
  detail?: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="min-w-0 bg-background px-5 py-3.5">
      <p className="type-technical-label text-muted-foreground">{label}</p>
      <p
        className={`mt-1 truncate text-xs font-medium text-foreground ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </p>
      {detail ? (
        <p className="type-meta mt-0.5 text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  )
}

function RunMetadataRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`type-meta mt-0.5 truncate text-foreground ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

function TargetRunAudit({
  actionsById,
  run,
  timezone,
}: {
  actionsById: ReadonlyMap<string, ScheduleAction>
  run: ScheduleHistoryRun["targetRuns"][number]
  timezone: string
}) {
  return (
    <article className="overflow-hidden rounded-lg border bg-background/35">
      <header className="flex items-center gap-3 border-b bg-muted/15 px-3 py-2.5">
        <TargetIcon
          kind={run.target.kind}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">{run.target.name}</p>
          <p className="type-meta truncate font-mono text-muted-foreground">
            {run.target.kind === "app" ? "App" : run.target.kind} · {run.target.id}
          </p>
        </div>
        <span className="type-meta text-muted-foreground">
          {durationLabel(run.finishedAt - run.startedAt)}
        </span>
        <RunResultIcon status={run.status} className="size-4 shrink-0" />
      </header>
      {run.error ? (
        <p className="type-meta border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive light:bg-destructive/10">
          {run.error}
        </p>
      ) : null}
      {run.attempts.length === 0 ? (
        <p className="type-meta px-3 py-4 text-muted-foreground">
          No actions were attempted.
        </p>
      ) : (
        <ActionAttemptAudit
          actionsById={actionsById}
          attempts={run.attempts}
          timezone={timezone}
        />
      )}
    </article>
  )
}

function ActionAttemptAudit({
  actionsById,
  attempts,
  timezone,
}: {
  actionsById: ReadonlyMap<string, ScheduleAction>
  attempts: ReadonlyArray<ScheduleHistoryRun["sequenceAttempts"][number]>
  timezone: string
}) {
  return (
    <ol className="divide-y divide-border/70">
      {attempts.map((attempt, index) => {
        const action = actionsById.get(attempt.actionId)
        return (
          <li key={attempt.id} className="flex gap-3 px-3 py-3">
            <span className="type-meta relative mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border bg-background font-mono text-muted-foreground">
              {index + 1}
            </span>
            <ActionIcon
              type={attempt.actionType}
              className="mt-1 size-3.5 shrink-0 text-primary-ink"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="type-card-title">
                  {actionLabel(attempt.actionType)}
                </p>
                <AttemptStatus status={attempt.status} />
              </div>
              <p className="type-meta mt-0.5 truncate font-mono text-muted-foreground">
                {actionAuditSummary(action, attempt.actionId)}
              </p>
              <p className="type-meta mt-1 text-muted-foreground">
                {timestampLabel(new Date(attempt.startedAt), timezone)} ·{" "}
                {durationLabel(attempt.finishedAt - attempt.startedAt)}
              </p>
              {attempt.error ? (
                <p className="type-meta mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-destructive light:bg-destructive/10">
                  {attempt.error}
                </p>
              ) : null}
              {attempt.result ? (
                <CommandResult result={attempt.result} />
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function AttemptStatus({
  status,
}: {
  status: ScheduleHistoryRun["targetRuns"][number]["attempts"][number]["status"]
}) {
  const succeeded = status === "succeeded"
  const failed = status === "failed" || status === "interrupted"
  // It may have run; nothing runs it again.
  const unknown = status === "unknown"
  return (
    <span
      className={`type-label inline-flex items-center gap-1 capitalize ${succeeded ? "text-emerald-400" : failed ? "text-destructive" : unknown ? "text-amber-300" : "text-muted-foreground"}`}
    >
      {succeeded ? (
        <Check className="size-3" />
      ) : failed ? (
        <X className="size-3" />
      ) : unknown ? (
        <CircleHelp className="size-3" />
      ) : (
        <CirclePause className="size-3" />
      )}
      {status.replaceAll("_", " ")}
    </span>
  )
}

// What a command run in a container printed, and how it exited.
function CommandResult({
  result,
}: {
  result: NonNullable<
    ScheduleHistoryRun["targetRuns"][number]["attempts"][number]["result"]
  >
}) {
  return (
    <div className="mt-2 min-w-0">
      <p className="type-meta text-muted-foreground">
        {result.exitCode === null
          ? "Exit code unknown"
          : `Exit code ${result.exitCode}`}
        {result.truncated ? " · showing the end of its output" : ""}
      </p>
      {result.output ? (
        <pre className="type-meta mt-1 max-h-48 overflow-auto rounded-md border bg-muted/40 px-2.5 py-2 font-mono break-all whitespace-pre-wrap">
          {result.output}
        </pre>
      ) : null}
    </div>
  )
}

function ScheduleEditorDialog({
  mode,
  options,
  storage,
  onClose,
  onSaved,
}: {
  mode: EditorMode
  options: ReadonlyArray<ScheduleOption>
  storage: ReadonlyArray<BackupStorage>
  onClose: () => void
  onSaved: (scheduleId: string) => void
}) {
  const queryClient = useQueryClient()
  const existing = mode.kind === "edit" ? mode.schedule : null
  const permissionKey = mode.kind === "create" ? "canCreate" : "canUpdate"
  const editorOptions = React.useMemo(() => {
    const referenced = new Set(existing?.targets.map(targetKey) ?? [])
    return options.filter(
      (option) => option.available || referenced.has(targetKey(option))
    )
  }, [existing, options])
  const [name, setName] = React.useState(existing?.name ?? "")
  const [cron, setCron] = React.useState(() =>
    normalizeScheduleCron(existing?.cron ?? "daily")
  )
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true)
  const [continueOnFailure, setContinueOnFailure] = React.useState(
    existing?.continueOnFailure ?? false
  )
  const [selectedTargets, setSelectedTargets] = React.useState(() => {
    if (existing) return new Set(existing.targets.map(targetKey))
    const selectable = editorOptions.filter((option) => option[permissionKey])
    const onlyTarget = selectable.length === 1 ? selectable[0] : undefined
    return new Set(onlyTarget ? [targetKey(onlyTarget)] : [])
  })
  const [actions, setActions] = React.useState<Array<ScheduleActionDraft>>(
    existing?.actions ?? []
  )
  const cronSummary = React.useMemo(() => cronDescription(cron), [cron])
  const selectedOptions = React.useMemo(
    () =>
      editorOptions.filter((option) => selectedTargets.has(targetKey(option))),
    [editorOptions, selectedTargets]
  )
  const completeActions = React.useMemo(() => {
    const selectedTargetKeys = new Set(
      selectedOptions.map((option) => targetKey(option))
    )
    const complete: Array<ScheduleAction> = []
    for (const action of actions) {
      if (!isCompleteScheduleAction(action)) continue
      // Marked as Hearth saves it, so what's checked here is what runs.
      const [scoped] = scheduleActionsForSave([
        action.type === "wait" || action.targetKeys === undefined
          ? action
          : {
              ...action,
              targetKeys: action.targetKeys.filter((key) =>
                selectedTargetKeys.has(key)
              ),
            },
      ])
      if (!scoped) continue
      complete.push(
        scoped.type === "console_command"
          ? { ...scoped, services: commandServices(scoped, selectedOptions) }
          : scoped
      )
    }
    return complete
  }, [actions, selectedOptions])
  const actionSelectionValid = completeActions.every((action) =>
    scheduleActionPermitted(action, selectedOptions, permissionKey)
  )
  const canSave =
    name.trim().length > 0 &&
    cronSummary !== null &&
    selectedOptions.length > 0 &&
    selectedOptions.every((option) => option.available) &&
    selectedOptions.every((option) => option[permissionKey]) &&
    actions.length > 0 &&
    actions.length === completeActions.length &&
    completeActions.every(scheduleActionIsConfigured) &&
    completeActions.every((action) =>
      commandServicesChosen(action, selectedOptions)
    ) &&
    actionSelectionValid

  const mutation = useMutation({
    mutationFn: async () => {
      const data = {
        actions: completeActions,
        continueOnFailure,
        cron,
        enabled,
        name,
        targets: selectedOptions.map(
          ({
            canCreate: _,
            canDelete: __,
            canExecute: ___,
            canUpdate: ____,
            available: _____,
            permittedActions: ______,
            relayName: _______,
            ...target
          }) => target
        ),
        // Kept for persisted schedule compatibility. Relays evaluate cron in
        // their own local timezone.
        timezone: existing?.timezone ?? "UTC",
      }
      return existing
        ? updateSchedule({
            data: { ...data, id: existing.id, revision: existing.revision },
          })
        : createSchedule({ data })
    },
    onSuccess: (schedule) => {
      upsertScheduleCache(queryClient, schedule)
      showToast({
        message: existing ? "Schedule updated" : "Schedule created",
        type: "success",
      })
      if (schedule) onSaved(schedule.id)
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "The schedule could not be saved"),
        type: "error",
      }),
  })

  const addAction = React.useCallback(() => {
    setActions((current) => [
      ...current,
      { id: crypto.randomUUID(), type: null },
    ])
  }, [])
  const updateAction = React.useCallback((next: ScheduleActionDraft) => {
    setActions((current) =>
      current.map((item) => (item.id === next.id ? next : item))
    )
  }, [])
  const moveEditorAction = React.useCallback(
    (actionId: string, direction: -1 | 1) => {
      setActions((current) => {
        const index = current.findIndex((action) => action.id === actionId)
        return index < 0 ? current : moveAction(current, index, direction)
      })
    },
    []
  )
  const reorderEditorAction = React.useCallback(
    (actionId: string, targetId: string) => {
      setActions((current) => reorderAction(current, actionId, targetId))
    },
    []
  )
  const removeAction = React.useCallback((actionId: string) => {
    setActions((current) => current.filter((action) => action.id !== actionId))
  }, [])
  const toggleTargets = React.useCallback(
    (keys: ReadonlyArray<string>, checked: boolean) => {
      setSelectedTargets((current) => {
        const next = new Set(current)
        for (const key of keys) {
          if (checked) next.add(key)
          else next.delete(key)
        }
        return next
      })
    },
    []
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid h-[min(90dvh,56rem)] max-h-none grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit schedule" : "Create schedule"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure when this schedule runs, which targets it applies to, and
            the actions it performs.
          </DialogDescription>
        </DialogHeader>

        <form
          action={() => {
            if (canSave && !mutation.isPending) mutation.mutate()
          }}
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-5"
        >
          <ScheduleEditorFields
            actionSelectionValid={actionSelectionValid}
            actions={actions}
            continueOnFailure={continueOnFailure}
            cron={cron}
            cronSummary={cronSummary}
            name={name}
            options={editorOptions}
            permissionKey={permissionKey}
            selectedOptions={selectedOptions}
            selectedOptionsCount={selectedOptions.length}
            selectedTargets={selectedTargets}
            storage={storage}
            onActionAdd={addAction}
            onActionChange={updateAction}
            onActionMove={moveEditorAction}
            onActionRemove={removeAction}
            onActionReorder={reorderEditorAction}
            onContinueOnFailureChange={setContinueOnFailure}
            onCronChange={setCron}
            onNameChange={setName}
            onTargetToggle={toggleTargets}
          />

          <DialogFooter className="flex-row flex-nowrap items-center">
            <Button
              aria-label={`Schedule is ${enabled ? "enabled" : "disabled"}. Click to ${enabled ? "disable" : "enable"}.`}
              aria-pressed={enabled}
              className={`mr-auto ${enabled ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-300 light:bg-emerald-500/20 light:text-emerald-700 light:hover:bg-emerald-500/30 light:hover:text-emerald-700" : "text-muted-foreground"}`}
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setEnabled((current) => !current)}
            >
              {enabled ? (
                <CircleCheck className="size-3.5" />
              ) : (
                <CirclePause className="size-3.5" />
              )}
              {enabled ? "Enabled" : "Disabled"}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                disabled={!canSave || mutation.isPending}
              >
                {mutation.isPending ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {existing ? "Save changes" : "Create schedule"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const ScheduleEditorFields = React.memo(function ScheduleEditorFields({
  actionSelectionValid,
  actions,
  continueOnFailure,
  cron,
  cronSummary,
  name,
  options,
  permissionKey,
  selectedOptions,
  selectedOptionsCount,
  selectedTargets,
  storage,
  onActionAdd,
  onActionChange,
  onActionMove,
  onActionRemove,
  onActionReorder,
  onContinueOnFailureChange,
  onCronChange,
  onNameChange,
  onTargetToggle,
}: {
  actionSelectionValid: boolean
  actions: ReadonlyArray<ScheduleActionDraft>
  continueOnFailure: boolean
  cron: string
  cronSummary: string | null
  name: string
  options: ReadonlyArray<ScheduleOption>
  permissionKey: "canCreate" | "canUpdate"
  selectedOptions: ReadonlyArray<ScheduleOption>
  selectedOptionsCount: number
  selectedTargets: ReadonlySet<string>
  storage: ReadonlyArray<BackupStorage>
  onActionAdd: () => void
  onActionChange: (action: ScheduleActionDraft) => void
  onActionMove: (actionId: string, direction: -1 | 1) => void
  onActionRemove: (actionId: string) => void
  onActionReorder: (actionId: string, targetId: string) => void
  onContinueOnFailureChange: (continueOnFailure: boolean) => void
  onCronChange: React.Dispatch<React.SetStateAction<string>>
  onNameChange: React.Dispatch<React.SetStateAction<string>>
  onTargetToggle: (keys: ReadonlyArray<string>, checked: boolean) => void
}) {
  return (
    <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-5">
      <ScheduleDetailsFields
        cron={cron}
        cronSummary={cronSummary}
        name={name}
        onCronChange={onCronChange}
        onNameChange={onNameChange}
      />
      <EditorSection
        aside={
          <span className="type-code text-muted-foreground">
            {selectedOptionsCount} selected
          </span>
        }
        title="Targets"
      >
        <ScheduleTargetSelector
          hideHeader
          options={options}
          permissionKey={permissionKey}
          selectedOptionsCount={selectedOptionsCount}
          selectedTargets={selectedTargets}
          onToggle={onTargetToggle}
        />
        {selectedOptions.some((option) => !option.available) ? (
          <p className="type-meta mt-2 text-destructive" role="alert">
            Remove unavailable targets before saving this schedule.
          </p>
        ) : null}
      </EditorSection>
      <EditorSection
        className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]"
        contentClassName="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
        aside={
          <div className="flex items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <label className="type-meta flex cursor-pointer items-center gap-2 text-muted-foreground">
                  <Switch
                    checked={continueOnFailure}
                    onCheckedChange={onContinueOnFailureChange}
                  />
                  Continue on failure
                </label>
              </TooltipTrigger>
              <TooltipContent>
                Run the remaining actions even if one fails or times out
              </TooltipContent>
            </Tooltip>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onActionAdd}
            >
              <Plus className="size-3.5" />
              Add Action
            </Button>
          </div>
        }
        title="Actions"
      >
        <ScheduleActionsEditor
          actions={actions}
          hideHeader
          permissionKey={permissionKey}
          selectedOptions={selectedOptions}
          storage={storage}
          onChange={onActionChange}
          onMove={onActionMove}
          onRemove={onActionRemove}
          onReorder={onActionReorder}
        />
        <ScheduleActionValidationMessage
          actions={actions}
          valid={actionSelectionValid}
        />
      </EditorSection>
    </div>
  )
})

function ScheduleActionValidationMessage({
  actions,
  valid,
}: {
  actions: ReadonlyArray<ScheduleActionDraft>
  valid: boolean
}) {
  return actions.some((action) => action.type !== null) && !valid ? (
    <p className="type-meta mt-2 text-destructive" role="alert">
      You do not have permission to configure one or more selected actions.
    </p>
  ) : null
}

const ScheduleDetailsFields = React.memo(function ScheduleDetailsFields({
  cron,
  cronSummary,
  name,
  onCronChange,
  onNameChange,
}: {
  cron: string
  cronSummary: string | null
  name: string
  onCronChange: React.Dispatch<React.SetStateAction<string>>
  onNameChange: React.Dispatch<React.SetStateAction<string>>
}) {
  const [timing, setTiming] = React.useState(() => cronPreset(cron))
  return (
    <div className="space-y-2.5">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field label="Name">
          <Input
            aria-label="Schedule name"
            autoComplete="off"
            data-1p-ignore
            data-bwignore
            data-lpignore="true"
            name="schedule-name"
            value={name}
            maxLength={120}
            placeholder="Daily server backup"
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>
        <Field label="Timing">
          <Select
            value={timing}
            onValueChange={(value) => {
              setTiming(value)
              if (value === "custom") return
              onCronChange(
                scheduleCronAliases[value as keyof typeof scheduleCronAliases]
              )
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hourly">Hourly</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.2fr)] sm:items-end">
        <Field label="Cron">
          <Input
            aria-label="Cron expression"
            className="font-mono"
            value={cron}
            maxLength={120}
            placeholder="0 0 * * *"
            onChange={(event) => {
              setTiming("custom")
              onCronChange(event.target.value)
            }}
          />
        </Field>
        <div
          className={`flex min-h-8 items-center rounded-lg border px-3 py-1 text-xs leading-5 ${cronSummary !== null ? "bg-muted/25 text-foreground" : "border-destructive/35 bg-destructive/5 text-destructive light:bg-destructive/10"}`}
          role={cronSummary === null ? "alert" : undefined}
        >
          {cronSummary ?? "Enter a valid five-part cron expression."}
        </div>
      </div>
    </div>
  )
})

const ScheduleTargetSelector = React.memo(function ScheduleTargetSelector({
  hideHeader = false,
  options,
  permissionKey,
  selectedOptionsCount,
  selectedTargets,
  onToggle,
}: {
  hideHeader?: boolean
  options: ReadonlyArray<ScheduleOption>
  permissionKey: "canCreate" | "canUpdate"
  selectedOptionsCount: number
  selectedTargets: ReadonlySet<string>
  onToggle: (keys: ReadonlyArray<string>, checked: boolean) => void
}) {
  const [open, setOpen] = React.useState(false)
  const pickerItems = React.useMemo(
    () =>
      options.map((option): InstancePickerItem => {
        const key = targetKey(option)
        return {
          ...scheduleTargetPickerItem(option),
          // Unavailable targets stay removable so stale schedules can be fixed.
          disabled:
            (!option[permissionKey] || !option.available) &&
            !(selectedTargets.has(key) && !option.available),
        }
      }),
    [options, permissionKey, selectedTargets]
  )
  const selectedNames = React.useMemo(() => {
    const names: Array<string> = []
    for (const option of options) {
      if (selectedTargets.has(targetKey(option)))
        names.push(option.kind === "relay" ? "Kiln" : option.name)
    }
    return names
  }, [options, selectedTargets])
  const selectTarget = React.useCallback(
    (item: InstancePickerItem) => {
      onToggle([item.key], !selectedTargets.has(item.key))
    },
    [onToggle, selectedTargets]
  )
  return (
    <div>
      {hideHeader ? null : (
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold">Targets</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Select every game server, database, or Kiln this schedule applies
              to.
            </p>
          </div>
          <span className="type-code text-muted-foreground">
            {selectedOptionsCount} selected
          </span>
        </div>
      )}
      <DrawerPopover open={open} onOpenChange={setOpen}>
        <DrawerPopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={`${hideHeader ? "" : "mt-3"} h-auto min-h-10 w-full justify-between gap-3 px-3 py-2 font-normal`}
          >
            <span className="min-w-0 truncate text-left">
              {selectedNames.length === 0
                ? "Select game servers, Apps, databases, or Relays"
                : selectedNames.slice(0, 3).join(", ")}
              {selectedNames.length > 3 ? ` +${selectedNames.length - 3}` : ""}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DrawerPopoverTrigger>
        <DrawerPopoverContent
          title="Targets"
          align="start"
          className="z-[70] w-[min(34rem,calc(100vw-2rem))] overflow-hidden p-0"
        >
          <InstancePickerContent
            multiple
            ariaLabel="Targets"
            emptyMessage="No accessible schedule targets found."
            items={pickerItems}
            selectedKeys={selectedTargets}
            onSelect={selectTarget}
            onSelectMany={onToggle}
          />
        </DrawerPopoverContent>
      </DrawerPopover>
    </div>
  )
})

const ScheduleActionsEditor = React.memo(function ScheduleActionsEditor({
  actions,
  hideHeader = false,
  permissionKey,
  selectedOptions,
  storage,
  onChange,
  onMove,
  onRemove,
  onReorder,
}: {
  actions: ReadonlyArray<ScheduleActionDraft>
  hideHeader?: boolean
  permissionKey: "canCreate" | "canUpdate"
  selectedOptions: ReadonlyArray<ScheduleOption>
  storage: ReadonlyArray<BackupStorage>
  onChange: (action: ScheduleActionDraft) => void
  onMove: (actionId: string, direction: -1 | 1) => void
  onRemove: (actionId: string) => void
  onReorder: (actionId: string, targetId: string) => void
}) {
  const [draggedActionId, setDraggedActionId] = React.useState<string | null>(
    null
  )
  const draggedActionIdRef = React.useRef<string | null>(null)
  const actionViewportRef = React.useRef<HTMLDivElement>(null)
  const previousActionCountRef = React.useRef(actions.length)
  React.useEffect(() => {
    const actionAdded = actions.length > previousActionCountRef.current
    previousActionCountRef.current = actions.length
    if (actionAdded && actionViewportRef.current) {
      const viewport = actionViewportRef.current
      const rows = viewport.querySelectorAll<HTMLElement>(
        "[data-schedule-action-row]"
      )
      const lastRow = rows.item(rows.length - 1)
      const revealThrough = lastRow
        ? lastRow.offsetTop - viewport.offsetTop + lastRow.offsetHeight / 2
        : 0
      if (revealThrough > viewport.scrollTop + viewport.clientHeight) {
        viewport.scrollTop = revealThrough - viewport.clientHeight
      }
    }
  }, [actions.length])
  const startDragging = React.useCallback((actionId: string) => {
    draggedActionIdRef.current = actionId
    setDraggedActionId(actionId)
  }, [])
  const stopDragging = React.useCallback(() => {
    draggedActionIdRef.current = null
    setDraggedActionId(null)
  }, [])
  const dragOverAction = React.useCallback(
    (targetId: string) => {
      const actionId = draggedActionIdRef.current
      if (actionId && actionId !== targetId) onReorder(actionId, targetId)
    },
    [onReorder]
  )
  return (
    <div className="h-full min-h-0">
      {hideHeader ? null : <h3 className="text-sm font-semibold">Actions</h3>}
      <div
        ref={actionViewportRef}
        aria-label="Schedule actions"
        className={`${hideHeader ? "" : "mt-3"} h-full min-h-0 [scrollbar-gutter:stable] overflow-y-auto overscroll-contain pr-1`}
        role="region"
      >
        {actions.length === 0 ? (
          <div className="grid h-full place-items-center rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            Add an action to build this schedule.
          </div>
        ) : (
          <div className="space-y-2">
            {actions.map((action, index) => (
              <ActionEditor
                key={action.id}
                action={action}
                dragging={draggedActionId === action.id}
                index={index}
                permissionKey={permissionKey}
                selectedOptions={selectedOptions}
                storage={storage}
                total={actions.length}
                onChange={onChange}
                onDragEnd={stopDragging}
                onDragOver={dragOverAction}
                onDragStart={startDragging}
                onMove={onMove}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

function EditorSection({
  aside,
  children,
  className = "",
  contentClassName = "space-y-3",
  title,
}: {
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
  title: string
}) {
  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-xs font-semibold">{title}</h3>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      <div className={`mt-2.5 ${contentClassName}`}>{children}</div>
    </section>
  )
}

function Field({
  label,
  labelId,
  hint,
  className,
  children,
}: {
  label: string
  labelId?: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={className}>
      <span
        id={labelId}
        className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium"
      >
        {label}
        {hint ? (
          <span className="font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  )
}

const ActionEditor = React.memo(function ActionEditor({
  action,
  dragging,
  index,
  permissionKey,
  selectedOptions,
  storage,
  total,
  onChange,
  onDragEnd,
  onDragOver,
  onDragStart,
  onMove,
  onRemove,
}: {
  action: ScheduleActionDraft
  dragging: boolean
  index: number
  permissionKey: "canCreate" | "canUpdate"
  selectedOptions: ReadonlyArray<ScheduleOption>
  storage: ReadonlyArray<BackupStorage>
  total: number
  onChange: (action: ScheduleActionDraft) => void
  onDragEnd: () => void
  onDragOver: (actionId: string) => void
  onDragStart: (actionId: string) => void
  onMove: (actionId: string, direction: -1 | 1) => void
  onRemove: (actionId: string) => void
}) {
  const [backupConfigOpen, setBackupConfigOpen] = React.useState(false)
  const {
    actionTargetKeys,
    commandApps,
    eligibleTargets,
    namedRestrictedTargets,
    restrictedTargets,
    selectedActionTargets,
    unsupportedTargets,
  } = React.useMemo(() => {
    if (action.type === null || action.type === "wait") {
      return {
        actionTargetKeys: new Set<string>(),
        commandApps: [],
        eligibleTargets: [],
        namedRestrictedTargets: [],
        restrictedTargets: [],
        selectedActionTargets: [],
        unsupportedTargets: [],
      }
    }
    const eligible = selectedOptions.filter(
      (target) =>
        scheduleActionSupportsTarget(action, target) &&
        target[permissionKey] &&
        target.permittedActions.includes(action.type)
    )
    // Without its own list, a step runs where the Relay runs it: every
    // target but those it must name.
    const keys = new Set<string>(
      action.targetKeys ??
        eligible
          .filter((target) => !scheduleActionNeedsNamedTarget(action, target))
          .map((target) => targetKey(target))
    )
    const selected = eligible.filter((target) => keys.has(targetKey(target)))
    const restricted = selectedOptions.filter(
      (target) =>
        scheduleActionSupportsTarget(action, target) &&
        (!target[permissionKey] ||
          !target.permittedActions.includes(action.type))
    )
    // Targets a saved step names that this person can't run it on, as when
    // it was saved before commands reached databases. They show as chosen so
    // they can be removed, and can't be chosen again.
    const namedRestricted = restricted.filter(
      (target) => action.targetKeys?.includes(targetKey(target)) === true
    )
    return {
      actionTargetKeys: keys,
      commandApps:
        action.type === "console_command"
          ? selected.filter((target) => target.kind === "app")
          : [],
      eligibleTargets: eligible,
      namedRestrictedTargets: namedRestricted,
      restrictedTargets: restricted,
      selectedActionTargets: [...selected, ...namedRestricted],
      unsupportedTargets: selectedOptions.filter(
        (target) => !scheduleActionSupportsTarget(action, target)
      ),
    }
  }, [action, permissionKey, selectedOptions])
  const backsUpAppsOnly =
    action.type === "backup" &&
    selectedActionTargets.length > 0 &&
    selectedActionTargets.every((target) => target.kind === "app")
  const changeAction = React.useCallback(
    (next: ScheduleActionDraft) =>
      onChange(
        namingNewTargets(action, next, selectedOptions, permissionKey)
      ),
    [action, onChange, permissionKey, selectedOptions]
  )
  const appServiceOptions = useAppServices(commandApps)
  // An App with one service runs the command there unless someone picks
  // otherwise.
  React.useEffect(() => {
    if (action.type !== "console_command") return
    const defaults: Record<string, string> = {}
    for (const target of commandApps) {
      const key = targetKey(target)
      const services = appServiceOptions.get(key)
      if (!action.services?.[key] && services?.length === 1) {
        defaults[key] = services[0]!
      }
    }
    if (Object.keys(defaults).length === 0) return
    onChange({ ...action, services: { ...action.services, ...defaults } })
  }, [action, appServiceOptions, commandApps, onChange])

  return (
    <div
      data-schedule-action-row
      className={`${namedRestrictedTargets.length > 0 ? "space-y-2" : action.type === "wait" ? "h-20 sm:h-16" : "h-12 sm:h-16"} rounded-lg border bg-background/45 p-1 transition-[border-color,opacity] sm:p-2 ${dragging ? "border-primary/40 opacity-55" : ""}`}
      onDragOver={(event) => {
        event.preventDefault()
        onDragOver(action.id)
      }}
      onDrop={(event) => event.preventDefault()}
    >
      <div
        className={`grid items-center gap-0.5 sm:grid-cols-[2rem_9rem_minmax(0,1fr)_auto] sm:grid-rows-1 sm:gap-2 ${namedRestrictedTargets.length > 0 ? "h-10 sm:h-12" : "h-full"} ${action.type === "wait" ? "grid-cols-[1.25rem_minmax(0,1fr)_auto] grid-rows-2" : "grid-cols-[1.25rem_8rem_minmax(0,1fr)_auto]"}`}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={`Reorder action ${index + 1}. Use arrow keys or drag.`}
              className={`-my-1 grid h-[calc(100%+0.5rem)] w-5 cursor-grab place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing sm:-my-2 sm:h-[calc(100%+1rem)] sm:w-8 ${action.type === "wait" ? "row-span-2 sm:row-span-1" : ""}`}
              draggable
              type="button"
              onDragEnd={onDragEnd}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", action.id)
                onDragStart(action.id)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp" && index > 0) {
                  event.preventDefault()
                  onMove(action.id, -1)
                }
                if (event.key === "ArrowDown" && index < total - 1) {
                  event.preventDefault()
                  onMove(action.id, 1)
                }
              }}
            >
              <GripVertical className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Drag to reorder</TooltipContent>
        </Tooltip>
        <div
          className={`flex min-w-0 items-center ${action.type === "wait" ? "col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto" : ""}`}
        >
          <ScheduleActionTypeSelect
            action={action}
            index={index}
            onChange={changeAction}
          />
        </div>
        <div
          className={`flex w-fit max-w-full min-w-0 items-center gap-1.5 justify-self-start ${action.type === "wait" ? "col-start-2 row-start-2 sm:col-start-auto sm:row-start-auto" : ""}`}
        >
          {action.type === "console_command" ? (
            <CommandEditorField
              apps={commandApps}
              appServices={appServiceOptions}
              services={action.services}
              targetKinds={selectedActionTargets.map((target) => target.kind)}
              value={action.command}
              onChange={(command, services) =>
                onChange({ ...action, command, services })
              }
            />
          ) : action.type === "backup" ? (
            <Button
              aria-label="Configure Backup"
              className="size-8 max-w-full min-w-0 justify-center truncate px-0 sm:w-fit sm:justify-start sm:px-2.5"
              type="button"
              title={action.name}
              variant="outline"
              onClick={() => setBackupConfigOpen(true)}
            >
              <SlidersHorizontal className="size-4 shrink-0" />
              <span className="hidden truncate sm:inline">
                Configure Backup
              </span>
            </Button>
          ) : action.type === "power" ? (
            <Select
              value={action.action}
              onValueChange={(value) =>
                changeAction({
                  ...action,
                  action: value as typeof action.action,
                })
              }
            >
              <SelectTrigger className="h-8 w-20 min-w-0 font-medium sm:w-28 [&_[data-slot=select-value]]:truncate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="start">Start</SelectItem>
                <SelectItem value="stop">Stop</SelectItem>
                <SelectItem value="restart">Restart</SelectItem>
                <SelectItem value="kill">Kill</SelectItem>
              </SelectContent>
            </Select>
          ) : action.type === "wait" ? (
            <WaitEditorFields action={action} onChange={onChange} />
          ) : null}
        </div>
        <div
          className={`flex shrink-0 items-center gap-0.5 ${action.type === "wait" ? "col-start-3 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto" : ""}`}
        >
          {action.type !== null && action.type !== "wait" ? (
            <>
              <ActionCompatibilityWarning
                restrictedTargets={restrictedTargets}
                unsupportedTargets={unsupportedTargets}
              />
              <ScheduleActionTargetsButton
                action={action}
                eligibleTargets={eligibleTargets}
                targets={selectedOptions}
                selectedTargets={selectedActionTargets}
                onToggle={(targetKeyValues, checked) => {
                  if (action.type === null) return
                  const eligibleKeys = new Set(eligibleTargets.map(targetKey))
                  const next = new Set([
                    ...actionTargetKeys,
                    ...namedRestrictedTargets.map(targetKey),
                  ])
                  for (const targetKeyValue of targetKeyValues) {
                    // Only targets this person may run it on can be added.
                    if (checked && eligibleKeys.has(targetKeyValue))
                      next.add(targetKeyValue)
                    else if (!checked) next.delete(targetKeyValue)
                  }
                  onChange({ ...action, targetKeys: [...next] })
                }}
              />
              <Separator
                className="mx-1 data-vertical:h-4 data-vertical:self-center"
                orientation="vertical"
              />
            </>
          ) : null}
          <ActionRowButton
            disabled={total === 1 || index === total - 1}
            icon={ArrowDown}
            label={`Move action ${index + 1} down`}
            tooltip="Move down"
            onClick={() => onMove(action.id, 1)}
          />
          <ActionRowButton
            disabled={total === 1 || index === 0}
            icon={ArrowUp}
            label={`Move action ${index + 1} up`}
            tooltip="Move up"
            onClick={() => onMove(action.id, -1)}
          />
          <ActionRowButton
            destructive
            icon={Trash2}
            label={`Delete action ${index + 1}`}
            tooltip="Delete action"
            onClick={() => onRemove(action.id)}
          />
        </div>
      </div>
      {action.type === "backup" ? (
        <BackupConfigurationDialog
          allowDefaultDestination={false}
          allowIncremental
          // A step that backs up only Apps takes them live or stopped, each
          // App's folder and owned volumes together; Hearth checks stopping
          // them as it saves.
          consistencyChoice={
            backsUpAppsOnly
              ? {
                  stoppedDescription:
                    "Stops each App once for its folder and every volume it owns",
                  stoppedUnavailable: null,
                }
              : undefined
          }
          {...(backsUpAppsOnly
            ? {
                description:
                  "Relay runs this job in its single durable queue. Each App's folder and every volume it owns are backed up together.",
              }
            : {})}
          initialConsistency={action.consistency ?? "live"}
          initialDestinationKeys={
            action.destination.kind === "storage"
              ? [action.destination.storageId]
              : ["local"]
          }
          initialMode={action.mode}
          initialName={action.name}
          onOpenChange={setBackupConfigOpen}
          onSubmit={(configuration) => {
            const { consistency: _consistency, ...rest } = action
            onChange({
              ...rest,
              ...(backsUpAppsOnly && configuration.consistency === "stopped"
                ? { consistency: "stopped" as const }
                : {}),
              destination: scheduleBackupDestination(
                configuration.destinationKeys[0]
              ),
              mode: backsUpAppsOnly ? "full" : configuration.mode,
              name: configuration.name,
            })
            setBackupConfigOpen(false)
          }}
          open={backupConfigOpen}
          showTarget={false}
          singleDestination
          storage={storage}
          submitLabel="Save backup"
          targets={selectedOptions.filter(isBackupOption).map(scheduleBackupTarget)}
          title="Configure Backup"
        />
      ) : null}
      {action.type !== null && namedRestrictedTargets.length > 0 ? (
        <NamedRestrictedTargetsNote
          action={action}
          targets={namedRestrictedTargets}
        />
      ) : null}
    </div>
  )
})

// Why a step that names targets this person can't run it on can't be saved,
// and what to do about it.
function NamedRestrictedTargetsNote({
  action,
  targets,
}: {
  action: ScheduleAction
  targets: ReadonlyArray<ScheduleOption>
}) {
  const shell = (target: ScheduleOption) =>
    action.type === "console_command" &&
    (target.kind === "database" || target.kind === "app")
  const databases = targets.filter(
    (target) => shell(target) && target.kind === "database"
  )
  const apps = targets.filter((target) => shell(target) && target.kind === "app")
  const others = targets.filter((target) => !shell(target))
  return (
    <p className="type-meta rounded-md border border-amber-400/30 bg-amber-400/5 px-2.5 py-2 text-pretty text-amber-300 light:text-amber-700">
      {databases.length > 0
        ? `Saving runs this command in ${targetList(databases)}'s shell, which needs Relay terminal permission. `
        : null}
      {apps.length > 0
        ? `Saving runs this command in ${targetList(apps)}'s shell, which needs App terminal permission. `
        : null}
      {others.length > 0
        ? `You don't have permission to run this action on ${targetList(others)}. `
        : null}
      Remove {targetList(targets)} from this step to save.
    </p>
  )
}

const ScheduleActionTargetsButton = React.memo(
  function ScheduleActionTargetsButton({
    action,
    eligibleTargets,
    onToggle,
    selectedTargets,
    targets,
  }: {
    action: ScheduleAction
    eligibleTargets: ReadonlyArray<ScheduleOption>
    onToggle: (targetKeys: ReadonlyArray<string>, checked: boolean) => void
    selectedTargets: ReadonlyArray<ScheduleOption>
    targets: ReadonlyArray<ScheduleOption>
  }) {
    const [open, setOpen] = React.useState(false)
    const selectedKeys = React.useMemo(
      () => new Set(selectedTargets.map(targetKey)),
      [selectedTargets]
    )
    // A target it can't run on stays removable while the step names it.
    const items = React.useMemo(() => {
      const eligibleKeys = new Set(eligibleTargets.map(targetKey))
      return targets.map((target): InstancePickerItem => ({
        ...scheduleTargetPickerItem(target),
        disabled:
          !eligibleKeys.has(targetKey(target)) &&
          !selectedKeys.has(targetKey(target)),
      }))
    }, [eligibleTargets, selectedKeys, targets])
    const toggleTarget = React.useCallback(
      (item: InstancePickerItem) =>
        onToggle([item.key], !selectedKeys.has(item.key)),
      [onToggle, selectedKeys]
    )

    return (
      <DrawerPopover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DrawerPopoverTrigger asChild>
              <Button
                aria-expanded={open}
                aria-label={`${selectedTargets.length} ${selectedTargets.length === 1 ? "target" : "targets"} for ${actionLabel(action.type)}`}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Server className="size-3.5" />
              </Button>
            </DrawerPopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {selectedTargets.length} action targets
          </TooltipContent>
        </Tooltip>
        <DrawerPopoverContent
          title="Action targets"
          align="end"
          className="z-[70] w-[min(28rem,calc(100vw-2rem))] overflow-hidden p-0"
        >
          <p className="type-meta border-b border-border/70 px-3.5 py-2 text-muted-foreground">
            Choose which of this schedule&apos;s targets run this action.
          </p>
          <InstancePickerContent
            multiple
            ariaLabel="Action targets"
            emptyMessage="No compatible targets selected."
            items={items}
            selectedKeys={selectedKeys}
            onSelect={toggleTarget}
            onSelectMany={onToggle}
          />
        </DrawerPopoverContent>
      </DrawerPopover>
    )
  }
)

// A Relay target is Kiln itself, backed up on that Relay.
function scheduleTargetPickerItem(option: ScheduleOption): InstancePickerItem {
  const kind =
    option.kind === "instance"
      ? "Game Server"
      : option.kind === "database"
        ? "Database"
        : option.kind === "app"
          ? "App"
          : "Kiln"
  return {
    identity:
      option.kind === "instance"
        ? { id: option.id, kind: "server", relayId: option.relayId }
        : option.kind === "database" || option.kind === "app"
          ? { id: option.id, kind: option.kind, relayId: option.relayId }
          : {
              id: option.relayId,
              kind: "relay",
              platform: true,
              relayId: option.relayId,
              source: "fleet",
            },
    key: targetKey(option),
    meta: option.available
      ? option.kind === "relay"
        ? `On ${option.relayName}`
        : `${option.relayName} · ${option.id.slice(0, 8)}`
      : `Unavailable · ${kind} · ${option.relayName}`,
    name: option.kind === "relay" ? "Kiln" : option.name,
    searchText: `${kind} ${option.relayName} ${option.id}`,
  }
}

// The targets the backup dialog lists. It names game servers, databases,
// and Kiln; an App's backups are of its folder and volumes, set live or
// stopped there instead.
function isBackupOption(
  target: ScheduleOption
): target is ScheduleOption & { kind: Exclude<ScheduleOption["kind"], "app"> } {
  return target.kind !== "app"
}

function scheduleBackupTarget(
  target: ScheduleOption & { kind: Exclude<ScheduleOption["kind"], "app"> }
): BackupConfigurationTarget {
  return {
    id: target.id,
    key: targetKey(target),
    kind: target.kind === "relay" ? "platform" : target.kind,
    name: target.kind === "relay" ? "Kiln" : target.name,
    relayId: target.relayId,
    relayName: target.relayName,
  }
}

const ActionRowButton = React.memo(function ActionRowButton({
  destructive = false,
  disabled = false,
  icon: Icon,
  label,
  tooltip,
  onClick,
}: {
  destructive?: boolean
  disabled?: boolean
  icon: typeof ArrowDown
  label: string
  tooltip: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={
            destructive ? "text-destructive hover:text-destructive" : undefined
          }
          disabled={disabled}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onClick}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
})

function ActionCompatibilityWarning({
  restrictedTargets,
  unsupportedTargets,
}: {
  restrictedTargets: ReadonlyArray<ScheduleOption>
  unsupportedTargets: ReadonlyArray<ScheduleOption>
}) {
  if (restrictedTargets.length === 0 && unsupportedTargets.length === 0) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="Action compatibility warning"
          className="grid size-7 shrink-0 place-items-center rounded-md text-amber-400 outline-none hover:bg-amber-400/10 focus-visible:ring-2 focus-visible:ring-ring/40 light:text-amber-700 light:hover:bg-amber-400/20"
          type="button"
        >
          <TriangleAlert className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1 text-pretty" side="top">
        {unsupportedTargets.length > 0 ? (
          <p>
            This action will be skipped on {targetList(unsupportedTargets)}
            because they do not support it.
          </p>
        ) : null}
        {restrictedTargets.length > 0 ? (
          <p>
            You do not have permission to run this action on{" "}
            {targetList(restrictedTargets)}.
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}

const ScheduleActionTypeSelect = React.memo(function ScheduleActionTypeSelect({
  action,
  index,
  onChange,
}: {
  action: ScheduleActionDraft
  index: number
  onChange: (action: ScheduleActionDraft) => void
}) {
  return (
    <Select
      value={action.type ?? ""}
      onValueChange={(value) =>
        onChange(
          createScheduleAction(value as ScheduleAction["type"], action.id)
        )
      }
    >
      <SelectTrigger
        aria-label={`Action ${index + 1} type`}
        className="h-8 min-w-0 flex-1 justify-start text-sm font-medium [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:truncate [&_[data-slot=select-value]]:text-left"
      >
        {action.type === null ? (
          <SelectValue placeholder="Select Action" />
        ) : (
          <>
            <ActionIcon
              type={action.type}
              className="size-4 shrink-0 text-primary-ink"
            />
            <SelectValue>{actionLabel(action.type)}</SelectValue>
          </>
        )}
      </SelectTrigger>
      <SelectContent>
        <ScheduleActionTypeOption type="console_command" />
        <ScheduleActionTypeOption type="backup" />
        <ScheduleActionTypeOption type="power" />
        <ScheduleActionTypeOption type="wait" />
      </SelectContent>
    </Select>
  )
})

function ScheduleActionTypeOption({ type }: { type: ScheduleAction["type"] }) {
  return (
    <SelectItem value={type}>
      <span className="flex items-center gap-2">
        <ActionIcon type={type} className="size-4 text-muted-foreground" />
        {actionLabel(type)}
      </span>
    </SelectItem>
  )
}

const CommandEditorField = React.memo(function CommandEditorField({
  apps,
  appServices,
  services,
  targetKinds,
  value,
  onChange,
}: {
  apps: ReadonlyArray<ScheduleOption>
  appServices: ReadonlyMap<string, ReadonlyArray<string> | undefined>
  services: Readonly<Record<string, string>> | undefined
  targetKinds: ReadonlyArray<ScheduleTarget["kind"]>
  value: string
  onChange: (value: string, services: Record<string, string> | undefined) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const [serviceDraft, setServiceDraft] = React.useState(services)
  const openEditor = React.useCallback(() => {
    setDraft(value)
    setServiceDraft(services)
    setOpen(true)
  }, [services, value])
  const unchosen = apps.some((app) => !services?.[targetKey(app)])
  const consoles = targetKinds.includes("instance")
  const shells = targetKinds.some(
    (kind) => kind === "app" || kind === "database"
  )
  return (
    <>
      <Button
        aria-label="Configure Command"
        className="size-8 max-w-full min-w-0 justify-center truncate px-0 sm:w-fit sm:justify-start sm:px-2.5"
        type="button"
        title={
          unchosen
            ? "Choose the service each App runs the command in"
            : value || "Configure Command"
        }
        variant="outline"
        onClick={openEditor}
      >
        {unchosen ? (
          <TriangleAlert className="size-4 shrink-0 text-amber-400" />
        ) : (
          <SlidersHorizontal className="size-4 shrink-0" />
        )}
        <span className="hidden truncate sm:inline">Configure Command</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Configure Command</DialogTitle>
            <DialogDescription className={shells ? undefined : "sr-only"}>
              {shells
                ? `${consoles ? "Game servers get it in their console. " : ""}Apps and databases run it with sh in their container, for up to 10 minutes; the run keeps its exit code and the end of its output.`
                : "Enter the console command this action should run."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            aria-label="Command editor"
            className="min-h-40 resize-y font-mono text-xs"
            maxLength={4096}
            placeholder={
              consoles ? "say Server backing up..." : "php artisan migrate"
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {apps.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-xs font-medium">Runs in</p>
              {apps.map((app) => {
                const key = targetKey(app)
                return (
                  <AppServiceSelect
                    key={key}
                    name={app.name}
                    services={appServices.get(key)}
                    value={serviceDraft?.[key]}
                    onChange={(service) =>
                      setServiceDraft((current) => ({
                        ...current,
                        [key]: service,
                      }))
                    }
                  />
                )
              })}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                onChange(draft, serviceDraft)
                setOpen(false)
              }}
            >
              Save command
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

const WaitEditorFields = React.memo(function WaitEditorFields({
  action,
  onChange,
}: {
  action: Extract<ScheduleAction, { type: "wait" }>
  onChange: (action: ScheduleActionDraft) => void
}) {
  return (
    <>
      <Input
        aria-label="Wait duration"
        className="h-8 w-20 font-mono sm:w-24"
        inputMode="numeric"
        min={1}
        step={1}
        type="number"
        value={action.duration || ""}
        onChange={(event) =>
          onChange({
            ...action,
            duration: event.target.valueAsNumber || 0,
          })
        }
      />
      <Select
        value={action.unit}
        onValueChange={(value) =>
          onChange({
            ...action,
            unit: value as typeof action.unit,
          })
        }
      >
        <SelectTrigger
          aria-label="Wait time unit"
          className="h-8 w-24 min-w-0 font-medium sm:w-32 [&_[data-slot=select-value]]:truncate"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="milliseconds">Milliseconds</SelectItem>
          <SelectItem value="seconds">Seconds</SelectItem>
          <SelectItem value="minutes">Minutes</SelectItem>
          <SelectItem value="hours">Hours</SelectItem>
          <SelectItem value="days">Days</SelectItem>
        </SelectContent>
      </Select>
    </>
  )
})

function DeleteScheduleDialog({
  schedule,
  onClose,
}: {
  schedule: Schedule | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      schedule
        ? deleteSchedule({ data: { id: schedule.id } })
        : Promise.resolve(null),
    onSuccess: () => {
      if (schedule) removeScheduleFromCache(queryClient, schedule.id)
      showToast({ message: "Schedule deleted", type: "success" })
      onClose()
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "The schedule could not be deleted"),
        type: "error",
      }),
  })
  return (
    <Dialog
      open={schedule !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete schedule?</DialogTitle>
          <DialogDescription>
            {schedule?.name} will stop running on every Relay. Existing run
            history is retained.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunStatusDot({
  status,
}: {
  status: Schedule["runs"][number]["status"]
}) {
  const label = status.replaceAll("_", " ")
  return (
    <span
      className={`type-label inline-flex items-center gap-1.5 capitalize ${status === "succeeded" ? "text-emerald-400" : status === "failed" || status === "interrupted" ? "text-destructive" : status === "partial" || status === "running" ? "text-amber-300" : "text-muted-foreground"}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${status === "succeeded" ? "bg-emerald-400" : status === "failed" || status === "interrupted" ? "bg-destructive" : status === "partial" || status === "running" ? `${status === "running" ? "animate-pulse " : ""}bg-amber-400` : "bg-muted-foreground"}`}
      />
      <span className="hidden sm:inline">{label}</span>
    </span>
  )
}

function RunResultIcon({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  if (status === "succeeded") {
    return (
      <CircleCheck
        className={`${className ?? ""} text-emerald-400 light:text-emerald-700`}
      />
    )
  }
  if (status === "running") {
    return (
      <LoaderCircle
        className={`${className ?? ""} animate-spin text-amber-300 light:text-amber-700`}
      />
    )
  }
  if (status === "partial") {
    return (
      <CircleX
        className={`${className ?? ""} text-amber-300 light:text-amber-700`}
      />
    )
  }
  if (status === "noop" || status.startsWith("skipped")) {
    return (
      <CirclePause className={`${className ?? ""} text-muted-foreground`} />
    )
  }
  return <CircleX className={`${className ?? ""} text-destructive`} />
}

function TargetIcon({
  kind,
  className,
}: {
  kind: ScheduleTarget["kind"]
  className?: string
}) {
  const Icon = kind === "instance" ? ServerKindIcon : instanceKindIcons[kind]
  return <Icon className={className} aria-hidden="true" />
}

function ActionIcon({
  type,
  className,
}: {
  type: ScheduleAction["type"]
  className?: string
}) {
  const Icon =
    type === "console_command"
      ? Code2
      : type === "backup"
        ? BackupIcon
        : type === "wait"
          ? Timer
          : Power
  return <Icon className={className} aria-hidden="true" />
}

function actionLabel(type: ScheduleAction["type"]) {
  if (type === "console_command") return "Command"
  if (type === "backup") return "Backup"
  if (type === "wait") return "Wait"
  return "Power"
}

function actionAuditSummary(
  action: ScheduleAction | undefined,
  actionId: string
) {
  if (!action) return `Action ${actionId}`
  if (action.type === "console_command") return action.command
  if (action.type === "backup") return action.name
  if (action.type === "wait") return waitDurationLabel(action)
  return action.action
}

function runStatusLabel(status: string) {
  return status
    .replaceAll("_", " ")
    .replace(/^./u, (value) => value.toUpperCase())
}

function targetKey(target: Pick<ScheduleTarget, "id" | "kind" | "relayId">) {
  return `${target.relayId}:${target.kind}:${target.id}`
}

function scheduleOptionsWithInstanceNames(
  options: ReadonlyArray<ScheduleOption>,
  instances: ReadonlyArray<{
    id: string
    name: string
    relayId: string
    relayName: string
  }>
): Array<ScheduleOption> {
  const instancesById = new Map(
    instances.map((instance) => [
      `${instance.relayId}:${instance.id}`,
      instance,
    ])
  )
  return options.map((option) => {
    if (option.kind !== "instance") return option
    const instance = instancesById.get(`${option.relayId}:${option.id}`)
    return instance
      ? { ...option, name: instance.name, relayName: instance.relayName }
      : option
  })
}

// A Relay target backs Kiln up, which only the Relay on Kiln's host can do.
// Others stay listed only where a schedule already names them, so it can be
// fixed.
function kilnScheduleOptions(
  options: ReadonlyArray<ScheduleOption>,
  kiln: KilnBackupHost | null,
  schedules: ReadonlyArray<Pick<Schedule, "targets">>
): Array<ScheduleOption> {
  const named = new Set(
    schedules.flatMap((schedule) =>
      schedule.targets.flatMap((target) =>
        target.kind === "relay" ? [target.relayId] : []
      )
    )
  )
  return options.filter(
    (option) =>
      option.kind !== "relay" ||
      option.relayId === kiln?.relayId ||
      named.has(option.relayId)
  )
}

function selectIsPlatformAdmin(capabilities: { isPlatformAdmin: boolean }) {
  return capabilities.isPlatformAdmin
}

function selectScheduleTargetInstances(snapshot: RelaySnapshot) {
  return snapshot.instances.map(({ id, name, relayId, relayName }) => ({
    id,
    name,
    relayId,
    relayName,
  }))
}

function canOperateSchedule(
  schedule: Pick<Schedule, "actions" | "targets">,
  options: ReadonlyMap<string, ScheduleOption>,
  permission: "canCreate" | "canExecute" | "canUpdate"
) {
  return schedule.targets.every((target) => {
    const option = options.get(targetKey(target))
    if (!option?.[permission]) return false
    const permittedActions = new Set(option.permittedActions)
    return schedule.actions.every(
      (action) =>
        !scheduleActionAppliesToTarget(action, target) ||
        permittedActions.has(action.type)
    )
  })
}

/**
 * Choosing a command or kill for targets that must be named, such as
 * databases, names every target it can run on, so they're included and
 * authorized as such.
 */
function namingNewTargets(
  previous: ScheduleActionDraft,
  next: ScheduleActionDraft,
  targets: ReadonlyArray<ScheduleOption>,
  permission: "canCreate" | "canUpdate"
): ScheduleActionDraft {
  if (next.type === null || next.type === "wait") return next
  if (next.targetKeys !== undefined) return next
  const chosen =
    previous.type !== next.type ||
    (previous.type === "power" &&
      next.type === "power" &&
      previous.action !== next.action)
  if (!chosen) return next
  const eligible = targets.filter(
    (target) =>
      scheduleActionSupportsTarget(next, target) &&
      target[permission] &&
      target.permittedActions.includes(next.type)
  )
  if (!eligible.some((target) => scheduleActionNeedsNamedTarget(next, target)))
    return next
  return { ...next, targetKeys: eligible.map((target) => targetKey(target)) }
}

function scheduleActionPermitted(
  action: ScheduleAction,
  targets: ReadonlyArray<ScheduleOption>,
  permission: "canCreate" | "canUpdate"
) {
  if (action.type === "wait") return true
  const compatible = targets.filter((target) =>
    scheduleActionAppliesToTarget(action, target)
  )
  return compatible.every(
    (target) =>
      target[permission] && target.permittedActions.includes(action.type)
  )
}

function moveAction(
  actions: Array<ScheduleActionDraft>,
  index: number,
  direction: -1 | 1
) {
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= actions.length) return actions
  const next = [...actions]
  const current = next[index]
  const other = next[nextIndex]
  if (!current || !other) return actions
  next[index] = other
  next[nextIndex] = current
  return next
}

function reorderAction(
  actions: Array<ScheduleActionDraft>,
  actionId: string,
  targetId: string
) {
  const sourceIndex = actions.findIndex((action) => action.id === actionId)
  const targetIndex = actions.findIndex((action) => action.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return actions
  }
  const next = [...actions]
  const [action] = next.splice(sourceIndex, 1)
  if (!action) return actions
  next.splice(targetIndex, 0, action)
  return next
}

function createScheduleAction(
  type: ScheduleAction["type"],
  id: string
): ScheduleAction {
  if (type === "console_command") return { command: "", id, type }
  if (type === "backup") {
    return {
      destination: { kind: "local" },
      id,
      mode: "full",
      name: "scheduled-<schedule>-<timestamp>",
      type,
    }
  }
  if (type === "wait") return { duration: 1, id, type, unit: "seconds" }
  return { action: "restart", id, type }
}

// The service each App target runs a command in, by target key. Undefined
// until an App's Relay reports its services.
function useAppServices(
  apps: ReadonlyArray<ScheduleOption>
): ReadonlyMap<string, ReadonlyArray<string> | undefined> {
  return useQueries({
    queries: apps.map((app) =>
      instanceInventoryQueryOptions(
        { id: app.id, kind: "app", relayId: app.relayId },
        "detail"
      )
    ),
    combine: React.useCallback(
      (results: ReadonlyArray<{ data?: InstanceInventory }>) =>
        new Map(
          apps.map((app, index) => {
            const value = results[index]?.data
            return [
              targetKey(app),
              value?.kind === "app" && value.view === "detail" && value.data
                ? appServices(value.data)
                : undefined,
            ] as const
          })
        ),
      [apps]
    ),
  })
}

const AppServiceSelect = React.memo(function AppServiceSelect({
  name,
  services,
  value,
  onChange,
}: {
  name: string
  services: ReadonlyArray<string> | undefined
  value: string | undefined
  onChange: (service: string) => void
}) {
  const choices =
    value && services && !services.includes(value)
      ? [...services, value]
      : (services ?? (value ? [value] : []))
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border px-2.5 py-1.5">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <TargetIcon kind="app" className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </span>
      <Select
        disabled={choices.length === 0}
        value={value ?? ""}
        onValueChange={onChange}
      >
        <SelectTrigger
          aria-label={`Service of ${name}`}
          className="h-8 w-40 min-w-0 font-mono text-xs [&_[data-slot=select-value]]:truncate"
        >
          <SelectValue
            placeholder={
              services === undefined
                ? "Loading services…"
                : services.length === 0
                  ? "Not deployed"
                  : "Choose a service"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {choices.map((service) => (
            <SelectItem key={service} value={service}>
              {service}
              {services && !services.includes(service) ? " (gone)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
})

// Only the services of Apps the command still runs on.
function commandServices(
  action: Extract<ScheduleAction, { type: "console_command" }>,
  targets: ReadonlyArray<ScheduleOption>
): Record<string, string> | undefined {
  const services = Object.fromEntries(
    targets.flatMap((target) => {
      const service = action.services?.[targetKey(target)]
      return target.kind === "app" &&
        service &&
        scheduleActionAppliesToTarget(action, target)
        ? [[targetKey(target), service]]
        : []
    })
  )
  return Object.keys(services).length > 0 ? services : undefined
}

// Every App a command runs on names the service it runs in.
function commandServicesChosen(
  action: ScheduleAction,
  targets: ReadonlyArray<ScheduleOption>
) {
  if (action.type !== "console_command") return true
  return targets.every(
    (target) =>
      target.kind !== "app" ||
      !scheduleActionAppliesToTarget(action, target) ||
      Boolean(action.services?.[targetKey(target)])
  )
}

function isCompleteScheduleAction(
  action: ScheduleActionDraft
): action is ScheduleAction {
  return action.type !== null
}

function scheduleActionIsConfigured(action: ScheduleAction) {
  if (action.type === "console_command") return action.command.trim().length > 0
  if (action.type === "wait") {
    return Number.isSafeInteger(action.duration) && action.duration > 0
  }
  return true
}

function waitDurationLabel(
  action: Pick<Extract<ScheduleAction, { type: "wait" }>, "duration" | "unit">
) {
  const unit =
    action.duration === 1 ? action.unit.replace(/s$/u, "") : action.unit
  return `${action.duration} ${unit}`
}

function targetList(targets: ReadonlyArray<ScheduleOption>) {
  const names = [...new Set(targets.map((target) => target.name))]
  if (names.length < 2) return names[0] ?? "this target"
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`
}

function cronPreset(cron: string) {
  const presets: Partial<
    Record<string, "daily" | "hourly" | "monthly" | "weekly">
  > = {
    daily: "daily",
    hourly: "hourly",
    monthly: "monthly",
    weekly: "weekly",
    "0 * * * *": "hourly",
    "0 0 * * *": "daily",
    "0 0 * * 0": "weekly",
    "0 0 1 * *": "monthly",
  }
  return presets[cron.trim().toLowerCase().replace(/\s+/gu, " ")] ?? "custom"
}

function cronDescription(cron: string) {
  return Result.getOrElse(
    Result.try(() => {
      if (!validateScheduleCron(cron, "UTC")) return null
      const normalizedCron = normalizeScheduleCron(cron)
      const [minute = "", hour = "", dayOfMonth, month, dayOfWeek] =
        normalizedCron.split(/\s+/u)
      if (
        /^\d+$/u.test(minute) &&
        /^\d+$/u.test(hour) &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
      ) {
        const hourNumber = Number(hour)
        const displayHour = hourNumber % 12 || 12
        return `Every day at ${displayHour}:${minute.padStart(2, "0")} ${hourNumber >= 12 ? "PM" : "AM"}`
      }
      return cronstrue.toString(normalizedCron, {
        throwExceptionOnParseError: true,
      })
    }),
    () => null
  )
}

function cronAliasLabel(cron: string) {
  const preset = cronPreset(cron)
  return preset === "custom"
    ? null
    : `${preset[0]?.toUpperCase()}${preset.slice(1)}`
}

function scheduleInput(schedule: Schedule) {
  return {
    actions: schedule.actions,
    continueOnFailure: schedule.continueOnFailure,
    cron: schedule.cron,
    enabled: schedule.enabled,
    name: schedule.name,
    targets: schedule.targets,
    timezone: schedule.timezone,
  }
}

function scheduleRowKey(schedule: Schedule) {
  return schedule.id
}

function scheduleMatchesScope(
  schedule: Pick<Schedule, "targets">,
  scope: ScheduleScope
) {
  return schedule.targets.some((target) =>
    scheduleTargetMatchesScope(target, scope)
  )
}

function scheduleTargetMatchesScope(
  target: ScheduleTarget,
  scope: ScheduleScope
) {
  const scopeKind = scope.kind ?? "server"
  const kind = scopeKind === "server" ? "instance" : scopeKind
  if (!("id" in scope)) return target.kind === kind
  return (
    target.kind === kind &&
    target.id === scope.id &&
    target.relayId === scope.relayId
  )
}

function scheduleSearchText(schedule: Schedule) {
  return [
    schedule.name,
    schedule.cron,
    schedule.timezone,
    ...schedule.actions.flatMap((action) => [
      actionLabel(action.type),
      action.type === "console_command"
        ? action.command
        : action.type === "backup"
          ? action.name
          : action.type === "wait"
            ? waitDurationLabel(action)
            : action.action,
    ]),
    ...schedule.targets.flatMap((target) => [
      target.name,
      target.kind,
      target.id,
    ]),
  ].join(" ")
}

const historySearchFields = [historySearchText] as const

function historyRowKey(entry: AutomationHistoryEntry) {
  return entry.kind === "schedule"
    ? `${entry.run.relayId}:${entry.run.id}`
    : `sync:${entry.run.id}`
}

function historySearchText(entry: AutomationHistoryEntry) {
  if (entry.kind === "sync") {
    const { run } = entry
    return [
      "sync",
      run.sync.repository,
      run.sync.sourcePath,
      run.sync.branch,
      run.sync.target.name,
      run.sync.target.relayName,
      run.status,
      syncTriggerLabel[run.trigger],
      run.message ?? "",
      run.commitMessage ?? "",
    ].join(" ")
  }
  const { run } = entry
  return [
    run.scheduleName,
    run.status,
    run.relayId,
    entry.relayName,
    ...run.targetRuns.flatMap((targetRun) => [
      targetRun.target.name,
      targetRun.target.kind,
      targetRun.status,
    ]),
  ].join(" ")
}

function durationLabel(durationMs: number) {
  const safeDuration = Math.max(0, durationMs)
  if (safeDuration < 1_000) return `${safeDuration} ms`
  if (safeDuration < 60_000) return `${(safeDuration / 1_000).toFixed(1)} s`
  const minutes = Math.floor(safeDuration / 60_000)
  const seconds = Math.round((safeDuration % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

function timestampLabel(date: Date, timeZone: string) {
  let formatter = timestampFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    })
    timestampFormatters.set(timeZone, formatter)
  }
  return formatter.format(date)
}

function fullTimestampLabel(date: Date, timeZone: string) {
  let formatter = fullTimestampFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone,
    })
    fullTimestampFormatters.set(timeZone, formatter)
  }
  return formatter.format(date)
}

function scheduleNextRun(schedule: Schedule) {
  const times = schedule.deployments.flatMap((deployment) =>
    deployment.nextRunAt ? [new Date(deployment.nextRunAt)] : []
  )
  return (
    times.sort((left, right) => left.getTime() - right.getTime())[0] ?? null
  )
}

function scheduleLastRun(
  schedule: Schedule,
  scope: ScheduleScope | null
): ScheduleRunWithRelay | null {
  let latest: ScheduleRunWithRelay | null = null
  for (const run of schedule.runs) {
    if (run.status === "running") continue
    if (
      scope &&
      !run.targetRuns.some((targetRun) =>
        scheduleTargetMatchesScope(targetRun.target, scope)
      )
    ) {
      continue
    }
    if (!latest || run.finishedAt > latest.finishedAt) latest = run
  }
  return latest
}

function scheduleStatusPresentation(
  schedule: Schedule
): IdentityStatusPresentation {
  if (schedule.runs.some((run) => run.status === "running")) {
    return { label: "Running", pulse: true, tone: "info" }
  }
  return schedule.enabled
    ? { label: "Enabled", tone: "success" }
    : { label: "Disabled", tone: "neutral" }
}

/** "Backup · Restart · Command", or how many actions when there are many. */
function scheduleActionSummary(schedule: Schedule) {
  if (schedule.actions.length === 0) return "No actions"
  if (schedule.actions.length > 3) return `${schedule.actions.length} actions`
  return schedule.actions.map((action) => actionLabel(action.type)).join(" · ")
}

function subscribeRelativeClock(listener: () => void) {
  if (relativeClockListeners.size === 0) relativeClockSnapshot = Date.now()
  relativeClockListeners.add(listener)
  if (!relativeClockTimer) {
    relativeClockTimer = setInterval(() => {
      relativeClockSnapshot = Date.now()
      for (const notify of relativeClockListeners) notify()
    }, 30_000)
  }
  return () => {
    relativeClockListeners.delete(listener)
    if (relativeClockListeners.size === 0 && relativeClockTimer) {
      clearInterval(relativeClockTimer)
      relativeClockTimer = null
    }
  }
}

function getRelativeClockSnapshot() {
  return relativeClockSnapshot
}

function relativeTime(date: Date, now: number = Date.now()) {
  const difference = date.getTime() - now
  const minutes = Math.round(difference / 60_000)
  if (Math.abs(minutes) < 60) {
    return stripTrailingPeriod(relativeFormatter.format(minutes, "minute"))
  }
  const hours = Math.round(difference / 3_600_000)
  if (Math.abs(hours) < 48) {
    return stripTrailingPeriod(relativeFormatter.format(hours, "hour"))
  }
  return stripTrailingPeriod(
    relativeFormatter.format(Math.round(difference / 86_400_000), "day")
  )
}

function stripTrailingPeriod(value: string) {
  return value.endsWith(".") ? value.slice(0, -1) : value
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback
}
