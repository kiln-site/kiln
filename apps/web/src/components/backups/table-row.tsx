import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Check,
  CircleAlert,
  CircleOff,
  CircleStop,
  Download,
  LoaderCircle,
  Pencil,
  Plus,
  History as RotateCcwClock,
  Trash2,
  X,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Progress } from "@workspace/ui/components/progress"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  InstanceName,
  type InstanceNameInstance,
} from "@/components/instance-name"
import {
  backupShowsArchivedLocalArtifact,
  backupTaskUploadProgressPercent,
} from "@/lib/backup-progress-presentation"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import { resetActiveBackupRunsToFirstPage } from "@/lib/backup-runs-cache"
import {
  cancelBackup,
  copyBackupToDestination,
  renameBackup,
} from "@/server/backups"
import type {
  Backup,
  BackupAvailabilityDestination,
  BackupDialogStore,
  BackupFilters,
  BackupNameStore,
} from "@/components/backups/state"

type BackupAvailabilityTagView = {
  error: string | null
  key: string
  kind: "local" | "remote"
  label: string
  name: string
  state: BackupAvailabilityState
  tooltip?: string
  uploadPercent: number | null
}
type BackupAvailabilityState =
  | "available"
  | "cancelled"
  | "deleting"
  | "failed"
  | "missing"
  | "working"
type BackupTargetPresentation = {
  id: string
  kindLabel: "Database" | "Relay" | "Server"
  name: string
}
const activeStatuses = new Set(["queued", "running", "deleting"])
const backupDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "long",
})
const backupDateCompact = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
})
const backupMinuteMs = 60_000
const backupHourMs = 60 * backupMinuteMs
const backupDayMs = 24 * backupHourMs

export const BackupTaskFeedback = React.memo(function BackupTaskFeedback({
  backup,
}: {
  backup: Backup
}) {
  const active =
    backup.taskStatus === "queued" || backup.taskStatus === "running"
  if (active) {
    return <ActiveBackupTaskState backup={backup} />
  }
  if (!backup.taskError) return null
  const cancelled = backup.taskStatus === "cancelled"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <p
          className={`flex min-w-0 items-center gap-1.5 text-xs ${cancelled ? "text-muted-foreground" : "text-destructive"}`}
        >
          {cancelled ? (
            <CircleStop className="size-3 shrink-0" />
          ) : (
            <CircleAlert className="size-3 shrink-0" />
          )}
          <span className="truncate">{backup.taskError}</span>
        </p>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-normal" side="bottom">
        {backup.taskPhase ? `${backupTaskPhaseLabel(backup.taskPhase)} · ` : ""}
        {backup.taskCurrentPath ? `${backup.taskCurrentPath} · ` : ""}
        {backup.taskError}
      </TooltipContent>
    </Tooltip>
  )
})

export const DesktopBackupTaskFeedback = React.memo(
  function DesktopBackupTaskFeedback({ backup }: { backup: Backup }) {
    const feedbackRef = React.useRef<HTMLDivElement>(null)
    React.useLayoutEffect(() => {
      const feedback = feedbackRef.current
      const cell = feedback?.parentElement
      const row = cell?.parentElement
      const actionsCell = row?.lastElementChild
      const createdCell = actionsCell?.previousElementSibling
      if (
        !feedback ||
        !(cell instanceof HTMLTableCellElement) ||
        !(actionsCell instanceof HTMLTableCellElement) ||
        !(createdCell instanceof HTMLTableCellElement)
      ) {
        return
      }
      const fitToActions = () => {
        const feedbackLeft = feedback.getBoundingClientRect().left
        const showCreatedTime =
          backup.taskStatus === "cancelled" &&
          window.getComputedStyle(createdCell).display !== "none"
        const boundaryCell = showCreatedTime ? createdCell : actionsCell
        const boundaryLeft = boundaryCell.getBoundingClientRect().left
        const trailingInset = Number.parseFloat(
          window.getComputedStyle(boundaryCell).paddingLeft
        )
        feedback.style.width = `${Math.max(
          0,
          boundaryLeft - feedbackLeft - trailingInset
        )}px`
      }
      const observer = new ResizeObserver(fitToActions)
      observer.observe(cell)
      observer.observe(createdCell)
      observer.observe(actionsCell)
      fitToActions()
      return () => observer.disconnect()
    }, [backup.taskStatus])
    return (
      <div ref={feedbackRef} className="relative z-10 min-w-0">
        <BackupTaskFeedback backup={backup} />
      </div>
    )
  }
)

