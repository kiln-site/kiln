import * as React from "react"
import * as Sentry from "@sentry/tanstackstart-react"
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ArchiveX,
  ArrowLeft,
  CircleAlert,
  Cloud,
  Copy,
  Download,
  HardDrive,
  LoaderCircle,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
import type { BackupTarget } from "@workspace/contracts"
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
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { ServerScopePicker } from "@/components/server-scope-picker"
import type { ServerPickerOption } from "@/components/server-picker-list"
import { brickIconPresentation } from "@/components/brick-icon"
import type { InstanceNameInstance } from "@/components/instance-name"
import { backupHasReportedDeleteArtifactProgress } from "@/lib/backup-progress-presentation"
import {
  readFileDownloadPreferences,
  shouldPreviewBackupDownload,
} from "@/lib/file-download-preferences"
import {
  createBackupDeleteFeedbackStore,
  createBackupDialogStore,
  createBackupNameStore,
  createBackupSelectionStore,
  createBackupStatusFilterStore,
  type Backup,
  type BackupAvailabilityDestination,
  type BackupDeleteFeedbackStore,
  type BackupDialogStore,
  type BackupFilters,
  type BackupNameStore,
  type BackupSearchStore,
  type BackupSelectionStore,
  type BackupStatusFilterStore,
} from "@/components/backups/state"
import { BackupBulkActions, BackupTable } from "@/components/backups/table"
import {
  backupCanBeRemoved,
  backupTargetName,
  BackupActionButton,
  formatBytes,
  targetKey,
} from "@/components/backups/table-row"
import { BackupToolbar } from "@/components/backups/toolbar"
import { roleHasPermission } from "@/lib/permissions"
import {
  accessCapabilitiesQueryOptions,
  backupRunsInfiniteQueryOptions,
  backupStorageQueryOptions,
  brickIconPresentationsQueryOptions,
  backupPolicyQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  managedDatabasesQueryOptions,
  queryKeys,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import {
  createDatabaseBackup,
  createInstanceBackup,
  createPlatformBackup,
  deleteBackup,
  getBackupDownloadUrl,
  restoreDatabaseBackup,
  restoreInstanceBackup,
  syncBackupRuns,
  getBackupPolicy,
  updateBackupExcludes,
  updateBackupLimits,
} from "@/server/backups"
import type { getAccessCapabilities } from "@/server/access"
import {
  deleteBackupStorage,
  saveBackupStorage,
  setPreferredBackupStorage,
  type getBackupStorage,
} from "@/server/backup-storage"
import {
  BackupConfigurationDialog,
  type BackupConfiguration,
  type BackupConfigurationTarget,
} from "@/components/backup-configuration-dialog"
import type { getManagedDatabaseDirectory } from "@/server/databases"
import type { getRelaySnapshot } from "@/server/relay"
import { flattenCursorPages } from "@/lib/cursor-page"
import type { BackupRunSort, BackupRunSortDirection } from "@/lib/backup-runs"
import {
  refreshActiveBackupRunsFirstPages,
  resetActiveBackupRunsToFirstPage,
  resetBackupRunsToFirstPage,
} from "@/lib/backup-runs-cache"
import { forkPromise } from "@/effect/promise"
type BackupStorage = Awaited<ReturnType<typeof getBackupStorage>>[number]
type BackupPolicy = Awaited<ReturnType<typeof getBackupPolicy>>
type CreateTarget = BackupConfigurationTarget

const completedDeleteFeedbackMs = 1_000
const emptyBackups: Array<Backup> = []
const emptyCompletedBackupFeedback: ReadonlyMap<string, Backup> = new Map()

function selectBackupScope(
  snapshot: Awaited<ReturnType<typeof getRelaySnapshot>>
) {
  return {
    nodes: snapshot.nodes.map(({ relayId, relayName, relayStatus }) => ({
      relayId,
      relayName,
      relayStatus,
    })),
    servers: snapshot.instances.map(
      ({
        brickId,
        brickSource,
        id,
        implementation,
        name,
        observedState,
        relayId,
        relayName,
        relayStatus,
      }) => ({
        brickId,
        brickSource,
        id,
        implementation,
        name,
        observedState,
        relayId,
        relayName,
        relayStatus,
      })
    ),
  }
}

function completedDeleteFeedback(backup: Backup): Backup {
  return {
    ...backup,
    artifacts: backup.artifacts.map((artifact) => ({
      ...artifact,
      error: null,
      status: "deleted",
    })),
    taskCurrentArtifactId: null,
    taskError: null,
    taskPhase: null,
    taskStatus: "succeeded",
  }
}

function backupWithDeleteIntent(backup: Backup): Backup {
  const firstArtifact = backup.artifacts.find(
    (artifact) => artifact.status !== "deleted"
  )
  return {
    ...backup,
    artifacts: backup.artifacts.map((artifact) =>
      artifact.id === firstArtifact?.id
        ? { ...artifact, error: null, status: "deleting" }
        : artifact
    ),
    status: "deleting",
    taskCurrentArtifactId: firstArtifact?.id ?? null,
    taskError: null,
    taskKind: "delete",
    taskPhase: null,
    taskStatus: "queued",
  }
}

function useBackupsWithDeleteFeedback(
  backups: Array<Backup>,
  deleteFeedbackStore: BackupDeleteFeedbackStore
): Array<Backup> {
  const deleting = React.useSyncExternalStore(
    deleteFeedbackStore.subscribe,
    deleteFeedbackStore.getSnapshot,
    deleteFeedbackStore.getServerSnapshot
  )
  const previousBackupsRef = React.useRef(backups)
  const [completedFeedback, setCompletedFeedback] = React.useState<
    ReadonlyMap<string, Backup>
  >(emptyCompletedBackupFeedback)
  const completedFeedbackRef = React.useRef(completedFeedback)
  const removalTimers = React.useRef(new Map<string, number>())

  React.useLayoutEffect(() => {
    const incomingIds = new Set(backups.map((backup) => backup.id))
    let nextFeedback = completedFeedbackRef.current
    const updateFeedback = () => {
      if (nextFeedback === completedFeedbackRef.current) {
        nextFeedback = new Map(nextFeedback)
      }
      return nextFeedback as Map<string, Backup>
    }
    for (const backup of backups) {
      const timer = removalTimers.current.get(backup.id)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        removalTimers.current.delete(backup.id)
      }
      if (nextFeedback.has(backup.id)) updateFeedback().delete(backup.id)
    }
    for (const current of previousBackupsRef.current) {
      if (incomingIds.has(current.id)) continue
      if (current.status !== "deleting" && !deleting.has(current.id)) continue
      if (!nextFeedback.has(current.id)) {
        updateFeedback().set(current.id, completedDeleteFeedback(current))
      }
      if (removalTimers.current.has(current.id)) continue
      const timer = window.setTimeout(() => {
        removalTimers.current.delete(current.id)
        const remaining = new Map(completedFeedbackRef.current)
        remaining.delete(current.id)
        completedFeedbackRef.current = remaining
        setCompletedFeedback(remaining)
        deleteFeedbackStore.remove([current.id])
      }, completedDeleteFeedbackMs)
      removalTimers.current.set(current.id, timer)
    }
    previousBackupsRef.current = backups
    if (nextFeedback !== completedFeedbackRef.current) {
      completedFeedbackRef.current = nextFeedback
      setCompletedFeedback(nextFeedback)
    }
  }, [backups, deleteFeedbackStore, deleting])

  React.useEffect(
    () => () => {
      for (const timer of removalTimers.current.values()) {
        window.clearTimeout(timer)
      }
      removalTimers.current.clear()
    },
    []
  )

  React.useEffect(() => {
    const finished = backups.flatMap((backup) =>
      deleting.has(backup.id) &&
      backup.taskKind === "delete" &&
      (backup.taskStatus === "cancelled" || backup.taskStatus === "failed")
        ? [backup.id]
        : []
    )
    if (finished.length > 0) deleteFeedbackStore.remove(finished)
  }, [backups, deleteFeedbackStore, deleting])

  return React.useMemo(() => {
    const incomingIds = new Set(backups.map((backup) => backup.id))
    return [
      ...backups.map((backup) => {
        const deleteFinishedWithError =
          backup.taskKind === "delete" &&
          (backup.taskStatus === "cancelled" || backup.taskStatus === "failed")
        return deleting.has(backup.id) && !deleteFinishedWithError
          ? backupHasReportedDeleteArtifactProgress(backup)
            ? backup
            : backupWithDeleteIntent(backup)
          : backup
      }),
      ...[...completedFeedback.values()].filter(
        (backup) => !incomingIds.has(backup.id)
      ),
    ]
  }, [backups, completedFeedback, deleting])
}

