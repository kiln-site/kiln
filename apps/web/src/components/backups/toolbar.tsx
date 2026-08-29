import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Check,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { useWorkspaceTableSearchInput } from "@/components/workspace-data-table"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import { backupsQueryOptions } from "@/lib/query-options"
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
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(
    () => searchStore.getSnapshot().length > 0
  )
  useWorkspaceTableSearchInput(inputRef, searchStore)

  React.useEffect(() => {
    if (mobileSearchOpen) inputRef.current?.focus()
  }, [mobileSearchOpen])

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <BackupSyncButton />

      {!mobileSearchOpen ? (
        <Button
          aria-label="Search backups"
          className="sm:hidden"
          size="icon"
          type="button"
          variant="outline"
          onClick={() => setMobileSearchOpen(true)}
        >
          <Search />
        </Button>
      ) : null}
      <div
        className={`${mobileSearchOpen ? "block" : "hidden"} relative min-w-0 flex-1 sm:block sm:max-w-md`}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          aria-label="Search backups"
          className="pl-9 text-base md:text-sm"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search backups"
          type="search"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>
      {mobileSearchOpen ? (
        <Button
          aria-label="Close backup search"
          className="sm:hidden"
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => {
            searchStore.set("")
            setMobileSearchOpen(false)
          }}
        >
          <X />
        </Button>
      ) : null}
      <BackupStatusFilter
        mobileSearchOpen={mobileSearchOpen}
        statusFilterStore={statusFilterStore}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="New Backup"
            className={`${mobileSearchOpen ? "hidden sm:inline-flex" : "inline-flex"} ml-auto shrink-0`}
            disabled={!canCreate}
            type="button"
            onClick={() => dialogStore.open({ kind: "create" })}
          >
            <Plus /> <span className="hidden sm:inline">New Backup</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">New Backup</TooltipContent>
      </Tooltip>
    </div>
  )
})

const BackupStatusFilter = React.memo(function BackupStatusFilter({
  mobileSearchOpen,
  statusFilterStore,
}: {
  mobileSearchOpen: boolean
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
              className={`${mobileSearchOpen ? "hidden sm:inline-flex" : "inline-flex"} shrink-0`}
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
  const { refetch } = useQuery({
    ...backupsQueryOptions(),
    notifyOnChangeProps: [],
  })
  const [spinning, setSpinning] = React.useState(false)
  const fetchDoneRef = React.useRef(true)
  const fallbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)
  const syncing = spinning

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
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
    if (spinning) return
    fetchDoneRef.current = false
    setSpinning(true)
    forkPromise(() =>
      ensuringPromise(refetch, () => {
        fetchDoneRef.current = true
        fallbackTimeoutRef.current = window.setTimeout(
          stopSpinIfDone,
          minimumBackupSyncFeedbackMs
        )
      })
    )
  }, [refetch, spinning, stopSpinIfDone])

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