const ActiveBackupTaskState = React.memo(function ActiveBackupTaskState({
  backup,
}: {
  backup: Backup
}) {
  const percent = backupTaskProgressPercent(backup)
  const progressDetail = backupTaskProgressDetail(backup, percent)
  return (
    <div className="min-w-0">
      <div aria-live="polite">
        <div className="type-support mb-1 flex min-w-0 items-center justify-between gap-2 text-muted-foreground">
          <span className="truncate font-medium text-foreground">
            {backupTaskPhaseLabel(backup.taskPhase, backup.taskStatus)}
          </span>
          <span className="shrink-0 tabular-nums">{progressDetail}</span>
        </div>
        <Progress
          aria-label={`${backup.name} progress`}
          className={
            percent === null
              ? "[&_[data-slot=progress-indicator]]:animate-pulse"
              : ""
          }
          value={percent ?? undefined}
        />
      </div>
      <div className="type-meta mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <div aria-live="polite" className="flex min-w-0 flex-1">
          {backup.taskCurrentPath ? (
            <BackupCurrentPath path={backup.taskCurrentPath} />
          ) : null}
        </div>
        <BackupElapsedTimer startedAt={backup.taskStartedAt} />
      </div>
    </div>
  )
})

const BackupElapsedTimer = React.memo(function BackupElapsedTimer({
  startedAt,
}: {
  startedAt: string | null
}) {
  const parsedStartedAt = startedAt ? new Date(startedAt).getTime() : Number.NaN
  const startedAtMs = Number.isFinite(parsedStartedAt) ? parsedStartedAt : null
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (startedAtMs === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAtMs])
  const elapsed = formatBackupElapsed(
    startedAtMs === null ? 0 : now - startedAtMs
  )
  return (
    <span
      aria-label={`Elapsed backup time ${elapsed}`}
      className="shrink-0 font-mono tabular-nums"
      suppressHydrationWarning
      title={
        startedAtMs === null
          ? "Waiting to start"
          : `Started ${backupDate.format(startedAtMs)}`
      }
    >
      {elapsed}
    </span>
  )
})

const BackupCurrentPath = React.memo(function BackupCurrentPath({
  path,
}: {
  path: string
}) {
  const segments = path.split("/")
  const filename = segments.at(-1) ?? path
  if (segments.length === 1) {
    return (
      <code className="mr-auto min-w-0 truncate font-mono" title={path}>
        {path}
      </code>
    )
  }
  const firstDirectory = segments[0]
  const middleDirectories =
    segments.length > 2 ? segments.slice(1, -1).join("/") : null
  return (
    <code
      className={`mr-auto grid min-w-0 font-mono ${middleDirectories ? "grid-cols-[minmax(7ch,1fr)_minmax(0,max-content)]" : "grid-cols-[minmax(4ch,1fr)_minmax(0,max-content)]"}`}
      title={path}
    >
      <span
        className={`grid min-w-0 ${middleDirectories ? "grid-cols-[minmax(4ch,max-content)_minmax(3ch,1fr)]" : "grid-cols-[minmax(4ch,max-content)]"}`}
      >
        <span className="flex min-w-0">
          <span className="truncate">{firstDirectory}</span>
          <span>/</span>
        </span>
        {middleDirectories ? (
          <span className="flex min-w-0">
            <span className="truncate">{middleDirectories}</span>
            <span>/</span>
          </span>
        ) : null}
      </span>
      <span className="truncate">{filename}</span>
    </code>
  )
})