export const BackupsPage = React.memo(function BackupsPage({
  filters,
  onFiltersChange,
  searchStore,
}: {
  filters: BackupFilters
  onFiltersChange: (change: Partial<BackupFilters>) => void
  searchStore: BackupSearchStore
}) {
  const { data: storage } = useSuspenseQuery(backupStorageQueryOptions())
  const { data: backupScope } = useSuspenseQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectBackupScope,
  })
  const { data: databaseOverview } = useSuspenseQuery(
    managedDatabasesQueryOptions()
  )
  const databases = databaseOverview.databases
  const { data: bricks } = useSuspenseQuery(
    brickIconPresentationsQueryOptions()
  )
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const [dialogStore] = React.useState(createBackupDialogStore)
  const [deleteFeedbackStore] = React.useState(createBackupDeleteFeedbackStore)
  const [selectionStore] = React.useState(createBackupSelectionStore)
  const [nameStore] = React.useState(createBackupNameStore)
  const [statusFilterStore] = React.useState(() =>
    createBackupStatusFilterStore(filters.status)
  )

  const scopeOptions = React.useMemo(
    () =>
      backupScopeOptions({
        databases,
        includePlatform: capabilities.isPlatformAdmin,
        nodes: backupScope.nodes,
        servers: backupScope.servers,
      }),
    [
      backupScope.nodes,
      backupScope.servers,
      capabilities.isPlatformAdmin,
      databases,
    ]
  )
  const selectedServer = React.useMemo(
    () =>
      scopeOptions.find(
        (option) =>
          option.id === filters.server &&
          option.relayId === filters.relay &&
          (option.kind ?? "server") === (filters.kind ?? "server")
      ) ?? null,
    [filters.kind, filters.relay, filters.server, scopeOptions]
  )
  const selectServer = React.useCallback(
    (server: ServerPickerOption | null) => {
      onFiltersChange({
        kind: server?.kind,
        relay: server?.relayId,
        server: server?.id,
      })
    },
    [onFiltersChange]
  )
  const targetNames = React.useMemo(() => {
    const names = new Map<string, string>()
    for (const server of backupScope.servers) {
      names.set(targetKey("instance", server.relayId, server.id), server.name)
    }
    for (const database of databases) {
      names.set(
        targetKey("database", database.relayId, database.id),
        database.name
      )
    }
    return names
  }, [backupScope.servers, databases])
  const targetInstances = React.useMemo(() => {
    const instances = new Map<string, InstanceNameInstance>()
    for (const server of backupScope.servers) {
      instances.set(targetKey("instance", server.relayId, server.id), {
        icon: brickIconPresentation(bricks, server),
        kind: "server",
        observedState: server.observedState,
        relayStatus: server.relayStatus,
      })
    }
    for (const database of databases) {
      instances.set(targetKey("database", database.relayId, database.id), {
        inventoryStatus: database.inventoryStatus,
        kind: "database",
        observedState: database.observedState,
      })
    }
    for (const relay of backupScope.nodes) {
      instances.set(targetKey("platform", relay.relayId, "kiln"), {
        kind: "relay",
        relayStatus: relay.relayStatus,
      })
    }
    return instances
  }, [backupScope.nodes, backupScope.servers, bricks, databases])
  const relayNames = React.useMemo(
    () =>
      new Map([
        ...backupScope.nodes.map(
          (relay) => [relay.relayId, relay.relayName] as const
        ),
        ...backupScope.servers.map(
          (instance) => [instance.relayId, instance.relayName] as const
        ),
      ]),
    [backupScope.nodes, backupScope.servers]
  )
  const storageNames = React.useMemo(
    () =>
      new Map(storage.map((destination) => [destination.id, destination.name])),
    [storage]
  )
  const availabilityDestinations = React.useMemo(
    (): Array<BackupAvailabilityDestination> => [
      { enabled: true, id: null, name: "Local", ownerUserId: null },
      ...storage.map((destination) => ({
        enabled: destination.enabled && !destination.deleting,
        id: destination.id,
        name: destination.name,
        ownerUserId: destination.ownerUserId,
      })),
    ],
    [storage]
  )
  React.useLayoutEffect(() => {
    statusFilterStore.set(filters.status)
  }, [filters.status, statusFilterStore])
  const createTargets = React.useMemo(
    () =>
      availableCreateTargets({
        capabilities,
        databases,
        nodes: backupScope.nodes,
        servers: backupScope.servers,
      }),
    [backupScope.nodes, backupScope.servers, capabilities, databases]
  )
  const scopedCreateTargetKey = selectedServer
    ? selectedBackupCreateTargetKey(selectedServer)
    : undefined
  const selectedCreateTargetKey = createTargets.some(
    (target) => target.key === scopedCreateTargetKey
  )
    ? scopedCreateTargetKey
    : undefined
  const canManageSelectedTarget = Boolean(
    selectedServer &&
    createTargets.some(
      (target) => target.key === selectedBackupCreateTargetKey(selectedServer)
    )
  )
  const canCreateBackup = React.useCallback(
    (backup: Backup) =>
      backup.targetKind === "platform"
        ? capabilities.isPlatformAdmin
        : canCreateForResource(
            capabilities,
            backup.relayId,
            backup.targetKind,
            backup.targetId
          ),
    [capabilities]
  )

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <ServerScopePicker
        allDescription="Every accessible server, database, and Relay"
        allLabel="All instances"
        ariaLabel="Accessible instances"
        changeLabel="Change instance"
        chooseLabel="Choose instance"
        emptyMessage="No accessible instances found."
        selectedServer={selectedServer}
        servers={scopeOptions}
        manageSettingsControl={
          canManageSelectedTarget && selectedServer ? (
            <Button asChild size="icon-sm" variant="outline">
              <Link
                aria-label="Manage selected backup settings"
                to="/backups/settings"
                search={{
                  kind: selectedServer.kind,
                  relay: selectedServer.relayId,
                  server: selectedServer.id,
                }}
              >
                <SlidersHorizontal />
              </Link>
            </Button>
          ) : (
            <Button
              aria-label="Manage selected backup settings"
              disabled
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <SlidersHorizontal />
            </Button>
          )
        }
        manageSettingsTooltip={
          canManageSelectedTarget
            ? "Backup settings"
            : "Choose an instance to manage its backup settings"
        }
        onSelect={selectServer}
      />

      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <BackupRunsSyncKick />
        <BackupToolbar
          canCreate={createTargets.length > 0}
          dialogStore={dialogStore}
          searchStore={searchStore}
          statusFilterStore={statusFilterStore}
        />
        <BackupDataSurface
          canCreate={canCreateBackup}
          currentUserId={capabilities.user.id}
          deleteFeedbackStore={deleteFeedbackStore}
          destinations={availabilityDestinations}
          dialogStore={dialogStore}
          targetInstances={targetInstances}
          nameStore={nameStore}
          relayNames={relayNames}
          searchStore={searchStore}
          selectedServer={selectedServer}
          selectionStore={selectionStore}
          statusFilterStore={statusFilterStore}
          targetNames={targetNames}
        />
      </section>

      <BackupDialogHost
        deleteFeedbackStore={deleteFeedbackStore}
        dialogStore={dialogStore}
        selectedCreateTargetKey={selectedCreateTargetKey}
        storage={storage}
        storageNames={storageNames}
        targetNames={targetNames}
        targets={createTargets}
      />
    </div>
  )
})

