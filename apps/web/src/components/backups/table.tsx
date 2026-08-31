import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table"
import { Archive, ArchiveX, LoaderCircle, Trash2, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  DataTableCompactList,
  DataTableEmptyState,
  DataTableRowCheckbox,
  DataTableSelectAllCheckbox,
} from "@/components/data-table"
import { DataTableView } from "@/components/data-table-view"
import {
  BackupAvailabilityTags,
  BackupCreatedTime,
  BackupNameEditor,
  BackupRowActions,
  BackupSizeDetails,
  BackupTargetLink,
  BackupTaskFeedback,
  DesktopBackupTaskFeedback,
  backupCanBeRemoved,
  backupTargetPresentation,
  targetKey,
} from "@/components/backups/table-row"
import type { InstanceNameInstance } from "@/components/instance-name"
import type {
  Backup,
  BackupAvailabilityDestination,
  BackupDeleteFeedbackStore,
  BackupDialogStore,
  BackupNameStore,
  BackupSearchStore,
  BackupSelectionStore,
  BackupStatusFilterStore,
} from "@/components/backups/state"
import {
  backupDisplayBytes,
  backupShowsPrimaryTaskFeedback,
} from "@/lib/backup-progress-presentation"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
  type DataTableInstance,
} from "@/lib/data-table"
import type { DataTableSource } from "@/lib/data-table-source"
import { resetActiveBackupRunsToFirstPage } from "@/lib/backup-runs-cache"
import { settlePromises } from "@/effect/promise"
import { deleteBackup } from "@/server/backups"
import type { BackupRunSort, BackupRunSortDirection } from "@/lib/backup-runs"

type BackupBulkDeleteOutcome =
  | {
      backup: Backup
      result: Awaited<ReturnType<typeof deleteBackup>>
      status: "deleted"
    }
  | { backup: Backup; message: string; status: "failed" }

const mobileBackupLayoutQuery = "(max-width: 767px)"
const backupSelectionBlockingOverlaySelector = [
  '[data-slot="combobox-content"][data-open]',
  '[data-slot="dialog-content"][data-open]',
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="dropdown-menu-sub-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[data-slot="sheet-content"][data-open]',
].join(",")

