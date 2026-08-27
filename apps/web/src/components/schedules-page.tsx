import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import {
  useMutation,
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
  CircleX,
  ClipboardCopy,
  Code2,
  Copy,
  Database,
  EllipsisVertical,
  GripVertical,
  HardDriveDownload,
  History,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Timer,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import cronstrue from "cronstrue"
import { Result } from "effect"

import type { ScheduleAction, ScheduleTarget } from "@workspace/contracts"
import {
  normalizeScheduleCron,
  scheduleActionAppliesToTarget,
  scheduleActionSupportsTarget,
  scheduleCronAliases,
  validateScheduleCron,
} from "@workspace/contracts"
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Separator } from "@workspace/ui/components/separator"
import { showToast } from "@workspace/ui/components/sonner"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import {
  ServerPickerList,
  serverPickerOptionKey,
  type ServerPickerOption,
} from "@/components/server-picker-list"
import {
  BackupConfigurationDialog,
  type BackupConfigurationTarget,
} from "@/components/backup-configuration-dialog"
import { BackupIcon } from "@/components/backup-icon"
import { useScheduleScope } from "@/components/schedule-scope"
import { forkPromise } from "@/effect/promise"
import { scheduleBackupDestination } from "@/lib/schedule-backup-configuration"
import {
  removeScheduleFromCache,
  schedulesCollectionOptions,
  upsertScheduleCache,
} from "@/lib/collections/schedules"
import {
  backupStorageQueryOptions,
  queryKeys,
  relaySnapshotQueryOptions,
  scheduleOptionsQueryOptions,
  schedulesQueryOptions,
} from "@/lib/query-options"
import { getBackupStorage } from "@/server/backup-storage"
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
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [editor, setEditor] = React.useState<EditorMode | null>(null)
  const [deleting, setDeleting] = React.useState<Schedule | null>(null)
  const options = React.useMemo(
    () => scheduleOptionsWithInstanceNames(scheduleOptions, instances),
    [instances, scheduleOptions]
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
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <ScheduleToolbar
          canCreate={canCreate}
          searchStore={searchStore}
          onCreate={openCreate}
        />
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
      </section>

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
  searchStore: WorkspaceTableSearchStore
  onCreate: () => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <ScheduleSyncButton />
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          id="schedule-search"
          type="search"
          className="pl-9"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search schedules"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>
      {canCreate ? (
        <Button className="ml-auto shrink-0" size="sm" onClick={onCreate}>
          <Plus />
          Create schedule
        </Button>
      ) : null}
    </div>
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
  scope: ServerPickerOption | null
  searchStore: WorkspaceTableSearchStore
  onCreate: () => void
  onDelete: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
  onViewHistory: (schedule: Schedule) => void
  onViewRun: (schedule: Schedule, run: ScheduleRunWithRelay) => void
}) {
  const renderRow = React.useCallback(
    (schedule: Schedule) => (
      <ScheduleTableRow
        optionMap={optionMap}
        schedule={schedule}
        scope={scope}
        onDelete={onDelete}
        onEdit={onEdit}
        onViewHistory={onViewHistory}
        onViewRun={onViewRun}
      />
    ),
    [onDelete, onEdit, onViewHistory, onViewRun, optionMap, scope]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <EmptyScheduleTable
        canCreate={canCreate}
        scopeActive={scope !== null}
        searchActive={searchActive}
        onCreate={onCreate}
      />
    ),
    [canCreate, onCreate, scope]
  )

  return (
    <WorkspaceDataTable
      getRowKey={scheduleRowKey}
      getSearchText={scheduleSearchText}
      head={<ScheduleTableHead />}
      items={schedules}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const ScheduleTableHead = React.memo(function ScheduleTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-20 px-2 sm:w-28 sm:px-3">
        Status
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[34%]">
        Name
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[20%] md:table-cell">
        Timing
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] lg:table-cell">
        Latest run
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] xl:table-cell">
        Next run
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-48 px-1 text-right sm:w-64 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const ScheduleTableRow = React.memo(function ScheduleTableRow({
  optionMap,
  schedule,
  scope,
  onDelete,
  onEdit,
  onViewHistory,
  onViewRun,
}: {
  optionMap: ReadonlyMap<string, ScheduleOption>
  schedule: Schedule
  scope: ServerPickerOption | null
  onDelete: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
  onViewHistory: (schedule: Schedule) => void
  onViewRun: (schedule: Schedule, run: ScheduleRunWithRelay) => void
}) {
  const queryClient = useQueryClient()
  const canEdit = canOperateSchedule(schedule, optionMap, "canUpdate")
  const canDelete = schedule.targets.every(
    (target) => optionMap.get(targetKey(target))?.canDelete
  )
  const canRun = canOperateSchedule(schedule, optionMap, "canExecute")
  const canDuplicate = canOperateSchedule(schedule, optionMap, "canCreate")
  const runMutation = useMutation({
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
  const nextRun = scheduleNextRun(schedule)
  const lastRun = scheduleLastRun(schedule, scope)
  const status = scheduleStatus(schedule)
  const copyScheduleId = React.useCallback(() => {
    forkPromise(
      async () => {
        await navigator.clipboard.writeText(schedule.id)
        showToast({ message: "Schedule ID copied", type: "success" })
      },
      (cause) =>
        showToast({
          message: errorMessage(cause, "The schedule ID could not be copied"),
          type: "error",
        })
    )
  }, [schedule.id])

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell className="px-2 sm:px-3">
        <ScheduleState state={status} />
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <p className="truncate text-xs font-semibold text-foreground">
          {schedule.name}
        </p>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <ScheduleTiming cron={schedule.cron} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <ScheduleLastRun
          run={lastRun}
          timezone={schedule.timezone}
          onView={() => lastRun && onViewRun(schedule, lastRun)}
        />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <ScheduleNextRun nextRun={nextRun} timezone={schedule.timezone} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3">
        <div className="flex items-center justify-end gap-1">
          {canRun ? (
            <Button
              type="button"
              size="sm"
              className="bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-500 focus-visible:ring-emerald-500/40 dark:bg-emerald-600 dark:hover:bg-emerald-500"
              disabled={runMutation.isPending}
              onClick={() => runMutation.mutate()}
            >
              {runMutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Play />
              )}
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
              <TooltipContent side="bottom">Edit schedule</TooltipContent>
            </Tooltip>
          ) : null}
          {canDelete ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete ${schedule.name}`}
                  onClick={() => onDelete(schedule)}
                >
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Delete schedule</TooltipContent>
            </Tooltip>
          ) : null}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom">More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={copyScheduleId}>
                <ClipboardCopy /> Copy schedule ID
              </DropdownMenuItem>
              {canDuplicate ? (
                <DropdownMenuItem
                  disabled={duplicateMutation.isPending}
                  onSelect={() => duplicateMutation.mutate()}
                >
                  {duplicateMutation.isPending ? (
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
              {canEdit ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={enabledMutation.isPending}
                    onSelect={() => enabledMutation.mutate(!schedule.enabled)}
                  >
                    {enabledMutation.isPending ? (
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
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

function ScheduleTiming({ cron }: { cron: string }) {
  const alias = cronAliasLabel(cron)
  if (!alias) {
    return (
      <span className="type-code -my-1 inline-flex h-7 items-center px-1 text-foreground">
        {cron}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="type-control-sm -my-1 inline-flex h-7 cursor-default items-center rounded-sm px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {alias}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono">
        {cron}
      </TooltipContent>
    </Tooltip>
  )
}

function ScheduleNextRun({
  nextRun,
  timezone,
}: {
  nextRun: Date | null
  timezone: string
}) {
  if (!nextRun) {
    return (
      <span className="type-meta -my-1 inline-flex h-7 items-center px-1 text-muted-foreground">
        Not scheduled
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={nextRun.toISOString()}
          tabIndex={0}
          className="type-control-sm -my-1 inline-flex h-7 cursor-default items-center rounded-sm px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          suppressHydrationWarning
        >
          <RelativeTimeText date={nextRun} />
        </time>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {fullTimestampLabel(nextRun, timezone)}
      </TooltipContent>
    </Tooltip>
  )
}

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

function ScheduleLastRun({
  run,
  timezone,
  onView,
}: {
  run: ScheduleRunWithRelay | null
  timezone: string
  onView: () => void
}) {
  if (!run) {
    return (
      <span className="type-meta -my-1 inline-flex h-7 items-center px-1 text-muted-foreground">
        Never
      </span>
    )
  }
  const result = latestRunResult(run)
  const finishedAt = new Date(run.finishedAt)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="-my-1 inline-flex h-7 items-center px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 hover:[&_[data-slot=badge]]:brightness-110"
          onClick={onView}
        >
          <Badge
            variant="outline"
            className={`type-meta px-1.5 py-0 ${result === "Success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : result === "Errored" ? "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-destructive/30 bg-destructive/10 text-destructive"}`}
          >
            {result}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {fullTimestampLabel(finishedAt, timezone)}
      </TooltipContent>
    </Tooltip>
  )
}

function latestRunResult(run: ScheduleRunWithRelay) {
  const attempts = [
    ...run.sequenceAttempts,
    ...run.targetRuns.flatMap((targetRun) => targetRun.attempts),
  ]
  const passed = attempts.filter((attempt) => attempt.status === "succeeded")
  const failed = attempts.filter((attempt) =>
    ["failed", "interrupted", "not_run"].includes(attempt.status)
  )
  if (passed.length === 0) return "Failed" as const
  if (failed.length > 0) return "Errored" as const
  return "Success" as const
}

function EmptyScheduleTable({
  canCreate,
  scopeActive,
  searchActive,
  onCreate,
}: {
  canCreate: boolean
  scopeActive: boolean
  searchActive: boolean
  onCreate: () => void
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Play className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">
        {searchActive
          ? "No schedules match your search"
          : scopeActive
            ? "No schedules for this instance"
            : "No schedules yet"}
      </p>
      <p className="type-support mt-1 max-w-sm text-muted-foreground">
        {searchActive
          ? "Try a schedule name, cron expression, action, or target."
          : scopeActive
            ? "Choose another instance or create a schedule for this target."
            : "Create Relay-owned automation that keeps running when Hearth is offline."}
      </p>
      {!searchActive && canCreate ? (
        <Button type="button" size="sm" className="mt-4" onClick={onCreate}>
          <Plus /> Create schedule
        </Button>
      ) : null}
    </div>
  )
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
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const filteredSchedule = React.useMemo(
    () =>
      search.schedule
        ? (schedules.find((schedule) => schedule.id === search.schedule) ??
          null)
        : null,
    [schedules, search.schedule]
  )
  const runs = React.useMemo(
    () => scheduleHistoryRuns(schedules, selectedScope, search.schedule),
    [schedules, search.schedule, selectedScope]
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
  const openRun = React.useCallback(
    (run: ScheduleHistoryRun) => {
      void navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          run: run.id,
          runRelay: run.relayId,
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
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <HistoryToolbar
          filteredScheduleName={
            search.schedule
              ? (filteredSchedule?.name ?? "Unknown schedule")
              : null
          }
          searchStore={searchStore}
          runCount={runs.length}
          onClearScheduleFilter={clearScheduleFilter}
        />
        <ScheduleHistoryTable
          runs={runs}
          scopeActive={selectedScope !== null}
          searchStore={searchStore}
          onOpenRun={openRun}
        />
      </section>
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
  scope: ServerPickerOption | null,
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

const HistoryToolbar = React.memo(function HistoryToolbar({
  filteredScheduleName,
  runCount,
  searchStore,
  onClearScheduleFilter,
}: {
  filteredScheduleName: string | null
  runCount: number
  searchStore: WorkspaceTableSearchStore
  onClearScheduleFilter: () => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)
  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <ScheduleSyncButton />
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          id="schedule-history-search"
          type="search"
          className="pl-9"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search run history"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>
      {filteredScheduleName ? (
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
      ) : null}
      <Badge variant="outline" className="type-meta font-mono">
        {runCount} run{runCount === 1 ? "" : "s"}
      </Badge>
    </div>
  )
})

const ScheduleHistoryTable = React.memo(function ScheduleHistoryTable({
  runs,
  scopeActive,
  searchStore,
  onOpenRun,
}: {
  runs: Array<ScheduleHistoryRun>
  scopeActive: boolean
  searchStore: WorkspaceTableSearchStore
  onOpenRun: (run: ScheduleHistoryRun) => void
}) {
  const renderRow = React.useCallback(
    (run: ScheduleHistoryRun) => (
      <ScheduleHistoryRow run={run} onOpen={onOpenRun} />
    ),
    [onOpenRun]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
        <Play className="size-6 text-muted-foreground/45" />
        <p className="mt-3 text-sm font-semibold">
          {searchActive
            ? "No runs match your search"
            : scopeActive
              ? "No runs for this instance"
              : "No schedule runs yet"}
        </p>
        <p className="type-support mt-1 max-w-sm text-muted-foreground">
          {scopeActive && !searchActive
            ? "Completed and attempted runs for this instance will appear here."
            : "Completed and attempted schedule runs will appear here."}
        </p>
      </div>
    ),
    [scopeActive]
  )
  return (
    <WorkspaceDataTable
      getRowKey={historyRowKey}
      getSearchText={historySearchText}
      head={<ScheduleHistoryHead />}
      items={runs}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const ScheduleHistoryHead = React.memo(function ScheduleHistoryHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-24 px-2 sm:w-32 sm:px-3">
        Status
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[30%]">
        Schedule
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[24%] md:table-cell">
        Started
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] lg:table-cell">
        Duration
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[14%] xl:table-cell">
        Targets
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[18%] sm:table-cell">
        Relay
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const ScheduleHistoryRow = React.memo(function ScheduleHistoryRow({
  run,
  onOpen,
}: {
  run: ScheduleHistoryRun
  onOpen: (run: ScheduleHistoryRun) => void
}) {
  const open = React.useCallback(() => onOpen(run), [onOpen, run])
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`View ${run.scheduleName} run from ${timestampLabel(new Date(run.startedAt), run.timezone)} details`}
      className="cursor-pointer transition-colors hover:bg-accent/25 focus-visible:bg-accent/30 focus-visible:outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          open()
        }
      }}
    >
      <WorkspaceTableCell className="px-2 sm:px-3">
        <RunStatusDot status={run.status} />
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">
            {run.scheduleName}
          </p>
          <p className="type-meta truncate font-mono text-muted-foreground">
            r{run.revision} · {run.status.replaceAll("_", " ")}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <div className="min-w-0">
          <p className="type-meta truncate text-foreground">
            {timestampLabel(new Date(run.startedAt), run.timezone)}
          </p>
          <p className="type-meta truncate text-muted-foreground">
            <RelativeTimeText date={new Date(run.startedAt)} />
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <span className="type-meta font-mono text-foreground">
          {durationLabel(run.finishedAt - run.startedAt)}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <span className="type-meta text-foreground">
          {run.targetRuns.length}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden sm:table-cell">
        <span className="type-meta block truncate font-mono text-muted-foreground">
          {run.relayId}
        </span>
      </WorkspaceTableCell>
    </tr>
  )
})

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
            {run.target.kind} · {run.target.id}
          </p>
        </div>
        <span className="type-meta text-muted-foreground">
          {durationLabel(run.finishedAt - run.startedAt)}
        </span>
        <RunResultIcon status={run.status} className="size-4 shrink-0" />
      </header>
      {run.error ? (
        <p className="type-meta border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive">
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
              className="mt-1 size-3.5 shrink-0 text-primary"
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
                <p className="type-meta mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-destructive">
                  {attempt.error}
                </p>
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
  return (
    <span
      className={`type-label inline-flex items-center gap-1 capitalize ${succeeded ? "text-emerald-400" : failed ? "text-destructive" : "text-muted-foreground"}`}
    >
      {succeeded ? (
        <Check className="size-3" />
      ) : failed ? (
        <X className="size-3" />
      ) : (
        <CirclePause className="size-3" />
      )}
      {status.replaceAll("_", " ")}
    </span>
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
  const [name, setName] = React.useState(existing?.name ?? "")
  const [cron, setCron] = React.useState(() =>
    normalizeScheduleCron(existing?.cron ?? "daily")
  )
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true)
  const [selectedTargets, setSelectedTargets] = React.useState(() => {
    if (existing) return new Set(existing.targets.map(targetKey))
    const selectable = options.filter((option) => option[permissionKey])
    const onlyTarget = selectable.length === 1 ? selectable[0] : undefined
    return new Set(onlyTarget ? [targetKey(onlyTarget)] : [])
  })
  const [actions, setActions] = React.useState<Array<ScheduleActionDraft>>(
    existing?.actions ?? []
  )
  const cronSummary = React.useMemo(() => cronDescription(cron), [cron])
  const selectedOptions = React.useMemo(
    () => options.filter((option) => selectedTargets.has(targetKey(option))),
    [options, selectedTargets]
  )
  const completeActions = React.useMemo(() => {
    const selectedTargetKeys = new Set(
      selectedOptions.map((option) => targetKey(option))
    )
    const complete: Array<ScheduleAction> = []
    for (const action of actions) {
      if (!isCompleteScheduleAction(action)) continue
      complete.push(
        action.type === "wait" || action.targetKeys === undefined
          ? action
          : {
              ...action,
              targetKeys: action.targetKeys.filter((key) =>
                selectedTargetKeys.has(key)
              ),
            }
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
    selectedOptions.every((option) => option[permissionKey]) &&
    actions.length > 0 &&
    actions.length === completeActions.length &&
    completeActions.every(scheduleActionIsConfigured) &&
    actionSelectionValid

  const mutation = useMutation({
    mutationFn: async () => {
      const data = {
        actions: completeActions,
        cron,
        enabled,
        name,
        targets: selectedOptions.map(
          ({
            canCreate: _,
            canDelete: __,
            canExecute: ___,
            canUpdate: ____,
            permittedActions: _____,
            relayName: ______,
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
            cron={cron}
            cronSummary={cronSummary}
            name={name}
            options={options}
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
            onCronChange={setCron}
            onNameChange={setName}
            onTargetToggle={toggleTargets}
          />

          <DialogFooter className="flex-row flex-nowrap items-center">
            <Button
              aria-label={`Schedule is ${enabled ? "enabled" : "disabled"}. Click to ${enabled ? "disable" : "enable"}.`}
              aria-pressed={enabled}
              className={`mr-auto ${enabled ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-300" : "text-muted-foreground"}`}
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
  onCronChange,
  onNameChange,
  onTargetToggle,
}: {
  actionSelectionValid: boolean
  actions: ReadonlyArray<ScheduleActionDraft>
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
      </EditorSection>
      <EditorSection
        className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]"
        contentClassName="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
        aside={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onActionAdd}
          >
            <Plus className="size-3.5" />
            Add Action
          </Button>
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
          className={`flex min-h-8 items-center rounded-lg border px-3 py-1 text-xs leading-5 ${cronSummary !== null ? "bg-muted/25 text-foreground" : "border-destructive/35 bg-destructive/5 text-destructive"}`}
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
  const pickerOptions = React.useMemo(
    () =>
      options.map(
        (option): ServerPickerOption => ({
          description:
            option.kind === "relay"
              ? `Relay · ${option.id}`
              : `${option.kind === "instance" ? "Server" : "Database"} · ${option.relayName} · ${option.id}`,
          disabled: !option[permissionKey],
          id: option.id,
          kind:
            option.kind === "instance"
              ? "server"
              : option.kind === "database"
                ? "database"
                : "relay",
          name: option.name,
          relayId: option.relayId,
          relayName: option.relayName,
        })
      ),
    [options, permissionKey]
  )
  const selectedPickerKeys = React.useMemo(() => {
    const keys = new Set<string>()
    for (const option of pickerOptions) {
      if (selectedTargets.has(scheduleTargetKey(option))) {
        keys.add(serverPickerOptionKey(option))
      }
    }
    return keys
  }, [pickerOptions, selectedTargets])
  const selectedNames = React.useMemo(() => {
    const names: Array<string> = []
    for (const option of options) {
      if (selectedTargets.has(targetKey(option))) names.push(option.name)
    }
    return names
  }, [options, selectedTargets])
  const selectTarget = React.useCallback(
    (option: ServerPickerOption) => {
      const key = scheduleTargetKey(option)
      onToggle([key], !selectedTargets.has(key))
    },
    [onToggle, selectedTargets]
  )
  const allOptions = React.useMemo(() => {
    const selectable = pickerOptions.filter((option) => !option.disabled)
    const aggregateOption = (
      label: string,
      description: string,
      targets: ReadonlyArray<ServerPickerOption>,
      kind?: "database" | "relay" | "server"
    ) => {
      const keys = targets.map(scheduleTargetKey)
      const selected = keys.every((key) => selectedTargets.has(key))
      return {
        description,
        kind,
        label,
        selected,
        onSelect: () => onToggle(keys, !selected),
      }
    }
    const servers = selectable.filter((option) => option.kind === "server")
    const databases = selectable.filter((option) => option.kind === "database")
    const relays = selectable.filter((option) => option.kind === "relay")
    return [
      selectable.length > 0
        ? aggregateOption(
            "All Instances",
            "Every accessible server, database, and Relay",
            selectable
          )
        : null,
      servers.length > 0
        ? aggregateOption(
            "All Servers",
            "Every accessible server",
            servers,
            "server"
          )
        : null,
      databases.length > 0
        ? aggregateOption(
            "All Databases",
            "Every accessible database",
            databases,
            "database"
          )
        : null,
      relays.length > 0
        ? aggregateOption(
            "All Relays",
            "Every accessible Relay",
            relays,
            "relay"
          )
        : null,
    ].filter((option) => option !== null)
  }, [onToggle, pickerOptions, selectedTargets])
  return (
    <div>
      {hideHeader ? null : (
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold">Targets</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Select every server, database, or Relay this schedule applies to.
            </p>
          </div>
          <span className="type-code text-muted-foreground">
            {selectedOptionsCount} selected
          </span>
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={`${hideHeader ? "" : "mt-3"} h-auto min-h-10 w-full justify-between gap-3 px-3 py-2 font-normal`}
          >
            <span className="min-w-0 truncate text-left">
              {selectedNames.length === 0
                ? "Select servers, databases, or Relays"
                : selectedNames.slice(0, 3).join(", ")}
              {selectedNames.length > 3 ? ` +${selectedNames.length - 3}` : ""}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="z-[70] w-[min(34rem,calc(100vw-2rem))] p-1.5"
        >
          <ServerPickerList
            allOptions={allOptions}
            multiple
            ariaLabel="Schedule targets"
            emptyMessage="No accessible schedule targets found."
            selectedKeys={selectedPickerKeys}
            servers={pickerOptions}
            onSelect={selectTarget}
          />
        </PopoverContent>
      </Popover>
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
  const unsupportedTargets =
    action.type === null || action.type === "wait"
      ? []
      : selectedOptions.filter(
          (target) => !scheduleActionSupportsTarget(action, target)
        )
  const restrictedTargets =
    action.type === null || action.type === "wait"
      ? []
      : selectedOptions.filter(
          (target) =>
            scheduleActionSupportsTarget(action, target) &&
            (!target[permissionKey] ||
              !target.permittedActions.includes(action.type))
        )
  const eligibleTargets =
    action.type === null || action.type === "wait"
      ? []
      : selectedOptions.filter(
          (target) =>
            scheduleActionSupportsTarget(action, target) &&
            target[permissionKey] &&
            target.permittedActions.includes(action.type)
        )
  const actionTargetKeys =
    action.type === null || action.type === "wait"
      ? new Set<string>()
      : new Set<string>(
          action.targetKeys ??
            eligibleTargets.map((target) => targetKey(target))
        )
  const selectedActionTargets = eligibleTargets.filter((target) =>
    actionTargetKeys.has(targetKey(target))
  )

  return (
    <div
      data-schedule-action-row
      className={`${action.type === "wait" ? "h-20" : "h-12"} rounded-lg border bg-background/45 p-1 transition-[border-color,opacity] sm:h-16 sm:p-2 ${dragging ? "border-primary/40 opacity-55" : ""}`}
      onDragOver={(event) => {
        event.preventDefault()
        onDragOver(action.id)
      }}
      onDrop={(event) => event.preventDefault()}
    >
      <div
        className={`grid h-full items-center gap-0.5 sm:grid-cols-[2rem_9rem_minmax(0,1fr)_auto] sm:grid-rows-1 sm:gap-2 ${action.type === "wait" ? "grid-cols-[1.25rem_minmax(0,1fr)_auto] grid-rows-2" : "grid-cols-[1.25rem_8rem_minmax(0,1fr)_auto]"}`}
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
            onChange={onChange}
          />
        </div>
        <div
          className={`flex w-fit max-w-full min-w-0 items-center gap-1.5 justify-self-start ${action.type === "wait" ? "col-start-2 row-start-2 sm:col-start-auto sm:row-start-auto" : ""}`}
        >
          {action.type === "console_command" ? (
            <CommandEditorField
              value={action.command}
              onChange={(command) => onChange({ ...action, command })}
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
                onChange({ ...action, action: value as typeof action.action })
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
                onToggle={(targetKeyValue, checked) => {
                  if (action.type === null) return
                  const next = new Set(actionTargetKeys)
                  if (checked) next.add(targetKeyValue)
                  else next.delete(targetKeyValue)
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
          initialDestinationKeys={
            action.destination.kind === "storage"
              ? [action.destination.storageId]
              : ["local"]
          }
          initialMode={action.mode}
          initialName={action.name}
          onOpenChange={setBackupConfigOpen}
          onSubmit={(configuration) => {
            onChange({
              ...action,
              destination: scheduleBackupDestination(
                configuration.destinationKeys[0]
              ),
              mode: configuration.mode,
              name: configuration.name,
            })
            setBackupConfigOpen(false)
          }}
          open={backupConfigOpen}
          showTarget={false}
          singleDestination
          storage={storage}
          submitLabel="Save backup"
          targets={selectedOptions.map(scheduleBackupTarget)}
          title="Configure Backup"
        />
      ) : null}
    </div>
  )
})

function ScheduleActionTargetsButton({
  action,
  eligibleTargets,
  onToggle,
  selectedTargets,
  targets,
}: {
  action: ScheduleAction
  eligibleTargets: ReadonlyArray<ScheduleOption>
  onToggle: (targetKey: string, checked: boolean) => void
  selectedTargets: ReadonlyArray<ScheduleOption>
  targets: ReadonlyArray<ScheduleOption>
}) {
  const [open, setOpen] = React.useState(false)
  const eligibleKeys = new Set(
    eligibleTargets.map((target) => targetKey(target))
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              aria-expanded={open}
              aria-label={`${selectedTargets.length} targets for ${actionLabel(action.type)}`}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Server className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {selectedTargets.length} action targets
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-1.5">
        <p className="type-meta px-2 py-1.5 text-muted-foreground">
          Choose which selected targets run this action.
        </p>
        <div className="space-y-0.5">
          {targets.map((target) => {
            const key = targetKey(target)
            const eligible = eligibleKeys.has(key)
            const checked = selectedTargets.some(
              (selected) => targetKey(selected) === key
            )
            return (
              <button
                key={key}
                aria-pressed={checked}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!eligible}
                type="button"
                onClick={() => onToggle(key, !checked)}
              >
                <span
                  className={`grid size-4 shrink-0 place-items-center rounded-sm border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                >
                  {checked ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{target.name}</span>
                <span className="type-meta shrink-0 text-muted-foreground">
                  {target.kind}
                </span>
              </button>
            )
          })}
          {targets.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No compatible targets selected.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function scheduleBackupTarget(
  target: ScheduleOption
): BackupConfigurationTarget {
  return {
    id: target.id,
    key: targetKey(target),
    kind: target.kind === "relay" ? "platform" : target.kind,
    name: target.name,
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
          className="grid size-7 shrink-0 place-items-center rounded-md text-amber-400 outline-none hover:bg-amber-400/10 focus-visible:ring-2 focus-visible:ring-ring/40"
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
              className="size-4 shrink-0 text-primary"
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
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const openEditor = React.useCallback(() => {
    setDraft(value)
    setOpen(true)
  }, [value])
  return (
    <>
      <Button
        aria-label="Configure Command"
        className="size-8 max-w-full min-w-0 justify-center truncate px-0 sm:w-fit sm:justify-start sm:px-2.5"
        type="button"
        title={value || "Configure Command"}
        variant="outline"
        onClick={openEditor}
      >
        <SlidersHorizontal className="size-4 shrink-0" />
        <span className="hidden truncate sm:inline">Configure Command</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Configure Command</DialogTitle>
            <DialogDescription className="sr-only">
              Enter the console command this action should run.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            aria-label="Console command editor"
            className="min-h-40 resize-y font-mono text-xs"
            maxLength={4096}
            placeholder="say Server backing up..."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
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
                onChange(draft)
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

function ScheduleState({
  state,
}: {
  state: "enabled" | "disabled" | "running"
}) {
  const label =
    state === "enabled"
      ? "Enabled"
      : state === "running"
        ? "Running"
        : "Disabled"
  return (
    <span
      className={`type-label inline-flex items-center gap-1.5 ${state === "enabled" ? "text-emerald-400" : state === "running" ? "text-amber-300" : "text-muted-foreground"}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${state === "enabled" ? "bg-emerald-400" : state === "running" ? "animate-pulse bg-amber-400" : "bg-muted-foreground"}`}
      />
      <span>{label}</span>
    </span>
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
    return <CircleCheck className={`${className ?? ""} text-emerald-400`} />
  }
  if (status === "running") {
    return (
      <LoaderCircle
        className={`${className ?? ""} animate-spin text-amber-300`}
      />
    )
  }
  if (status === "partial") {
    return <CircleX className={`${className ?? ""} text-amber-300`} />
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
  const Icon =
    kind === "instance"
      ? Server
      : kind === "database"
        ? Database
        : HardDriveDownload
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

function scheduleTargetKey(target: ServerPickerOption) {
  const kind = target.kind === "server" ? "instance" : target.kind
  return `${target.relayId}:${kind ?? "instance"}:${target.id}`
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
  scope: ServerPickerOption
) {
  return schedule.targets.some((target) =>
    scheduleTargetMatchesScope(target, scope)
  )
}

function scheduleTargetMatchesScope(
  target: ScheduleTarget,
  scope: ServerPickerOption
) {
  const scopeKind = scope.kind ?? "server"
  const kind = scopeKind === "server" ? "instance" : scopeKind
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

function historyRowKey(run: ScheduleHistoryRun) {
  return `${run.relayId}:${run.id}`
}

function historySearchText(run: ScheduleHistoryRun) {
  return [
    run.scheduleName,
    run.status,
    run.relayId,
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
  scope: ServerPickerOption | null
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

function scheduleStatus(
  schedule: Schedule
): "enabled" | "disabled" | "running" {
  if (schedule.runs.some((run) => run.status === "running")) return "running"
  return schedule.enabled ? "enabled" : "disabled"
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