const BackupRunsSyncKick = React.memo(function BackupRunsSyncKick() {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    const controller = new AbortController()
    // Let Strict Mode tear down its probe effect before dispatching the POST.
    const startTimeout = window.setTimeout(() => {
      forkPromise(
        async () => {
          await syncBackupRuns({ signal: controller.signal })
          await refreshActiveBackupRunsFirstPages(
            queryClient,
            controller.signal
          )
        },
        (cause) =>
          captureBackupRunsBackgroundError(
            "mountSync",
            controller.signal,
            cause
          )
      )
    })
    return () => {
      window.clearTimeout(startTimeout)
      controller.abort()
    }
  }, [queryClient])
  return null
})

const BackupDataSurface = React.memo(function BackupDataSurface({
  canCreate,
  currentUserId,
  deleteFeedbackStore,
  destinations,
  dialogStore,
  targetInstances,
  nameStore,
  relayNames,
  searchStore,
  selectedServer,
  selectionStore,
  statusFilterStore,
  targetNames,
}: {
  canCreate: (backup: Backup) => boolean
  currentUserId: string
  deleteFeedbackStore: BackupDeleteFeedbackStore
  destinations: ReadonlyArray<BackupAvailabilityDestination>
  dialogStore: BackupDialogStore
  targetInstances: ReadonlyMap<string, InstanceNameInstance>
  nameStore: BackupNameStore
  relayNames: ReadonlyMap<string, string>
  searchStore: BackupSearchStore
  selectedServer: ServerPickerOption | null
  selectionStore: BackupSelectionStore
  statusFilterStore: BackupStatusFilterStore
  targetNames: ReadonlyMap<string, string>
}) {
  const search = React.useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getNormalizedSnapshot,
    searchStore.getNormalizedServerSnapshot
  )
  const status = React.useSyncExternalStore(
    statusFilterStore.subscribe,
    statusFilterStore.getSnapshot,
    statusFilterStore.getServerSnapshot
  )
  const [debouncedSearch, setDebouncedSearch] = React.useState(search)
  const [sorting, setSorting] = React.useState<{
    direction: BackupRunSortDirection
    sort: BackupRunSort
  }>({ direction: "desc", sort: "createdAt" })
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(timer)
  }, [search])
  const scope = React.useMemo(
    () =>
      selectedServer
        ? {
            kind:
              selectedServer.kind === "database"
                ? ("database" as const)
                : selectedServer.kind === "relay"
                  ? ("platform" as const)
                  : ("instance" as const),
            relayId: selectedServer.relayId,
            targetId: selectedServer.id,
          }
        : null,
    [selectedServer]
  )
  const queryInput = React.useMemo(
    () => ({
      cursor: null,
      direction: sorting.direction,
      scope,
      search: debouncedSearch,
      sort: sorting.sort,
      status: status ?? null,
    }),
    [debouncedSearch, scope, sorting.direction, sorting.sort, status]
  )
  const queryClient = useQueryClient()
  const queryOptions = React.useMemo(
    () => backupRunsInfiniteQueryOptions(queryInput),
    [queryInput]
  )
  const refreshStaleCacheOnMount =
    queryClient.getQueryState(queryOptions.queryKey)?.isInvalidated ?? false
  const query = useInfiniteQuery(queryOptions)
  const isUpdating = query.isPlaceholderData && query.isFetching
  React.useEffect(() => {
    if (!refreshStaleCacheOnMount) return
    const controller = new AbortController()
    forkPromise(
      () =>
        resetBackupRunsToFirstPage(queryClient, queryInput, controller.signal),
      (cause) =>
        captureBackupRunsBackgroundError(
          "staleRefresh",
          controller.signal,
          cause
        )
    )
    return () => controller.abort()
  }, [queryClient, queryInput, refreshStaleCacheOnMount])
  const backups = React.useMemo(
    () =>
      query.data
        ? flattenCursorPages(query.data.pages, (backup) => backup.id)
        : emptyBackups,
    [query.data]
  )
  const visibleBackups = useBackupsWithDeleteFeedback(
    backups,
    deleteFeedbackStore
  )
  const pagination = React.useMemo(
    () => ({
      error: !isUpdating && query.isFetchNextPageError ? query.error : null,
      hasMore: !isUpdating && query.hasNextPage,
      isLoading: !isUpdating && query.isFetchingNextPage,
      onLoadMore: query.fetchNextPage,
      resetKey: JSON.stringify(queryInput),
    }),
    [
      isUpdating,
      query.error,
      query.fetchNextPage,
      query.hasNextPage,
      query.isFetchNextPageError,
      query.isFetchingNextPage,
      queryInput,
    ]
  )
  const changeSort = React.useCallback(
    (sort: BackupRunSort, direction: BackupRunSortDirection) => {
      setSorting((current) =>
        current.sort === sort && current.direction === direction
          ? current
          : { direction, sort }
      )
    },
    []
  )
  const retry = React.useCallback(() => {
    void query.refetch()
  }, [query.refetch])

  React.useLayoutEffect(() => {
    nameStore.sync(
      visibleBackups.map((backup) => [backup.id, backup.name] as const)
    )
    selectionStore.retain(
      new Set(
        visibleBackups.flatMap((backup) =>
          backupCanBeRemoved(backup) ? [backup.id] : []
        )
      )
    )
  }, [nameStore, selectionStore, visibleBackups])

  React.useLayoutEffect(() => {
    selectionStore.clear()
  }, [queryInput, selectionStore])

  return (
    <>
      <BackupTable
        backups={visibleBackups}
        canCreate={canCreate}
        currentUserId={currentUserId}
        destinations={destinations}
        dialogStore={dialogStore}
        targetInstances={targetInstances}
        error={
          query.isError && !query.data && !query.isFetchNextPageError
            ? query.error
            : null
        }
        loading={query.isPending}
        nameStore={nameStore}
        onRetry={retry}
        onSortChange={changeSort}
        pagination={pagination}
        relayNames={relayNames}
        scopeFiltered={Boolean(selectedServer)}
        searchStore={searchStore}
        selectionStore={selectionStore}
        sort={sorting.sort}
        sortDirection={sorting.direction}
        statusFilterStore={statusFilterStore}
        targetNames={targetNames}
        updating={isUpdating}
      />
      <BackupBulkActions
        backups={visibleBackups}
        deleteFeedbackStore={deleteFeedbackStore}
        nameStore={nameStore}
        selectionStore={selectionStore}
      />
    </>
  )
})

function captureBackupRunsBackgroundError(
  operation: "mountSync" | "staleRefresh",
  signal: AbortSignal,
  cause: unknown
): void {
  if (signal.aborted) return
  Sentry.captureException(cause, {
    tags: { "kiln.operation": `backups.${operation}` },
  })
}

