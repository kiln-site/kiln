import * as React from "react"
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Effect, Result } from "effect"
import {
  Check,
  CloudDownload,
  ExternalLink,
  History,
  LoaderCircle,
  RadioTower,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
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
import { Skeleton } from "@workspace/ui/components/skeleton"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"

import type { PublicKilnRelease } from "@/effect/github-releases"
import { useKilnGitRepository } from "@/lib/git-repository"
import { queryKeys, updateOverviewQueryOptions } from "@/lib/query-options"
import { replaceRelayUpdateVersion } from "@/lib/system-update-cache"
import {
  compareLatestReleaseVersion,
  compareReleaseVersions,
  findKilnRelease,
  isKilnReleaseVersion,
} from "@/lib/release-version"
import {
  beginSystemUpdateBatch,
  canStartSystemUpdate,
  inactiveSystemUpdateBatch,
  isHearthUpdateLocked,
  recordHearthUpdateCompletion,
  recordSystemUpdateFailure,
  systemUpdateCompletionDisposition,
  type SystemUpdateBatchState,
} from "@/lib/system-update-batch"
import {
  createSystemUpdateActivityStore,
  type SystemUpdateActivityStore,
} from "@/lib/system-update-activity-store"
import { systemUpdateProgress } from "@/lib/system-update-progress"
import {
  applicationConnectionToastId,
  applicationReconnectedToastId,
  activeSystemUpdateStorageKey,
  canRefetchSystemUpdateOverview,
  clearSystemUpdateActive,
  markSystemUpdateActive,
  relayDisconnectToastId,
  relayReconnectToastId,
  setSystemUpdateOverviewRefetchBlocked,
} from "@/lib/system-update-presence"
import type { UpdateOverview } from "@/server/updates"
import { getSystemUpdateStatus, startSystemUpdates } from "@/server/updates"

type UpdateTarget = {
  component: "hearth" | "relay"
  currentVersion: string | null
  eligible: boolean
  key: string
  name: string
  reason: string | null
  relayId: string | null
}

type ActiveUpdate = {
  component: "hearth" | "relay"
  name: string
  operationId: string
  phase?: string
  previousVersion: string | null
  relayId: string
  targetVersion: string | null
  targetKey: string
  versionName?: string
}

type PendingUpdate = {
  latestVersion: string
  latestVersionName: string
  targets: ReadonlyArray<UpdateTarget>
}

type HearthUpdateCompletion = {
  version: string
  versionName: string
}

type UpdateFailure = {
  message: string
  target: UpdateTarget | ActiveUpdate
}

type SystemUpdateOperation = Awaited<ReturnType<typeof getSystemUpdateStatus>>

type ActiveUpdatePollerController = {
  complete: (update: ActiveUpdate, operation: SystemUpdateOperation) => void
  setReconnecting: (operationId: string, reconnecting: boolean) => void
}

const inactiveUpdateBatch = inactiveSystemUpdateBatch<
  UpdateFailure,
  HearthUpdateCompletion
>()

type DialogView = "changelog" | "overview"

type ViewVisibility = {
  changelogMounted: boolean
  view: DialogView
}

type UpdateDialogViewStore = ReturnType<typeof createUpdateDialogViewStore>

const changelogRangeStorageKey = "kiln.system-update-changelog-ranges"
const updateFailureStorageKey = "kiln.system-update-failures"
const systemUpdateToastId = "system-update"
const minimumUpdateCheckDuration = 750
const completedUpdateDisplayDuration = 1_500
const mockRelayPhaseDuration = 325
const mockHearthPhaseDuration = 850
const mockHearthDialogDelay = 1_800
const releaseDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
})
const lastCheckedFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
})

function activeUpdateQueryOptions(active: ActiveUpdate) {
  return queryOptions({
    queryKey: ["updates", "operation", active.relayId, active.operationId],
    queryFn: () =>
      getSystemUpdateStatus({
        data: {
          operationId: active.operationId,
          relayId: active.relayId,
        },
      }),
    refetchInterval: (query) =>
      query.state.data?.status === "failed" ||
      query.state.data?.status === "succeeded"
        ? false
        : 2_000,
    retry: 2,
    retryDelay: 2_000,
    notifyOnChangeProps: ["data", "isError", "isRefetchError", "isSuccess"],
  })
}