const backupTableColumnHelper = createDataTableColumnHelper<Backup>()
export const BackupTable = React.memo(function BackupTable({
  availableRelayIds,
  availableTargetKeys,
  canCreate,
  currentUserId,
  destinations,
  dialogStore,
  targetInstances,
  nameStore,
  onSortChange,
  scopeFiltered,
  searchStore,
  selectionStore,
  sort,
  sortDirection,
  source,
  statusFilterStore,
}: {
  availableRelayIds: ReadonlySet<string>
  availableTargetKeys: ReadonlySet<string>
  canCreate: (backup: Backup) => boolean
  currentUserId: string
  destinations: ReadonlyArray<BackupAvailabilityDestination>
  dialogStore: BackupDialogStore
  targetInstances: ReadonlyMap<string, InstanceNameInstance>
  nameStore: BackupNameStore
  onSortChange: (sort: BackupRunSort, direction: BackupRunSortDirection) => void
  scopeFiltered: boolean
  searchStore: BackupSearchStore
  selectionStore: BackupSelectionStore
  sort: BackupRunSort
  sortDirection: BackupRunSortDirection
  source: DataTableSource<Backup>
  statusFilterStore: BackupStatusFilterStore
}) {
  const mobileScrollRootRef = React.useRef<HTMLDivElement>(null)
  const mobileLayout = React.useSyncExternalStore(
    subscribeToMobileBackupLayout,
    getMobileBackupLayoutSnapshot,
    getServerMobileBackupLayoutSnapshot
  )
  const renderMobileRow = React.useCallback(
    (backup: Backup) => (
      <BackupMobileRow
        key={backup.id}
        backup={backup}
        canCreate={canCreate(backup)}
        currentUserId={currentUserId}
        destinations={destinations}
        dialogStore={dialogStore}
        instance={targetInstances.get(
          targetKey(
            backup.targetKind,
            backup.relayId,
            backup.targetKind === "platform" ? "kiln" : backup.targetId
          )
        )}
        nameStore={nameStore}
        relayName={backup.relayId}
        selectionStore={selectionStore}
        targetAvailable={
          backup.targetKind === "platform"
            ? availableRelayIds.has(backup.relayId)
            : availableTargetKeys.has(
                targetKey(backup.targetKind, backup.relayId, backup.targetId)
              )
        }
        targetName={backup.targetId}
      />
    ),
    [
      canCreate,
      currentUserId,
      destinations,
      dialogStore,
      targetInstances,
      nameStore,
      availableRelayIds,
      availableTargetKeys,
      selectionStore,
    ]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean, filterActive: boolean) => (
      <DataTableEmptyState
        description="Manual backups appear here as soon as Relay accepts them."
        icon={<Archive className="size-7 text-muted-foreground/45" />}
        title={
          searchActive
            ? "No backups match this search"
            : filterActive
              ? "No backups match these filters"
              : "No backups yet"
        }
      />
    ),
    []
  )
  return (
    <div id="backup-table-root" className="min-h-0 flex-1">
      {mobileLayout ? (
        <div
          ref={mobileScrollRootRef}
          className="h-full overflow-y-auto overscroll-contain"
        >
          <BackupMobileList
            renderEmpty={renderEmpty}
            renderRow={renderMobileRow}
            scopeFiltered={scopeFiltered}
            scrollRootRef={mobileScrollRootRef}
            searchStore={searchStore}
            selectionStore={selectionStore}
            source={source}
            statusFilterStore={statusFilterStore}
          />
        </div>
      ) : (
        <BackupDesktopTable
          availableRelayIds={availableRelayIds}
          availableTargetKeys={availableTargetKeys}
          canCreate={canCreate}
          currentUserId={currentUserId}
          destinations={destinations}
          dialogStore={dialogStore}
          targetInstances={targetInstances}
          nameStore={nameStore}
          onSortChange={onSortChange}
          renderEmpty={renderEmpty}
          scopeFiltered={scopeFiltered}
          searchStore={searchStore}
          selectionStore={selectionStore}
          sort={sort}
          sortDirection={sortDirection}
          source={source}
          statusFilterStore={statusFilterStore}
        />
      )}
    </div>
  )
})

