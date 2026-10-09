import * as React from "react"
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual"
import { Effect, Result } from "effect"
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  CloudDownload,
  ExternalLink,
  LoaderCircle,
  RadioTower,
  RefreshCw,
  ScrollText,
  Search,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@workspace/ui/components/hover-card"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import type { PublicKilnRelease } from "@/effect/github-releases"
import { useKilnGitRepository } from "@/lib/git-repository"
import {
  changelogTimeline,
  type ChangelogMarker,
  type ChangelogTimelineItem,
} from "@/lib/changelog-timeline"
import { flattenCursorPages } from "@/lib/cursor-page"
import {
  queryKeys,
  releaseHistoryInfiniteQueryOptions,
  updateOverviewQueryOptions,
} from "@/lib/query-options"
import { replaceRelayUpdateVersion } from "@/lib/system-update-cache"
import {
  compareLatestReleaseVersion,
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
import {
  systemUpdateProgress,
  systemUpdateSteps,
} from "@/lib/system-update-progress"
import type { ReleaseChangeGroup } from "@/lib/release-notes"
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
  reachable: boolean
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

type UpdateDialogViewStore = ReturnType<typeof createUpdateDialogViewStore>

const updateFailureStorageKey = "kiln.system-update-failures"
const systemUpdateToastId = "system-update"
const minimumUpdateCheckDuration = 750
const completedUpdateDisplayDuration = 1_500
const mockRelayPhaseDuration = 325
const mockHearthPhaseDuration = 850
const mockHearthDialogDelay = 1_800
const shortReleaseDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
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
    viewStoreRef.current = createUpdateDialogViewStore()
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
  }, [requestId, viewStore])

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
      for (const target of update.targets) {
        activityStore.setTargetFailure(target.key, null)
      }
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
        activityStore.setTargetFailure(failure.target.key, failure.message)
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
        const message = `${completed.name}'s saved update operation could not be found. Check the target container before trying again.`
        activityStore.setTargetFailure(completed.targetKey, message)
        batch.current = recordSystemUpdateFailure(batch.current, {
          message,
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
        const message =
          operation.error ??
          "The update failed. The previous container was restored."
        activityStore.setTargetFailure(completed.targetKey, message)
        batch.current = recordSystemUpdateFailure(batch.current, {
          message,
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
      activityStore.setTargetFailure(completed.targetKey, null)
      const completedVersion = completed.targetVersion ?? operation.version
      // Hearth records the version it replaced on its next check; the
      // changelog marks it right away.
      if (completed.previousVersion) {
        const { previousVersion, targetKey } = completed
        queryClient.setQueryData<UpdateOverview>(
          queryKeys.updates,
          (overview) =>
            overview
              ? {
                  ...overview,
                  previousVersions: {
                    ...overview.previousVersions,
                    [targetKey]: previousVersion,
                  },
                }
              : overview
        )
      }
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
      latestVersionName: string,
      failRelays: boolean
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
        activityStore.setTargetFailure(update.targetKey, null)
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
        if (failRelays && update.component === "relay") {
          const failedPhases = phases.slice(
            0,
            phases.indexOf("replace.waitUntilHealthy") + 1
          )
          failedPhases.forEach((phase, index) => {
            mockTimers.current.push(
              window.setTimeout(
                () => activityStore.setPhase(update.operationId, phase),
                phaseDuration * (index + 1)
              )
            )
          })
          mockTimers.current.push(
            window.setTimeout(
              () => {
                activityStore.setTargetFailure(
                  update.targetKey,
                  "Health check timed out. The previous container was restored."
                )
                mockActiveRef.current = mockActiveRef.current.filter(
                  (activeUpdate) =>
                    activeUpdate.operationId !== update.operationId
                )
                publishDisplayedActive()
              },
              phaseDuration * (failedPhases.length + 3)
            )
          )
          continue
        }
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
            activityStore.setHearthReloadRequired(true)
            setHearthCompletion({
              version: latestVersion,
              versionName: latestVersionName,
            })
          } else if (failRelays) {
            dismissToast(systemUpdateToastId)
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

  const confirmationError =
    updateMutation.error instanceof Error ? updateMutation.error.message : null
  const confirmation = React.useMemo<UpdateConfirmationState>(
    () => ({
      error: confirmationError,
      starting: updateMutation.isPending,
      update: pending,
    }),
    [confirmationError, pending, updateMutation.isPending]
  )
  const mutateUpdate = updateMutation.mutate
  const resetUpdate = updateMutation.reset
  const pendingRef = React.useRef(pending)
  React.useEffect(() => {
    pendingRef.current = pending
  }, [pending])
  const confirmPendingUpdate = React.useCallback(() => {
    const update = pendingRef.current
    if (
      update &&
      canStartSystemUpdate({
        hearthReloadRequired: activityStore.getHearthReloadRequiredSnapshot(),
        mutationPending: updateMutationPendingRef.current,
      })
    ) {
      setPending(null)
      mutateUpdate(update)
    }
  }, [activityStore, mutateUpdate])
  const cancelPendingUpdate = React.useCallback(() => {
    if (updateMutationPendingRef.current) return
    resetUpdate()
    setPending(null)
  }, [resetUpdate])

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
        confirmation={confirmation}
        focusedRelayId={initialRelayId}
        open={open}
        store={viewStore}
        onCancelUpdate={cancelPendingUpdate}
        onConfirmUpdate={confirmPendingUpdate}
        onMockUpdate={handleMockUpdate}
        onOpenChange={onOpenChange}
        onUpdate={handleUpdate}
      />
      <Dialog
        open={hearthCompletion !== null && !open}
        onOpenChange={() => undefined}
      >
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

type UpdateConfirmationState = {
  error: string | null
  starting: boolean
  update: PendingUpdate | null
}

type MockUpdateHandler = (
  targets: ReadonlyArray<UpdateTarget>,
  latestVersion: string,
  latestVersionName: string,
  failRelays: boolean
) => void

type UpdateHandler = (
  targets: ReadonlyArray<UpdateTarget>,
  latestVersion: string,
  latestVersionName?: string
) => void

const UpdaterDialog = React.memo(function UpdaterDialog({
  activityStore,
  confirmation,
  focusedRelayId,
  open,
  store,
  onCancelUpdate,
  onConfirmUpdate,
  onMockUpdate,
  onOpenChange,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  confirmation: UpdateConfirmationState
  focusedRelayId: string | null
  open: boolean
  store: UpdateDialogViewStore
  onCancelUpdate: () => void
  onConfirmUpdate: () => void
  onMockUpdate: MockUpdateHandler
  onOpenChange: (open: boolean) => void
  onUpdate: UpdateHandler
}) {
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        initialFocus={closeButtonRef}
        className="h-[min(40rem,calc(100dvh-2rem))] max-h-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-3xl"
        showCloseButton={false}
      >
        <UpdateDialogData
          activityStore={activityStore}
          closeButtonRef={closeButtonRef}
          confirmation={confirmation}
          focusedRelayId={focusedRelayId}
          open={open}
          store={store}
          onCancelUpdate={onCancelUpdate}
          onConfirmUpdate={onConfirmUpdate}
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
  closeButtonRef,
  confirmation,
  focusedRelayId,
  open,
  store,
  onCancelUpdate,
  onConfirmUpdate,
  onMockUpdate,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  closeButtonRef: React.RefObject<HTMLButtonElement | null>
  confirmation: UpdateConfirmationState
  focusedRelayId: string | null
  open: boolean
  store: UpdateDialogViewStore
  onCancelUpdate: () => void
  onConfirmUpdate: () => void
  onMockUpdate: MockUpdateHandler
  onUpdate: UpdateHandler
}) {
  const busy = React.useSyncExternalStore(
    activityStore.subscribeActivities,
    activityStore.getBusySnapshot,
    activityStore.getBusySnapshot
  )
  const overviewQuery = useQuery({
    ...updateOverviewQueryOptions(),
    enabled: () => open && !busy && canRefetchSystemUpdateOverview(),
    notifyOnChangeProps: ["data", "error", "isError", "isPending"],
  })
  const overview = React.useMemo(
    () =>
      import.meta.env.DEV
        ? withDevMockRelays(overviewQuery.data)
        : overviewQuery.data,
    [overviewQuery.data]
  )
  const targets = React.useMemo(
    () => (overview ? updateTargets(overview) : []),
    [overview]
  )
  const releases = overview?.releases ?? noReleases

  return (
    <>
      <UpdaterHeader
        activityStore={activityStore}
        closeButtonRef={closeButtonRef}
        open={open}
        store={store}
      />
      <UpdateDialogBody
        activityStore={activityStore}
        errorMessage={
          overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : "Update information is unavailable."
        }
        failed={overviewQuery.isError && overview === undefined && !busy}
        focusedRelayId={focusedRelayId}
        overview={overview}
        pending={overviewQuery.isPending && !busy}
        store={store}
        targets={targets}
        onRetry={overviewQuery.refetch}
        onUpdate={onUpdate}
      />
      <UpdaterFooter
        activityStore={activityStore}
        checkFailed={overviewQuery.isError && overview !== undefined}
        confirmation={confirmation}
        open={open}
        releases={releases}
        targets={targets}
        onCancelUpdate={onCancelUpdate}
        onConfirmUpdate={onConfirmUpdate}
        onMockUpdate={onMockUpdate}
        onRetryCheck={overviewQuery.refetch}
        onUpdate={onUpdate}
      />
    </>
  )
})

const noReleases: ReadonlyArray<PublicKilnRelease> = []

const UpdaterHeader = React.memo(function UpdaterHeader({
  activityStore,
  closeButtonRef,
  open,
  store,
}: {
  activityStore: SystemUpdateActivityStore
  closeButtonRef: React.RefObject<HTMLButtonElement | null>
  open: boolean
  store: UpdateDialogViewStore
}) {
  return (
    <div className="flex h-14 items-center justify-between gap-3 border-b pr-3 pl-5">
      <DialogTitle className="flex items-center gap-2.5 text-lg">
        <CloudDownload className="size-4 text-primary" />
        Kiln Updater
      </DialogTitle>
      <div className="flex shrink-0 items-center gap-0.5">
        <UpdaterChangelogButton store={store} />
        <UpdaterCheckButton activityStore={activityStore} open={open} />
        <DialogClose
          render={
            <Button
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground"
              ref={closeButtonRef}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <X />
        </DialogClose>
      </div>
    </div>
  )
})

const UpdaterChangelogButton = React.memo(function UpdaterChangelogButton({
  store,
}: {
  store: UpdateDialogViewStore
}) {
  const queryClient = useQueryClient()
  const view = React.useSyncExternalStore(
    store.subscribeView,
    store.getViewSnapshot,
    store.getViewSnapshot
  )
  const active = view === "changelog"
  const prefetch = () =>
    void queryClient.prefetchInfiniteQuery(releaseHistoryInfiniteQueryOptions())

  return (
    <Button
      aria-pressed={active}
      className={`mr-1.5 shadow-none ${
        active
          ? "border-primary/45 bg-primary/10 text-foreground hover:bg-primary/15"
          : "bg-card"
      }`}
      size="sm"
      type="button"
      variant="outline"
      onClick={() =>
        active ? store.showOverview() : store.openChangelog(null)
      }
      onFocus={prefetch}
      onPointerEnter={prefetch}
    >
      <ScrollText />
      Changelog
    </Button>
  )
})

const UpdaterCheckButton = React.memo(function UpdaterCheckButton({
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
    notifyOnChangeProps: ["isFetching"],
  })
  const checking = useMinimumDuration(
    overviewQuery.isFetching,
    minimumUpdateCheckDuration
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-busy={checking}
          aria-label={checking ? "Checking for updates" : "Check for updates"}
          className="text-muted-foreground hover:text-foreground"
          disabled={checking || updating}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={() => void overviewQuery.refetch()}
        >
          <RefreshCw className={checking ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Check for updates</TooltipContent>
    </Tooltip>
  )
})

function useMinimumDuration(active: boolean, minimumDuration: number) {
  const [visible, setVisible] = React.useState(active)
  const startedAtRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (active) {
      if (startedAtRef.current === null) {
        startedAtRef.current = performance.now()
      }
      setVisible(true)
      return
    }
    const startedAt = startedAtRef.current
    if (startedAt === null) {
      setVisible(false)
      return
    }
    const timeoutId = window.setTimeout(
      () => {
        startedAtRef.current = null
        setVisible(false)
      },
      Math.max(0, minimumDuration - (performance.now() - startedAt))
    )
    return () => window.clearTimeout(timeoutId)
  }, [active, minimumDuration])

  return visible
}

const UpdateDialogBody = React.memo(function UpdateDialogBody({
  activityStore,
  errorMessage,
  failed,
  focusedRelayId,
  overview,
  pending,
  store,
  targets,
  onRetry,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  errorMessage: string
  failed: boolean
  focusedRelayId: string | null
  overview: UpdateOverview | undefined
  pending: boolean
  store: UpdateDialogViewStore
  targets: Array<UpdateTarget>
  onRetry: () => void
  onUpdate: UpdateHandler
}) {
  const view = React.useSyncExternalStore(
    store.subscribeView,
    store.getViewSnapshot,
    store.getViewSnapshot
  )

  if (pending) {
    return (
      <div className="min-h-0 overflow-hidden">
        <UpdateListSkeleton />
      </div>
    )
  }
  if (failed) {
    return (
      <div className="min-h-0 overflow-y-auto">
        <UpdateDialogError message={errorMessage} onRetry={onRetry} />
      </div>
    )
  }
  if (!overview) {
    return (
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        <ActiveUpdatesFallback activityStore={activityStore} />
      </div>
    )
  }

  const overviewVisible = view === "overview"
  return (
    <div className="relative min-h-0">
      <div
        aria-hidden={!overviewVisible}
        className={`absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain ${
          overviewVisible ? "" : "invisible"
        }`}
        inert={!overviewVisible}
      >
        <UpdateTargetList
          activityStore={activityStore}
          focusedRelayId={focusedRelayId}
          releases={overview.releases}
          targets={targets}
          onChangelog={store.openChangelog}
          onUpdate={onUpdate}
        />
      </div>
      {overviewVisible ? null : (
        <UpdateChangelogPage
          overview={overview}
          store={store}
          targets={targets}
        />
      )}
    </div>
  )
})

const UpdateTargetList = React.memo(function UpdateTargetList({
  activityStore,
  focusedRelayId,
  releases,
  targets,
  onChangelog,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  focusedRelayId: string | null
  releases: ReadonlyArray<PublicKilnRelease>
  targets: Array<UpdateTarget>
  onChangelog: (targetKey: string) => void
  onUpdate: UpdateHandler
}) {
  const latestRelease = releases[0] ?? null
  if (!latestRelease) {
    return (
      <p className="type-support px-5 py-6 text-muted-foreground">
        No public Kiln releases are available yet.
      </p>
    )
  }
  const hearthTarget = targets.find((target) => target.component === "hearth")
  const relayTargets = targets.filter((target) => target.component === "relay")

  return (
    <div className="pb-2">
      {hearthTarget ? (
        <>
          <UpdateSectionLabel>Hearth</UpdateSectionLabel>
          <UpdateTargetRow
            activityStore={activityStore}
            focused={false}
            latestVersion={latestRelease.version}
            releases={releases}
            target={hearthTarget}
            onChangelog={onChangelog}
            onUpdate={onUpdate}
          />
        </>
      ) : null}
      <UpdateSectionLabel>Relays</UpdateSectionLabel>
      {relayTargets.length > 0 ? (
        relayTargets.map((target) => (
          <UpdateTargetRow
            activityStore={activityStore}
            focused={target.relayId === focusedRelayId}
            key={target.key}
            latestVersion={latestRelease.version}
            releases={releases}
            target={target}
            onChangelog={onChangelog}
            onUpdate={onUpdate}
          />
        ))
      ) : (
        <p className="type-support border-t border-border/60 px-5 py-5 text-muted-foreground">
          No Relays are paired with this Panel.
        </p>
      )}
      <div className="border-t border-border/60" />
    </div>
  )
})

function UpdateSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="type-technical-label flex h-8 items-end px-5 pb-1.5 text-[0.6875rem] text-muted-foreground">
      {children}
    </p>
  )
}