const BackupDialogHost = React.memo(function BackupDialogHost({
  deleteFeedbackStore,
  dialogStore,
  selectedCreateTargetKey,
  storage,
  storageNames,
  targetNames,
  targets,
}: {
  deleteFeedbackStore: BackupDeleteFeedbackStore
  dialogStore: BackupDialogStore
  selectedCreateTargetKey?: string
  storage: Array<BackupStorage>
  storageNames: ReadonlyMap<string, string>
  targetNames: ReadonlyMap<string, string>
  targets: Array<CreateTarget>
}) {
  const dialog = React.useSyncExternalStore(
    dialogStore.subscribe,
    dialogStore.getSnapshot,
    dialogStore.getServerSnapshot
  )
  const close = React.useCallback(
    (open: boolean) => {
      if (!open) dialogStore.close()
    },
    [dialogStore]
  )

  if (dialog.kind === "closed") return null
  if (dialog.kind === "create") {
    return (
      <CreateBackupDialog
        initialTargetKey={selectedCreateTargetKey}
        open
        storage={storage}
        targets={targets}
        onOpenChange={close}
      />
    )
  }
  if (dialog.kind === "restore") {
    return (
      <RestoreBackupDialog
        backup={dialog.backup}
        open
        targetName={backupTargetName(dialog.backup, targetNames)}
        onOpenChange={close}
      />
    )
  }
  if (dialog.kind === "download") {
    return (
      <DownloadBackupDialog
        backup={dialog.backup}
        open
        storageNames={storageNames}
        onOpenChange={close}
      />
    )
  }
  return (
    <DeleteBackupDialog
      backup={dialog.backup}
      deleteFeedbackStore={deleteFeedbackStore}
      open
      onOpenChange={close}
    />
  )
})