const BackupDesktopTable = React.memo(function BackupDesktopTable({
  availableRelayIds,
  availableTargetKeys,
  canCreate,
  currentUserId,
  destinations,
  dialogStore,
  targetInstances,
  nameStore,
  onSortChange,
  renderEmpty,
  scopeFiltered,
  searchStore,
  selectionStore,
  sort,
  sortDirection,
  source,
  statusFilterStore,
}: {
  availableRelayIds: ReadonlySet<string>
  availableTargetKeys: ReadonlySet<string>
  canCreate: (backup: Backup) => boolean
  currentUserId: string
  destinations: ReadonlyArray<BackupAvailabilityDestination>
  dialogStore: BackupDialogStore
  targetInstances: ReadonlyMap<string, InstanceNameInstance>
  nameStore: BackupNameStore
  onSortChange: (sort: BackupRunSort, direction: BackupRunSortDirection) => void
  renderEmpty: (searchActive: boolean, filterActive: boolean) => React.ReactNode
  scopeFiltered: boolean
  searchStore: BackupSearchStore
  selectionStore: BackupSelectionStore
  sort: BackupRunSort
  sortDirection: BackupRunSortDirection
  source: DataTableSource<Backup>
  statusFilterStore: BackupStatusFilterStore
}) {
  const [initialTableState] = React.useState(() => ({
    rowSelection: backupRowSelectionState(selectionStore.getSnapshot()),
    sorting: [{ desc: sortDirection === "desc", id: sort }],
  }))
  const definition = React.useMemo(() => {
    const columns = backupTableColumnHelper.columns([
      backupTableColumnHelper.display({
        id: "selection",
        enableSorting: false,
        header: ({ table }) => (
          <DataTableSelectAllCheckbox
            ariaLabel="Select all visible backups"
            table={table}
          />
        ),
        cell: ({ row }) => (
          <DataTableRowCheckbox
            ariaLabel={`Select ${row.original.name}`}
            disabledTitle="Wait for active backup work to finish"
            row={row}
          />
        ),
        meta: dataTableColumnMeta(
          { width: "2.5rem" },
          {
            cellClassName: "h-auto px-2 py-2.5",
            headerClassName: "px-2",
          }
        ),
      }),
      backupTableColumnHelper.accessor(
        (backup) => nameStore.get(backup.id, backup.name),
        {
          id: "name",
          header: "Name",
          sortFn: (left, right) =>
            nameStore
              .get(left.original.id, left.original.name)
              .localeCompare(
                nameStore.get(right.original.id, right.original.name)
              ),
          cell: ({ row }) => {
            const backup = row.original
            const canCreateBackup = canCreate(backup)
            return (
              <div className="min-w-0">
                <BackupNameEditor
                  backupId={backup.id}
                  editable={canCreateBackup}
                  nameStore={nameStore}
                  name={backup.name}
                />
                <BackupAvailabilityTags
                  backup={backup}
                  canCopy={canCreateBackup}
                  currentUserId={currentUserId}
                  destinations={destinations}
                />
              </div>
            )
          },
          meta: dataTableColumnMeta(
            { width: "minmax(0,1.2fr)" },
            { cellClassName: "h-auto py-2.5" }
          ),
        }
      ),
      backupTableColumnHelper.accessor((backup) => backup.targetId, {
        id: "target",
        header: "Target",
        sortFn: "text",
        cell: ({ row }) => {
          const backup = row.original
          const target = backupTargetPresentation(
            backup,
            backup.relayId,
            backup.targetId
          )
          const targetAvailable =
            backup.targetKind === "platform"
              ? availableRelayIds.has(backup.relayId)
              : availableTargetKeys.has(
                  targetKey(backup.targetKind, backup.relayId, backup.targetId)
                )

          return (
            <BackupTargetLink
              available={targetAvailable}
              displayId={target.id}
              instance={targetInstances.get(
                targetKey(
                  backup.targetKind,
                  backup.relayId,
                  backup.targetKind === "platform" ? "kiln" : backup.targetId
                )
              )}
              kindLabel={target.kindLabel}
              name={target.name}
              relayId={backup.relayId}
              targetId={backup.targetId}
              targetKind={backup.targetKind}
            />
          )
        },
        meta: dataTableColumnMeta(
          { width: "minmax(0,1fr)" },
          { cellClassName: "h-auto py-2.5" }
        ),
      }),
      backupTableColumnHelper.accessor(
        (backup) => backupDisplayBytes(backup) ?? undefined,
        {
          id: "size",
          header: "Size",
          sortDescFirst: true,
          sortUndefined: "last",
          cell: ({ row }) => {
            const backup = row.original
            return backupShowsPrimaryTaskFeedback(backup) ? (
              <DesktopBackupTaskFeedback backup={backup} />
            ) : (
              <BackupSizeDetails
                bytes={backupDisplayBytes(backup)}
                mode={backup.backupMode}
              />
            )
          },
          meta: dataTableColumnMeta(
            { width: "12rem" },
            {
              cellClassName: "h-auto py-2.5 text-sm text-muted-foreground",
            }
          ),
        }
      ),
      backupTableColumnHelper.accessor(
        (backup) => Date.parse(backup.createdAt),
        {
          id: "createdAt",
          header: "Created",
          sortDescFirst: true,
          cell: ({ row }) => {
            const backup = row.original
            const hidesCreatedTime =
              backupShowsPrimaryTaskFeedback(backup) &&
              backup.taskStatus !== "cancelled"
            return hidesCreatedTime ? null : (
              <span className="whitespace-nowrap">
                <BackupCreatedTime createdAt={backup.createdAt} />
              </span>
            )
          },
          meta: dataTableColumnMeta(
            { hideBelow: "xl", width: "6.5rem" },
            {
              cellClassName: "h-auto py-2.5 text-sm text-muted-foreground",
              headerClassName: "px-2",
              headerLabelClassName: "shrink-0 overflow-visible text-clip",
            }
          ),
        }
      ),
      backupTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const backup = row.original
          const targetAvailable =
            backup.targetKind === "platform"
              ? availableRelayIds.has(backup.relayId)
              : availableTargetKeys.has(
                  targetKey(backup.targetKind, backup.relayId, backup.targetId)
                )
          return (
            <BackupRowActions
              backup={backup}
              canCancel={canCreate(backup)}
              dialogStore={dialogStore}
              nameStore={nameStore}
              targetAvailable={targetAvailable}
            />
          )
        },
        meta: dataTableColumnMeta(
          { width: "11.25rem" },
          { cellClassName: "h-auto py-2.5" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Backups",
      columns,
      getRowClassName: backupTableRowClassName,
      model: {
        enableRowRangeSelection: true,
        enableRowSelection: (row) => backupCanBeRemoved(row.original),
        enableSubRowSelection: false,
        getRowId: backupRowKey,
        initialState: initialTableState,
        manualSorting: true,
      },
      virtualization: { estimateRowHeight: 76, overscan: 8 },
    })
  }, [
    canCreate,
    currentUserId,
    destinations,
    dialogStore,
    targetInstances,
    nameStore,
    availableRelayIds,
    availableTargetKeys,
    initialTableState,
  ])

  return (
    <DataTableView
      definition={definition}
      emptyState={
        <BackupDesktopEmptyState
          renderEmpty={renderEmpty}
          scopeFiltered={scopeFiltered}
          searchStore={searchStore}
          statusFilterStore={statusFilterStore}
        />
      }
      source={source}
    >
      {(table) => (
        <BackupDesktopTableStateSync
          onSortChange={onSortChange}
          selectionStore={selectionStore}
          table={table}
        />
      )}
    </DataTableView>
  )
})

const BackupDesktopTableStateSync = React.memo(
  function BackupDesktopTableStateSync({
    onSortChange,
    selectionStore,
    table,
  }: {
    onSortChange: (
      sort: BackupRunSort,
      direction: BackupRunSortDirection
    ) => void
    selectionStore: BackupSelectionStore
    table: DataTableInstance<Backup>
  }) {
    const selectedBackupIds = React.useSyncExternalStore(
      selectionStore.subscribe,
      selectionStore.getSnapshot,
      selectionStore.getServerSnapshot
    )
    const handleSortingChange = React.useEffectEvent(
      (sorting: SortingState) => {
        const next = sorting[0]
        if (
          !next ||
          !["name", "target", "size", "createdAt"].includes(next.id)
        ) {
          return
        }
        onSortChange(next.id as BackupRunSort, next.desc ? "desc" : "asc")
      }
    )
    React.useLayoutEffect(() => {
      const subscription = table.atoms.sorting.subscribe(handleSortingChange)
      return () => subscription.unsubscribe()
    }, [table])

    React.useLayoutEffect(() => {
      const current = table.atoms.rowSelection.get()
      if (backupSelectionMatchesState(selectedBackupIds, current)) return
      table.setRowSelection(backupRowSelectionState(selectedBackupIds))
    }, [selectedBackupIds, table])

    React.useLayoutEffect(() => {
      const subscription = table.atoms.rowSelection.subscribe((selection) => {
        selectionStore.replace(Object.keys(selection))
      })
      return () => subscription.unsubscribe()
    }, [selectionStore, table])

    return null
  }
)

const BackupDesktopEmptyState = React.memo(function BackupDesktopEmptyState({
  renderEmpty,
  scopeFiltered,
  searchStore,
  statusFilterStore,
}: {
  renderEmpty: (searchActive: boolean, filterActive: boolean) => React.ReactNode
  scopeFiltered: boolean
  searchStore: BackupSearchStore
  statusFilterStore: BackupStatusFilterStore
}) {
  const searchActive = React.useSyncExternalStore(
    searchStore.subscribe,
    () => searchStore.getNormalizedSnapshot().length > 0,
    () => searchStore.getNormalizedServerSnapshot().length > 0
  )
  const status = React.useSyncExternalStore(
    statusFilterStore.subscribe,
    statusFilterStore.getSnapshot,
    statusFilterStore.getServerSnapshot
  )
  return renderEmpty(searchActive, scopeFiltered || Boolean(status))
})

const BackupMobileList = React.memo(function BackupMobileList({
  renderEmpty,
  renderRow,
  scopeFiltered,
  scrollRootRef,
  searchStore,
  selectionStore,
  source,
  statusFilterStore,
}: {
  renderEmpty: (searchActive: boolean, filterActive: boolean) => React.ReactNode
  renderRow: (backup: Backup) => React.ReactNode
  scopeFiltered: boolean
  scrollRootRef: React.RefObject<Element | null>
  searchStore: BackupSearchStore
  selectionStore: BackupSelectionStore
  source: DataTableSource<Backup>
  statusFilterStore: BackupStatusFilterStore
}) {
  const search = React.useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getSnapshot,
    searchStore.getServerSnapshot
  )
  const status = React.useSyncExternalStore(
    statusFilterStore.subscribe,
    statusFilterStore.getSnapshot,
    statusFilterStore.getServerSnapshot
  )
  return (
    <DataTableCompactList
      emptyState={renderEmpty(
        search.trim().length > 0,
        scopeFiltered || Boolean(status)
      )}
      header={
        <BackupMobileSelectAll backups={source.rows} store={selectionStore} />
      }
      renderRow={renderRow}
      scrollRootRef={scrollRootRef}
      source={source}
    />
  )
})