export const BackupRowActions = React.memo(function BackupRowActions({
  backup,
  canCancel,
  dialogStore,
  nameStore,
  targetAvailable,
}: {
  backup: Backup
  canCancel: boolean
  dialogStore: BackupDialogStore
  nameStore: BackupNameStore
  targetAvailable: boolean
}) {
  const backupForDialog = () => {
    const currentName = nameStore.get(backup.id, backup.name)
    return currentName === backup.name
      ? backup
      : { ...backup, name: currentName }
  }
  const cancellable =
    canCancel &&
    backup.taskKind === "create" &&
    (backup.taskStatus === "queued" || backup.taskStatus === "running")
  const canRestore =
    backup.status === "available" &&
    !backupSourceIsActive(backup) &&
    targetAvailable &&
    (backup.targetKind === "instance" || backup.targetKind === "database")
  const restore = (
    <Button
      aria-label={`Restore ${backup.name}`}
      disabled={!canRestore}
      size="sm"
      type="button"
      variant="outline"
      onClick={() =>
        dialogStore.open({ backup: backupForDialog(), kind: "restore" })
      }
    >
      <RotateCcwClock /> Restore
    </Button>
  )
  return (
    <div className="flex items-center gap-1">
      {cancellable ? (
        <CancelBackupButton backup={backup} />
      ) : targetAvailable ? (
        restore
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">{restore}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {missingTargetMessage(backup.targetKind)}
          </TooltipContent>
        </Tooltip>
      )}
      <div className="flex items-center gap-0.5">
        <BackupActionButton
          disabled={backup.status !== "available"}
          icon={Download}
          label={`Download ${backup.name}`}
          tooltip="Download or create a link"
          onClick={() =>
            dialogStore.open({ backup: backupForDialog(), kind: "download" })
          }
        />
        <BackupActionButton
          disabled={!backupCanBeRemoved(backup)}
          icon={Trash2}
          label={`${backup.relayPresent ? "Delete" : "Forget"} ${backup.name}`}
          tooltip={backup.relayPresent ? "Delete backup" : "Forget backup"}
          onClick={() =>
            dialogStore.open({ backup: backupForDialog(), kind: "delete" })
          }
        />
      </div>
    </div>
  )
})

const CancelBackupButton = React.memo(function CancelBackupButton({
  backup,
}: {
  backup: Backup
}) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => cancelBackup({ data: { backupId: backup.id } }),
    onError: (error) => {
      showToast({
        message:
          error instanceof Error ? error.message : "Could not cancel backup",
        type: "error",
      })
    },
    onSuccess: async () => {
      await resetActiveBackupRunsToFirstPage(queryClient)
      showToast({ message: "Backup cancelled", type: "success" })
    },
  })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={`Cancel ${backup.name}`}
          disabled={cancel.isPending}
          size="sm"
          type="button"
          variant="destructive"
          onClick={() => cancel.mutate()}
        >
          {cancel.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <CircleStop />
          )}
          Cancel
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Stop creating this backup</TooltipContent>
    </Tooltip>
  )
})