export const InfraUpdatesDialog = React.memo(function InfraUpdatesDialog({
  initialRelayId,
  open,
  onOpenChange,
  onRetryTarget,
  requestId,
}: {
  initialRelayId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRetryTarget: (relayId: string | null) => void
  requestId: number
}) {
  const gitRepository = useKilnGitRepository()
  const githubIssuesUrl = `${gitRepository}/issues/new/choose`
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState<PendingUpdate | null>(null)
  const [active, setActive] = React.useState<Array<ActiveUpdate>>([])
  const [activityStore] = React.useState(createSystemUpdateActivityStore)
  const [hearthCompletion, setHearthCompletion] =
    React.useState<HearthUpdateCompletion | null>(null)
  const [changelogRevision, setChangelogRevision] = React.useState(0)
  const activeRef = React.useRef<ReadonlyArray<ActiveUpdate>>([])
  const batch =
    React.useRef<SystemUpdateBatchState<UpdateFailure, HearthUpdateCompletion>>(
      inactiveUpdateBatch
    )
  const completedOperations = React.useRef(new Set<string>())
  const reconnectingOperations = React.useRef(new Set<string>())
  const mockTimers = React.useRef<Array<number>>([])
  const completedUpdateTimers = React.useRef(new Set<number>())
  const completedUpdatesRef = React.useRef<ReadonlyArray<ActiveUpdate>>([])
  const heldHearthUpdateRef = React.useRef<ActiveUpdate | null>(null)
  const mockActiveRef = React.useRef<ReadonlyArray<ActiveUpdate>>([])
  const preparingUpdatesRef = React.useRef<ReadonlyArray<ActiveUpdate>>([])
  const viewStoreRef = React.useRef<UpdateDialogViewStore | null>(null)
  if (viewStoreRef.current === null) {
    viewStoreRef.current = createUpdateDialogViewStore(
      initialRelayId ? relayTargetKey(initialRelayId) : "hearth"
    )
  }
  const viewStore = viewStoreRef.current
  const publishDisplayedActive = React.useCallback(() => {
    activityStore.setActivities([
      ...activeRef.current,
      ...(heldHearthUpdateRef.current ? [heldHearthUpdateRef.current] : []),
      ...mockActiveRef.current,
      ...completedUpdatesRef.current,
      ...preparingUpdatesRef.current,
    ])
  }, [activityStore])
  const replaceActive = React.useCallback(
    (next: ReadonlyArray<ActiveUpdate>) => {
      const stored = [...next]
      activeRef.current = stored
      storeActiveUpdates(stored)
      publishDisplayedActive()
      setActive(stored)
    },
    [publishDisplayedActive]
  )

  const holdCompletedUpdate = React.useCallback(
    (update: ActiveUpdate) => {
      activityStore.setPhase(update.operationId, "completed")
      completedUpdatesRef.current = [
        ...completedUpdatesRef.current.filter(
          (completed) => completed.operationId !== update.operationId
        ),
        { ...update, phase: "completed" },
      ]
      publishDisplayedActive()

      const timer = window.setTimeout(() => {
        completedUpdatesRef.current = completedUpdatesRef.current.filter(
          (completed) => completed.operationId !== update.operationId
        )
        completedUpdateTimers.current.delete(timer)
        publishDisplayedActive()
      }, completedUpdateDisplayDuration)
      completedUpdateTimers.current.add(timer)
    },
    [activityStore, publishDisplayedActive]
  )

  React.useEffect(
    () => () => {
      for (const timer of completedUpdateTimers.current) {
        window.clearTimeout(timer)
      }
      completedUpdateTimers.current.clear()
    },
    []
  )

  React.useEffect(() => {
    if (requestId === 0) return
    viewStore.showOverview()
    viewStore.setTarget(
      initialRelayId ? relayTargetKey(initialRelayId) : "hearth"
    )
  }, [initialRelayId, requestId, viewStore])

  React.useEffect(() => {
    const restored = Result.try(() => {
      const stored = window.localStorage.getItem(activeSystemUpdateStorageKey)
      return stored ? parseActiveUpdates(JSON.parse(stored) as unknown) : []
    })
    if (Result.isSuccess(restored) && restored.success.length > 0) {
      setSystemUpdateOverviewRefetchBlocked(true)
      void queryClient.cancelQueries({
        exact: true,
        queryKey: queryKeys.updates,
      })
      for (const update of restored.success) {
        activityStore.setPhase(update.operationId, update.phase ?? "Preparing")
        registerUpdatePresence(update)
      }
      const versionName =
        restored.success[0]?.versionName ??
        friendlyVersionName(restored.success[0]?.targetVersion ?? null)
      batch.current = beginSystemUpdateBatch(batch.current, versionName)
      showSystemUpdateProgressToast(versionName, false)
      replaceActive(restored.success)
    } else {
      window.localStorage.removeItem(activeSystemUpdateStorageKey)
    }
  }, [activityStore, queryClient, replaceActive])

  const registerStartedUpdate = React.useCallback(
    (update: ActiveUpdate) => {
      activityStore.setPhase(update.operationId, update.phase ?? "Preparing")
      preparingUpdatesRef.current = preparingUpdatesRef.current.filter(
        (preparing) => preparing.targetKey !== update.targetKey
      )
      registerUpdatePresence(update)
      replaceActive([...activeRef.current, update])
    },
    [activityStore, replaceActive]
  )
  const updateMutation = useMutation({
    mutationFn: (update: PendingUpdate) =>
      startUpdates(
        update.targets,
        update.latestVersion,
        update.latestVersionName,
        registerStartedUpdate
      ),
    onMutate: async (update) => {
      setSystemUpdateOverviewRefetchBlocked(true)
      const cancelOverviewQuery = queryClient.cancelQueries({
        exact: true,
        queryKey: queryKeys.updates,
      })
      const preparingUpdates = update.targets.flatMap((target) =>
        isTargetUpdating(activeRef.current, target)
          ? []
          : [
              {
                component: target.component,
                name: target.name,
                operationId: `preparing:${target.key}`,
                phase: "Preparing",
                previousVersion: target.currentVersion,
                relayId: target.relayId ?? "preparing",
                targetVersion: update.latestVersion,
                targetKey: target.key,
                versionName: update.latestVersionName,
              } satisfies ActiveUpdate,
            ]
      )
      for (const preparing of preparingUpdates) {
        activityStore.setPhase(preparing.operationId, "Preparing")
      }
      preparingUpdatesRef.current = preparingUpdates
      publishDisplayedActive()
      batch.current = beginSystemUpdateBatch(
        batch.current,
        update.latestVersionName
      )
      dismissToast(systemUpdateToastId)
      showSystemUpdateProgressToast(
        batch.current.versionName ?? update.latestVersionName,
        false
      )
      await cancelOverviewQuery
    },
    onSuccess: ({ failures }) => {
      for (const failure of failures) {
        batch.current = recordSystemUpdateFailure(batch.current, failure)
      }
    },
    onSettled: () => {
      preparingUpdatesRef.current = []
      publishDisplayedActive()
    },
  })

  const handleOperationReconnectingChange = React.useCallback(
    (operationId: string, reconnecting: boolean) => {
      const wasReconnecting = reconnectingOperations.current.size > 0
      if (reconnecting) reconnectingOperations.current.add(operationId)
      else reconnectingOperations.current.delete(operationId)
      const isReconnecting = reconnectingOperations.current.size > 0
      if (wasReconnecting === isReconnecting) return
      if (!batch.current.active || activeRef.current.length === 0) return
      showSystemUpdateProgressToast(
        batch.current.versionName ?? "the latest version",
        isReconnecting,
        open ? undefined : () => onRetryTarget(null)
      )
    },
    [onRetryTarget, open]
  )

  const handleOperationComplete = React.useCallback(
    (completed: ActiveUpdate, operation: SystemUpdateOperation) => {
      if (operation?.status === "running") return
      if (completedOperations.current.has(completed.operationId)) return
      completedOperations.current.add(completed.operationId)

      const remainingActive = activeRef.current.filter(
        (item) => item.operationId !== completed.operationId
      )
      if (operation === null || operation === undefined) {
        replaceActive(remainingActive)
        const disposition = systemUpdateCompletionDisposition(
          completed.component,
          "failed"
        )
        if (disposition.clearPresence) clearSystemUpdateActive(completed)
        batch.current = recordSystemUpdateFailure(batch.current, {
          message: `${completed.name}'s saved update operation could not be found. Check the target container before trying again.`,
          target: completed,
        })
        return
      }

      if (operation.status === "failed") {
        replaceActive(remainingActive)
        const disposition = systemUpdateCompletionDisposition(
          completed.component,
          "failed"
        )
        if (disposition.clearPresence) clearSystemUpdateActive(completed)
        batch.current = recordSystemUpdateFailure(batch.current, {
          message:
            operation.error ??
            "The update failed. The previous container was restored.",
          target: completed,
        })
        return
      }
      const disposition = systemUpdateCompletionDisposition(
        completed.component,
        "succeeded"
      )
      const lockUntilReload =
        disposition.lockUntilReload && isViewedHearthUpdate(completed)
      if (!lockUntilReload) clearSystemUpdateActive(completed)
      resetUpdateFailureCount(completed.targetKey)
      const completedVersion = completed.targetVersion ?? operation.version
      storeChangelogRange(
        completed.targetKey,
        completed.previousVersion,
        completedVersion
      )
      setChangelogRevision((revision) => revision + 1)
      if (completed.component === "relay" && completed.relayId) {
        queryClient.setQueryData<UpdateOverview>(
          queryKeys.updates,
          (overview) =>
            overview
              ? {
                  ...overview,
                  relays: replaceRelayUpdateVersion(
                    overview.relays,
                    completed.relayId,
                    completedVersion
                  ),
                }
              : overview
        )
      }
      if (lockUntilReload) {
        const completion = {
          version: completedVersion,
          versionName:
            completed.versionName ?? friendlyVersionName(completedVersion),
        }
        batch.current = recordHearthUpdateCompletion(batch.current, completion)
        if (isHearthUpdateLocked(batch.current)) {
          activityStore.setPhase(completed.operationId, "awaitingReload")
          heldHearthUpdateRef.current = {
            ...completed,
            phase: "awaitingReload",
            targetVersion: completedVersion,
            versionName: completion.versionName,
          }
          activityStore.setHearthReloadRequired(true)
          setPending(null)
          publishDisplayedActive()
        }
      } else {
        holdCompletedUpdate({
          ...completed,
          targetVersion: completedVersion,
          versionName:
            completed.versionName ?? friendlyVersionName(completedVersion),
        })
      }
      replaceActive(remainingActive)
    },
    [
      activityStore,
      holdCompletedUpdate,
      publishDisplayedActive,
      queryClient,
      replaceActive,
    ]
  )

  React.useEffect(() => {
    if (!batch.current.active) return
    if (activeRef.current.length > 0 || updateMutation.isPending) {
      showSystemUpdateProgressToast(
        batch.current.versionName ?? "the latest version",
        reconnectingOperations.current.size > 0,
        open ? undefined : () => onRetryTarget(null)
      )
      return
    }

    const completedBatch = batch.current
    batch.current = inactiveSystemUpdateBatch<
      UpdateFailure,
      HearthUpdateCompletion
    >()
    setSystemUpdateOverviewRefetchBlocked(false)
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.updates }),
      queryClient.invalidateQueries({ queryKey: queryKeys.relays }),
    ])
    const failures = completedBatch.failures
    const hearth = completedBatch.hearthCompletion

    if (failures.length > 0) {
      showSystemUpdateFailureToast(failures, onRetryTarget, githubIssuesUrl)
    } else if (hearth === null) {
      showSystemUpdateSuccessToast(
        completedBatch.versionName ?? "the latest version"
      )
    }

    if (hearth) {
      if (failures.length === 0) dismissToast(systemUpdateToastId)
      setHearthCompletion(hearth)
    }
  }, [
    active.length,
    githubIssuesUrl,
    onRetryTarget,
    open,
    queryClient,
    updateMutation.isPending,
  ])

  const clearMockTimers = React.useCallback(() => {
    for (const timer of mockTimers.current) window.clearTimeout(timer)
    mockTimers.current = []
  }, [])

  React.useEffect(() => clearMockTimers, [clearMockTimers])

  const updateMutationPendingRef = React.useRef(updateMutation.isPending)
  React.useEffect(() => {
    updateMutationPendingRef.current = updateMutation.isPending
  }, [updateMutation.isPending])

  const handleUpdate = React.useCallback(
    (
      targets: ReadonlyArray<UpdateTarget>,
      latestVersion: string,
      latestVersionName?: string
    ) => {
      if (
        !canStartSystemUpdate({
          hearthReloadRequired: heldHearthUpdateRef.current !== null,
          mutationPending: updateMutationPendingRef.current,
        })
      ) {
        return
      }
      setPending({
        latestVersion,
        latestVersionName:
          latestVersionName ?? friendlyVersionName(latestVersion),
        targets,
      })
    },
    []
  )

  const handleMockUpdate = React.useCallback(
    (
      targets: ReadonlyArray<UpdateTarget>,
      latestVersion: string,
      latestVersionName: string
    ) => {
      if (
        targets.length === 0 ||
        updateMutationPendingRef.current ||
        batch.current.active ||
        activeRef.current.length > 0 ||
        heldHearthUpdateRef.current !== null ||
        mockActiveRef.current.length > 0
      ) {
        return
      }
      clearMockTimers()
      const updates = targets.map((target, index) => ({
        component: target.component,
        name: target.name,
        operationId: `mock:${index}`,
        phase: "Preparing",
        previousVersion: target.currentVersion,
        relayId: target.relayId ?? "mock-relay",
        targetVersion: latestVersion,
        targetKey: target.key,
        versionName: latestVersionName,
      })) satisfies Array<ActiveUpdate>
      const phases = [
        "replace.inspectContainer",
        "replace.tagTarget",
        "replace.stopCurrent",
        "replace.renameCurrent",
        "replace.createTarget",
        "replace.connectNetwork",
        "replace.startTarget",
        "reconnecting",
        "replace.waitUntilHealthy",
        "replace.removeBackup",
      ]

      for (const update of updates) {
        activityStore.setPhase(update.operationId, "Preparing")
      }
      mockActiveRef.current = updates
      publishDisplayedActive()
      showSystemUpdateProgressToast(latestVersionName, false)
      const viewedHearth = updates.find(isViewedHearthUpdate)
      const toastTimelineUpdate = viewedHearth ?? updates[0]
      for (const update of updates) {
        const phaseDuration = isViewedHearthUpdate(update)
          ? mockHearthPhaseDuration
          : mockRelayPhaseDuration
        phases.forEach((phase, index) => {
          const timer = window.setTimeout(
            () => {
              const completed = index === phases.length - 1
              activityStore.setPhase(
                update.operationId,
                completed
                  ? isViewedHearthUpdate(update)
                    ? "awaitingReload"
                    : "completed"
                  : phase
              )
              if (
                update.operationId === toastTimelineUpdate?.operationId &&
                (phase === "reconnecting" ||
                  phases[index - 1] === "reconnecting")
              ) {
                showSystemUpdateProgressToast(
                  latestVersionName,
                  phase === "reconnecting"
                )
              }
            },
            phaseDuration * (index + 1)
          )
          mockTimers.current.push(timer)
        })

        if (!isViewedHearthUpdate(update)) {
          const releaseTimer = window.setTimeout(
            () => {
              mockActiveRef.current = mockActiveRef.current.filter(
                (activeUpdate) =>
                  activeUpdate.operationId !== update.operationId
              )
              publishDisplayedActive()
            },
            phaseDuration * phases.length + completedUpdateDisplayDuration
          )
          mockTimers.current.push(releaseTimer)
        }
      }

      const longestUpdateDuration = Math.max(
        ...updates.map(
          (update) =>
            (isViewedHearthUpdate(update)
              ? mockHearthPhaseDuration
              : mockRelayPhaseDuration) * phases.length
        )
      )
      const completionTimer = window.setTimeout(
        () => {
          if (viewedHearth) {
            dismissToast(systemUpdateToastId)
            setHearthCompletion({
              version: latestVersion,
              versionName: latestVersionName,
            })
          } else {
            showSystemUpdateSuccessToast(latestVersionName)
          }
        },
        viewedHearth
          ? mockHearthPhaseDuration * phases.length + mockHearthDialogDelay
          : longestUpdateDuration
      )
      mockTimers.current.push(completionTimer)

      const cleanupTimer = window.setTimeout(
        () => {
          mockTimers.current = []
        },
        Math.max(
          longestUpdateDuration + completedUpdateDisplayDuration,
          viewedHearth
            ? mockHearthPhaseDuration * phases.length + mockHearthDialogDelay
            : 0
        ) + 50
      )
      mockTimers.current.push(cleanupTimer)
    },
    [activityStore, clearMockTimers, publishDisplayedActive]
  )

  const pollerController = React.useMemo<ActiveUpdatePollerController>(
    () => ({
      complete: handleOperationComplete,
      setReconnecting: handleOperationReconnectingChange,
    }),
    [handleOperationComplete, handleOperationReconnectingChange]
  )

  return (
    <>
      <ActiveUpdatePollers
        active={active}
        activityStore={activityStore}
        controller={pollerController}
      />
      <UpdaterDialog
        activityStore={activityStore}
        changelogRevision={changelogRevision}
        focusedRelayId={initialRelayId}
        open={open}
        store={viewStore}
        onMockUpdate={handleMockUpdate}
        onOpenChange={onOpenChange}
        onUpdate={handleUpdate}
      />

      <UpdateConfirmation
        error={
          updateMutation.error instanceof Error
            ? updateMutation.error.message
            : null
        }
        latestVersion={pending?.latestVersion ?? null}
        open={pending !== null}
        pending={updateMutation.isPending}
        targets={pending?.targets ?? []}
        onConfirm={() => {
          if (
            pending &&
            canStartSystemUpdate({
              hearthReloadRequired:
                activityStore.getHearthReloadRequiredSnapshot(),
              mutationPending: updateMutation.isPending,
            })
          ) {
            const update = pending
            setPending(null)
            updateMutation.mutate(update)
          }
        }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !updateMutation.isPending) {
            updateMutation.reset()
            setPending(null)
          }
        }}
      />
      <Dialog open={hearthCompletion !== null} onOpenChange={() => undefined}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Kiln successfully updated</DialogTitle>
            <DialogDescription>
              {hearthCompletion?.versionName ?? "The new version"} is ready.
              Reload the page to reconnect to the updated Kiln.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