const BackupMobileSelectAll = React.memo(function BackupMobileSelectAll({
  backups,
  store,
}: {
  backups: Array<Backup>
  store: BackupSelectionStore
}) {
  const backupIds = React.useMemo(
    () =>
      backups.flatMap((backup) =>
        backupCanBeRemoved(backup) ? [backup.id] : []
      ),
    [backups]
  )

  return (
    <div className="flex h-10 items-center justify-between border-b bg-muted/10 px-3">
      <label
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
        htmlFor="backup-mobile-select-all"
      >
        <BackupSelectAllCheckbox
          backupIds={backupIds}
          inputId="backup-mobile-select-all"
          selectionStore={store}
        />
        Select visible
      </label>
      <span className="type-code text-muted-foreground">
        {backups.length} {backups.length === 1 ? "backup" : "backups"}
      </span>
    </div>
  )
})

const BackupSelectAllCheckbox = React.memo(function BackupSelectAllCheckbox({
  backupIds,
  inputId,
  selectionStore,
}: {
  backupIds: ReadonlyArray<string>
  inputId: string
  selectionStore: BackupSelectionStore
}) {
  const getSelectedCountSnapshot = React.useCallback(
    () =>
      backupIds.reduce(
        (count, backupId) =>
          count + Number(selectionStore.getSnapshot().has(backupId)),
        0
      ),
    [backupIds, selectionStore]
  )
  const selectedCount = React.useSyncExternalStore(
    selectionStore.subscribe,
    getSelectedCountSnapshot,
    () => 0
  )
  const inputRef = React.useRef<HTMLInputElement>(null)
  const allSelected = backupIds.length > 0 && selectedCount === backupIds.length

  React.useLayoutEffect(() => {
    if (!inputRef.current) return
    inputRef.current.indeterminate = selectedCount > 0 && !allSelected
  }, [allSelected, selectedCount])

  return (
    <input
      ref={inputRef}
      aria-label="Select all visible backups"
      checked={allSelected}
      className="size-4 rounded-[3px] border-input accent-primary"
      disabled={backupIds.length === 0}
      id={inputId}
      type="checkbox"
      onChange={() => {
        if (allSelected) selectionStore.deselect(backupIds)
        else selectionStore.select(backupIds)
      }}
    />
  )
})