export const BackupNameEditor = React.memo(function BackupNameEditor({
  backupId,
  editable,
  nameStore,
  name,
}: {
  backupId: string
  editable: boolean
  nameStore: BackupNameStore
  name: string
}) {
  const queryClient = useQueryClient()
  const nameRef = React.useRef<HTMLInputElement>(null)
  const [editing, setEditing] = React.useState(false)
  const getNameSnapshot = React.useCallback(
    () => nameStore.get(backupId, name),
    [backupId, name, nameStore]
  )
  const subscribeToName = React.useCallback(
    (listener: () => void) => nameStore.subscribeToBackup(backupId, listener),
    [backupId, nameStore]
  )
  const currentName = React.useSyncExternalStore(
    subscribeToName,
    getNameSnapshot,
    () => name
  )
  const rename = useMutation({
    mutationFn: (nextName: string) =>
      renameBackup({ data: { backupId, name: nextName } }),
    onError: (error) => {
      showToast({
        message:
          error instanceof Error ? error.message : "Could not rename backup",
        type: "error",
      })
    },
    onSuccess: async (result: { name: string }) => {
      nameStore.set(backupId, result.name)
      await resetActiveBackupRunsToFirstPage(queryClient)
      setEditing(false)
      showToast({
        message: "Backup renamed",
        type: "success",
      })
    },
  })

  React.useLayoutEffect(() => {
    if (!editing) return
    const input = nameRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [editing])

  const saveName = () => {
    if (rename.isPending) return
    const next = nameRef.current?.value.trim() ?? ""
    if (next.length === 0) {
      showToast({
        message: "Backup name is required",
        type: "error",
      })
      return
    }
    if (next === currentName) {
      setEditing(false)
      return
    }
    rename.mutate(next)
  }

  const cancelEditing = () => {
    if (rename.isPending) return
    setEditing(false)
  }

  return (
    <div className="flex h-6 min-w-0 items-center gap-1">
      {editing && editable ? (
        <>
          <input
            ref={nameRef}
            aria-label={`Backup name for ${currentName}`}
            autoComplete="off"
            className="h-6 min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-sm leading-6 font-semibold shadow-none outline-none focus-visible:text-foreground"
            defaultValue={currentName}
            disabled={rename.isPending}
            maxLength={120}
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                cancelEditing()
              } else if (event.key === "Enter") {
                event.preventDefault()
                saveName()
              }
            }}
          />
          <BackupActionButton
            disabled={rename.isPending}
            icon={Check}
            label={`Save name for ${currentName}`}
            size="icon-xs"
            spinning={rename.isPending}
            tooltip="Save"
            onClick={saveName}
          />
          <BackupActionButton
            disabled={rename.isPending}
            icon={X}
            label={`Cancel renaming ${currentName}`}
            size="icon-xs"
            tooltip="Cancel"
            onClick={cancelEditing}
          />
        </>
      ) : (
        <>
          <p
            className="min-w-0 truncate text-sm leading-6 font-semibold"
            title={currentName}
          >
            {currentName}
          </p>
          {editable ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Edit name for ${currentName}`}
                  className="shrink-0"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Edit name</TooltipContent>
            </Tooltip>
          ) : null}
        </>
      )}
    </div>
  )
})

export const BackupAvailabilityTags = React.memo(
  function BackupAvailabilityTags({
    backup,
    canCopy,
    currentUserId,
    destinations,
  }: {
    backup: Backup
    canCopy: boolean
    currentUserId: string
    destinations: ReadonlyArray<BackupAvailabilityDestination>
  }) {
    const queryClient = useQueryClient()
    const tags = backupAvailabilityTags(backup, destinations)
    const extraDestinations = extraBackupDestinations(
      backup,
      currentUserId,
      destinations
    )
    const copyDisabledReason = backupCopyDisabledReason(
      backup,
      canCopy,
      destinations,
      extraDestinations
    )
    const copy = useMutation({
      mutationFn: (storageId: string) =>
        copyBackupToDestination({
          data: { backupId: backup.id, storageId },
        }),
      onError: (error) => {
        showToast({
          message:
            error instanceof Error
              ? error.message
              : "Could not copy this backup",
          type: "error",
        })
      },
      onSuccess: async () => {
        await resetActiveBackupRunsToFirstPage(queryClient)
        showToast({
          message: "Backup copy started",
          type: "success",
        })
      },
    })
    const plusButton = (
      <Button
        aria-label={`Copy ${backup.name} to another destination`}
        className="shrink-0"
        disabled={copy.isPending}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        {copy.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
      </Button>
    )

    return (
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="type-meta text-muted-foreground">Availability:</span>
        {tags.map((tag) => (
          <BackupAvailabilityTag key={tag.key} tag={tag} />
        ))}
        {copyDisabledReason ? null : extraDestinations.length === 1 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={`Copy ${backup.name} to ${extraDestinations[0]?.name}`}
                className="shrink-0"
                disabled={copy.isPending}
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={() => {
                  const storageId = extraDestinations[0]?.id
                  if (storageId) copy.mutate(storageId)
                }}
              >
                {copy.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plus />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Copy to {extraDestinations[0]?.name}
            </TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>{plusButton}</DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                Copy to another destination
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              {extraDestinations.map((destination) => (
                <DropdownMenuItem
                  key={destination.id}
                  disabled={copy.isPending}
                  onSelect={() => {
                    if (destination.id) copy.mutate(destination.id)
                  }}
                >
                  {destination.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    )
  }
)

function BackupAvailabilityTag({ tag }: { tag: BackupAvailabilityTagView }) {
  const working = tag.state === "working"
  const deleting = tag.state === "deleting"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`type-meta inline-flex h-6 max-w-36 items-center gap-1 rounded-md border px-2 font-mono font-semibold ${tag.key === "local" || tag.key === "s3" ? "uppercase" : ""} ${availabilityTagClassName(tag.state)}`}
        >
          {tag.uploadPercent !== null ? (
            <BackupUploadProgress
              label={`${tag.name} upload`}
              percent={tag.uploadPercent}
            />
          ) : working || deleting ? (
            <LoaderCircle className="size-2.5 shrink-0 animate-spin" />
          ) : tag.state === "available" ? (
            <Check className="size-2.5 shrink-0" />
          ) : tag.state === "failed" ? (
            <X className="size-2.5 shrink-0" />
          ) : (
            <CircleOff className="size-2.5 shrink-0" />
          )}
          <span className="truncate">{tag.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {tag.tooltip ??
          `${tag.name} · ${
            tag.uploadPercent === null
              ? availabilityStateLabel(tag.state)
              : `Uploading · ${tag.uploadPercent}%`
          }${tag.error ? ` · ${tag.error}` : ""}`}
      </TooltipContent>
    </Tooltip>
  )
}

const BackupUploadProgress = React.memo(function BackupUploadProgress({
  label,
  percent,
}: {
  label: string
  percent: number
}) {
  const radius = 4
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - percent / 100)
  return (
    <svg
      aria-label={`${label}: ${percent}%`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className="size-2.5 shrink-0 -rotate-90"
      role="progressbar"
      viewBox="0 0 10 10"
    >
      <circle
        className="stroke-current opacity-25"
        cx="5"
        cy="5"
        fill="none"
        r={radius}
        strokeWidth="1.5"
      />
      <circle
        className="stroke-current transition-[stroke-dashoffset] duration-300"
        cx="5"
        cy="5"
        fill="none"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  )
})

function BackupMissingTargetTooltip({
  children,
  kind,
  missing,
}: {
  children: React.ReactElement
  kind: Backup["targetKind"]
  missing: boolean
}) {
  if (!missing) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{missingTargetMessage(kind)}</TooltipContent>
    </Tooltip>
  )
}

export const BackupTargetLink = React.memo(function BackupTargetLink({
  available,
  instance,
  relayId,
  target,
  targetId,
  targetKind,
}: {
  available: boolean
  instance?: InstanceNameInstance
  relayId: string
  target: BackupTargetPresentation
  targetId: string
  targetKind: Backup["targetKind"]
}) {
  const identity = (
    <InstanceName
      className="w-full"
      instance={
        instance ?? {
          kind:
            targetKind === "database"
              ? "database"
              : targetKind === "platform"
                ? "relay"
                : "server",
        }
      }
      name={target.name}
      nameClassName={
        available
          ? "transition-colors group-hover/target-link:text-primary"
          : "text-muted-foreground"
      }
      meta={`${target.kindLabel} · ${target.id.slice(0, 8)}`}
      metaClassName="font-mono"
    />
  )
  const targetContent = available ? (
    <BackupTargetAnchor
      relayId={relayId}
      searchId={target.id}
      targetId={targetId}
      targetKind={targetKind}
      targetName={target.name}
    >
      {identity}
    </BackupTargetAnchor>
  ) : (
    <BackupMissingTargetTooltip kind={targetKind} missing>
      <div
        aria-label={missingTargetMessage(targetKind)}
        className="flex min-h-14 min-w-0 flex-1 cursor-help items-center px-3 py-2.5"
      >
        {identity}
      </div>
    </BackupMissingTargetTooltip>
  )

  return (
    <div className="-mx-3 -my-2.5 flex w-[calc(100%+1.5rem)] min-w-0 items-stretch">
      {targetContent}
    </div>
  )
})

const BackupTargetAnchor = React.memo(function BackupTargetAnchor({
  children,
  relayId,
  searchId,
  targetId,
  targetKind,
  targetName,
}: {
  children: React.ReactNode
  relayId: string
  searchId: string
  targetId: string
  targetKind: Backup["targetKind"]
  targetName: string
}) {
  const className =
    "group/target-link flex min-h-14 min-w-0 flex-1 items-center px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"

  if (targetKind === "instance") {
    return (
      <Link
        aria-label={`Open ${targetName}`}
        className={className}
        params={{
          serverId: relayInstanceRouteId(relayId, targetId.slice(0, 8)),
        }}
        preload="intent"
        to="/server/$serverId/console"
      >
        {children}
      </Link>
    )
  }

  if (targetKind === "database") {
    return (
      <Link
        aria-label={`Open ${targetName}`}
        className={className}
        preload="intent"
        search={{ search: searchId }}
        to="/infra/databases"
      >
        {children}
      </Link>
    )
  }

  return (
    <Link
      aria-label={`View ${targetName}`}
      className={className}
      preload="intent"
      to="/infra/relays"
    >
      {children}
    </Link>
  )
})

export function BackupCreatedTime({ createdAt }: { createdAt: string }) {
  const timestamp = new Date(createdAt).getTime()
  const relative = shortRelativeBackupTime(timestamp)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className="block truncate text-sm"
          dateTime={createdAt}
          suppressHydrationWarning
        >
          {relative ?? backupDateCompact.format(timestamp)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span suppressHydrationWarning>{backupDate.format(timestamp)}</span>
      </TooltipContent>
    </Tooltip>
  )
}

export function BackupActionButton({
  disabled,
  icon: Icon,
  label,
  onClick,
  size = "icon-sm",
  spinning = false,
  tooltip,
}: {
  disabled: boolean
  icon: typeof Download
  label: string
  onClick: () => void
  size?: "icon" | "icon-sm" | "icon-xs"
  spinning?: boolean
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={disabled}
          size={size}
          type="button"
          variant="ghost"
          onClick={onClick}
        >
          <Icon className={spinning ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function backupIsActive(backup: Backup): boolean {
  return (
    backupSourceIsActive(backup) ||
    backup.artifacts.some((artifact) => activeStatuses.has(artifact.status))
  )
}

export function backupCanBeRemoved(backup: Backup): boolean {
  return !backup.relayPresent || !backupIsActive(backup)
}

function backupSourceIsActive(backup: Backup): boolean {
  return (
    activeStatuses.has(backup.status) ||
    (backup.status === "available" &&
      (backup.taskStatus === "queued" || backup.taskStatus === "running"))
  )
}

export function backupMatchesStatusFilter(
  backup: Backup,
  status: BackupFilters["status"]
): boolean {
  if (!status) return true
  const active = backupIsActive(backup)
  if (status === "active") return active
  const failed =
    backup.status === "failed" ||
    backup.artifacts.some((artifact) => artifact.status === "failed")
  if (status === "failed") return !active && failed
  return !active && !failed && backup.status === "available"
}

const BackupModeBadge = React.memo(function BackupModeBadge({
  mode,
}: {
  mode: Backup["backupMode"]
}) {
  return (
    <Badge variant="outline" className="type-meta shrink-0 px-1.5 py-0">
      {mode === "incremental" ? "Incremental" : "Full"}
    </Badge>
  )
})

export const BackupSizeDetails = React.memo(function BackupSizeDetails({
  bytes,
  mode,
}: {
  bytes: number | null
  mode: Backup["backupMode"]
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="whitespace-nowrap">
        {bytes === null ? "—" : formatBytes(bytes)}
      </span>
      <BackupModeBadge mode={mode} />
    </div>
  )
})

export function backupTargetName(
  backup: Backup,
  targetNames: ReadonlyMap<string, string>
): string {
  if (backup.targetKind === "platform") return "Kiln platform"
  return (
    targetNames.get(
      targetKey(backup.targetKind, backup.relayId, backup.targetId)
    ) ?? backup.targetId
  )
}

export function backupTargetSortName(
  backup: Backup,
  relayNames: ReadonlyMap<string, string>,
  targetNames: ReadonlyMap<string, string>
): string {
  if (backup.targetKind === "platform") {
    return relayNames.get(backup.relayId) ?? ""
  }
  return (
    targetNames.get(
      targetKey(backup.targetKind, backup.relayId, backup.targetId)
    ) ?? ""
  )
}

export function backupTargetPresentation(
  backup: Backup,
  relayName: string,
  targetName: string
): BackupTargetPresentation {
  if (backup.targetKind === "platform") {
    return {
      id: backup.relayId,
      kindLabel: "Relay",
      name: relayName,
    }
  }
  const shortId = backup.targetId.slice(0, 8)
  return {
    id: backup.targetId,
    kindLabel: backup.targetKind === "database" ? "Database" : "Server",
    name: targetName === backup.targetId ? shortId : targetName,
  }
}

function missingTargetMessage(kind: Backup["targetKind"]): string {
  if (kind === "database") return "This database no longer exists"
  if (kind === "platform") return "This Relay no longer exists"
  return "This server no longer exists"
}

function backupAvailabilityTags(
  backup: Backup,
  destinations: ReadonlyArray<BackupAvailabilityDestination>
): Array<BackupAvailabilityTagView> {
  const incremental = backup.artifactKind === "restic_snapshot"
  const incrementalStorageIds = new Set(
    backup.artifacts.map((artifact) => artifact.storageId)
  )
  const visibleDestinations = incremental
    ? destinations.filter((destination) =>
        incrementalStorageIds.has(destination.id)
      )
    : destinations
  const uploadPercent = backupTaskUploadProgressPercent(backup)
  const artifactsByStorage = new Map<string, Backup["artifacts"][number]>()
  for (const artifact of backup.artifacts) {
    artifactsByStorage.set(artifact.storageId ?? "local", artifact)
  }
  const tags: Array<BackupAvailabilityTagView> = visibleDestinations.map(
    (destination) => {
      const key = destination.id ?? "local"
      const kind = destination.id ? "remote" : "local"
      const artifact = artifactsByStorage.get(key)
      const state = backupArtifactAvailabilityState(backup, artifact, kind)
      return {
        error: artifact?.error ?? null,
        key,
        kind,
        label: destination.id ? destination.name : "Local",
        name: destination.id ? destination.name : "Local Relay",
        state,
        uploadPercent:
          destination.id &&
          artifact?.id === backup.taskCurrentArtifactId &&
          state === "working"
            ? uploadPercent
            : null,
      }
    }
  )
  const seen = new Set(tags.map((tag) => tag.key))
  for (const artifact of backup.artifacts) {
    const key = artifact.storageId ?? "local"
    if (seen.has(key)) continue
    const kind = artifact.storageId ? "remote" : "local"
    const state = backupArtifactAvailabilityState(backup, artifact, kind)
    tags.push({
      error: artifact.error,
      key,
      kind,
      label: artifact.storageId ? "S3" : "Local",
      name: artifact.storageId ? "S3 destination" : "Local Relay",
      state,
      uploadPercent:
        artifact.storageId &&
        artifact.id === backup.taskCurrentArtifactId &&
        state === "working"
          ? uploadPercent
          : null,
    })
  }
  const s3Configured =
    destinations.some((destination) => destination.id !== null) ||
    backup.artifacts.some((artifact) => artifact.storageId !== null)
  if (!incremental && !s3Configured) {
    tags.push({
      error: null,
      key: "s3",
      kind: "remote",
      label: "S3",
      name: "S3",
      state: "missing",
      tooltip: "S3 not configured",
      uploadPercent: null,
    })
  }
  return tags
}

function backupArtifactAvailabilityState(
  backup: Backup,
  artifact: Backup["artifacts"][number] | undefined,
  kind: BackupAvailabilityTagView["kind"]
): BackupAvailabilityState {
  const state = artifactAvailabilityState(backup, artifact)
  if (
    kind === "local" &&
    backupShowsArchivedLocalArtifact(backup, state === "working")
  ) {
    return "available"
  }
  return state
}

function extraBackupDestinations(
  backup: Backup,
  currentUserId: string,
  destinations: ReadonlyArray<BackupAvailabilityDestination>
): Array<BackupAvailabilityDestination & { id: string }> {
  return destinations.flatMap((destination) => {
    if (
      !destination.enabled ||
      !destination.id ||
      (backup.targetKind === "platform"
        ? destination.ownerUserId !== null
        : destination.ownerUserId !== null &&
          destination.ownerUserId !== currentUserId)
    ) {
      return []
    }
    const artifact = backup.artifacts.find(
      (candidate) => candidate.storageId === destination.id
    )
    if (
      artifact &&
      (artifact.status === "available" ||
        artifact.status === "queued" ||
        artifact.status === "running")
    ) {
      return []
    }
    return [{ ...destination, id: destination.id }]
  })
}

function backupCopyDisabledReason(
  backup: Backup,
  canCopy: boolean,
  destinations: ReadonlyArray<BackupAvailabilityDestination>,
  extraDestinations: ReadonlyArray<BackupAvailabilityDestination>
): string | null {
  if (!canCopy) return "You do not have permission to copy this backup"
  if (backup.artifactKind === "restic_snapshot") {
    return "Incremental snapshots cannot be copied to S3"
  }
  const hasAvailableFile = backup.artifacts.some(
    (artifact) => artifact.status === "available"
  )
  const s3Configured = destinations.some(
    (destination) => destination.enabled && destination.id !== null
  )
  if (!hasAvailableFile) {
    return "A successful backup file is required before copying to another destination"
  }
  if (!s3Configured) return "S3 not configured"
  if (extraDestinations.length === 0) {
    return "Already stored on every destination"
  }
  return null
}

function artifactAvailabilityState(
  backup: Backup,
  artifact: Backup["artifacts"][number] | undefined
): BackupAvailabilityState {
  const status = artifact?.status
  if (status === "deleting") return "deleting"
  if (
    status === "failed" &&
    backup.taskKind === "create" &&
    backup.taskStatus === "cancelled"
  ) {
    return "cancelled"
  }
  if (artifact?.error) return "failed"
  if (status === "available") return "available"
  if (status === "failed") return "failed"
  if (status === "queued" || status === "running") {
    return "working"
  }
  return "missing"
}

function availabilityTagClassName(state: BackupAvailabilityState): string {
  if (state === "available") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (state === "working") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
  }
  if (state === "deleting") {
    return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  if (state === "failed" || state === "cancelled") {
    return "border-destructive/30 bg-destructive/10 text-destructive"
  }
  return "border-border/70 bg-muted/40 text-muted-foreground"
}

function availabilityStateLabel(state: BackupAvailabilityState): string {
  if (state === "available") return "Available"
  if (state === "working") return "Backing up"
  if (state === "deleting") return "Deleting"
  if (state === "cancelled") return "Cancelled"
  if (state === "failed") return "Failed"
  return "Not available"
}

export function targetKey(
  kind: "database" | "instance" | "platform",
  relayId: string,
  targetId: string
): string {
  return `${kind}:${relayId}:${targetId}`
}

function backupTaskPhaseLabel(
  phase: Backup["taskPhase"],
  status?: Backup["taskStatus"]
): string {
  if (!phase) return status === "queued" ? "Queued" : "Working"
  switch (phase) {
    case "preparing":
      return "Preparing"
    case "collecting":
      return "Scanning files"
    case "archiving":
      return "Archiving"
    case "dumping":
      return "Exporting data"
    case "uploading":
      return "Uploading"
    case "finalizing":
      return "Finalizing"
  }
}

function backupTaskProgressPercent(backup: Backup): number | null {
  if (backup.taskPhase === "uploading" || backup.taskPhase === "finalizing") {
    return 100
  }
  if (backup.taskPhase !== "archiving") return null
  if (backup.taskBytesTotal === null || backup.taskBytesTotal <= 0) return null
  return Math.min(
    100,
    Math.floor((backup.taskBytesCompleted / backup.taskBytesTotal) * 100)
  )
}

function backupTaskProgressDetail(
  backup: Backup,
  percent: number | null
): string {
  if (backup.taskPhase === "uploading") {
    return backup.artifactKind === "archive" ? "Archive ready" : "Export ready"
  }
  if (backup.taskPhase === "finalizing") return "Finishing…"
  if (percent === null) {
    return backup.taskBytesCompleted > 0
      ? formatBytes(backup.taskBytesCompleted)
      : "Working…"
  }
  return `${percent}% · ${formatBytes(backup.taskBytesCompleted)} / ${formatBytes(backup.taskBytesTotal ?? 0)}`
}

function shortRelativeBackupTime(
  timestamp: number,
  now: number = Date.now()
): string | null {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < backupMinuteMs) return "just now"
  if (elapsed < backupHourMs) {
    return `${Math.floor(elapsed / backupMinuteMs)}m ago`
  }
  if (elapsed < backupDayMs) {
    return `${Math.floor(elapsed / backupHourMs)}h ago`
  }
  if (elapsed < 7 * backupDayMs) {
    return `${Math.floor(elapsed / backupDayMs)}d ago`
  }
  return null
}

function formatBackupElapsed(elapsedMs: number): string {
  const elapsedSeconds = Math.floor(Math.max(0, elapsedMs) / 1_000)
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}