const UpdaterDialog = React.memo(function UpdaterDialog({
  activityStore,
  changelogRevision,
  focusedRelayId,
  open,
  store,
  onMockUpdate,
  onOpenChange,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  changelogRevision: number
  focusedRelayId: string | null
  open: boolean
  store: UpdateDialogViewStore
  onMockUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName: string
  ) => void
  onOpenChange: (open: boolean) => void
  onUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName?: string
  ) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="h-[min(46rem,calc(100dvh-2rem))] max-h-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[calc(100%-2rem)] xl:max-w-5xl"
      >
        <div className="border-b bg-background/35 px-5 pt-5">
          <UpdaterTitleBar activityStore={activityStore} open={open} />
          <UpdaterViewTabs store={store} />
        </div>
        <UpdateDialogData
          activityStore={activityStore}
          changelogRevision={changelogRevision}
          focusedRelayId={focusedRelayId}
          open={open}
          store={store}
          onMockUpdate={onMockUpdate}
          onUpdate={onUpdate}
        />
      </DialogContent>
    </Dialog>
  )
})

const ActiveUpdatePollers = React.memo(function ActiveUpdatePollers({
  active,
  activityStore,
  controller,
}: {
  active: ReadonlyArray<ActiveUpdate>
  activityStore: SystemUpdateActivityStore
  controller: ActiveUpdatePollerController
}) {
  return active.map((update) => (
    <ActiveUpdatePoller
      activityStore={activityStore}
      controller={controller}
      key={update.operationId}
      update={update}
    />
  ))
})

const ActiveUpdatePoller = React.memo(function ActiveUpdatePoller({
  activityStore,
  controller,
  update,
}: {
  activityStore: SystemUpdateActivityStore
  controller: ActiveUpdatePollerController
  update: ActiveUpdate
}) {
  const operationQuery = useQuery(activeUpdateQueryOptions(update))
  const completed = React.useRef(false)
  const reconnecting = operationQuery.isError || operationQuery.isRefetchError
  const phase = reconnecting ? "reconnecting" : operationQuery.data?.phase

  React.useEffect(() => {
    if (phase) activityStore.setPhase(update.operationId, phase)
  }, [activityStore, phase, update.operationId])

  React.useEffect(() => {
    controller.setReconnecting(update.operationId, reconnecting)
    return () => controller.setReconnecting(update.operationId, false)
  }, [controller, reconnecting, update.operationId])

  React.useEffect(() => {
    if (!operationQuery.isSuccess || completed.current) return
    if (operationQuery.data?.status === "running") return
    completed.current = true
    controller.complete(update, operationQuery.data)
  }, [controller, operationQuery.data, operationQuery.isSuccess, update])

  return null
})

const UpdateDialogData = React.memo(function UpdateDialogData({
  activityStore,
  changelogRevision,
  focusedRelayId,
  open,
  store,
  onMockUpdate,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  changelogRevision: number
  focusedRelayId: string | null
  open: boolean
  store: UpdateDialogViewStore
  onMockUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName: string
  ) => void
  onUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName?: string
  ) => void
}) {
  const active = React.useSyncExternalStore(
    activityStore.subscribeActivities,
    activityStore.getActivitiesSnapshot,
    activityStore.getActivitiesSnapshot
  )
  const overviewQuery = useQuery({
    ...updateOverviewQueryOptions(),
    enabled: () =>
      open && active.length === 0 && canRefetchSystemUpdateOverview(),
    notifyOnChangeProps: ["data", "error", "isError", "isPending"],
  })
  const overview = overviewQuery.data
  const targets = React.useMemo(
    () => (overview ? updateTargets(overview) : []),
    [overview]
  )

  return (
    <UpdateDialogBody
      activityStore={activityStore}
      changelogRevision={changelogRevision}
      errorMessage={
        overviewQuery.error instanceof Error
          ? overviewQuery.error.message
          : "Update information is unavailable."
      }
      failed={overviewQuery.isError && active.length === 0}
      focusedRelayId={focusedRelayId}
      overview={overview}
      pending={overviewQuery.isPending && active.length === 0}
      store={store}
      targets={targets}
      onMockUpdate={onMockUpdate}
      onRetry={overviewQuery.refetch}
      onUpdate={onUpdate}
    />
  )
})