type UpdateTargetRowProps = {
  activityStore: SystemUpdateActivityStore
  focused: boolean
  latestVersion: string
  releases: ReadonlyArray<PublicKilnRelease>
  target: UpdateTarget
  onChangelog: (targetKey: string) => void
  onUpdate: UpdateHandler
}

// Every state of a row (idle, updating, done, failed, unavailable) renders
// into the same fixed lines so nothing around it moves.
const updateRowClassName =
  "relative grid h-[3.875rem] grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border/60 pr-4 pl-5"

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

  React.useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "nearest" })
  }, [focused])

  return (
    <div
      ref={rowRef}
      className={`${updateRowClassName} ${
        focused
          ? "bg-accent/35 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
          : ""
      }`}
    >
      <UpdateTargetIcon target={target} />
      <div className="min-w-0">
        <div className="flex h-5 min-w-0 items-center gap-2">
          <h3 className="type-card-title min-w-0 shrink truncate">
            {target.name}
          </h3>
          <UpdateTargetVersion
            activityStore={activityStore}
            latestVersion={latestVersion}
            releases={releases}
            target={target}
          />
        </div>
        <div
          aria-live="polite"
          className="mt-[3px] flex h-[1.125rem] min-w-0 items-center gap-2"
        >
          <UpdateTargetStatus
            activityStore={activityStore}
            releases={releases}
            target={target}
          />
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          className="text-muted-foreground"
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => onChangelog(target.key)}
        >
          <ScrollText />
          Changes
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

