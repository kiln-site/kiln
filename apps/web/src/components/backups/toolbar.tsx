import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Check, Plus, RefreshCw, SlidersHorizontal } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { DataTableToolbar } from "@/components/data-table-workspace"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import { backupRunsSearchMaxLength } from "@/lib/backup-runs"
import { resetActiveBackupRunsToFirstPage } from "@/lib/backup-runs-cache"
import { syncBackupRuns } from "@/server/backups"
import type {
  BackupDialogStore,
  BackupFilters,
  BackupSearchStore,
  BackupStatusFilterStore,
} from "@/components/backups/state"

const minimumBackupSyncFeedbackMs = 1_000
const backupStatusFilterOptions: ReadonlyArray<{
  label: string
  value: BackupFilters["status"]
}> = [
  { label: "All statuses", value: undefined },
  { label: "Available", value: "available" },
  { label: "In progress", value: "active" },
  { label: "Failed", value: "failed" },
]

export const BackupToolbar = React.memo(function BackupToolbar({
  canCreate,
  dialogStore,
  searchStore,
  statusFilterStore,
}: {
  canCreate: boolean
  dialogStore: BackupDialogStore
  searchStore: BackupSearchStore
  statusFilterStore: BackupStatusFilterStore
}) {
  return (
    <DataTableToolbar
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="New Backup"
              disabled={!canCreate}
              type="button"
              onClick={() => dialogStore.open({ kind: "create" })}
            >
              <Plus /> <span className="hidden sm:inline">New Backup</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New Backup</TooltipContent>
        </Tooltip>
      }
      controls={<BackupStatusFilter statusFilterStore={statusFilterStore} />}
      leading={<BackupSyncButton />}
      search={{
        ariaLabel: "Search backups",
        maxLength: backupRunsSearchMaxLength,
        placeholder: "Search backups",
        store: searchStore,
      }}
    />
  )
})

const BackupStatusFilter = React.memo(function BackupStatusFilter({
  statusFilterStore,
}: {
  statusFilterStore: BackupStatusFilterStore
}) {
  const status = React.useSyncExternalStore(
    statusFilterStore.subscribe,
    statusFilterStore.getSnapshot,
    statusFilterStore.getServerSnapshot
  )

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Filter backups by status"
              className="shrink-0"
              type="button"
              variant={status ? "secondary" : "outline"}
            >
              <SlidersHorizontal />
              <span className="hidden lg:inline">
                {backupStatusFilterLabel(status)}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Filter by status</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {backupStatusFilterOptions.map((option) => (
          <DropdownMenuItem
            key={option.label}
            onSelect={() => statusFilterStore.set(option.value)}
          >
            <span className="w-4">
              {status === option.value ? <Check /> : null}
            </span>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

const BackupSyncButton = React.memo(function BackupSyncButton() {
  const queryClient = useQueryClient()
  const [spinning, setSpinning] = React.useState(false)
  const fetchDoneRef = React.useRef(true)
  const fallbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)
  const syncControllerRef = React.useRef<AbortController>(undefined)
  const syncing = spinning

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      syncControllerRef.current?.abort()
      if (fallbackTimeoutRef.current !== undefined) {
        window.clearTimeout(fallbackTimeoutRef.current)
      }
    }
  }, [])

  const stopSpinIfDone = React.useCallback(() => {
    if (!mountedRef.current || !fetchDoneRef.current) return
    if (fallbackTimeoutRef.current !== undefined) {
      window.clearTimeout(fallbackTimeoutRef.current)
      fallbackTimeoutRef.current = undefined
    }
    setSpinning(false)
  }, [])

  const syncBackups = React.useCallback(() => {
    if (spinning || syncControllerRef.current) return
    const controller = new AbortController()
    syncControllerRef.current = controller
    fetchDoneRef.current = false
    setSpinning(true)
    forkPromise(
      () =>
        ensuringPromise(
          async () => {
            await syncBackupRuns({ signal: controller.signal })
            await resetActiveBackupRunsToFirstPage(
              queryClient,
              controller.signal
            )
          },
          () => {
            if (syncControllerRef.current === controller) {
              syncControllerRef.current = undefined
            }
            fetchDoneRef.current = true
            if (!mountedRef.current) return
            fallbackTimeoutRef.current = window.setTimeout(
              stopSpinIfDone,
              minimumBackupSyncFeedbackMs
            )
          }
        ),
      (cause) => {
        if (controller.signal.aborted) return
        showToast({
          message: `Backup sync failed: ${cause instanceof Error ? cause.message : "Unknown error"}`,
          type: "error",
        })
      }
    )
  }, [queryClient, spinning, stopSpinIfDone])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Sync backups"
          aria-busy={syncing}
          disabled={syncing}
          size="icon"
          type="button"
          variant="outline"
          onClick={syncBackups}
        >
          <RefreshCw
            className={spinning ? "animate-spin" : ""}
            onAnimationIteration={stopSpinIfDone}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Sync backups</TooltipContent>
    </Tooltip>
  )
})

function backupStatusFilterLabel(status: BackupFilters["status"]): string {
  return (
    backupStatusFilterOptions.find((option) => option.value === status)
      ?.label ?? "All statuses"
  )
}