const UpdateDialogBody = React.memo(function UpdateDialogBody({
  activityStore,
  changelogRevision,
  errorMessage,
  failed,
  focusedRelayId,
  overview,
  pending,
  store,
  targets,
  onMockUpdate,
  onRetry,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  changelogRevision: number
  errorMessage: string
  failed: boolean
  focusedRelayId: string | null
  overview: UpdateOverview | undefined
  pending: boolean
  store: UpdateDialogViewStore
  targets: Array<UpdateTarget>
  onMockUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName: string
  ) => void
  onRetry: () => void
  onUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName?: string
  ) => void
}) {
  const visibility = React.useSyncExternalStore(
    store.subscribeVisibility,
    store.getVisibilitySnapshot,
    store.getVisibilitySnapshot
  )

  return (
    <div className="relative min-h-0 overflow-hidden">
      {pending ? (
        <div className="h-full overflow-x-hidden overflow-y-auto overscroll-contain">
          <UpdateDialogSkeleton />
        </div>
      ) : failed ? (
        <div className="h-full overflow-x-hidden overflow-y-auto overscroll-contain">
          <UpdateDialogError message={errorMessage} onRetry={onRetry} />
        </div>
      ) : overview ? (
        <>
          <div
            aria-hidden={visibility.view !== "overview"}
            className={`absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain [will-change:opacity] [contain:strict] ${
              visibility.view === "overview"
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            inert={visibility.view !== "overview"}
            role="tabpanel"
          >
            <UpdateOverviewView
              activityStore={activityStore}
              focusedRelayId={focusedRelayId}
              overview={overview}
              targets={targets}
              onMockUpdate={onMockUpdate}
              onChangelog={store.openChangelog}
              onUpdate={onUpdate}
            />
          </div>

          {visibility.changelogMounted ? (
            <div
              aria-hidden={visibility.view !== "changelog"}
              className={`absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain [will-change:opacity] [contain:strict] ${
                visibility.view === "changelog"
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0"
              }`}
              inert={visibility.view !== "changelog"}
              role="tabpanel"
            >
              <UpdateChangelogView
                changelogRevision={changelogRevision}
                overview={overview}
                store={store}
                targets={targets}
              />
            </div>
          ) : null}
        </>
      ) : (
        <ActiveUpdatesFallback activityStore={activityStore} />
      )}
    </div>
  )
})

const ActiveUpdatesFallback = React.memo(function ActiveUpdatesFallback({
  activityStore,
}: {
  activityStore: SystemUpdateActivityStore
}) {
  const active = React.useSyncExternalStore(
    activityStore.subscribeActivities,
    activityStore.getActivitiesSnapshot,
    activityStore.getActivitiesSnapshot
  )
  if (active.length === 0) return null

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-5">
      <section className="overflow-hidden rounded-xl border bg-card/45">
        {active.map((update) => (
          <div
            className="flex h-20 items-center gap-3 border-b px-4 last:border-b-0"
            key={update.operationId}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background/55 text-primary">
              <LoaderCircle className="size-4 animate-spin" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{update.name}</p>
              <div className="mt-2 h-4">
                <UpdateProgressBar
                  activityStore={activityStore}
                  initialPhase={update.phase}
                  operationId={update.operationId}
                />
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
})

const UpdaterTitleBar = React.memo(function UpdaterTitleBar({
  activityStore,
  open,
}: {
  activityStore: SystemUpdateActivityStore
  open: boolean
}) {
  return (
    <DialogHeader className="flex-row items-center justify-between gap-3 pr-10">
      <DialogTitle className="flex items-center gap-2.5 text-2xl text-white">
        <CloudDownload className="size-5 text-primary" />
        Kiln Updater
      </DialogTitle>
      <UpdaterCheckControl activityStore={activityStore} open={open} />
    </DialogHeader>
  )
})

const UpdaterCheckControl = React.memo(function UpdaterCheckControl({
  activityStore,
  open,
}: {
  activityStore: SystemUpdateActivityStore
  open: boolean
}) {
  const updating = React.useSyncExternalStore(
    activityStore.subscribeActivities,
    activityStore.getBusySnapshot,
    activityStore.getBusySnapshot
  )
  const overviewQuery = useQuery({
    ...updateOverviewQueryOptions(),
    enabled: () => open && !updating && canRefetchSystemUpdateOverview(),
    notifyOnChangeProps: ["dataUpdatedAt", "isFetching"],
  })
  const [lastCheckedAt, setLastCheckedAt] = React.useState("Not yet")
  const [checking, setChecking] = React.useState(overviewQuery.isFetching)
  const checkStartedAtRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (overviewQuery.dataUpdatedAt === 0) return
    setLastCheckedAt(
      lastCheckedFormatter.format(new Date(overviewQuery.dataUpdatedAt))
    )
  }, [overviewQuery.dataUpdatedAt])

  React.useEffect(() => {
    if (overviewQuery.isFetching) {
      if (checkStartedAtRef.current === null) {
        checkStartedAtRef.current = performance.now()
      }
      setChecking(true)
      return
    }

    const checkStartedAt = checkStartedAtRef.current
    if (checkStartedAt === null) {
      setChecking(false)
      return
    }

    const remainingDuration = Math.max(
      0,
      minimumUpdateCheckDuration - (performance.now() - checkStartedAt)
    )
    const timeoutId = window.setTimeout(() => {
      checkStartedAtRef.current = null
      setChecking(false)
    }, remainingDuration)

    return () => window.clearTimeout(timeoutId)
  }, [overviewQuery.isFetching])

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        aria-busy={checking}
        aria-label={checking ? "Checking for updates" : "Check for updates"}
        disabled={checking || updating}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => void overviewQuery.refetch()}
      >
        <RefreshCw className={checking ? "animate-spin" : ""} />
        <span className="hidden sm:inline">Check for updates</span>
      </Button>
      <p className="hidden text-[0.5625rem] text-muted-foreground sm:block">
        Last Checked: {lastCheckedAt}
      </p>
    </div>
  )
})

const UpdaterViewTabs = React.memo(function UpdaterViewTabs({
  store,
}: {
  store: UpdateDialogViewStore
}) {
  const visibility = React.useSyncExternalStore(
    store.subscribeVisibility,
    store.getVisibilitySnapshot,
    store.getVisibilitySnapshot
  )

  return (
    <div
      aria-label="Update dialog views"
      className="mt-4 flex gap-1"
      role="tablist"
    >
      <ViewButton
        active={visibility.view === "overview"}
        label="Overview"
        onClick={store.showOverview}
      />
      <ViewButton
        active={visibility.view === "changelog"}
        icon={History}
        label="Changelog"
        onClick={store.showChangelog}
      />
    </div>
  )
})

const ViewButton = React.memo(function ViewButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon?: typeof History
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-selected={active}
      className={`relative flex h-9 items-center gap-1.5 px-3 text-xs font-medium transition-colors outline-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 focus-visible:text-foreground ${
        active
          ? "text-foreground after:bg-primary"
          : "text-muted-foreground after:bg-transparent hover:text-foreground"
      }`}
      role="tab"
      type="button"
      onClick={onClick}
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      {label}
    </button>
  )
})

const UpdateOverviewView = React.memo(function UpdateOverviewView({
  activityStore,
  focusedRelayId,
  overview,
  targets,
  onMockUpdate,
  onChangelog,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  focusedRelayId: string | null
  overview: UpdateOverview
  targets: Array<UpdateTarget>
  onMockUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName: string
  ) => void
  onChangelog: (targetKey: string) => void
  onUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName?: string
  ) => void
}) {
  const latestRelease = overview.releases[0] ?? null
  const hearthTarget = targets.find((target) => target.component === "hearth")
  const relayTargets = targets.filter((target) => target.component === "relay")

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <section className="sticky top-0 z-10 flex flex-col gap-3 rounded-xl border border-primary/20 bg-background/95 px-4 py-3 shadow-sm backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <div>
            <p className="text-xs font-semibold text-foreground">
              Game servers stay online
            </p>
            <p className="mt-0.5 max-w-2xl text-[0.625rem] leading-4 text-muted-foreground">
              Updates do not restart running game servers or disconnect players.
              {overview.canUpdateHearth
                ? " Only the Panel may be briefly unavailable."
                : " A Relay may reconnect briefly while its update completes."}
            </p>
          </div>
        </div>
        <UpdateOverviewControls
          activityStore={activityStore}
          latestRelease={latestRelease}
          releases={overview.releases}
          targets={targets}
          onMockUpdate={onMockUpdate}
          onUpdate={onUpdate}
        />
      </section>

      <section className="overflow-hidden rounded-xl border bg-card/45">
        {latestRelease ? (
          <>
            {hearthTarget ? (
              <>
                <UpdateSectionLabel component="hearth" />
                <UpdateTargetRow
                  activityStore={activityStore}
                  focused={false}
                  key={hearthTarget.key}
                  latestVersion={latestRelease.version}
                  releases={overview.releases}
                  target={hearthTarget}
                  onChangelog={onChangelog}
                  onUpdate={onUpdate}
                />
              </>
            ) : null}

            <div className={hearthTarget ? "border-t border-border" : ""}>
              <UpdateSectionLabel component="relay" />
              {relayTargets.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {relayTargets.map((target) => (
                    <UpdateTargetRow
                      activityStore={activityStore}
                      focused={target.relayId === focusedRelayId}
                      key={target.key}
                      latestVersion={latestRelease.version}
                      releases={overview.releases}
                      target={target}
                      onChangelog={onChangelog}
                      onUpdate={onUpdate}
                    />
                  ))}
                </div>
              ) : (
                <p className="px-4 py-5 text-xs text-muted-foreground">
                  No Relays are paired with this Panel.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="px-4 py-6 text-xs text-amber-300">
            No public Kiln releases are available yet.
          </p>
        )}
      </section>
    </div>
  )
})

const UpdateOverviewControls = React.memo(function UpdateOverviewControls({
  activityStore,
  latestRelease,
  releases,
  targets,
  onMockUpdate,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  latestRelease: PublicKilnRelease | null
  releases: ReadonlyArray<PublicKilnRelease>
  targets: ReadonlyArray<UpdateTarget>
  onMockUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName: string
  ) => void
  onUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName?: string
  ) => void
}) {
  const active = React.useSyncExternalStore(
    activityStore.subscribeActivities,
    activityStore.getActivitiesSnapshot,
    activityStore.getActivitiesSnapshot
  )
  const activeTargetKeys = new Set(active.map((update) => update.targetKey))
  const hearthReloadRequired = useHearthReloadRequired(activityStore)
  const availableTargets = latestRelease
    ? targets.filter(
        (target) =>
          targetHasUpdate(target, releases) && !activeTargetKeys.has(target.key)
      )
    : []
  const mockableTargets = targets.filter(
    (target) => !activeTargetKeys.has(target.key)
  )
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        disabled={hearthReloadRequired || availableTargets.length === 0}
        size="sm"
        type="button"
        onClick={() => {
          if (latestRelease) {
            onUpdate(
              availableTargets,
              latestRelease.version,
              latestRelease.name
            )
          }
        }}
      >
        <CloudDownload />
        Update all
      </Button>
      {import.meta.env.DEV ? (
        <Button
          disabled={
            hearthReloadRequired ||
            active.length > 0 ||
            mockableTargets.length === 0
          }
          size="sm"
          type="button"
          variant="outline"
          onClick={() => {
            if (latestRelease) {
              onMockUpdate(
                mockableTargets,
                latestRelease.version,
                latestRelease.name
              )
            }
          }}
        >
          Mock update
        </Button>
      ) : null}
    </div>
  )
})

const UpdateSectionLabel = React.memo(function UpdateSectionLabel({
  component,
}: {
  component: "hearth" | "relay"
}) {
  const Icon = component === "hearth" ? ServerCog : RadioTower

  return (
    <div className="flex items-center gap-2 border-b border-border/70 bg-background/35 px-4 py-2.5">
      <Icon
        className={`size-3.5 ${
          component === "hearth" ? "text-primary" : "text-muted-foreground"
        }`}
      />
      <p className="font-mono text-[0.5625rem] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
        {component === "hearth" ? "Hearth" : "Relays"}
      </p>
    </div>
  )
})

type UpdateTargetRowProps = {
  activityStore: SystemUpdateActivityStore
  focused: boolean
  latestVersion: string
  releases: ReadonlyArray<PublicKilnRelease>
  target: UpdateTarget
  onChangelog: (targetKey: string) => void
  onUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName?: string
  ) => void
}

type UpdateTargetStatus = {
  label: string
  tone: string
}

const UpdateStatusCallout = React.memo(function UpdateStatusCallout({
  status,
}: {
  status: UpdateTargetStatus
}) {
  return (
    <span
      className={`inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-[3px] border px-1.5 font-mono text-[0.5rem] leading-none font-semibold tracking-[0.06em] whitespace-nowrap uppercase ${status.tone}`}
    >
      {status.label}
    </span>
  )
})

const UpdateTargetRow = React.memo(function UpdateTargetRow({
  activityStore,
  focused,
  latestVersion,
  releases,
  target,
  onChangelog,
  onUpdate,
}: UpdateTargetRowProps) {
  const rowRef = React.useRef<HTMLDivElement>(null)
  const currentRelease = findKilnRelease(releases, target.currentVersion)

  React.useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "nearest" })
  }, [focused])

  return (
    <div
      ref={rowRef}
      className={`grid gap-3 px-4 py-3 transition-colors sm:h-20 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${
        focused
          ? "bg-amber-400/[0.055] ring-1 ring-amber-400/20 ring-inset"
          : ""
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <UpdateTargetIcon activityStore={activityStore} target={target} />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 min-w-0 items-center gap-2 overflow-hidden">
            <h3 className="min-w-0 truncate text-sm font-semibold">
              {target.name}
            </h3>
            {currentRelease ? (
              <>
                <span
                  aria-hidden="true"
                  className="text-xs text-muted-foreground"
                >
                  ·
                </span>
                <GitHubVersionLink href={currentRelease.url}>
                  <span className="block max-w-56 truncate text-sm font-semibold text-foreground">
                    {currentRelease.name}
                  </span>
                </GitHubVersionLink>
              </>
            ) : null}
            <UpdateTargetStatusCallout
              activityStore={activityStore}
              releases={releases}
              target={target}
            />
          </div>
          <div className="mt-2 h-4 overflow-hidden" aria-live="polite">
            <UpdateTargetDetails
              activityStore={activityStore}
              latestVersion={latestVersion}
              releases={releases}
              target={target}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pl-12 sm:pl-0">
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onChangelog(target.key)}
        >
          <History />
          View changes
        </Button>
        <UpdateTargetAction
          activityStore={activityStore}
          latestVersion={latestVersion}
          releases={releases}
          target={target}
          onUpdate={onUpdate}
        />
      </div>
    </div>
  )
}, areUpdateTargetRowPropsEqual)

function useTargetActivity(
  activityStore: SystemUpdateActivityStore,
  targetKey: string
) {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      activityStore.subscribeTargetActivity(targetKey, listener),
    [activityStore, targetKey]
  )
  const getSnapshot = React.useCallback(
    () => activityStore.getTargetActivitySnapshot(targetKey),
    [activityStore, targetKey]
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function useHearthReloadRequired(activityStore: SystemUpdateActivityStore) {
  return React.useSyncExternalStore(
    activityStore.subscribeHearthReloadRequired,
    activityStore.getHearthReloadRequiredSnapshot,
    activityStore.getHearthReloadRequiredSnapshot
  )
}

const UpdateTargetIcon = React.memo(function UpdateTargetIcon({
  activityStore,
  target,
}: {
  activityStore: SystemUpdateActivityStore
  target: UpdateTarget
}) {
  const updating = useTargetActivity(activityStore, target.key) !== undefined
  const Icon = target.component === "hearth" ? ServerCog : RadioTower
  return (
    <span
      className={`grid size-9 shrink-0 place-items-center rounded-lg border ${
        target.component === "hearth"
          ? "border-primary/25 bg-primary/[0.07] text-primary"
          : "bg-background/55 text-muted-foreground"
      }`}
    >
      {updating ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <Icon className="size-4" />
      )}
    </span>
  )
})

const UpdateTargetStatusCallout = React.memo(
  function UpdateTargetStatusCallout({
    activityStore,
    releases,
    target,
  }: {
    activityStore: SystemUpdateActivityStore
    releases: ReadonlyArray<PublicKilnRelease>
    target: UpdateTarget
  }) {
    const updating = useTargetActivity(activityStore, target.key) !== undefined
    const comparison = compareLatestReleaseVersion(
      target.currentVersion,
      releases
    )
    return (
      <UpdateStatusCallout
        status={targetStatus(target, comparison, updating)}
      />
    )
  }
)

const UpdateTargetDetails = React.memo(function UpdateTargetDetails({
  activityStore,
  latestVersion,
  releases,
  target,
}: {
  activityStore: SystemUpdateActivityStore
  latestVersion: string
  releases: ReadonlyArray<PublicKilnRelease>
  target: UpdateTarget
}) {
  const activeUpdate = useTargetActivity(activityStore, target.key)
  return activeUpdate ? (
    <UpdateProgressBar
      activityStore={activityStore}
      initialPhase={activeUpdate.phase}
      operationId={activeUpdate.operationId}
    />
  ) : (
    <OverviewVersionLink
      currentVersion={target.currentVersion}
      latestVersion={latestVersion}
      reason={!target.eligible ? target.reason : null}
      releases={releases}
    />
  )
})

const UpdateTargetAction = React.memo(function UpdateTargetAction({
  activityStore,
  latestVersion,
  releases,
  target,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  latestVersion: string
  releases: ReadonlyArray<PublicKilnRelease>
  target: UpdateTarget
  onUpdate: (
    targets: ReadonlyArray<UpdateTarget>,
    latestVersion: string,
    latestVersionName?: string
  ) => void
}) {
  const updating = useTargetActivity(activityStore, target.key) !== undefined
  const hearthReloadRequired = useHearthReloadRequired(activityStore)
  const comparison = compareLatestReleaseVersion(
    target.currentVersion,
    releases
  )
  const updateAvailable = targetHasUpdate(target, releases)
  const reinstallAvailable = target.eligible && comparison === 0
  const latestRelease = findKilnRelease(releases, latestVersion)

  return (
    <Button
      className={
        updating
          ? "w-28 border-sky-400/30 bg-sky-400/10 text-sky-300 opacity-100"
          : "w-28"
      }
      size="sm"
      type="button"
      disabled={
        hearthReloadRequired ||
        (!updateAvailable && !reinstallAvailable) ||
        updating
      }
      onClick={() =>
        onUpdate(
          [target],
          latestVersion,
          latestRelease?.name ?? friendlyVersionName(latestVersion)
        )
      }
    >
      {updating ? (
        <LoaderCircle className="animate-spin" />
      ) : updateAvailable ? (
        <CloudDownload />
      ) : reinstallAvailable ? (
        <RefreshCw />
      ) : (
        <Check />
      )}
      {updating
        ? "Updating..."
        : updateAvailable
          ? "Update"
          : reinstallAvailable
            ? "Reinstall"
            : "Unavailable"}
    </Button>
  )
})

const UpdateProgressBar = React.memo(function UpdateProgressBar({
  activityStore,
  initialPhase,
  operationId,
}: {
  activityStore: SystemUpdateActivityStore
  initialPhase: string | undefined
  operationId: string
}) {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      activityStore.subscribePhase(operationId, listener),
    [activityStore, operationId]
  )
  const getSnapshot = React.useCallback(
    () => activityStore.getPhaseSnapshot(operationId) ?? initialPhase,
    [activityStore, initialPhase, operationId]
  )
  const phase = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const progress = systemUpdateProgress(phase, phase === "reconnecting")
  const completed = phase === "awaitingReload" || phase === "completed"
  return (
    <div className="flex max-w-md min-w-0 items-center gap-2 [contain:layout_style]">
      <div
        aria-label={`${progress.label}: ${progress.percent}%`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.percent}
        className="h-1.5 max-w-36 min-w-16 flex-1 overflow-hidden bg-muted/70"
        role="progressbar"
      >
        <div
          className="h-full bg-primary transition-[width] duration-500"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      <span
        className={`flex min-w-0 items-center gap-1.5 text-[0.5625rem] ${completed ? "text-emerald-300" : "text-muted-foreground"}`}
      >
        <span className="truncate">{progress.label}</span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[0.5rem] tabular-nums opacity-70"
        >
          {progress.percent}%
        </span>
        {completed ? (
          <Check aria-hidden="true" className="size-3 shrink-0" />
        ) : null}
      </span>
    </div>
  )
})

const OverviewVersionLink = React.memo(function OverviewVersionLink({
  currentVersion,
  latestVersion,
  reason,
  releases,
}: {
  currentVersion: string | null
  latestVersion: string
  reason: string | null
  releases: ReadonlyArray<PublicKilnRelease>
}) {
  const gitRepository = useKilnGitRepository()
  const currentRelease = findKilnRelease(releases, currentVersion)
  const latestRelease = findKilnRelease(releases, latestVersion)
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[0.625rem] leading-4 whitespace-nowrap text-muted-foreground">
      {currentRelease ? (
        <GitHubVersionLink href={currentRelease.url}>
          <span className="block max-w-56 truncate font-mono text-[0.5625rem]">
            {currentRelease.tag}
          </span>
        </GitHubVersionLink>
      ) : isKilnReleaseVersion(currentVersion) ? (
        <GitHubVersionLink
          href={githubReleaseUrl(gitRepository, currentVersion)}
        >
          <span className="block max-w-56 truncate font-mono text-[0.5625rem]">
            v{currentVersion}
          </span>
        </GitHubVersionLink>
      ) : (
        <>
          <span className="shrink-0">{displayVersion(currentVersion)}</span>
          <span aria-hidden="true">·</span>
          <GitHubVersionLink
            href={
              latestRelease?.url ??
              githubReleaseUrl(gitRepository, latestVersion)
            }
          >
            <span className="block max-w-56 truncate font-mono text-[0.5625rem]">
              Latest: v{latestVersion}
            </span>
          </GitHubVersionLink>
        </>
      )}
      {reason ? (
        <>
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <WifiOff className="size-3 shrink-0" />
            <span className="truncate">{reason}</span>
          </span>
        </>
      ) : null}
    </div>
  )
})