function backupTableRowClassName() {
  return "group hover:bg-muted/20 has-checked:bg-primary/[0.07]"
}

const BackupMobileRow = React.memo(function BackupMobileRow({
  backup,
  canCreate,
  currentUserId,
  destinations,
  dialogStore,
  instance,
  nameStore,
  relayName,
  selectionStore,
  targetAvailable,
  targetName,
}: {
  backup: Backup
  canCreate: boolean
  currentUserId: string
  destinations: ReadonlyArray<BackupAvailabilityDestination>
  dialogStore: BackupDialogStore
  instance?: InstanceNameInstance
  nameStore: BackupNameStore
  relayName: string
  selectionStore: BackupSelectionStore
  targetAvailable: boolean
  targetName: string
}) {
  const target = backupTargetPresentation(backup, relayName, targetName)
  const showsPrimaryTaskFeedback = backupShowsPrimaryTaskFeedback(backup)
  const displayBytes = backupDisplayBytes(backup)
  return (
    <article
      aria-label={backup.name}
      className="min-w-0 p-3 transition-colors has-checked:bg-primary/[0.07]"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <BackupSelectionCheckbox backup={backup} store={selectionStore} />
        <div className="min-w-0 flex-1">
          <BackupNameEditor
            backupId={backup.id}
            editable={canCreate}
            nameStore={nameStore}
            name={backup.name}
          />
        </div>
      </div>
      <div className="mt-2.5 overflow-hidden rounded-lg border bg-background/45 px-3 py-2.5">
        <BackupTargetLink
          available={targetAvailable}
          displayId={target.id}
          instance={instance}
          kindLabel={target.kindLabel}
          name={target.name}
          relayId={backup.relayId}
          targetId={backup.targetId}
          targetKind={backup.targetKind}
        />
      </div>
      {showsPrimaryTaskFeedback ? (
        <div className="mt-2.5">
          <BackupTaskFeedback backup={backup} />
        </div>
      ) : (
        <div className="mt-2.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 text-xs text-muted-foreground">
          <BackupSizeDetails bytes={displayBytes} mode={backup.backupMode} />
          <BackupCreatedTime createdAt={backup.createdAt} />
        </div>
      )}
      <BackupAvailabilityTags
        backup={backup}
        canCopy={canCreate}
        currentUserId={currentUserId}
        destinations={destinations}
      />
      <div className="mt-3 flex justify-end border-t pt-2.5">
        <BackupRowActions
          backup={backup}
          canCancel={canCreate}
          dialogStore={dialogStore}
          nameStore={nameStore}
          targetAvailable={targetAvailable}
        />
      </div>
    </article>
  )
})