type TargetUpdateState = "done" | "failed" | "idle" | "running"

function useTargetUpdateState(
  activityStore: SystemUpdateActivityStore,
  targetKey: string
): TargetUpdateState {
  const subscribe = React.useCallback(
    (listener: () => void) => {
      let unsubscribePhase = () => {}
      const subscribePhase = () => {
        unsubscribePhase()
        const activity = activityStore.getTargetActivitySnapshot(targetKey)
        unsubscribePhase = activity
          ? activityStore.subscribePhase(activity.operationId, listener)
          : () => {}
      }
      subscribePhase()
      const unsubscribeActivity = activityStore.subscribeTargetActivity(
        targetKey,
        () => {
          subscribePhase()
          listener()
        }
      )
      const unsubscribeFailure = activityStore.subscribeTargetFailure(
        targetKey,
        listener
      )
      return () => {
        unsubscribeActivity()
        unsubscribeFailure()
        unsubscribePhase()
      }
    },
    [activityStore, targetKey]
  )
  const getSnapshot = React.useCallback((): TargetUpdateState => {
    const activity = activityStore.getTargetActivitySnapshot(targetKey)
    if (activity) {
      const progress = systemUpdateProgress(
        activityStore.getPhaseSnapshot(activity.operationId) ?? activity.phase,
        false
      )
      return progress.step >= systemUpdateSteps.length ? "done" : "running"
    }
    return activityStore.getTargetFailureSnapshot(targetKey) ? "failed" : "idle"
  }, [activityStore, targetKey])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

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

function useTargetFailure(
  activityStore: SystemUpdateActivityStore,
  targetKey: string
) {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      activityStore.subscribeTargetFailure(targetKey, listener),
    [activityStore, targetKey]
  )
  const getSnapshot = React.useCallback(
    () => activityStore.getTargetFailureSnapshot(targetKey),
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

function UpdateTargetIcon({ target }: { target: UpdateTarget }) {
  const Icon = target.component === "hearth" ? ServerCog : RadioTower
  return (
    <span
      className={`grid size-8 shrink-0 place-items-center border ${
        target.component === "hearth"
          ? "border-primary/25 bg-primary/[0.07] text-primary"
          : "bg-background/55 text-muted-foreground"
      }`}
    >
      <Icon className="size-4" />
    </span>
  )
}

const UpdateTargetVersion = React.memo(function UpdateTargetVersion({
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
  const state = useTargetUpdateState(activityStore, target.key)
  const latest = releaseVersionLabel(releases, latestVersion)
  if (state === "done") {
    return (
      <span className="type-meta truncate font-mono text-foreground">
        {latest}
      </span>
    )
  }
  const current = releaseVersionLabel(releases, target.currentVersion)
  if (current === null) return null
  const showTarget =
    (state === "running" || targetHasUpdate(target, releases)) &&
    target.currentVersion !== latestVersion
  return (
    <span className="type-meta flex min-w-0 items-center gap-1.5 font-mono whitespace-nowrap text-muted-foreground">
      <span className={`truncate ${showTarget ? "" : "text-foreground"}`}>
        {current}
      </span>
      {showTarget ? (
        <>
          <ArrowRight aria-label="to" className="size-3 shrink-0" />
          <span className="truncate text-foreground">{latest}</span>
        </>
      ) : null}
    </span>
  )
})

type StatusTone = "failed" | "info" | "muted" | "warning"

const statusToneClassName: Readonly<Record<StatusTone, string>> = {
  failed: "text-red-300",
  info: "text-sky-200",
  muted: "text-muted-foreground",
  warning: "text-amber-200",
}

function StatusText({
  children,
  tone,
}: {
  children: string
  tone: StatusTone
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`type-meta min-w-0 truncate ${statusToneClassName[tone]}`}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{children}</TooltipContent>
    </Tooltip>
  )
}

const UpdateTargetStatus = React.memo(function UpdateTargetStatus({
  activityStore,
  releases,
  target,
}: {
  activityStore: SystemUpdateActivityStore
  releases: ReadonlyArray<PublicKilnRelease>
  target: UpdateTarget
}) {
  const activity = useTargetActivity(activityStore, target.key)
  const failure = useTargetFailure(activityStore, target.key)

  if (activity) {
    return (
      <UpdateTargetProgress
        activityStore={activityStore}
        initialPhase={activity.phase}
        operationId={activity.operationId}
      />
    )
  }
  if (failure) return <StatusText tone="failed">{failure}</StatusText>
  const status = targetStatus(target, releases)
  return <StatusText tone={status.tone}>{status.text}</StatusText>
})

const UpdateTargetProgress = React.memo(function UpdateTargetProgress({
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
  const progress = systemUpdateProgress(phase, false)

  if (progress.step >= systemUpdateSteps.length) {
    return (
      <StatusText tone="muted">
        {phase === "awaitingReload" ? "Waiting for reload" : "Up to date"}
      </StatusText>
    )
  }
  return (
    <>
      <span
        aria-label={`${progress.label}: ${progress.percent}%`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.percent}
        className="grid w-24 shrink-0 grid-cols-5 gap-0.5"
        role="progressbar"
      >
        {systemUpdateSteps.map((step, index) => (
          <span
            className={`h-1 ${
              index <= progress.step ? "bg-primary" : "bg-muted"
            }`}
            key={step}
          />
        ))}
      </span>
      <span className="type-meta min-w-0 truncate text-muted-foreground">
        {progress.label}
      </span>
    </>
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
  onUpdate: UpdateHandler
}) {
  const state = useTargetUpdateState(activityStore, target.key)
  const hearthReloadRequired = useHearthReloadRequired(activityStore)
  const latestName =
    findKilnRelease(releases, latestVersion)?.name ??
    friendlyVersionName(latestVersion)
  const update = () => onUpdate([target], latestVersion, latestName)
  const latest =
    compareLatestReleaseVersion(target.currentVersion, releases) === 0

  if (state === "running") {
    return (
      <Button
        className="w-24 border-primary/25 bg-primary/10 text-primary disabled:opacity-100"
        disabled
        size="sm"
        type="button"
      >
        <LoaderCircle className="animate-spin" />
        Updating
      </Button>
    )
  }
  if (state === "done") {
    return (
      <Button
        className="w-24 text-emerald-200 disabled:opacity-100"
        disabled
        size="sm"
        type="button"
        variant="ghost"
      >
        <Check />
        Updated
      </Button>
    )
  }
  if (
    state === "failed" ||
    targetHasUpdate(target, releases) ||
    (target.eligible && latest)
  ) {
    return (
      <Button
        className="w-24"
        disabled={hearthReloadRequired}
        size="sm"
        type="button"
        variant="outline"
        onClick={update}
      >
        {state === "failed"
          ? "Retry"
          : targetHasUpdate(target, releases)
            ? "Update"
            : "Reinstall"}
      </Button>
    )
  }
  return (
    <Button className="w-24" disabled size="sm" type="button" variant="ghost">
      {latest ? "Up to date" : "Unavailable"}
    </Button>
  )
})

const UpdaterFooter = React.memo(function UpdaterFooter({
  activityStore,
  checkFailed,
  confirmation,
  open,
  releases,
  targets,
  onCancelUpdate,
  onConfirmUpdate,
  onMockUpdate,
  onRetryCheck,
  onUpdate,
}: {
  activityStore: SystemUpdateActivityStore
  checkFailed: boolean
  confirmation: UpdateConfirmationState
  open: boolean
  releases: ReadonlyArray<PublicKilnRelease>
  targets: Array<UpdateTarget>
  onCancelUpdate: () => void
  onConfirmUpdate: () => void
  onMockUpdate: MockUpdateHandler
  onRetryCheck: () => void
  onUpdate: UpdateHandler
}) {
  const busy = React.useSyncExternalStore(
    activityStore.subscribeActivities,
    activityStore.getBusySnapshot,
    activityStore.getBusySnapshot
  )
  const hearthReloadRequired = useHearthReloadRequired(activityStore)
  const latestRelease = releases[0] ?? null
  const latestName = latestRelease
    ? compactReleaseName(latestRelease.name)
    : "the latest version"

  if (hearthReloadRequired) {
    return (
      <UpdaterFooterBar>
        <span className="truncate">
          Reload Kiln to start using {latestName}.
        </span>
        <Button type="button" onClick={() => window.location.reload()}>
          <RefreshCw />
          Reload now
        </Button>
      </UpdaterFooterBar>
    )
  }

  if (confirmation.update) {
    const { targets: pendingTargets } = confirmation.update
    const label =
      pendingTargets.length === 1
        ? (pendingTargets[0]?.name ?? "1 component")
        : `${pendingTargets.length} components`
    return (
      <UpdaterFooterBar tone="primary">
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-primary" />
          <span className="truncate">
            <span className="font-medium text-foreground">
              Update {label} to{" "}
              {compactReleaseName(confirmation.update.latestVersionName)}?
            </span>{" "}
            {confirmation.error ? (
              <span className="text-destructive">{confirmation.error}</span>
            ) : (
              "Game servers keep running."
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            disabled={confirmation.starting}
            type="button"
            variant="ghost"
            onClick={onCancelUpdate}
          >
            Cancel
          </Button>
          <Button
            autoFocus
            disabled={confirmation.starting}
            type="button"
            onClick={onConfirmUpdate}
          >
            {confirmation.starting ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <CloudDownload />
            )}
            Confirm
          </Button>
        </span>
      </UpdaterFooterBar>
    )
  }

  if (busy) {
    return (
      <UpdaterFooterBar>
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-primary" />
          <span className="truncate">
            Safe to close. Updates keep running in the background.
          </span>
        </span>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Close
        </DialogClose>
      </UpdaterFooterBar>
    )
  }

  const availableTargets = latestRelease
    ? targets.filter((target) => targetHasUpdate(target, releases))
    : []
  return (
    <UpdaterFooterBar tone={checkFailed ? "warning" : "default"}>
      {checkFailed ? (
        <span className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-amber-300" />
          <span className="truncate">
            <span className="text-amber-200">Couldn’t check for updates.</span>{" "}
            Showing earlier results.
          </span>
        </span>
      ) : (
        <LastCheckedLabel activityStore={activityStore} open={open} />
      )}
      <span className="flex shrink-0 items-center gap-1.5">
        {checkFailed ? (
          <Button type="button" variant="ghost" onClick={onRetryCheck}>
            <RefreshCw />
            Retry
          </Button>
        ) : null}
        {import.meta.env.DEV && latestRelease ? (
          <>
            <Button
              disabled={targets.length === 0}
              type="button"
              variant="ghost"
              onClick={() =>
                onMockUpdate(
                  targets,
                  latestRelease.version,
                  latestRelease.name,
                  false
                )
              }
            >
              Mock
            </Button>
            <Button
              disabled={targets.length === 0}
              type="button"
              variant="ghost"
              onClick={() =>
                onMockUpdate(
                  targets,
                  latestRelease.version,
                  latestRelease.name,
                  true
                )
              }
            >
              Mock failure
            </Button>
          </>
        ) : null}
        <Button
          disabled={availableTargets.length === 0}
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
          {availableTargets.length > 0
            ? `Update all (${availableTargets.length})`
            : "Update all"}
        </Button>
      </span>
    </UpdaterFooterBar>
  )
})

type FooterTone = "default" | "primary" | "warning"

const footerToneClassName: Readonly<Record<FooterTone, string>> = {
  default: "border-border bg-background/35",
  primary: "border-primary/30 bg-primary/[0.07]",
  warning: "border-amber-300/25 bg-amber-300/[0.05]",
}

function UpdaterFooterBar({
  children,
  tone = "default",
}: {
  children: React.ReactNode
  tone?: FooterTone
}) {
  return (
    <div
      className={`type-support flex h-13 items-center justify-between gap-3 border-t pr-3 pl-5 text-muted-foreground ${footerToneClassName[tone]}`}
    >
      {children}
    </div>
  )
}

const LastCheckedLabel = React.memo(function LastCheckedLabel({
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
    notifyOnChangeProps: ["dataUpdatedAt"],
  })
  return (
    <span className="truncate">
      {overviewQuery.dataUpdatedAt > 0
        ? `Checked ${lastCheckedFormatter.format(new Date(overviewQuery.dataUpdatedAt))}`
        : null}
    </span>
  )
})

// Rows have fixed heights so the virtualizer never measures, and nothing
// shifts while older releases load in below.
const changelogRowHeight: Readonly<
  Record<ChangelogTimelineItem["kind"], number>
> = {
  change: 30,
  day: 32,
  earlier: 44,
  quiet: 30,
  version: 44,
}
const changelogEndHeight = 64
// Pages to load on open looking for the oldest version a component runs.
const changelogMarkerPageLimit = 6

const changeGroupLabel: Readonly<Record<ReleaseChangeGroup, string>> = {
  fixed: "Fixed",
  improved: "Improved",
  new: "New",
  other: "Other",
}

const changeGroupClassName: Readonly<Record<ReleaseChangeGroup, string>> = {
  fixed: "text-amber-200/90",
  improved: "text-sky-200/90",
  new: "text-emerald-200/90",
  other: "text-muted-foreground",
}

const UpdateChangelogPage = React.memo(function UpdateChangelogPage({
  overview,
  store,
  targets,
}: {
  overview: UpdateOverview
  store: UpdateDialogViewStore
  targets: Array<UpdateTarget>
}) {
  const gitRepository = useKilnGitRepository()
  const historyQuery = useInfiniteQuery({
    ...releaseHistoryInfiniteQueryOptions(),
    notifyOnChangeProps: [
      "data",
      "hasNextPage",
      "isError",
      "isFetchingNextPage",
      "isPending",
    ],
  })
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    refetch,
  } = historyQuery
  const releases = React.useMemo(
    () =>
      flattenCursorPages(
        (data?.pages ?? []).map((page) => ({
          items: page.releases,
          nextCursor: page.nextCursor,
        })),
        (release) => release.tag
      ),
    [data]
  )
  const markers = React.useMemo(
    () =>
      changelogMarkers(targets, overview.previousVersions, overview.releases),
    [overview.previousVersions, overview.releases, targets]
  )
  const timeline = React.useMemo(
    () => changelogTimeline(releases, markers),
    [markers, releases]
  )
  const pageCount = data?.pages.length ?? 0

  // Keep loading while a component's version is older than what's loaded,
  // so its line shows without scrolling down to it first.
  React.useEffect(() => {
    if (
      timeline.missingMarkers > 0 &&
      hasNextPage &&
      !isFetchingNextPage &&
      // A failed page waits for Retry instead of being fetched again.
      !isError &&
      pageCount < changelogMarkerPageLimit
    ) {
      void fetchNextPage()
    }
  }, [
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    pageCount,
    timeline.missingMarkers,
  ])

  // A release the overview found that history doesn't have yet.
  const latestTag = overview.releases[0]?.tag
  const refreshedForTag = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (
      !latestTag ||
      releases.length === 0 ||
      refreshedForTag.current === latestTag ||
      releases.some((release) => release.tag === latestTag)
    ) {
      return
    }
    refreshedForTag.current = latestTag
    void refetch()
  }, [latestTag, refetch, releases])

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const { items } = timeline
  // The version line above the visible rows stays pinned to the top, so
  // it's clear which update the changes belong to.
  const headerIndexes = React.useMemo(
    () =>
      items.flatMap((item, index) =>
        item.kind === "version" || item.kind === "earlier" ? [index] : []
      ),
    [items]
  )
  const pinnedIndexRef = React.useRef(0)
  const rangeExtractor = React.useCallback(
    (range: Range) => {
      let pinned = 0
      for (const index of headerIndexes) {
        if (index > range.startIndex) break
        pinned = index
      }
      pinnedIndexRef.current = pinned
      return [...new Set([pinned, ...defaultRangeExtractor(range)])].sort(
        (left, right) => left - right
      )
    },
    [headerIndexes]
  )
  const virtualizer = useVirtualizer({
    count: items.length + 1,
    estimateSize: (index) => {
      const item = items[index]
      return item ? changelogRowHeight[item.kind] : changelogEndHeight
    },
    getItemKey: (index) => items[index]?.key ?? "end",
    getScrollElement: () => scrollRef.current,
    overscan: 12,
    rangeExtractor,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems.at(-1)?.index ?? 0

  React.useEffect(() => {
    if (
      lastVisibleIndex >= items.length - 20 &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isError
    ) {
      void fetchNextPage()
    }
  }, [
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    items.length,
    lastVisibleIndex,
  ])

  // Opened from a component's row: start at its version line.
  const jumpedRef = React.useRef(false)
  React.useLayoutEffect(() => {
    if (jumpedRef.current) return
    const jumpTarget = store.getJumpTarget()
    if (!jumpTarget) {
      jumpedRef.current = true
      return
    }
    const index = timeline.markerIndexes.get(`${jumpTarget}:current`)
    if (index === undefined) {
      if (!isPending && (!hasNextPage || pageCount >= changelogMarkerPageLimit))
        jumpedRef.current = true
      return
    }
    jumpedRef.current = true
    virtualizer.scrollToIndex(index, { align: "start" })
  }, [hasNextPage, isPending, pageCount, store, timeline, virtualizer])

  const jumpTo = React.useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "start" }),
    [virtualizer]
  )
  const jumpEntries = React.useMemo(
    () =>
      targets.map((target): ChangelogJumpEntry => {
        const marker = markers.find(
          (item) => item.key === `${target.key}:current`
        )
        const release = marker
          ? releases.find(
              (item) =>
                item.version === marker.version ||
                item.aliases.includes(marker.version)
            )
          : undefined
        return {
          component: target.component,
          index: timeline.markerIndexes.get(`${target.key}:current`),
          key: target.key,
          name: target.name,
          versionLabel: release ? compactReleaseName(release.name) : null,
        }
      }),
    [markers, releases, targets, timeline.markerIndexes]
  )

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-3 pl-3">
        <Button
          className="shrink-0 bg-card shadow-none"
          size="sm"
          type="button"
          variant="outline"
          onClick={store.showOverview}
        >
          <ChevronLeft />
          Back
        </Button>
        <h3 className="type-card-title ml-1 min-w-0 flex-1 truncate">
          Changelog
        </h3>
        <Button
          className="shrink-0 text-muted-foreground hover:text-foreground"
          disabled={items.length === 0}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => jumpTo(0)}
        >
          <span aria-hidden="true" className="size-2 bg-primary" />
          Latest
        </Button>
        {jumpEntries.length === 1 && jumpEntries[0] ? (
          <ChangelogJumpButton entry={jumpEntries[0]} onJump={jumpTo} />
        ) : jumpEntries.length > 1 ? (
          <ChangelogJumpMenu entries={jumpEntries} onJump={jumpTo} />
        ) : null}
        <Button
          asChild
          className="shrink-0 text-muted-foreground"
          size="sm"
          variant="ghost"
        >
          <a
            href={`${gitRepository}/releases`}
            rel="noreferrer"
            target="_blank"
          >
            GitHub
            <ExternalLink />
          </a>
        </Button>
      </div>
      <div
        ref={scrollRef}
        aria-busy={isPending}
        aria-label="Changelog"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
        role="feed"
      >
        {isPending ? (
          <ChangelogSkeleton />
        ) : (
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const item = items[virtualItem.index]
              const pinned =
                item !== undefined &&
                (item.kind === "version" || item.kind === "earlier") &&
                virtualItem.index === pinnedIndexRef.current
              return (
                <div
                  className={`inset-x-0 top-0 ${
                    pinned ? "sticky z-10" : "absolute"
                  } ${item?.kind === "version" || item?.kind === "earlier" ? "z-10" : ""}`}
                  data-index={virtualItem.index}
                  key={virtualItem.key}
                  style={{
                    height: `${virtualItem.size}px`,
                    ...(pinned
                      ? {}
                      : { transform: `translateY(${virtualItem.start}px)` }),
                  }}
                >
                  {item ? (
                    <ChangelogRow
                      first={virtualItem.index === 0}
                      gitRepository={gitRepository}
                      item={item}
                    />
                  ) : (
                    <ChangelogEnd
                      error={isError}
                      loading={hasNextPage || isFetchingNextPage}
                      onRetry={() => void fetchNextPage()}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
})

type ChangelogJumpEntry = {
  component: "hearth" | "relay"
  // The row of its version line, once that release is loaded.
  index: number | undefined
  key: string
  name: string
  versionLabel: string | null
}

const ChangelogJumpButton = React.memo(function ChangelogJumpButton({
  entry,
  onJump,
}: {
  entry: ChangelogJumpEntry
  onJump: (index: number) => void
}) {
  const { index } = entry
  return (
    <Button
      className="max-w-44 shrink-0 text-muted-foreground hover:text-foreground"
      disabled={index === undefined}
      size="sm"
      type="button"
      variant="ghost"
      onClick={() => {
        if (index !== undefined) onJump(index)
      }}
    >
      {entry.component === "hearth" ? <ServerCog /> : <RadioTower />}
      <span className="truncate">{entry.name}</span>
    </Button>
  )
})

const ChangelogJumpMenu = React.memo(function ChangelogJumpMenu({
  entries,
  onJump,
}: {
  entries: ReadonlyArray<ChangelogJumpEntry>
  onJump: (index: number) => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          className="shrink-0 bg-card shadow-none"
          size="sm"
          type="button"
          variant="outline"
        >
          Jump to
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <ChangelogJumpList
          entries={entries}
          onJump={(index) => {
            setOpen(false)
            onJump(index)
          }}
        />
      </PopoverContent>
    </Popover>
  )
})

function ChangelogJumpList({
  entries,
  onJump,
}: {
  entries: ReadonlyArray<ChangelogJumpEntry>
  onJump: (index: number) => void
}) {
  const listId = React.useId()
  const [search, setSearch] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const query = search.trim().toLocaleLowerCase()
  const visible = React.useMemo(
    () =>
      query
        ? entries.filter(
            (entry) =>
              entry.name.toLocaleLowerCase().includes(query) ||
              entry.versionLabel?.toLocaleLowerCase().includes(query)
          )
        : entries,
    [entries, query]
  )
  const active = visible[Math.min(activeIndex, visible.length - 1)]
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!active) return
    listRef.current
      ?.querySelector(`[data-key="${CSS.escape(active.key)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active])

  const choose = (entry: ChangelogJumpEntry | undefined) => {
    if (entry?.index !== undefined) onJump(entry.index)
  }

  return (
    <>
      <div className="border-b border-border/70 p-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-activedescendant={
              active ? `${listId}-${active.key}` : undefined
            }
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-label="Search Panel and Relays"
            autoFocus
            className="h-8 bg-input/14 pr-2 pl-8 text-sm"
            placeholder="Search Panel and Relays"
            role="combobox"
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                const step = event.key === "ArrowDown" ? 1 : -1
                setActiveIndex((index) =>
                  visible.length === 0
                    ? 0
                    : (Math.min(index, visible.length - 1) +
                        step +
                        visible.length) %
                      visible.length
                )
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                choose(active)
              }
            }}
          />
        </div>
      </div>
      {visible.length > 0 ? (
        <div
          aria-label="Panel and Relays"
          className="max-h-72 overflow-y-auto overscroll-contain p-1.5"
          id={listId}
          ref={listRef}
          role="listbox"
        >
          {visible.map((entry) => {
            const unavailable = entry.index === undefined
            return (
              <div
                aria-disabled={unavailable || undefined}
                aria-selected={entry === active}
                className={`flex h-8 cursor-default items-center gap-2 px-2 text-sm ${
                  entry === active ? "bg-accent text-foreground" : ""
                } ${unavailable ? "text-muted-foreground" : ""}`}
                data-key={entry.key}
                id={`${listId}-${entry.key}`}
                key={entry.key}
                role="option"
                onClick={() => choose(entry)}
                onPointerMove={() => setActiveIndex(visible.indexOf(entry))}
              >
                {entry.component === "hearth" ? (
                  <ServerCog className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <RadioTower className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="type-meta shrink-0 font-mono text-muted-foreground">
                  {entry.versionLabel ?? "Not a release"}
                </span>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="type-support px-3 py-4 text-muted-foreground">
          Nothing matches “{search.trim()}”.
        </p>
      )}
    </>
  )
}

// The timeline's line runs through the gutter of every row.
const changelogGutterLine =
  "before:absolute before:inset-y-0 before:left-[1.4375rem] before:w-px before:-translate-x-1/2 before:bg-muted-foreground/30"

const ChangelogRow = React.memo(function ChangelogRow({
  first,
  gitRepository,
  item,
}: {
  first: boolean
  gitRepository: string
  item: ChangelogTimelineItem
}) {
  if (item.kind === "version") {
    return <ChangelogVersionLine first={first} item={item} />
  }
  if (item.kind === "earlier") {
    return (
      <div
        className={`relative flex h-full items-center border-y border-border/60 bg-popover pr-4 pl-12 ${changelogGutterLine}`}
      >
        <span className="type-technical-label text-[0.6875rem] text-muted-foreground">
          Earlier releases
        </span>
      </div>
    )
  }
  if (item.kind === "day") {
    return (
      <div
        className={`relative flex h-full items-end pr-4 pb-1 pl-12 ${changelogGutterLine}`}
      >
        <span
          aria-hidden="true"
          className="absolute bottom-[0.6rem] left-[1.4375rem] h-px w-2 bg-muted-foreground/30"
        />
        <span className="type-meta font-mono text-muted-foreground">
          {item.label}
        </span>
      </div>
    )
  }
  if (item.kind === "quiet") {
    return (
      <div
        className={`type-meta relative flex h-full items-center pr-4 pl-12 text-muted-foreground ${changelogGutterLine}`}
      >
        {item.hiddenCount > 0
          ? `Maintenance only · ${item.hiddenCount} ${item.hiddenCount === 1 ? "change" : "changes"}`
          : "No changes listed"}
      </div>
    )
  }
  const { change, release } = item
  return (
    <div
      className={`relative grid h-full grid-cols-[4.25rem_minmax(0,1fr)_auto] items-center gap-3 pr-4 pl-12 hover:bg-accent/25 ${changelogGutterLine}`}
      title={`${compactReleaseName(release.name)} · ${formatShortReleaseDate(release.publishedAt)}`}
    >
      <span className={`type-meta ${changeGroupClassName[change.group]}`}>
        {changeGroupLabel[change.group]}
      </span>
      <span className="type-support flex min-w-0 items-baseline gap-2">
        <span className="truncate text-foreground">
          {change.group === "other"
            ? linkedMarkdownText(change.title)
            : change.title}
        </span>
        {change.scope ? (
          <span className="type-meta shrink-0 font-mono text-muted-foreground">
            {change.scope}
          </span>
        ) : null}
      </span>
      {change.pullRequest ? (
        <a
          className="type-meta font-mono text-muted-foreground transition-colors hover:text-primary"
          href={`${gitRepository}/pull/${change.pullRequest}`}
          rel="noreferrer"
          target="_blank"
        >
          #{change.pullRequest}
        </a>
      ) : (
        <span />
      )}
    </div>
  )
})

const ChangelogVersionLine = React.memo(function ChangelogVersionLine({
  first,
  item,
}: {
  first: boolean
  item: Extract<ChangelogTimelineItem, { kind: "version" }>
}) {
  const { latest, markers, release, releaseCount } = item
  const current = markers.some((marker) => marker.state === "current")
  const previous = markers.some((marker) => marker.state === "previous")
  return (
    <div
      className={`relative flex h-full items-center gap-3 bg-popover pr-4 pl-12 before:absolute before:left-[1.4375rem] before:w-px before:-translate-x-1/2 before:bg-muted-foreground/30 ${
        first
          ? "border-b border-border/60 before:top-1/2 before:bottom-0"
          : "border-y border-border/60 before:inset-y-0"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-1/2 left-[1.4375rem] size-2.5 -translate-x-1/2 -translate-y-1/2 ${
          latest
            ? "bg-primary"
            : current
              ? "bg-sky-300"
              : "border border-muted-foreground bg-popover"
        }`}
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5 whitespace-nowrap">
        <h3 className="type-card-title truncate">
          {compactReleaseName(release.name)}
        </h3>
        {latest ? <span className="type-meta text-primary">Latest</span> : null}
        {current ? (
          <span className="type-meta text-sky-200">Current</span>
        ) : null}
        {previous ? (
          <span className="type-meta text-muted-foreground">Previous</span>
        ) : null}
        <span className="type-meta shrink-0 font-mono text-muted-foreground">
          {formatShortReleaseDate(release.publishedAt)}
        </span>
        <ChangelogMarkerIcons markers={markers} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {releaseCount > 1 ? (
          <span className="type-meta text-muted-foreground">
            {releaseCount} releases
          </span>
        ) : null}
        <Button
          asChild
          className="text-muted-foreground"
          size="icon-sm"
          variant="ghost"
        >
          <a
            aria-label={`${release.name} on GitHub`}
            href={release.url}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink />
          </a>
        </Button>
      </div>
    </div>
  )
})

// Who runs, or ran, this version: a Panel icon and a Relay icon with a count
// of the others. Hovering lists them all, scrolling past a dozen or so.
function ChangelogMarkerIcons({
  markers,
}: {
  markers: ReadonlyArray<ChangelogMarker>
}) {
  if (markers.length === 0) return null
  const groups = (["current", "previous"] as const).flatMap((state) => {
    const inState = markers.filter((marker) => marker.state === state)
    const panel = inState.find((marker) => marker.component === "hearth")
    const relays = inState.filter((marker) => marker.component === "relay")
    return [
      ...(panel ? [{ component: "hearth" as const, extra: 0, state }] : []),
      ...(relays.length > 0
        ? [{ component: "relay" as const, extra: relays.length - 1, state }]
        : []),
    ]
  })
  const current = markers.filter((marker) => marker.state === "current")
  const previous = markers.filter((marker) => marker.state === "previous")

  return (
    <HoverCard closeDelay={100} openDelay={150}>
      <HoverCardTrigger asChild>
        <span
          aria-label={markers
            .map(
              (marker) =>
                `${marker.name}${marker.state === "previous" ? " (previous)" : ""}`
            )
            .join(", ")}
          className="flex shrink-0 cursor-default items-center gap-2 self-center"
          role="img"
        >
          {groups.map((group) => (
            <span
              className={`type-meta inline-flex items-center gap-0.5 ${
                group.state === "current"
                  ? "text-sky-200"
                  : "text-muted-foreground"
              }`}
              key={`${group.state}:${group.component}`}
            >
              {group.component === "hearth" ? (
                <ServerCog className="size-3.5" />
              ) : (
                <RadioTower className="size-3.5" />
              )}
              {group.extra > 0 ? `+${group.extra}` : null}
            </span>
          ))}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-64 p-0">
        <div className="max-h-60 overflow-y-auto overscroll-contain py-1.5">
          <ChangelogMarkerList label="Current" markers={current} />
          <ChangelogMarkerList label="Previous" markers={previous} />
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function ChangelogMarkerList({
  label,
  markers,
}: {
  label: string
  markers: ReadonlyArray<ChangelogMarker>
}) {
  if (markers.length === 0) return null
  return (
    <div className="px-1.5 py-1">
      <p className="type-technical-label px-1.5 pb-1 text-[0.6875rem] text-muted-foreground">
        {label} · {markers.length}
      </p>
      {markers.map((marker) => (
        <p
          className="flex h-7 items-center gap-2 px-1.5 text-sm"
          key={marker.key}
        >
          {marker.component === "hearth" ? (
            <ServerCog className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <RadioTower className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{marker.name}</span>
        </p>
      ))}
    </div>
  )
}

function ChangelogEnd({
  error,
  loading,
  onRetry,
}: {
  error: boolean
  loading: boolean
  onRetry: () => void
}) {
  return (
    <div className="type-meta relative flex h-full items-center gap-2 pr-4 pl-12 text-muted-foreground before:absolute before:top-0 before:bottom-1/2 before:left-[1.4375rem] before:w-px before:-translate-x-1/2 before:bg-muted-foreground/30">
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-[1.4375rem] size-2 -translate-x-1/2 -translate-y-1/2 border border-muted-foreground bg-popover"
      />
      {error ? (
        <>
          <span>Couldn’t load older releases.</span>
          <Button size="sm" type="button" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </>
      ) : loading ? (
        <>
          <LoaderCircle className="size-3.5 animate-spin" />
          Loading older releases
        </>
      ) : (
        "The first Kiln release"
      )}
    </div>
  )
}

function ChangelogSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="flex h-[44px] items-center border-b border-border/60 pl-12">
        <Skeleton className="h-3 w-40" />
      </div>
      {Array.from({ length: 9 }, (_, index) => (
        <div className="flex h-[30px] items-center gap-3 pl-12" key={index}>
          <Skeleton className="h-2.5 w-12" />
          <Skeleton
            className="h-2.5"
            style={{ width: `${40 + ((index * 17) % 35)}%` }}
          />
        </div>
      ))}
    </div>
  )
}

// Development only: `localStorage.setItem("kiln.dev.mockRelays", "12")` adds
// that many fake Relays on recent releases, many sharing one, to try the
// updater with a large fleet.
function withDevMockRelays(
  overview: UpdateOverview | undefined
): UpdateOverview | undefined {
  const count = Number(
    Result.getOrElse(
      Result.try(() => window.localStorage.getItem("kiln.dev.mockRelays")),
      () => null
    ) ?? 0
  )
  if (!overview || !Number.isInteger(count) || count <= 0) return overview
  const { releases } = overview
  const versionAt = (index: number) =>
    releases[Math.min(index, releases.length - 1)]?.version ?? null
  const previousVersions = { ...overview.previousVersions }
  const relays = Array.from({ length: count }, (_, index) => {
    const relayId = `dev-mock-relay-${index + 1}`
    // Most share one nightly; the rest trail behind.
    const current = versionAt(index < count * 0.6 ? 2 : index % 2 ? 5 : 12)
    const previous = versionAt(index % 3 === 0 ? 9 : 20)
    if (previous) previousVersions[`relay:${relayId}`] = previous
    return {
      component: "relay" as const,
      container: "",
      currentImage: "",
      currentVersion: current,
      eligible: false,
      name: `relay-${["eu", "us", "ap"][index % 3]}-${String(index + 1).padStart(2, "0")}`,
      reachable: false as const,
      reason: "Development mock Relay",
      relayId,
    }
  })
  return {
    ...overview,
    previousVersions,
    relays: [...overview.relays, ...relays],
  }
}

function changelogMarkers(
  targets: ReadonlyArray<UpdateTarget>,
  previousVersions: Readonly<Record<string, string>>,
  releases: ReadonlyArray<PublicKilnRelease>
): Array<ChangelogMarker> {
  return targets.flatMap((target, index): Array<ChangelogMarker> => {
    let current = target.currentVersion
    let previous: string | null = previousVersions[target.key] ?? null
    // Development builds aren't releases. Place them on recent ones so the
    // timeline has something to show.
    if (import.meta.env.DEV && !findKilnRelease(releases, current)) {
      current = releases[2 + index * 4]?.version ?? null
      previous = releases[9 + index * 6]?.version ?? null
    }
    const base = {
      component: target.component,
      name: target.name,
    }
    return [
      ...(current
        ? [
            {
              ...base,
              key: `${target.key}:current`,
              state: "current" as const,
              version: current,
            },
          ]
        : []),
      ...(previous && previous !== current
        ? [
            {
              ...base,
              key: `${target.key}:previous`,
              state: "previous" as const,
              version: previous,
            },
          ]
        : []),
    ]
  })
}

function UpdateListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Checking for updates">
      <UpdateSectionLabel>Hearth</UpdateSectionLabel>
      <UpdateRowSkeleton />
      <UpdateSectionLabel>Relays</UpdateSectionLabel>
      <UpdateRowSkeleton />
      <UpdateRowSkeleton />
    </div>
  )
}

function UpdateRowSkeleton() {
  return (
    <div className={updateRowClassName}>
      <Skeleton className="size-8" />
      <div className="min-w-0">
        <div className="flex h-5 items-center">
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="mt-[3px] flex h-[1.125rem] items-center gap-2">
          <Skeleton className="h-[1.125rem] w-16" />
          <Skeleton className="h-2.5 w-28" />
        </div>
      </div>
      <Skeleton className="h-7 w-24" />
    </div>
  )
}

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
    <div className="pt-2">
      {active.map((update) => (
        <div className={updateRowClassName} key={update.operationId}>
          <span className="grid size-8 shrink-0 place-items-center border bg-background/55">
            <LoaderCircle className="size-4 animate-spin text-primary" />
          </span>
          <div className="min-w-0">
            <div className="flex h-5 min-w-0 items-center">
              <h3 className="type-card-title truncate">{update.name}</h3>
            </div>
            <div className="mt-[3px] flex h-[1.125rem] min-w-0 items-center gap-2">
              <UpdateTargetProgress
                activityStore={activityStore}
                initialPhase={update.phase}
                operationId={update.operationId}
              />
            </div>
          </div>
          <span aria-hidden="true" className="w-24" />
        </div>
      ))}
    </div>
  )
})

function UpdateDialogError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="grid h-full min-h-80 place-items-center p-6 text-center">
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

function updateTargets(overview: UpdateOverview): Array<UpdateTarget> {
  const hearth: UpdateTarget = {
    component: "hearth",
    currentVersion:
      overview.hearth?.currentVersion ?? overview.currentVersion ?? null,
    eligible: overview.hearth?.eligible ?? false,
    key: "hearth",
    name: "Panel",
    reachable: true,
    reason:
      overview.hearth?.reason ??
      "Pair a Relay running on Hearth's Docker host to enable updates.",
    relayId: overview.hearth?.relayId ?? null,
  }
  return [
    ...(overview.canUpdateHearth ? [hearth] : []),
    ...overview.relays.map((relay): UpdateTarget => ({
      component: "relay",
      currentVersion: relay.currentVersion,
      eligible: relay.eligible,
      key: relayTargetKey(relay.relayId),
      name: relay.name,
      reachable: relay.reachable,
      reason: relay.reason,
      relayId: relay.relayId,
    })),
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

function createUpdateDialogViewStore() {
  let view: DialogView = "overview"
  // The component whose version line the changelog opens on, or null for
  // the top.
  let jumpTarget: string | null = null
  const listeners = new Set<() => void>()

  const setView = (next: DialogView) => {
    if (next === view) return
    view = next
    listeners.forEach((listener) => listener())
  }

  return {
    getJumpTarget: () => jumpTarget,
    getViewSnapshot: () => view,
    openChangelog: (targetKey: string | null) => {
      jumpTarget = targetKey
      setView("changelog")
    },
    showOverview: () => setView("overview"),
    subscribeView: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
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
    previous.reachable === next.reachable &&
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

function targetStatus(
  target: UpdateTarget,
  releases: ReadonlyArray<PublicKilnRelease>
): { text: string; tone: StatusTone } {
  if (!target.reachable) {
    return {
      text: target.reason ? `Offline · ${target.reason}` : "Offline",
      tone: "muted",
    }
  }
  const comparison = compareLatestReleaseVersion(
    target.currentVersion,
    releases
  )
  if (comparison === 0) return { text: "Up to date", tone: "muted" }
  if (comparison === -1) {
    return { text: "Newer than the latest release", tone: "info" }
  }
  if (!target.eligible) {
    return {
      text: target.reason ?? "This container can’t be updated from Kiln.",
      tone: "muted",
    }
  }
  if (target.currentVersion === null) {
    return { text: "Version unknown", tone: "warning" }
  }
  if (comparison === 1) {
    const behind = releasesBehind(releases, target.currentVersion)
    return {
      text:
        behind === null
          ? "Update available"
          : `${behind} ${behind === 1 ? "release" : "releases"} behind`,
      tone: "warning",
    }
  }
  return { text: "Custom build", tone: "info" }
}

function releasesBehind(
  releases: ReadonlyArray<PublicKilnRelease>,
  version: string
): number | null {
  const release = findKilnRelease(releases, version)
  const index = release ? releases.indexOf(release) : -1
  return index > 0 ? index : null
}

function compactReleaseName(name: string): string {
  return name.replace(/^v\d+\.\d+\.\d+\s+(?=Nightly\b)/u, "")
}

function releaseVersionLabel(
  releases: ReadonlyArray<PublicKilnRelease>,
  version: string | null
): string | null {
  if (!version) return null
  const release = findKilnRelease(releases, version)
  if (release) return compactReleaseName(release.name)
  return isKilnReleaseVersion(version) ? `v${version}` : version
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

function displayComponent(component: "hearth" | "relay"): string {
  return component === "hearth" ? "Panel" : "Relay"
}

function relayTargetKey(relayId: string): string {
  return `relay:${relayId}`
}

function formatShortReleaseDate(publishedAt: string | null): string {
  if (!publishedAt) return "Recently"
  const date = new Date(publishedAt)
  return Number.isFinite(date.getTime())
    ? shortReleaseDateFormatter.format(date)
    : "Recently"
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