function DownloadBackupDialog({
  backup,
  onOpenChange,
  open,
  storageNames,
}: {
  backup: Backup
  onOpenChange: (open: boolean) => void
  open: boolean
  storageNames: ReadonlyMap<string, string>
}) {
  const availableArtifacts = backup.artifacts.filter(
    (artifact) => artifact.status === "available"
  )
  const [artifactId, setArtifactId] = React.useState(
    () =>
      availableArtifacts.find((artifact) => artifact.storageId === null)?.id ??
      availableArtifacts[0]?.id ??
      ""
  )
  const [expiryValue, setExpiryValue] = React.useState("15")
  const [expiryUnit, setExpiryUnit] = React.useState<"hours" | "minutes">(
    "minutes"
  )
  const [shared, setShared] = React.useState<{
    expiresAt: string
    url: string
  } | null>(null)
  const artifact = availableArtifacts.find(
    (candidate) => candidate.id === artifactId
  )
  const expiresInSeconds = Math.min(
    7 * 24 * 60 * 60,
    Math.max(
      60,
      Math.round(
        Number(expiryValue || 0) * (expiryUnit === "hours" ? 3600 : 60)
      )
    )
  )
  const signDownload = useMutation({
    mutationFn: async (mode: "download" | "link") => {
      let poll = false
      for (;;) {
        const result = await getBackupDownloadUrl({
          data: {
            artifactId,
            backupId: backup.id,
            expiresInSeconds: mode === "download" ? 300 : expiresInSeconds,
            poll,
            preview: shouldPreviewBackupDownload(
              mode,
              readFileDownloadPreferences().previewBackupDownloads
            ),
          },
        })
        poll = true
        if (!("url" in result)) {
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          continue
        }
        return result
      }
    },
    onSuccess: (result, mode) => {
      if (!("url" in result)) return
      if (mode === "link") {
        setShared(result)
        return
      }
      const anchor = document.createElement("a")
      anchor.href = result.url
      anchor.rel = "noopener"
      anchor.click()
    },
    onError: (error) =>
      showToast({
        message: `Download failed: ${error.message}`,
        type: "error",
      }),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Download {backup.name}</DialogTitle>
          <DialogDescription>
            Choose an available copy, then download it or create a temporary
            signed URL.
            {backup.artifactKind === "restic_snapshot"
              ? " Incremental snapshots are exported to a zip first."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {signDownload.isPending &&
          backup.artifactKind === "restic_snapshot" ? (
            <p className="text-xs text-muted-foreground">Preparing export…</p>
          ) : null}
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Source</span>
            <Select
              value={artifactId}
              onValueChange={(value) => {
                setArtifactId(value)
                setShared(null)
              }}
            >
              <SelectTrigger
                aria-label="Backup download source"
                className="h-10 w-full px-3 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-max min-w-(--radix-select-trigger-width)">
                {availableArtifacts.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.storageId
                      ? `${storageNames.get(candidate.storageId) ?? "S3"} · S3`
                      : "Local Relay"}
                    {candidate.bytes === null
                      ? ""
                      : ` · ${formatBytes(candidate.bytes)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/15 p-3">
            <div>
              <p className="type-technical-label text-muted-foreground">
                Destination
              </p>
              <p className="mt-1 truncate text-sm font-medium">
                {artifact?.storageId
                  ? (storageNames.get(artifact.storageId) ?? "S3")
                  : "Local Relay"}
              </p>
            </div>
            <div>
              <p className="type-technical-label text-muted-foreground">Size</p>
              <p className="mt-1 font-mono text-sm font-medium">
                {artifact?.bytes === null || artifact?.bytes === undefined
                  ? "—"
                  : formatBytes(artifact.bytes)}
              </p>
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Link2 className="size-4 text-muted-foreground" />
              <p className="text-xs font-medium">Temporary URL</p>
            </div>
            <div className="mt-3 flex gap-2">
              <Input
                aria-label="Temporary URL duration"
                className="min-w-0 flex-1"
                min={1}
                type="number"
                value={expiryValue}
                onChange={(event) => {
                  setExpiryValue(event.currentTarget.value)
                  setShared(null)
                }}
              />
              <Select
                value={expiryUnit}
                onValueChange={(value) => {
                  setExpiryUnit(value === "hours" ? "hours" : "minutes")
                  setShared(null)
                }}
              >
                <SelectTrigger
                  aria-label="Temporary URL duration unit"
                  className="h-8 shrink-0 px-3 whitespace-nowrap"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Hours</SelectItem>
                </SelectContent>
              </Select>
              <Button
                disabled={!artifact || signDownload.isPending}
                type="button"
                variant="outline"
                onClick={() => signDownload.mutate("link")}
              >
                {signDownload.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Link2 />
                )}
                Get URL
              </Button>
            </div>
            <p className="type-meta mt-2 text-muted-foreground">
              Links can remain valid from 1 minute up to 7 days.
            </p>
            {shared ? (
              <div className="mt-3 flex gap-2">
                <Input
                  aria-label="Generated temporary backup URL"
                  className="type-code"
                  readOnly
                  value={shared.url}
                />
                <Button
                  aria-label="Copy temporary URL"
                  size="icon"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(shared.url).then(() =>
                      showToast({
                        message: "Temporary URL copied",
                        type: "success",
                      })
                    )
                  }}
                >
                  <Copy />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            disabled={!artifact || signDownload.isPending}
            type="button"
            onClick={() => signDownload.mutate("download")}
          >
            {signDownload.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Download />
            )}
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateBackupDialog({
  initialTargetKey,
  onOpenChange,
  open,
  storage,
  targets,
}: {
  initialTargetKey?: string
  onOpenChange: (open: boolean) => void
  open: boolean
  storage: Array<BackupStorage>
  targets: Array<CreateTarget>
}) {
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: async (configuration: BackupConfiguration) => {
      const target = targets.find(
        (candidate) => candidate.key === configuration.targetKey
      )
      if (!target) throw new Error("Choose a backup target")
      const data = {
        maxBytes: null,
        name: configuration.name,
        relayId: target.relayId,
        ...(configuration.destinationKeys.includes("default")
          ? {}
          : {
              storageIds: configuration.destinationKeys.map((destination) =>
                destination === "local" ? null : destination
              ),
            }),
      }
      if (target.kind === "instance") {
        return createInstanceBackup({
          data: {
            ...data,
            instanceId: target.id,
            mode: configuration.mode,
          },
        })
      }
      if (target.kind === "database") {
        return createDatabaseBackup({
          data: { ...data, databaseId: target.id },
        })
      }
      return createPlatformBackup({ data })
    },
    onSuccess: async (result, configuration) => {
      await resetActiveBackupRunsToFirstPage(queryClient)
      showToast({
        message: result.relayAccepted
          ? `${configuration.name} queued`
          : `${configuration.name} saved and will resume when Relay reconnects`,
        type: result.relayAccepted ? "success" : "warning",
      })
      onOpenChange(false)
    },
  })

  return (
    <BackupConfigurationDialog
      error={create.error?.message}
      initialTargetKey={initialTargetKey}
      onOpenChange={onOpenChange}
      onSubmit={(configuration) => create.mutate(configuration)}
      open={open}
      pending={create.isPending}
      storage={storage}
      submitLabel={create.isPending ? "Creating backup…" : "Create backup"}
      targets={targets}
      title="Create backup"
    />
  )
}

export const BackupSettingsPage = React.memo(function BackupSettingsPage({
  filters,
  onFiltersChange,
}: {
  filters: BackupFilters
  onFiltersChange: (change: Partial<BackupFilters>) => void
}) {
  const { data: storage } = useSuspenseQuery(backupStorageQueryOptions())
  const { data: backupScope } = useSuspenseQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectBackupScope,
  })
  const { data: databases } = useSuspenseQuery(
    managedDatabaseDirectoryQueryOptions()
  )
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const configurableOptions = React.useMemo(() => {
    const targets = availableCreateTargets({
      capabilities,
      databases,
      nodes: backupScope.nodes,
      servers: backupScope.servers,
    })
    const targetKeys = new Set(targets.map((target) => target.key))
    return backupScopeOptions({
      databases,
      includePlatform: capabilities.isPlatformAdmin,
      nodes: backupScope.nodes,
      servers: backupScope.servers,
    }).filter((option) => targetKeys.has(selectedBackupCreateTargetKey(option)))
  }, [backupScope.nodes, backupScope.servers, capabilities, databases])
  const selectedTarget = React.useMemo(
    () =>
      configurableOptions.find(
        (option) =>
          option.id === filters.server &&
          option.relayId === filters.relay &&
          (option.kind ?? "server") === (filters.kind ?? "server")
      ) ?? null,
    [configurableOptions, filters.kind, filters.relay, filters.server]
  )
  const selectTarget = React.useCallback(
    (target: ServerPickerOption | null) => {
      onFiltersChange({
        kind: target?.kind,
        relay: target?.relayId,
        server: target?.id,
      })
    },
    [onFiltersChange]
  )

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <ServerScopePicker
        allDescription="Select a target to edit its backup policy"
        allLabel="No instance selected"
        ariaLabel="Configurable backup targets"
        changeLabel="Change instance"
        chooseLabel="Choose instance"
        emptyMessage="No configurable backup targets found."
        selectedServer={selectedTarget}
        servers={configurableOptions}
        onSelect={selectTarget}
      />
      {selectedTarget ? (
        <BackupSettingsSurface
          isPlatformAdmin={capabilities.isPlatformAdmin}
          storage={storage}
          target={selectedTarget}
        />
      ) : (
        <section className="rounded-xl border border-dashed bg-card/30 px-5 py-12 text-center [contain:paint]">
          <span className="mx-auto grid size-10 place-items-center rounded-lg border bg-background text-muted-foreground">
            <SlidersHorizontal className="size-4" />
          </span>
          <h2 className="mt-4 font-heading text-base font-semibold">
            Choose an instance to configure
          </h2>
          <p className="type-support mx-auto mt-1 max-w-md text-muted-foreground">
            Backup limits, the preferred destination, and exclusions are set
            independently for each server, database, or Relay.
          </p>
        </section>
      )}
    </div>
  )
})

function BackupSettingsSurface({
  isPlatformAdmin,
  target,
  storage,
}: {
  isPlatformAdmin: boolean
  target: ServerPickerOption
  storage: Array<BackupStorage>
}) {
  const policyTarget = React.useMemo(() => backupPolicyTarget(target), [target])
  const policy = useQuery(
    backupPolicyQueryOptions(target.relayId, policyTarget)
  )

  return (
    <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
      {policy.data ? (
        <BackupSettingsEditor
          key={`${target.relayId}:${policyTarget.kind}:${policyTarget.id}`}
          isPlatformAdmin={isPlatformAdmin}
          policy={policy.data}
          target={target}
          storage={storage}
        />
      ) : policy.error ? (
        <p className="p-5 text-xs text-destructive">{policy.error.message}</p>
      ) : (
        <div className="grid h-40 place-items-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      )}
    </section>
  )
}

function BackupSettingsEditor({
  isPlatformAdmin,
  policy,
  target,
  storage,
}: {
  isPlatformAdmin: boolean
  policy: BackupPolicy
  target: ServerPickerOption
  storage: Array<BackupStorage>
}) {
  const queryClient = useQueryClient()
  const policyTarget = React.useMemo(() => backupPolicyTarget(target), [target])
  const [quantityLimit, setQuantityLimit] = React.useState(
    () => policy.quantityLimit?.toString() ?? ""
  )
  const [sizeLimit, setSizeLimit] = React.useState(() =>
    bytesToGiBInput(policy.sizeLimitBytes)
  )
  const [adminQuantityLimit, setAdminQuantityLimit] = React.useState(
    () => policy.adminQuantityLimit?.toString() ?? ""
  )
  const [adminSizeLimit, setAdminSizeLimit] = React.useState(() =>
    bytesToGiBInput(policy.adminSizeLimitBytes)
  )
  const enabledStorage = React.useMemo(
    () =>
      storage.filter(
        (destination) =>
          destination.enabled &&
          !destination.deleting &&
          (policyTarget.kind !== "platform" || destination.ownerUserId === null)
      ),
    [policyTarget.kind, storage]
  )
  const [storageId, setStorageId] = React.useState(() =>
    policy.storageId &&
    enabledStorage.some((destination) => destination.id === policy.storageId)
      ? policy.storageId
      : "local"
  )
  const [exclude, setExclude] = React.useState(() => policy.exclude.join("\n"))
  const save = useMutation({
    mutationFn: async () => {
      const operations: Array<Promise<unknown>> = [
        updateBackupLimits({
          data: {
            quantityLimit: parseOptionalInteger(
              quantityLimit,
              "Quantity limit"
            ),
            relayId: target.relayId,
            scope: "user",
            sizeLimitBytes: parseOptionalGiB(sizeLimit, "Size limit"),
            target: policyTarget,
          },
        }),
        updateBackupExcludes({
          data: {
            exclude: excludeLines(exclude),
            relayId: target.relayId,
            target: policyTarget,
          },
        }),
        setPreferredBackupStorage({
          data: {
            relayId: target.relayId,
            storageId: storageId === "local" ? null : storageId,
            target: policyTarget,
          },
        }),
      ]
      if (isPlatformAdmin) {
        operations.push(
          updateBackupLimits({
            data: {
              quantityLimit: parseOptionalInteger(
                adminQuantityLimit,
                "Platform quantity limit"
              ),
              relayId: target.relayId,
              scope: "platform",
              sizeLimitBytes: parseOptionalGiB(
                adminSizeLimit,
                "Platform size limit"
              ),
              target: policyTarget,
            },
          })
        )
      }
      await Promise.all(operations)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.backups.policy(target.relayId, policyTarget),
      })
      showToast({
        message: `${target.name} backup settings saved`,
        type: "success",
      })
    },
  })

  return (
    <div className="grid gap-4 p-5 sm:grid-cols-2">
      <StorageTextField
        label="Quantity limit"
        placeholder="Unlimited"
        type="number"
        value={quantityLimit}
        onChange={setQuantityLimit}
      />
      <StorageTextField
        label="Size limit (GiB)"
        placeholder="Unlimited"
        type="number"
        value={sizeLimit}
        onChange={setSizeLimit}
      />
      {isPlatformAdmin ? (
        <StorageTextField
          label="Platform quantity ceiling"
          placeholder="Not enforced"
          type="number"
          value={adminQuantityLimit}
          onChange={setAdminQuantityLimit}
        />
      ) : null}
      {isPlatformAdmin ? (
        <StorageTextField
          label="Platform size ceiling (GiB)"
          placeholder="Not enforced"
          type="number"
          value={adminSizeLimit}
          onChange={setAdminSizeLimit}
        />
      ) : null}
      {!isPlatformAdmin &&
      (policy.adminQuantityLimit !== null ||
        policy.adminSizeLimitBytes !== null) ? (
        <div className="type-meta rounded-lg border border-amber-500/25 bg-amber-500/8 p-3 text-muted-foreground sm:col-span-2">
          Platform ceiling: {policy.adminQuantityLimit ?? "unlimited"} backups ·{" "}
          {policy.adminSizeLimitBytes === null
            ? " unlimited size"
            : ` ${formatBytes(policy.adminSizeLimitBytes)}`}
        </div>
      ) : null}
      <label className="block sm:col-span-2">
        <span className="mb-2 block text-xs font-medium">
          Preferred destination
        </span>
        <Select value={storageId} onValueChange={setStorageId}>
          <SelectTrigger
            aria-label="Preferred backup destination"
            className="h-9 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-max min-w-(--radix-select-trigger-width)">
            <SelectItem value="local">Local Relay storage</SelectItem>
            {enabledStorage.map((destination) => (
              <SelectItem key={destination.id} value={destination.id}>
                {destination.name} · S3
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="block sm:col-span-2">
        <span className="mb-2 block text-xs font-medium">Extra exclusions</span>
        <Textarea
          aria-label="Extra backup exclusions"
          className="min-h-28 font-mono text-xs"
          placeholder={"cache/**\nlogs/*.log\nworld/session.lock"}
          value={exclude}
          onChange={(event) => setExclude(event.currentTarget.value)}
        />
        <span className="type-meta mt-1.5 block text-muted-foreground">
          One glob per line. Relay validates exclusions before applying them to
          compatible archives.
        </span>
      </label>
      {save.error ? (
        <p className="text-xs text-destructive sm:col-span-2">
          {save.error.message}
        </p>
      ) : null}
      <div className="flex justify-end sm:col-span-2">
        <Button
          disabled={save.isPending}
          type="button"
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  )
}

export const BackupDestinationsPage = React.memo(
  function BackupDestinationsPage() {
    const { data: storage } = useSuspenseQuery(backupStorageQueryOptions())
    const { data: capabilities } = useSuspenseQuery(
      accessCapabilitiesQueryOptions()
    )
    const currentUserId = capabilities.user.id
    const isPlatformAdmin = capabilities.isPlatformAdmin
    const [editor, setEditor] = React.useState<BackupStorage | "new" | null>(
      null
    )
    const [deleteCandidate, setDeleteCandidate] =
      React.useState<BackupStorage | null>(null)

    return (
      <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
        <section className="min-w-0 overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
          {editor ? (
            <BackupStorageEditor
              existing={editor === "new" ? null : editor}
              isPlatformAdmin={isPlatformAdmin}
              onBack={() => setEditor(null)}
            />
          ) : (
            <>
              <div className="flex min-w-0 items-start justify-between gap-4 border-b px-5 py-4">
                <div className="min-w-0">
                  <h2 className="font-heading text-base font-semibold tracking-tight">
                    Backup destinations
                  </h2>
                  <p className="type-support mt-1 text-muted-foreground">
                    Relay-local storage is always available. Add S3-compatible
                    destinations for off-node copies and signed downloads.
                  </p>
                </div>
                <Button
                  className="shrink-0"
                  type="button"
                  onClick={() => setEditor("new")}
                >
                  <Plus />
                  <span className="hidden sm:inline">Add S3 destination</span>
                  <span className="sm:hidden">Add</span>
                </Button>
              </div>
              <div className="min-w-0 space-y-2 p-5">
                <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/35 p-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-background text-muted-foreground">
                    <HardDrive className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold">
                      Local Relay storage
                    </span>
                    <span className="type-meta mt-0.5 block text-muted-foreground">
                      Stored on the Relay that owns the resource
                    </span>
                  </span>
                  <Badge variant="outline">Built in</Badge>
                </div>
                {storage.map((destination) => {
                  const canManage =
                    isPlatformAdmin || destination.ownerUserId === currentUserId
                  const retryDelete = destination.deleting
                  return (
                    <div
                      key={destination.id}
                      className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/35 p-3"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-background text-muted-foreground">
                        <Cloud className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-xs font-semibold">
                            {destination.name}
                          </span>
                          <Badge variant="outline">
                            {destination.ownerUserId === null
                              ? "Platform"
                              : "Personal"}
                          </Badge>
                          {destination.deleting ? (
                            <Badge variant="outline">Deleting</Badge>
                          ) : !destination.enabled ? (
                            <Badge variant="outline">Disabled</Badge>
                          ) : null}
                        </span>
                        <span className="type-meta mt-1 block truncate font-mono text-muted-foreground">
                          {destination.endpoint} / {destination.bucket}
                          {destination.objectPrefix
                            ? ` / ${destination.objectPrefix}`
                            : ""}
                        </span>
                        {destination.lastError ? (
                          <span className="type-meta mt-1 block text-destructive">
                            {destination.lastError}
                          </span>
                        ) : null}
                      </span>
                      {canManage ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <BackupActionButton
                            disabled={false}
                            icon={Pencil}
                            label={`Edit ${destination.name}`}
                            tooltip={
                              destination.deleting
                                ? "Update credentials to retry delete"
                                : "Edit destination"
                            }
                            onClick={() => setEditor(destination)}
                          />
                          <BackupActionButton
                            disabled={false}
                            icon={Trash2}
                            label={
                              retryDelete
                                ? `Retry deleting ${destination.name}`
                                : `Delete ${destination.name}`
                            }
                            tooltip={
                              retryDelete
                                ? "Retry destination delete"
                                : "Delete destination"
                            }
                            onClick={() => setDeleteCandidate(destination)}
                          />
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </section>
        {deleteCandidate ? (
          <DeleteBackupStorageDialog
            destination={deleteCandidate}
            open
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setDeleteCandidate(null)
            }}
          />
        ) : null}
      </div>
    )
  }
)

function BackupStorageEditor({
  existing,
  isPlatformAdmin,
  onBack,
}: {
  existing: BackupStorage | null
  isPlatformAdmin: boolean
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState(existing?.name ?? "")
  const [endpoint, setEndpoint] = React.useState(existing?.endpoint ?? "")
  const [region, setRegion] = React.useState(existing?.region ?? "")
  const [bucket, setBucket] = React.useState(existing?.bucket ?? "")
  const [objectPrefix, setObjectPrefix] = React.useState(
    existing?.objectPrefix ?? ""
  )
  const [accessKeyId, setAccessKeyId] = React.useState("")
  const [secretAccessKey, setSecretAccessKey] = React.useState("")
  const [forcePathStyle, setForcePathStyle] = React.useState(
    existing?.forcePathStyle ?? false
  )
  const [allowPrivateNetwork, setAllowPrivateNetwork] = React.useState(
    existing?.allowPrivateNetwork ?? false
  )
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true)
  const [platform, setPlatform] = React.useState(existing?.ownerUserId === null)
  const locationLocked = Boolean(existing?.deleting)
  const save = useMutation({
    mutationFn: () =>
      saveBackupStorage({
        data: {
          ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim() } : {}),
          allowPrivateNetwork,
          bucket: bucket.trim(),
          enabled,
          endpoint: endpoint.trim(),
          forcePathStyle,
          ...(existing ? { id: existing.id } : {}),
          name: name.trim(),
          objectPrefix: objectPrefix.trim(),
          platform,
          region: region.trim(),
          ...(secretAccessKey ? { secretAccessKey } : {}),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.backups.storage,
      })
      showToast({
        message: `${name.trim()} verified and saved`,
        type: "success",
      })
      onBack()
    },
  })
  const accessKeyProvided = Boolean(accessKeyId.trim())
  const secretKeyProvided = Boolean(secretAccessKey)
  const credentialsReady =
    accessKeyProvided === secretKeyProvided &&
    (existing !== null || (accessKeyProvided && secretKeyProvided))
  const canSave =
    Boolean(name.trim()) &&
    Boolean(endpoint.trim()) &&
    Boolean(region.trim()) &&
    Boolean(bucket.trim()) &&
    credentialsReady

  return (
    <>
      <div className="border-b px-5 py-4">
        <div className="mb-1 flex items-center gap-2">
          <Button
            aria-label="Back to backup destinations"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <h2 className="font-heading text-base font-semibold tracking-tight">
            {existing ? `Edit ${existing.name}` : "Add S3 destination"}
          </h2>
        </div>
        <p className="type-support text-muted-foreground">
          {locationLocked
            ? "This destination is still deleting. Update credentials, save, then retry the prefix purge. Location fields stay locked."
            : "Credentials are encrypted by Hearth and verified before they are saved. Existing secrets are never sent back to the browser."}
        </p>
      </div>
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <StorageTextField label="Name" value={name} onChange={setName} />
        <StorageTextField
          disabled={locationLocked}
          label="Region"
          placeholder="us-east-1"
          value={region}
          onChange={setRegion}
        />
        <div className="sm:col-span-2">
          <StorageTextField
            disabled={locationLocked}
            label="Endpoint"
            placeholder="https://s3.example.com"
            value={endpoint}
            onChange={setEndpoint}
          />
        </div>
        <StorageTextField
          disabled={locationLocked}
          label="Bucket"
          value={bucket}
          onChange={setBucket}
        />
        <StorageTextField
          disabled={locationLocked}
          label="Object prefix"
          placeholder="kiln/backups"
          value={objectPrefix}
          onChange={setObjectPrefix}
        />
        <StorageTextField
          autoComplete="off"
          label="Access key ID"
          placeholder={existing ? "Leave blank to keep current key" : ""}
          value={accessKeyId}
          onChange={setAccessKeyId}
        />
        <StorageTextField
          autoComplete="new-password"
          label="Secret access key"
          placeholder={existing ? "Leave blank to keep current key" : ""}
          type="password"
          value={secretAccessKey}
          onChange={setSecretAccessKey}
        />
      </div>
      <div className="grid gap-2 px-5 pb-5 sm:grid-cols-2">
        <StorageSwitch
          checked={enabled}
          description="Allow new backups to select this destination."
          label="Enabled"
          onCheckedChange={setEnabled}
        />
        <StorageSwitch
          checked={forcePathStyle}
          description="Use endpoint/bucket/object addressing."
          disabled={locationLocked}
          label="Path-style URLs"
          onCheckedChange={setForcePathStyle}
        />
        {isPlatformAdmin ? (
          <StorageSwitch
            checked={allowPrivateNetwork}
            description="Permit private or loopback S3 endpoints."
            label="Private network"
            onCheckedChange={setAllowPrivateNetwork}
          />
        ) : null}
        {isPlatformAdmin ? (
          <StorageSwitch
            checked={platform}
            description="Available to every user and platform backup."
            disabled={existing !== null}
            label="Platform destination"
            onCheckedChange={setPlatform}
          />
        ) : null}
      </div>
      {save.error ? (
        <p className="px-5 pb-5 text-xs text-destructive">
          {save.error.message}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 border-t bg-background/35 px-5 py-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" type="button" onClick={onBack}>
          Cancel
        </Button>
        <Button
          disabled={!canSave || save.isPending}
          type="button"
          onClick={() => save.mutate()}
        >
          {save.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Cloud />
          )}
          Verify and save
        </Button>
      </div>
    </>
  )
}

function StorageTextField({
  autoComplete,
  disabled = false,
  label,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  autoComplete?: string
  disabled?: boolean
  label: string
  onChange: (value: string) => void
  placeholder?: string
  type?: React.HTMLInputTypeAttribute
  value: string
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-medium">{label}</span>
      <Input
        aria-label={label}
        autoComplete={autoComplete}
        disabled={disabled}
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}

function StorageSwitch({
  checked,
  description,
  disabled = false,
  label,
  onCheckedChange,
}: {
  checked: boolean
  description: string
  disabled?: boolean
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/35 p-3">
      <span>
        <span className="block text-xs font-semibold">{label}</span>
        <span className="type-meta mt-0.5 block text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  )
}

function DeleteBackupStorageDialog({
  destination,
  onOpenChange,
  open,
}: {
  destination: BackupStorage
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const queryClient = useQueryClient()
  const retry = destination.deleting
  const remove = useMutation({
    mutationFn: () => deleteBackupStorage({ data: { id: destination.id } }),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.backups.storage,
      })
    },
    onSuccess: () => {
      showToast({
        message: `${destination.name} deleted`,
        type: "success",
      })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {retry ? "Retry destination delete?" : "Delete destination?"}
          </DialogTitle>
          <DialogDescription>
            {retry
              ? `“${destination.name}” is still marked deleting. Retry purges remaining S3 prefixes, then removes the destination.`
              : `“${destination.name}” can only be deleted when no retained backups reference it. Incremental restic prefixes in this destination are purged; full-archive objects already in the bucket stay.`}
          </DialogDescription>
        </DialogHeader>
        {destination.lastError ? (
          <p className="text-xs text-destructive">{destination.lastError}</p>
        ) : null}
        {remove.error ? (
          <p className="text-xs text-destructive">{remove.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            {retry ? "Retry delete" : "Delete destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RestoreBackupDialog({
  backup,
  onOpenChange,
  open,
  targetName,
}: {
  backup: Backup
  onOpenChange: (open: boolean) => void
  open: boolean
  targetName: string
}) {
  const queryClient = useQueryClient()
  const [safetyBackup, setSafetyBackup] = React.useState(true)
  const restore = useMutation({
    mutationFn: () =>
      backup.targetKind === "database"
        ? restoreDatabaseBackup({ data: { backupId: backup.id, safetyBackup } })
        : restoreInstanceBackup({
            data: { backupId: backup.id, safetyBackup },
          }),
    onSuccess: async (result) => {
      await resetActiveBackupRunsToFirstPage(queryClient)
      showToast({
        message: result.relayAccepted
          ? `Restore of ${targetName} queued`
          : `Restore saved and will resume when Relay reconnects`,
        type: result.relayAccepted ? "success" : "warning",
      })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {targetName}</DialogTitle>
          <DialogDescription>
            This replaces the target with “{backup.name}”. Game servers must be
            stopped; managed databases remain running for logical import.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-background/35 p-3">
          <span>
            <span className="block text-xs font-semibold">Safety backup</span>
            <span className="type-meta mt-1 block text-muted-foreground">
              Take a new full backup immediately before restoring.
            </span>
          </span>
          <Switch
            aria-label="Take a safety backup before restore"
            checked={safetyBackup}
            onCheckedChange={setSafetyBackup}
          />
        </label>
        {restore.error ? (
          <p className="text-xs text-destructive">{restore.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={restore.isPending}
            type="button"
            onClick={() => restore.mutate()}
          >
            {restore.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCcw />
            )}
            Restore backup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteBackupDialog({
  backup,
  deleteFeedbackStore,
  onOpenChange,
  open,
}: {
  backup: Backup
  deleteFeedbackStore: BackupDeleteFeedbackStore
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    onMutate: () => {
      deleteFeedbackStore.mark([backup])
    },
    mutationFn: () =>
      deleteBackup({
        data: {
          backupId: backup.id,
          mode: backup.relayPresent ? "delete" : "forget",
        },
      }),
    onError: async () => {
      deleteFeedbackStore.remove([backup.id])
      await resetActiveBackupRunsToFirstPage(queryClient)
    },
    onSuccess: async (result) => {
      await resetActiveBackupRunsToFirstPage(queryClient)
      showToast({
        message: result.forgotten
          ? `${backup.name} forgotten`
          : result.relayAccepted
            ? `${backup.name} queued for deletion`
            : `Deletion saved and will resume when Relay reconnects`,
        type: result.forgotten || result.relayAccepted ? "success" : "warning",
      })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {backup.relayPresent ? "Delete backup?" : "Forget backup?"}
          </DialogTitle>
          <DialogDescription>
            {backup.relayPresent
              ? `“${backup.name}” and its stored artifact will be permanently removed.`
              : `The Relay for “${backup.name}” no longer belongs to Hearth.`}
          </DialogDescription>
        </DialogHeader>
        {!backup.relayPresent ? (
          <div className="flex gap-2.5 rounded-lg border border-primary/25 bg-primary/[0.06] px-3 py-2.5 text-xs leading-5">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>
              Forgetting removes this backup’s history from Hearth. Any stored
              files are left untouched.
            </p>
          </div>
        ) : null}
        {remove.error ? (
          <p className="text-xs text-destructive">{remove.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : backup.relayPresent ? (
              <Trash2 />
            ) : (
              <ArchiveX />
            )}
            {backup.relayPresent ? "Delete backup" : "Forget backup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function backupScopeOptions({
  databases,
  includePlatform,
  nodes,
  servers,
}: {
  databases: Awaited<ReturnType<typeof getManagedDatabaseDirectory>>
  includePlatform: boolean
  nodes: ReturnType<typeof selectBackupScope>["nodes"]
  servers: ReturnType<typeof selectBackupScope>["servers"]
}): Array<ServerPickerOption> {
  const options: Array<ServerPickerOption> = []
  for (const server of servers) {
    options.push({
      description: `Server · ${server.relayName} · ${server.id}`,
      id: server.id,
      kind: "server",
      name: server.name,
      relayId: server.relayId,
      relayName: server.relayName,
    })
  }
  for (const database of databases) {
    options.push({
      description: `Database · ${database.relayName} · ${database.id}`,
      id: database.id,
      kind: "database",
      name: database.name,
      relayId: database.relayId,
      relayName: database.relayName,
    })
  }
  if (includePlatform) {
    for (const node of nodes) {
      options.push({
        description: `Relay · ${node.relayId}`,
        id: node.relayId,
        kind: "relay",
        name: node.relayName,
        relayId: node.relayId,
        relayName: node.relayName,
      })
    }
  }
  return options
}

function backupPolicyTarget(target: ServerPickerOption): BackupTarget {
  const kind = target.kind ?? "server"
  return {
    id: target.id,
    kind: kind === "server" ? "instance" : kind === "relay" ? "platform" : kind,
  }
}

function selectedBackupCreateTargetKey(selected: ServerPickerOption): string {
  const kind = selected.kind ?? "server"
  if (kind === "database") {
    return targetKey("database", selected.relayId, selected.id)
  }
  if (kind === "relay") {
    return targetKey("platform", selected.relayId, "kiln")
  }
  return targetKey("instance", selected.relayId, selected.id)
}

function availableCreateTargets({
  capabilities,
  databases,
  nodes,
  servers,
}: {
  capabilities: Awaited<ReturnType<typeof getAccessCapabilities>>
  databases: Awaited<ReturnType<typeof getManagedDatabaseDirectory>>
  nodes: ReturnType<typeof selectBackupScope>["nodes"]
  servers: ReturnType<typeof selectBackupScope>["servers"]
}): Array<CreateTarget> {
  const targets: Array<CreateTarget> = []
  for (const server of servers) {
    if (
      canCreateForResource(capabilities, server.relayId, "instance", server.id)
    ) {
      targets.push({
        id: server.id,
        key: targetKey("instance", server.relayId, server.id),
        kind: "instance",
        name: server.name,
        relayId: server.relayId,
        relayName: server.relayName,
      })
    }
  }
  for (const database of databases) {
    if (!database.supportsImportExport) continue
    if (
      canCreateForResource(
        capabilities,
        database.relayId,
        "database",
        database.id
      )
    ) {
      targets.push({
        id: database.id,
        key: targetKey("database", database.relayId, database.id),
        kind: "database",
        name: database.name,
        relayId: database.relayId,
        relayName: database.relayName,
      })
    }
  }
  if (capabilities.isPlatformAdmin) {
    for (const relay of nodes) {
      targets.push({
        id: relay.relayId,
        key: targetKey("platform", relay.relayId, "kiln"),
        kind: "platform",
        name: "Kiln platform",
        relayId: relay.relayId,
        relayName: relay.relayName,
      })
    }
  }
  return targets
}

function canCreateForResource(
  capabilities: Awaited<ReturnType<typeof getAccessCapabilities>>,
  relayId: string,
  resourceType: "database" | "instance",
  resourceId: string
): boolean {
  if (capabilities.isPlatformAdmin) return true
  return capabilities.grants.some(
    (grant) =>
      grant.relayId === relayId &&
      roleHasPermission(grant.role, "backup.create") &&
      (grant.resourceType === "relay" ||
        (grant.resourceType === resourceType &&
          grant.resourceId === resourceId))
  )
}

function parseOptionalInteger(value: string, label: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a whole number of zero or more`)
  }
  return parsed
}

function parseOptionalGiB(value: string, label: string): number | null {
  if (!value.trim()) return null
  const gibibytes = Number(value)
  const bytes = Math.round(gibibytes * 1024 ** 3)
  if (
    !Number.isFinite(gibibytes) ||
    gibibytes < 0 ||
    !Number.isSafeInteger(bytes)
  ) {
    throw new Error(`${label} must be a non-negative size`)
  }
  return bytes
}

function bytesToGiBInput(bytes: number | null): string {
  if (bytes === null) return ""
  return (bytes / 1024 ** 3).toString()
}

function excludeLines(value: string): Array<string> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}