const BackupSelectionCheckbox = React.memo(function BackupSelectionCheckbox({
  backup,
  store,
}: {
  backup: Backup
  store: BackupSelectionStore
}) {
  const getSelectedSnapshot = React.useCallback(
    () => store.getSnapshot().has(backup.id),
    [backup.id, store]
  )
  const selected = React.useSyncExternalStore(
    store.subscribe,
    getSelectedSnapshot,
    () => false
  )
  const disabled = !backupCanBeRemoved(backup)

  return (
    <label
      className="grid size-7 shrink-0 place-items-center"
      title={disabled ? "Wait for active backup work to finish" : undefined}
    >
      <input
        aria-label={`Select ${backup.name}`}
        checked={selected}
        className="size-4 rounded-[3px] border-input accent-primary"
        disabled={disabled}
        type="checkbox"
        onChange={() => store.toggle(backup.id)}
      />
    </label>
  )
})

const BackupSelectionAmount = React.memo(function BackupSelectionAmount({
  store,
}: {
  store: BackupSelectionStore
}) {
  const getCountSnapshot = React.useCallback(
    () => store.getSnapshot().size,
    [store]
  )
  const count = React.useSyncExternalStore(
    store.subscribe,
    getCountSnapshot,
    () => 0
  )

  return <span className="col-start-1 row-start-1 text-center">{count}</span>
})

const BackupBulkActionMenu = React.memo(function BackupBulkActionMenu({
  disabled,
  onDelete,
  store,
}: {
  disabled: boolean
  onDelete: () => void
  store: BackupSelectionStore
}) {
  const getHasSelectionSnapshot = React.useCallback(
    () => store.getSnapshot().size > 0,
    [store]
  )
  const hasSelection = React.useSyncExternalStore(
    store.subscribe,
    getHasSelectionSnapshot,
    () => false
  )

  React.useEffect(() => {
    if (!hasSelection) return

    const clearSelectionOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (document.querySelector(backupSelectionBlockingOverlaySelector)) return
      store.clear()
    }

    window.addEventListener("keydown", clearSelectionOnEscape)
    return () => window.removeEventListener("keydown", clearSelectionOnEscape)
  }, [hasSelection, store])

  if (!hasSelection) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full animate-in items-center gap-1.5 rounded-xl border border-accent-border/30 bg-[color-mix(in_oklab,var(--surface-overlay)_88%,transparent)] p-1.5 pl-3 text-popover-foreground shadow-2xl shadow-black/45 backdrop-blur-xl fade-in-0 slide-in-from-bottom-2">
        <span
          aria-live="polite"
          className="mr-1 inline-flex items-center gap-2 text-sm font-semibold whitespace-nowrap"
        >
          <span className="grid rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-xs tabular-nums">
            <span aria-hidden className="invisible col-start-1 row-start-1">
              999
            </span>
            <BackupSelectionAmount store={store} />
          </span>
          <span>Selected</span>
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Clear backup selection"
              disabled={disabled}
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={store.clear}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Clear selection</TooltipContent>
        </Tooltip>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        <Button
          className="shrink-0"
          disabled={disabled}
          size="sm"
          type="button"
          variant="destructive"
          onClick={onDelete}
        >
          <Trash2 /> Delete
        </Button>
      </div>
    </div>
  )
})