const GitHubVersionLink = React.memo(function GitHubVersionLink({
  children,
  href,
}: {
  children: React.ReactNode
  href: string
}) {
  return (
    <a
      className="inline-block rounded-sm transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  )
})

const UpdateChangelogView = React.memo(function UpdateChangelogView({
  changelogRevision,
  overview,
  store,
  targets,
}: {
  changelogRevision: number
  overview: UpdateOverview
  store: UpdateDialogViewStore
  targets: Array<UpdateTarget>
}) {
  const latestVersion = overview.releases[0]?.version ?? null

  return (
    <div className="p-4 sm:p-5">
      <ChangelogTargetPicker store={store} targets={targets} />

      {targets.length > 0 && latestVersion ? (
        <div className="rounded-xl border bg-card/40 p-4 sm:p-5">
          <ChangelogSelectionHeader
            changelogRevision={changelogRevision}
            latestVersion={latestVersion}
            overview={overview}
            store={store}
            targets={targets}
          />
          <ChangelogTimeline
            changelogRevision={changelogRevision}
            releases={overview.releases}
            store={store}
            targets={targets}
          />
        </div>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
          Changelog information is unavailable.
        </p>
      )}
    </div>
  )
})

const ChangelogTargetPicker = React.memo(function ChangelogTargetPicker({
  store,
  targets,
}: {
  store: UpdateDialogViewStore
  targets: Array<UpdateTarget>
}) {
  const selectedKey = React.useSyncExternalStore(
    store.subscribeTarget,
    store.getTargetSnapshot,
    store.getTargetSnapshot
  )

  return (
    <div
      aria-label="Changelog target"
      className="mb-5 no-scrollbar flex gap-2 overflow-x-auto pb-1"
    >
      {targets.map((target) => (
        <ChangelogTargetButton
          key={target.key}
          selected={target.key === selectedKey}
          target={target}
          onSelect={store.setTarget}
        />
      ))}
    </div>
  )
})

const ChangelogTargetButton = React.memo(function ChangelogTargetButton({
  selected,
  target,
  onSelect,
}: {
  selected: boolean
  target: UpdateTarget
  onSelect: (targetKey: string) => void
}) {
  return (
    <button
      aria-pressed={selected}
      className={`flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 ${
        selected
          ? "border-primary/35 bg-primary/[0.08] text-foreground"
          : "bg-background/35 text-muted-foreground hover:text-foreground"
      }`}
      type="button"
      onClick={() => onSelect(target.key)}
    >
      {target.component === "hearth" ? (
        <ServerCog className="size-3.5 text-primary" />
      ) : (
        <RadioTower className="size-3.5" />
      )}
      <span>
        <span className="block text-xs font-semibold">{target.name}</span>
        <span className="block font-mono text-[0.5rem]">
          {displayVersion(target.currentVersion)}
        </span>
      </span>
    </button>
  )
}, areChangelogTargetButtonPropsEqual)

const ChangelogSelectionHeader = React.memo(function ChangelogSelectionHeader({
  latestVersion,
  overview,
  store,
  targets,
}: {
  changelogRevision: number
  latestVersion: string
  overview: UpdateOverview
  store: UpdateDialogViewStore
  targets: Array<UpdateTarget>
}) {
  const gitRepository = useKilnGitRepository()
  const githubReleasesUrl = `${gitRepository}/releases`
  const selectedKey = React.useSyncExternalStore(
    store.subscribeTarget,
    store.getTargetSnapshot,
    store.getTargetSnapshot
  )
  const selectedTarget = findSelectedTarget(targets, selectedKey)
  const selection = selectedTarget
    ? changelogSelection(selectedTarget, latestVersion, overview.releases)
    : { alreadyLatest: false, fromVersion: null, updated: false }
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b pb-4">
      <div>
        <p className="text-sm font-semibold">{selectedTarget?.name}</p>
        <p className="mt-1 font-mono text-[0.625rem] text-muted-foreground">
          {selection.alreadyLatest ? (
            <>Current v{latestVersion}</>
          ) : (
            <>
              {displayVersion(selection.fromVersion)}
              <span className="mx-2 text-border">→</span>v{latestVersion}
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <a
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.625rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          href={githubReleasesUrl}
          rel="noreferrer"
          target="_blank"
        >
          View all changelogs
          <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}, areChangelogSelectionHeaderPropsEqual)

const ChangelogTimeline = React.memo(function ChangelogTimeline({
  releases: availableReleases,
  store,
  targets,
}: {
  changelogRevision: number
  releases: ReadonlyArray<PublicKilnRelease>
  store: UpdateDialogViewStore
  targets: Array<UpdateTarget>
}) {
  const selectedKey = React.useSyncExternalStore(
    store.subscribeTarget,
    store.getTargetSnapshot,
    store.getTargetSnapshot
  )
  const selectedTarget = findSelectedTarget(targets, selectedKey)
  const selection = selectedTarget
    ? changelogSelection(
        selectedTarget,
        availableReleases[0]?.version ?? null,
        availableReleases
      )
    : { alreadyLatest: false, fromVersion: null, updated: false }
  const releases = React.useMemo(
    () =>
      selection.alreadyLatest
        ? []
        : changelogReleases(availableReleases, selection.fromVersion),
    [availableReleases, selection.alreadyLatest, selection.fromVersion]
  )

  return releases.length > 0 ? (
    <div className="relative ml-1 space-y-6 border-l border-border/80 pl-5">
      {releases.map((release, index) => (
        <ChangelogRelease
          current={
            !selection.updated && release.version === selection.fromVersion
          }
          key={release.tag}
          latest={index === 0}
          previous={
            selection.updated && release.version === selection.fromVersion
          }
          release={release}
        />
      ))}
    </div>
  ) : (
    <div className="grid min-h-40 place-items-center text-center">
      <div>
        <Check className="mx-auto size-5 text-emerald-400" />
        <p className="mt-3 text-sm font-semibold">
          Already on the latest release
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          No newer release notes are waiting for this component.
        </p>
      </div>
    </div>
  )
}, areChangelogTimelinePropsEqual)

const ChangelogRelease = React.memo(function ChangelogRelease({
  current,
  latest,
  previous,
  release,
}: {
  current: boolean
  latest: boolean
  previous: boolean
  release: PublicKilnRelease
}) {
  return (
    <article>
      <span
        className={`absolute -left-[0.34rem] mt-1.5 size-2.5 rounded-full border-2 border-popover ${
          latest
            ? "bg-emerald-400"
            : current
              ? "bg-sky-300"
              : previous
                ? "bg-amber-300"
                : "bg-border"
        }`}
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{release.name}</h3>
            {latest ? (
              <Badge className="border border-emerald-300/35 bg-emerald-300/10 text-emerald-200">
                Latest
              </Badge>
            ) : null}
            {current ? <Badge variant="outline">Current</Badge> : null}
            {previous ? <Badge variant="outline">Previous</Badge> : null}
          </div>
          <p className="mt-1 font-mono text-[0.5625rem] text-muted-foreground">
            {formatReleaseDate(release.publishedAt)}
          </p>
        </div>
        <a
          className="inline-flex items-center gap-1 text-[0.625rem] text-muted-foreground transition-colors hover:text-primary"
          href={release.url}
          rel="noreferrer"
          target="_blank"
        >
          GitHub <ExternalLink className="size-3" />
        </a>
      </div>
      <PlainReleaseNotes notes={release.notes} />
    </article>
  )
})

const PlainReleaseNotes = React.memo(function PlainReleaseNotes({
  notes,
}: {
  notes: string | null
}) {
  const lines = React.useMemo(() => markdownTextLines(notes), [notes])

  return (
    <div className="mt-3 max-w-3xl space-y-1.5 text-[0.6875rem] leading-5 text-muted-foreground">
      {lines.map((line) => (
        <p key={line.id}>{linkedMarkdownText(line.text)}</p>
      ))}
    </div>
  )
})

function UpdateDialogSkeleton() {
  return (
    <div className="space-y-4 p-5">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

function UpdateDialogError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="grid min-h-80 place-items-center p-6 text-center">
      <div className="max-w-sm">
        <TriangleAlert className="mx-auto size-6 text-amber-300" />
        <p className="mt-3 text-sm font-semibold">
          Update information is unavailable
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {message}
        </p>
        <Button className="mt-4" size="sm" type="button" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

function UpdateConfirmation({
  error,
  latestVersion,
  open,
  pending,
  targets,
  onConfirm,
  onOpenChange,
}: {
  error: string | null
  latestVersion: string | null
  open: boolean
  pending: boolean
  targets: ReadonlyArray<UpdateTarget>
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  const targetLabel =
    targets.length === 1
      ? (targets[0]?.name ?? "system")
      : `${targets.length} systems`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update {targetLabel}?</DialogTitle>
          <DialogDescription>
            {targets.length > 0 && latestVersion
              ? `${targetLabel} will update to v${latestVersion}.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={pending}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={pending} type="button" onClick={onConfirm}>
            {pending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <CloudDownload />
            )}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function updateTargets(overview: UpdateOverview): Array<UpdateTarget> {
  const hearth: UpdateTarget = {
    component: "hearth",
    currentVersion:
      overview.hearth?.currentVersion ?? overview.currentVersion ?? null,
    eligible: overview.hearth?.eligible ?? false,
    key: "hearth",
    name: "Panel",
    reason:
      overview.hearth?.reason ??
      "Pair a Relay running on Hearth's Docker host to enable updates.",
    relayId: overview.hearth?.relayId ?? null,
  }
  return [
    ...(overview.canUpdateHearth ? [hearth] : []),
    ...overview.relays.map(
      (relay): UpdateTarget => ({
        component: "relay",
        currentVersion: relay.currentVersion,
        eligible: relay.eligible,
        key: relayTargetKey(relay.relayId),
        name: relay.name,
        reason: relay.reason,
        relayId: relay.relayId,
      })
    ),
  ]
}

function isViewedHearthUpdate(
  update: Pick<ActiveUpdate, "component" | "targetKey">
): boolean {
  return update.component === "hearth" && update.targetKey === "hearth"
}

async function startUpdates(
  targets: ReadonlyArray<UpdateTarget>,
  latestVersion: string,
  latestVersionName: string,
  onStarted: (update: ActiveUpdate) => void
): Promise<{
  failures: Array<{ message: string; target: UpdateTarget }>
}> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        startSystemUpdates({
          data: {
            targets: targets.map(({ component, relayId }) => ({
              component,
              relayId,
            })),
          },
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onFailure: (cause) => {
          return {
            failures: targets.map((target) => ({
              message:
                cause instanceof Error
                  ? cause.message
                  : "Update could not start.",
              target,
            })),
          }
        },
        onSuccess: (result) => {
          const failures: Array<{
            message: string
            target: UpdateTarget
          }> = []
          for (const failure of result.failures) {
            const target = targets.find(
              (candidate) =>
                candidate.component === failure.component &&
                (candidate.component === "hearth" ||
                  candidate.relayId === failure.relayId)
            )
            if (!target) continue
            failures.push({ message: failure.message, target })
          }
          for (const started of result.started) {
            const target = targets.find(
              (candidate) =>
                candidate.component === started.operation.component &&
                (candidate.component === "hearth" ||
                  candidate.relayId === started.relayId)
            )
            if (!target) continue
            onStarted({
              component: started.operation.component,
              name: target.name,
              operationId: started.operation.id,
              previousVersion: target.currentVersion,
              relayId: started.relayId,
              targetVersion: latestVersion,
              targetKey: target.key,
              versionName: latestVersionName,
            })
          }
          return { failures }
        },
      })
    )
  )
}

function registerUpdatePresence(update: ActiveUpdate): void {
  markSystemUpdateActive(update)
  dismissConnectionToasts(update)
}

function showSystemUpdateProgressToast(
  versionName: string,
  reconnecting: boolean,
  onOpen?: () => void
): void {
  showToast({
    type: "loading",
    message: `Updating Kiln to ${versionName}`,
    id: systemUpdateToastId,
    description: reconnecting ? "Reconnecting…" : undefined,
    duration: Infinity,
    closeButton: false,
    dismissible: false,
    action: onOpen ? { label: "View updates", onClick: onOpen } : undefined,
  })
}

function showSystemUpdateSuccessToast(versionName: string): void {
  showToast({
    type: "success",
    message: `Kiln updated to ${versionName}`,
    id: systemUpdateToastId,
    duration: 5_000,
    closeButton: true,
    dismissible: true,
  })
}

function friendlyVersionName(version: string | null): string {
  return version ? `v${version}` : "the latest version"
}

function showSystemUpdateFailureToast(
  failures: ReadonlyArray<{
    message: string
    target: UpdateTarget | ActiveUpdate
  }>,
  onRetryTarget: (relayId: string | null) => void,
  githubIssuesUrl: string
): void {
  const first = failures[0]
  if (!first) return
  const targetKey =
    "targetKey" in first.target ? first.target.targetKey : first.target.key
  const failureCount = incrementUpdateFailureCount(targetKey)
  showToast({
    type: "error",
    message:
      failures.length === 1 ? "Kiln update failed" : "Some updates failed",
    id: systemUpdateToastId,
    description:
      failures.length === 1
        ? `${first.target.name}: ${first.message}`
        : failures.map(({ target }) => target.name).join(", "),
    duration: Infinity,
    action: {
      label: "Open updater",
      onClick: () =>
        onRetryTarget(
          first.target.component === "hearth" ? null : first.target.relayId
        ),
    },
    cancel:
      failureCount > 1
        ? {
            label: "Report issue",
            onClick: () =>
              window.open(githubIssuesUrl, "_blank", "noopener,noreferrer"),
          }
        : undefined,
  })
}

function dismissConnectionToasts(
  update: Pick<ActiveUpdate, "component" | "relayId">
): void {
  if (update.component === "hearth") {
    dismissToast(applicationConnectionToastId)
    dismissToast(applicationReconnectedToastId)
    return
  }
  dismissToast(relayDisconnectToastId(update.relayId))
  dismissToast(relayReconnectToastId(update.relayId))
}

function createUpdateDialogViewStore(initialTargetKey: string) {
  let visibility: ViewVisibility = {
    changelogMounted: false,
    view: "overview",
  }
  let targetKey = initialTargetKey
  const visibilityListeners = new Set<() => void>()
  const targetListeners = new Set<() => void>()

  const setVisibility = (next: ViewVisibility) => {
    if (
      next.view === visibility.view &&
      next.changelogMounted === visibility.changelogMounted
    ) {
      return
    }
    visibility = next
    visibilityListeners.forEach((listener) => listener())
  }

  const setTarget = (nextTargetKey: string) => {
    if (nextTargetKey === targetKey) return
    targetKey = nextTargetKey
    targetListeners.forEach((listener) => listener())
  }

  return {
    getTargetSnapshot: () => targetKey,
    getVisibilitySnapshot: () => visibility,
    openChangelog: (nextTargetKey: string) => {
      setTarget(nextTargetKey)
      setVisibility({ changelogMounted: true, view: "changelog" })
    },
    setTarget,
    showChangelog: () =>
      setVisibility({ changelogMounted: true, view: "changelog" }),
    showOverview: () =>
      setVisibility({
        changelogMounted: visibility.changelogMounted,
        view: "overview",
      }),
    subscribeTarget: (listener: () => void) => {
      targetListeners.add(listener)
      return () => targetListeners.delete(listener)
    },
    subscribeVisibility: (listener: () => void) => {
      visibilityListeners.add(listener)
      return () => visibilityListeners.delete(listener)
    },
  }
}

function findSelectedTarget(
  targets: ReadonlyArray<UpdateTarget>,
  selectedKey: string
): UpdateTarget | null {
  return (
    targets.find((target) => target.key === selectedKey) ?? targets[0] ?? null
  )
}

function areUpdateTargetRowPropsEqual(
  previous: UpdateTargetRowProps,
  next: UpdateTargetRowProps
): boolean {
  return (
    previous.focused === next.focused &&
    previous.activityStore === next.activityStore &&
    previous.latestVersion === next.latestVersion &&
    previous.releases === next.releases &&
    previous.onChangelog === next.onChangelog &&
    previous.onUpdate === next.onUpdate &&
    areUpdateTargetsEqual(previous.target, next.target)
  )
}

function areChangelogTargetButtonPropsEqual(
  previous: {
    selected: boolean
    target: UpdateTarget
    onSelect: (targetKey: string) => void
  },
  next: {
    selected: boolean
    target: UpdateTarget
    onSelect: (targetKey: string) => void
  }
): boolean {
  return (
    previous.selected === next.selected &&
    previous.onSelect === next.onSelect &&
    previous.target.component === next.target.component &&
    previous.target.currentVersion === next.target.currentVersion &&
    previous.target.key === next.target.key &&
    previous.target.name === next.target.name
  )
}

function areChangelogTimelinePropsEqual(
  previous: {
    changelogRevision: number
    releases: ReadonlyArray<PublicKilnRelease>
    store: UpdateDialogViewStore
    targets: Array<UpdateTarget>
  },
  next: {
    changelogRevision: number
    releases: ReadonlyArray<PublicKilnRelease>
    store: UpdateDialogViewStore
    targets: Array<UpdateTarget>
  }
): boolean {
  if (
    previous.changelogRevision !== next.changelogRevision ||
    previous.releases !== next.releases ||
    previous.store !== next.store
  ) {
    return false
  }
  const selectedKey = next.store.getTargetSnapshot()
  return (
    findSelectedTarget(previous.targets, selectedKey)?.currentVersion ===
    findSelectedTarget(next.targets, selectedKey)?.currentVersion
  )
}

function areChangelogSelectionHeaderPropsEqual(
  previous: {
    changelogRevision: number
    latestVersion: string
    overview: UpdateOverview
    store: UpdateDialogViewStore
    targets: Array<UpdateTarget>
  },
  next: {
    changelogRevision: number
    latestVersion: string
    overview: UpdateOverview
    store: UpdateDialogViewStore
    targets: Array<UpdateTarget>
  }
): boolean {
  if (
    previous.changelogRevision !== next.changelogRevision ||
    previous.latestVersion !== next.latestVersion ||
    previous.overview.releases !== next.overview.releases ||
    previous.store !== next.store
  ) {
    return false
  }
  const selectedKey = next.store.getTargetSnapshot()
  const previousTarget = findSelectedTarget(previous.targets, selectedKey)
  const nextTarget = findSelectedTarget(next.targets, selectedKey)
  return (
    previousTarget?.currentVersion === nextTarget?.currentVersion &&
    previousTarget?.name === nextTarget?.name
  )
}

function areUpdateTargetsEqual(
  previous: UpdateTarget,
  next: UpdateTarget
): boolean {
  return (
    previous.component === next.component &&
    previous.currentVersion === next.currentVersion &&
    previous.eligible === next.eligible &&
    previous.key === next.key &&
    previous.name === next.name &&
    previous.reason === next.reason &&
    previous.relayId === next.relayId
  )
}

function isTargetUpdating(
  active: ReadonlyArray<ActiveUpdate>,
  target: UpdateTarget
): boolean {
  return active.some(
    (item) =>
      item.component === target.component &&
      (target.component === "hearth" || item.relayId === target.relayId)
  )
}

function targetHasUpdate(
  target: UpdateTarget,
  releases: ReadonlyArray<PublicKilnRelease>
): boolean {
  const comparison = compareLatestReleaseVersion(
    target.currentVersion,
    releases
  )
  return target.eligible && (target.currentVersion === null || comparison === 1)
}

function changelogReleases(
  releases: ReadonlyArray<PublicKilnRelease>,
  fromVersion: string | null
): Array<PublicKilnRelease> {
  if (!isKilnReleaseVersion(fromVersion)) return releases.slice(0, 1)
  const currentRelease = findKilnRelease(releases, fromVersion)
  const currentReleaseIndex = currentRelease
    ? releases.indexOf(currentRelease)
    : -1
  if (currentReleaseIndex >= 0) {
    return releases.slice(0, currentReleaseIndex + 1)
  }
  const publishedAtByVersion = releaseDates(releases)
  const relevantReleases = releases.filter(
    (release) =>
      compareReleaseVersions(
        release.version,
        fromVersion,
        publishedAtByVersion
      ) >= 0
  )
  return relevantReleases.length > 0 ? relevantReleases : releases.slice(0, 1)
}

function releaseDates(
  releases: ReadonlyArray<PublicKilnRelease>
): ReadonlyMap<string, string | null> {
  return new Map(
    releases.map((release) => [release.version, release.publishedAt])
  )
}

function targetStatus(
  target: UpdateTarget,
  comparison: -1 | 0 | 1 | null,
  updating: boolean
): UpdateTargetStatus {
  if (updating) {
    return {
      label: "Updating...",
      tone: "border-sky-300/35 bg-sky-300/10 text-sky-200",
    }
  }
  if (comparison === 0) {
    return {
      label: "Latest",
      tone: "border-emerald-300/35 bg-emerald-300/10 text-emerald-200",
    }
  }
  if (comparison === -1) {
    return {
      label: "Ahead",
      tone: "border-sky-300/25 bg-sky-300/[0.07] text-sky-200",
    }
  }
  if (!target.eligible) {
    return {
      label: "Managed elsewhere",
      tone: "border-border bg-muted/35 text-muted-foreground",
    }
  }
  if (target.currentVersion === null) {
    return {
      label: "Unknown",
      tone: "border-amber-300/25 bg-amber-300/[0.07] text-amber-200",
    }
  }
  if (comparison === null) {
    return {
      label: "Custom",
      tone: "border-sky-300/25 bg-sky-300/[0.07] text-sky-200",
    }
  }
  if (comparison === 1) {
    return {
      label: "Outdated",
      tone: "border-amber-300/35 bg-amber-300/10 text-amber-200",
    }
  }
  return {
    label: "Custom",
    tone: "border-sky-300/25 bg-sky-300/[0.07] text-sky-200",
  }
}

function parseActiveUpdates(value: unknown): Array<ActiveUpdate> {
  const values = Array.isArray(value) ? value : [value]
  const active: Array<ActiveUpdate> = []

  for (const item of values) {
    const parsed = parseActiveUpdate(item)
    if (parsed) active.push(parsed)
  }

  return active
}

function parseActiveUpdate(value: unknown): ActiveUpdate | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "component" in value &&
    (value.component === "hearth" || value.component === "relay") &&
    "operationId" in value &&
    typeof value.operationId === "string" &&
    "relayId" in value &&
    typeof value.relayId === "string"
  ) {
    const component = value.component
    const relayId = value.relayId
    return {
      component,
      name:
        "name" in value && typeof value.name === "string"
          ? value.name
          : displayComponent(component),
      operationId: value.operationId,
      phase:
        "phase" in value && typeof value.phase === "string"
          ? value.phase
          : undefined,
      previousVersion:
        "previousVersion" in value &&
        (typeof value.previousVersion === "string" ||
          value.previousVersion === null)
          ? value.previousVersion
          : null,
      relayId,
      targetVersion:
        "targetVersion" in value &&
        (typeof value.targetVersion === "string" ||
          value.targetVersion === null)
          ? value.targetVersion
          : null,
      targetKey:
        "targetKey" in value && typeof value.targetKey === "string"
          ? value.targetKey
          : component === "hearth"
            ? "hearth"
            : relayTargetKey(relayId),
      versionName:
        "versionName" in value && typeof value.versionName === "string"
          ? value.versionName
          : undefined,
    }
  }
  return null
}

function storeActiveUpdates(active: ReadonlyArray<ActiveUpdate>): void {
  if (active.length === 0) {
    window.localStorage.removeItem(activeSystemUpdateStorageKey)
    return
  }
  window.localStorage.setItem(
    activeSystemUpdateStorageKey,
    JSON.stringify(active)
  )
}

type ChangelogRange = {
  fromVersion: string | null
  toVersion: string
}

function changelogSelection(
  target: UpdateTarget,
  latestVersion: string | null,
  releases: ReadonlyArray<PublicKilnRelease>
): {
  alreadyLatest: boolean
  fromVersion: string | null
  updated: boolean
} {
  const canonicalCurrentVersion =
    findKilnRelease(releases, target.currentVersion)?.version ??
    target.currentVersion
  const ranges = readStorageRecord<ChangelogRange>(changelogRangeStorageKey)
  const range = ranges[target.key]
  const canonicalRangeVersion =
    findKilnRelease(releases, range?.toVersion ?? null)?.version ??
    range?.toVersion
  const recentRange =
    canonicalRangeVersion === canonicalCurrentVersion &&
    canonicalCurrentVersion === latestVersion
      ? range
      : null
  return {
    alreadyLatest:
      canonicalCurrentVersion === latestVersion && recentRange === null,
    fromVersion: recentRange?.fromVersion ?? canonicalCurrentVersion,
    updated: recentRange !== null,
  }
}

function storeChangelogRange(
  targetKey: string,
  fromVersion: string | null,
  toVersion: string
): void {
  const ranges = readStorageRecord<ChangelogRange>(changelogRangeStorageKey)
  ranges[targetKey] = { fromVersion, toVersion }
  window.localStorage.setItem(changelogRangeStorageKey, JSON.stringify(ranges))
}

function incrementUpdateFailureCount(targetKey: string): number {
  const failures = readStorageRecord<number>(updateFailureStorageKey)
  const previousCount = failures[targetKey]
  const count =
    (typeof previousCount === "number" && Number.isFinite(previousCount)
      ? previousCount
      : 0) + 1
  failures[targetKey] = count
  window.localStorage.setItem(updateFailureStorageKey, JSON.stringify(failures))
  return count
}

function resetUpdateFailureCount(targetKey: string): void {
  const failures = readStorageRecord<number>(updateFailureStorageKey)
  if (!(targetKey in failures)) return
  delete failures[targetKey]
  if (Object.keys(failures).length === 0) {
    window.localStorage.removeItem(updateFailureStorageKey)
    return
  }
  window.localStorage.setItem(updateFailureStorageKey, JSON.stringify(failures))
}

function readStorageRecord<Value>(key: string): Record<string, Value> {
  return Result.getOrElse(
    Result.try(() => {
      const stored = window.localStorage.getItem(key)
      if (!stored) return {}
      const parsed: unknown = JSON.parse(stored)
      return typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, Value>)
        : {}
    }),
    () => ({})
  )
}

function displayVersion(version: string | null): string {
  return version ? `v${version}` : "Version unavailable"
}

function displayComponent(component: "hearth" | "relay"): string {
  return component === "hearth" ? "Panel" : "Relay"
}

function relayTargetKey(relayId: string): string {
  return `relay:${relayId}`
}

function formatReleaseDate(publishedAt: string | null): string {
  if (!publishedAt) return "Recently published"
  const date = new Date(publishedAt)
  return Number.isFinite(date.getTime())
    ? releaseDateFormatter.format(date)
    : "Recently published"
}

function githubReleaseUrl(gitRepository: string, version: string): string {
  return `${gitRepository}/releases/tag/${encodeURIComponent(`v${version}`)}`
}

function markdownTextLines(
  notes: string | null
): Array<{ id: string; text: string }> {
  if (!notes?.trim()) {
    return [{ id: "no-changes", text: "No changes were specified." }]
  }

  const lines = notes
    .replaceAll("\r", "")
    .split("\n")
    .map((line) =>
      line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/u, "").trim()
    )
    .filter(
      (line) =>
        line.length > 0 &&
        !/^(```|~~~)/u.test(line) &&
        !/^[-*_]{3,}$/u.test(line) &&
        !isReleaseNoteBoilerplate(line)
    )
  const occurrences = new Map<string, number>()

  return lines.map((text) => {
    const occurrence = (occurrences.get(text) ?? 0) + 1
    occurrences.set(text, occurrence)
    return { id: `${text}:${occurrence}`, text }
  })
}

function isReleaseNoteBoilerplate(line: string): boolean {
  const plainLine = stripInlineMarkdown(line).trim()
  return (
    /^what(?:'|’)?s changed:?$/iu.test(plainLine) ||
    /^full changelog\s*:/iu.test(plainLine)
  )
}

function linkedMarkdownText(text: string): React.ReactNode {
  const linkPattern =
    /!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<]+)|(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/gu
  const content: Array<React.ReactNode> = []
  let cursor = 0

  for (const match of text.matchAll(linkPattern)) {
    const index = match.index
    const markdownLabel = match[1]
    const markdownUrl = match[2]
    const bareUrl = match[3]
    const githubUsername = match[4]
    if (index > cursor) {
      content.push(stripInlineMarkdown(text.slice(cursor, index)))
    }

    if (githubUsername) {
      content.push(
        <a
          className="text-primary underline decoration-primary/35 underline-offset-2 transition-colors hover:decoration-primary"
          href={`https://github.com/${githubUsername}`}
          key={`${index}:github:${githubUsername}`}
          rel="noreferrer"
          target="_blank"
        >
          @{githubUsername}
        </a>
      )
      cursor = index + match[0].length
      continue
    }

    const rawUrl = markdownUrl ?? bareUrl
    if (!rawUrl) continue
    const url = bareUrl ? trimBareUrl(rawUrl) : rawUrl
    const label =
      githubPullRequestLabel(url) ??
      (markdownLabel ? stripInlineMarkdown(markdownLabel) : url)
    content.push(
      <a
        className="text-primary underline decoration-primary/35 underline-offset-2 transition-colors hover:decoration-primary"
        href={url}
        key={`${index}:${url}`}
        rel="noreferrer"
        target="_blank"
      >
        {label}
      </a>
    )
    cursor =
      index + match[0].length - (bareUrl ? rawUrl.length - url.length : 0)
  }

  if (cursor < text.length) {
    content.push(stripInlineMarkdown(text.slice(cursor)))
  }
  return content.length > 0 ? content : stripInlineMarkdown(text)
}

function githubPullRequestLabel(url: string): string | null {
  const match = url.match(
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\/?$/u
  )
  return match?.[1] ? `#${match[1]}` : null
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<\/?[^>]+>/gu, "")
    .replace(/[*_~`]+/gu, "")
}

function trimBareUrl(url: string): string {
  return url.replace(/[),.;:!?]+$/u, "")
}