export const BackupBulkActions = React.memo(function BackupBulkActions({
  backups,
  deleteFeedbackStore,
  nameStore,
  selectionStore,
}: {
  backups: Array<Backup>
  deleteFeedbackStore: BackupDeleteFeedbackStore
  nameStore: BackupNameStore
  selectionStore: BackupSelectionStore
}) {
  const queryClient = useQueryClient()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [confirmationBackups, setConfirmationBackups] = React.useState<
    Array<Backup>
  >([])
  const remove = useMutation({
    onMutate: (targets: Array<Backup>) => {
      deleteFeedbackStore.mark(targets)
    },
    mutationFn: async (targets: Array<Backup>) => {
      const settlements = await settlePromises(
        targets,
        (backup) =>
          deleteBackup({
            data: {
              backupId: backup.id,
              mode: backup.relayPresent ? "delete" : "forget",
            },
          }),
        4
      )
      return settlements.map(
        (settlement): BackupBulkDeleteOutcome =>
          settlement.status === "fulfilled"
            ? {
                backup: settlement.input,
                result: settlement.value,
                status: "deleted",
              }
            : {
                backup: settlement.input,
                message:
                  settlement.reason instanceof Error
                    ? settlement.reason.message
                    : "Could not delete this backup",
                status: "failed",
              }
      )
    },
    onSuccess: async (outcomes) => {
      const deleted = outcomes.filter((outcome) => outcome.status === "deleted")
      const failed = outcomes.filter((outcome) => outcome.status === "failed")
      const forgotten = deleted.filter((outcome) => outcome.result.forgotten)
      const deferred = deleted.filter(
        (outcome) => !outcome.result.forgotten && !outcome.result.relayAccepted
      )
      deleteFeedbackStore.remove(failed.map((outcome) => outcome.backup.id))

      if (failed.length === 0) {
        setConfirmOpen(false)
        setConfirmationBackups([])
      } else {
        setConfirmationBackups(failed.map((outcome) => outcome.backup))
      }
      if (deleted.length > 0) {
        selectionStore.deselect(deleted.map((outcome) => outcome.backup.id))
      }
      await resetActiveBackupRunsToFirstPage(queryClient)

      if (failed.length > 0) {
        showToast({
          message:
            deleted.length > 0
              ? `${deleted.length} deleted; ${failed.length} could not be deleted`
              : `${failed.length} backups could not be deleted`,
          type: "error",
        })
        return
      }
      showToast({
        message:
          forgotten.length === deleted.length
            ? `${forgotten.length} ${forgotten.length === 1 ? "backup" : "backups"} forgotten`
            : forgotten.length > 0
              ? `${forgotten.length} forgotten; ${deleted.length - forgotten.length} queued for deletion`
              : deferred.length > 0
                ? `${deleted.length} backups scheduled; ${deferred.length} will resume when Relay reconnects`
                : `${deleted.length} ${deleted.length === 1 ? "backup" : "backups"} queued for deletion`,
        type: deferred.length > 0 ? "warning" : "success",
      })
    },
  })
  const failedOutcomes = (remove.data ?? []).filter(
    (outcome) => outcome.status === "failed"
  )
  const orphanedConfirmationCount = confirmationBackups.filter(
    (backup) => !backup.relayPresent
  ).length
  const allConfirmationBackupsOrphaned =
    confirmationBackups.length > 0 &&
    orphanedConfirmationCount === confirmationBackups.length
  const openConfirmation = React.useCallback(() => {
    const selected = selectionStore.getSnapshot()
    const selectedBackups: Array<Backup> = []
    for (const backup of backups) {
      if (!selected.has(backup.id)) continue
      const currentName = nameStore.get(backup.id, backup.name)
      selectedBackups.push(
        currentName === backup.name ? backup : { ...backup, name: currentName }
      )
    }
    if (selectedBackups.length === 0) return
    remove.reset()
    setConfirmationBackups(selectedBackups)
    setConfirmOpen(true)
  }, [backups, nameStore, remove, selectionStore])

  return (
    <>
      <BackupBulkActionMenu
        disabled={remove.isPending}
        store={selectionStore}
        onDelete={openConfirmation}
      />

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (remove.isPending) return
          setConfirmOpen(open)
          if (!open) {
            remove.reset()
            setConfirmationBackups([])
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {allConfirmationBackupsOrphaned
                ? "Forget"
                : orphanedConfirmationCount > 0
                  ? "Remove"
                  : "Delete"}{" "}
              {confirmationBackups.length}{" "}
              {confirmationBackups.length === 1 ? "backup" : "backups"}?
            </DialogTitle>
            <DialogDescription>
              {allConfirmationBackupsOrphaned
                ? "Their Relays no longer belong to Hearth. Backup history will be forgotten, while stored files remain untouched."
                : orphanedConfirmationCount > 0
                  ? `${orphanedConfirmationCount} orphaned ${orphanedConfirmationCount === 1 ? "backup" : "backups"} will be forgotten. The remaining backups and their stored artifacts will be deleted.`
                  : "Every selected backup and all of its stored artifacts will be permanently removed. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-44 overflow-y-auto rounded-lg border bg-muted/15 px-3 py-2">
            <ul className="divide-y divide-border/60 text-sm">
              {confirmationBackups.map((backup) => (
                <li
                  key={backup.id}
                  className="flex min-w-0 py-2 first:pt-0 last:pb-0"
                >
                  <span className="truncate font-medium">{backup.name}</span>
                </li>
              ))}
            </ul>
          </div>
          {failedOutcomes.length > 0 ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {failedOutcomes.map((outcome) => (
                <p key={outcome.backup.id}>
                  <span className="font-semibold">{outcome.backup.name}:</span>{" "}
                  {outcome.message}
                </p>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              disabled={remove.isPending}
              type="button"
              variant="ghost"
              onClick={() => {
                setConfirmOpen(false)
                setConfirmationBackups([])
                remove.reset()
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending || confirmationBackups.length === 0}
              type="button"
              variant="destructive"
              onClick={() => remove.mutate(confirmationBackups)}
            >
              {remove.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : allConfirmationBackupsOrphaned ? (
                <ArchiveX />
              ) : (
                <Trash2 />
              )}
              {allConfirmationBackupsOrphaned
                ? "Forget"
                : orphanedConfirmationCount > 0
                  ? "Remove"
                  : "Delete"}{" "}
              {confirmationBackups.length}{" "}
              {confirmationBackups.length === 1 ? "backup" : "backups"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

function subscribeToMobileBackupLayout(onChange: () => void): () => void {
  const media = window.matchMedia(mobileBackupLayoutQuery)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

function getMobileBackupLayoutSnapshot(): boolean {
  return window.matchMedia(mobileBackupLayoutQuery).matches
}

function getServerMobileBackupLayoutSnapshot(): boolean {
  return false
}

function backupRowKey(backup: Backup) {
  return backup.id
}

function backupRowSelectionState(
  selectedBackupIds: ReadonlySet<string>
): RowSelectionState {
  return Object.fromEntries(
    [...selectedBackupIds].map((backupId) => [backupId, true] as const)
  )
}

function backupSelectionMatchesState(
  selectedBackupIds: ReadonlySet<string>,
  rowSelection: RowSelectionState
): boolean {
  const selectedRowIds = Object.keys(rowSelection)
  return (
    selectedBackupIds.size === selectedRowIds.length &&
    selectedRowIds.every((backupId) => selectedBackupIds.has(backupId))
  )
}
