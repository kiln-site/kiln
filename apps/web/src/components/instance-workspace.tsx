import * as React from "react"
import * as Sentry from "@sentry/tanstackstart-react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link, useParams, useRouterState } from "@tanstack/react-router"
import { Effect, Queue, Stream } from "effect"
import {
  shouldWaitForRelayBrowserAuthorization,
  relayBrowserAuthorizationChanges,
} from "@/lib/authenticated-relay-socket"
import type {
  RelayInstanceProvisioning,
  RelayInstanceResources,
  RelayObservedState,
} from "@workspace/contracts"
import { relayInstanceLifecycleEventTime } from "@workspace/contracts"
import {
  Check,
  Copy,
  LoaderCircle,
  OctagonX,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@workspace/ui/components/hover-card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { showToast } from "@workspace/ui/components/sonner"

import {
  FileTreePreferencesContext,
  InstanceIdentityContext,
  InstancePermissionsContext,
  InstanceRelayConnectedContext,
} from "@/components/instance-workspace-context"
import type {
  FileTreePreferences,
  InstanceWorkspacePermissions,
} from "@/components/instance-workspace-context"
import { WorkspaceFrame } from "@/components/workspace-frame"
import {
  WorkspaceCopyValueButton,
  WorkspaceHeader,
  WorkspaceIdCopyButton,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import { provisioningFailureDiagnostics } from "@/lib/provisioning-diagnostics"
import {
  beginPendingPowerAction,
  finishPendingPowerAction,
  isPowerControlLocked,
  reconcilePendingPowerInstance,
  type ServerAction,
} from "@/lib/instance-power-state"
import { openRelayResourceStream } from "@/lib/relay-resource-stream"
import {
  RESOURCE_HISTORY_WINDOW_MS,
  resourceHistoryStore,
  type ResourceHistoryStore,
} from "@/lib/resource-history-store"
import {
  accessCapabilitiesQueryOptions,
  queryKeys,
  relayConnectionQueryOptions,
  relaySnapshotQueryOptions,
  replaceRelaySnapshotInstance,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import {
  selectInstanceObservedState,
  selectInstanceWorkspaceInstance,
  selectRelayConnected,
} from "@/lib/relay-selectors"
import type {
  InstanceRuntime,
  InstanceWorkspaceInstance,
} from "@/lib/relay-selectors"
import { performRelayAction } from "@/server/relay"

const ResourceHistoryChart = React.lazy(async () => {
  const module = await import("@/components/resource-history-chart")
  return { default: module.ResourceHistoryChart }
})
const localTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
})
const RESOURCE_VISUAL_FLOOR_PERCENT = 6

function hasKnownStorageUsage(
  storage: RelayInstanceResources["storage"] | undefined
): storage is RelayInstanceResources["storage"] & {
  percent: number
  usedBytes: number
} {
  return (
    storage !== undefined &&
    storage.totalBytes > 0 &&
    storage.usedBytes !== null &&
    storage.percent !== null
  )
}

function clampResourcePercent(value: number | null | undefined): number {
  return value === null || value === undefined
    ? 0
    : Math.max(RESOURCE_VISUAL_FLOOR_PERCENT, Math.min(value, 100))
}

export function InstanceWorkspace({
  children,
  instance,
  fileTreePreferences,
  permissions,
}: {
  children: React.ReactNode
  instance: InstanceWorkspaceInstance
  fileTreePreferences: FileTreePreferences
  permissions: InstanceWorkspacePermissions
}) {
  return (
    <InstanceIdentityContext.Provider value={instance}>
      <InstancePermissionsContext.Provider value={permissions}>
        <FileTreePreferencesContext.Provider value={fileTreePreferences}>
          <InstanceRelayConnectionBoundary instance={instance}>
            <InstanceProvisioningBoundary instance={instance}>
              {children}
            </InstanceProvisioningBoundary>
          </InstanceRelayConnectionBoundary>
        </FileTreePreferencesContext.Provider>
      </InstancePermissionsContext.Provider>
    </InstanceIdentityContext.Provider>
  )
}

export const InstanceWorkspaceShell = React.memo(
  function InstanceWorkspaceShell({ children }: { children: React.ReactNode }) {
    return (
      <WorkspaceFrame header={<InstanceWorkspaceHeader />}>
        <div data-slot="instance-workspace-surface" className="contents">
          {children}
        </div>
      </WorkspaceFrame>
    )
  }
)

function InstanceRelayConnectionBoundary({
  children,
  instance,
}: {
  children: React.ReactNode
  instance: InstanceWorkspaceInstance
}) {
  const queryClient = useQueryClient()
  const selectRelayConnection = React.useMemo(
    () => selectRelayConnected(instance.relayId),
    [instance.relayId]
  )
  const { data: relayConnected = false } = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConnection,
  })

  return (
    <InstanceRelayConnectedContext.Provider value={relayConnected}>
      {!instance.provisioning ? (
        <RelayResourceStreamController
          instance={instance}
          relayConnected={relayConnected}
        />
      ) : null}
      {children}
    </InstanceRelayConnectedContext.Provider>
  )
}

const PROVISIONING_PHASES: ReadonlyArray<{
  phase: Exclude<
    RelayInstanceProvisioning["phase"],
    "awaiting_claim" | "queued" | "failed"
  >
  detail: string
  label: string
}> = [
  {
    phase: "preparing",
    label: "Prepare",
    detail: "Checking capacity and creating storage",
  },
  {
    phase: "pulling_image",
    label: "Download",
    detail: "Fetching the server image",
  },
  {
    phase: "creating_container",
    label: "Build",
    detail: "Allocating ports and creating the container",
  },
  {
    phase: "finalizing",
    label: "Finalize",
    detail: "Connecting services and publishing the server",
  },
]

const PROVISIONING_FAILURE_GUIDANCE: Record<
  NonNullable<RelayInstanceProvisioning["failedPhase"]>,
  string
> = {
  preparing:
    "Check Docker networking, storage, and capacity on the Relay. After resolving the cause, delete this failed server and provision it again.",
  pulling_image:
    "Check the image name, registry access, and the Relay's internet connection. After resolving the cause, delete this failed server and provision it again.",
  creating_container:
    "Check the Relay for port conflicts and Docker container errors. After resolving the cause, delete this failed server and provision it again.",
  finalizing:
    "Check Relay networking and service configuration. After resolving the cause, delete this failed server and provision it again.",
}

function InstanceProvisioningBoundary({
  children,
  instance,
}: {
  children: React.ReactNode
  instance: InstanceWorkspaceInstance
}) {
  const isInfoRoute = useRouterState({
    select: (state) => state.location.pathname.endsWith("/info"),
  })
  if (!instance.provisioning) return children
  if (isInfoRoute) return children
  return <InstanceProvisioningState instance={instance} />
}

const InstanceProvisioningState = React.memo(
  function InstanceProvisioningState({
    instance,
  }: {
    instance: InstanceWorkspaceInstance
  }) {
    const provisioning = instance.provisioning
    if (!provisioning) return null
    const failed = provisioning.phase === "failed"
    const effectivePhase = failed
      ? (provisioning.failedPhase ?? "preparing")
      : provisioning.phase === "awaiting_claim" ||
          provisioning.phase === "queued"
        ? "preparing"
        : provisioning.phase
    const activeIndex = PROVISIONING_PHASES.findIndex(
      (step) => step.phase === effectivePhase
    )
    const activeStep = PROVISIONING_PHASES[activeIndex]
    const failureGuidance = failed
      ? PROVISIONING_FAILURE_GUIDANCE[provisioning.failedPhase ?? "preparing"]
      : null
    const diagnostics = provisioningFailureDiagnostics({
      attempt: provisioning.attempt,
      error: provisioning.error,
      failedPhase: provisioning.failedPhase,
      instanceId: instance.id,
      instanceName: instance.name,
      relayId: instance.relayId,
    })

    function copyDiagnostics() {
      Effect.runFork(
        Effect.tryPromise({
          try: () => navigator.clipboard.writeText(diagnostics),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: () =>
              showToast({
                message:
                  "Could not copy diagnostics. Select the error text manually.",
                type: "error",
              }),
            onSuccess: () =>
              showToast({
                message: "Provisioning diagnostics copied",
                type: "success",
              }),
          })
        )
      )
    }

    return (
      <div className="flex min-h-0 w-full flex-1 overflow-y-auto">
        <div className="m-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-10">
          <section className="self-center">
            <div className="type-technical-label mb-5 flex items-center gap-2 text-primary">
              {failed ? (
                <TriangleAlert className="size-4" />
              ) : (
                <LoaderCircle className="size-4 animate-spin" />
              )}
              {failed ? "Provisioning stopped" : "Provisioning in background"}
            </div>
            <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {failed
                ? `${instance.name} needs your attention.`
                : `${instance.name} is already yours.`}
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              {failed
                ? "Kiln kept the server record intact, but the Relay could not finish building it. The Relay's reported reason and next step are below."
                : "Kiln is downloading and assembling the server on the Relay. You can leave this page; provisioning will continue and this workspace will unlock automatically."}
            </p>
            {failed ? (
              <div className="mt-7 max-w-2xl border border-destructive/30 bg-destructive/6">
                <div className="border-b border-destructive/20 p-4">
                  <p className="type-technical-label text-destructive">
                    Failed during {activeStep?.label ?? "provisioning"}
                  </p>
                  <p
                    className="mt-2 line-clamp-3 text-sm leading-6 break-words text-foreground"
                    title={
                      provisioning.error ??
                      "The Relay did not provide an error message."
                    }
                  >
                    {provisioning.error ??
                      "The Relay did not provide an error message."}
                  </p>
                </div>
                <div className="p-4">
                  <p className="type-technical-label text-muted-foreground">
                    Next step
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {failureGuidance}
                  </p>
                  <Button
                    className="mt-4"
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyDiagnostics}
                  >
                    <Copy />
                    Copy diagnostics
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-8 h-px max-w-xl overflow-hidden bg-border">
                <div className="h-full w-1/3 animate-pulse bg-primary" />
              </div>
            )}
          </section>

          <aside className="border border-border/80 bg-background/50">
            <div className="type-technical-label flex items-center justify-between border-b border-border/80 px-4 py-3 text-muted-foreground">
              <span>Build sequence</span>
              <span>Attempt {Math.max(1, provisioning.attempt)}</span>
            </div>
            <ol className="p-4">
              {PROVISIONING_PHASES.map((step, index) => {
                const complete = index < activeIndex
                const active = !failed && index === activeIndex
                const failedStep = failed && index === activeIndex
                return (
                  <li
                    key={step.phase}
                    className="grid grid-cols-[1.5rem_1fr] gap-x-3 pb-5 last:pb-0"
                  >
                    <div className="flex flex-col items-center">
                      <span
                        className={`grid size-6 place-items-center border text-[10px] ${
                          complete
                            ? "border-primary bg-primary text-primary-foreground"
                            : failedStep
                              ? "border-destructive bg-destructive/10 text-destructive"
                              : active
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground"
                        }`}
                      >
                        {complete ? (
                          <Check className="size-3.5" />
                        ) : failedStep ? (
                          <OctagonX className="size-3.5" />
                        ) : (
                          index + 1
                        )}
                      </span>
                      {index < PROVISIONING_PHASES.length - 1 ? (
                        <span className="mt-1 h-full w-px bg-border" />
                      ) : null}
                    </div>
                    <div className="min-w-0 pt-0.5">
                      <p
                        className={`text-sm font-medium ${
                          failedStep
                            ? "text-destructive"
                            : active
                              ? "text-primary"
                              : "text-foreground"
                        }`}
                      >
                        {step.label}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {step.detail}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
          </aside>
        </div>
      </div>
    )
  }
)

function RelayResourceStreamController({
  instance,
  relayConnected,
}: {
  instance: InstanceWorkspaceInstance
  relayConnected: boolean
}) {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    if (!relayConnected) return
    let durableFingerprint: string | null = null

    const connectionFiber = Effect.runFork(
      Effect.gen(function* () {
        const authorizationChanges = yield* relayBrowserAuthorizationChanges(
          instance.relayId,
          instance.id
        )
        let retryDelay = 500
        for (;;) {
          const failed = yield* Effect.suspend(() => {
            let lastSequence = -1
            return openRelayResourceStream(instance.relayId, instance.id).pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  retryDelay = 500
                  if (event.sequence <= lastSequence) return
                  lastSequence = event.sequence
                  const patchStartedAt = performance.now()
                  resourceHistoryStore(instance.relayId, instance.id).record(
                    event.history,
                    event.instance.resources
                  )
                  const streamedInstance = reconcilePendingPowerInstance(
                    instance.relayId,
                    event.instance
                  )
                  const { resources: _resources, ...durableInstance } =
                    streamedInstance
                  const nextFingerprint = JSON.stringify(durableInstance)
                  const durableChanged = nextFingerprint !== durableFingerprint
                  if (durableChanged) {
                    durableFingerprint = nextFingerprint
                    queryClient.setQueryData<RelayFleetSnapshot>(
                      queryKeys.relay.snapshot,
                      (snapshot) => {
                        const current = snapshot?.instances.find(
                          (candidate) =>
                            candidate.id === streamedInstance.id &&
                            candidate.relayId === instance.relayId
                        )
                        return replaceRelaySnapshotInstance(snapshot, {
                          ...streamedInstance,
                          resources: current?.resources ?? null,
                          relayId: instance.relayId,
                        })
                      }
                    )
                  }
                  Sentry.metrics.distribution(
                    "relay.resources.query_patch",
                    performance.now() - patchStartedAt,
                    {
                      unit: "millisecond",
                      attributes: {
                        "kiln.durable_changed": String(durableChanged),
                      },
                    }
                  )
                })
              ),
              Effect.andThen(
                Effect.fail(new Error("Relay resource stream closed"))
              )
            )
          }).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => null,
            })
          )
          if (shouldWaitForRelayBrowserAuthorization(failed)) {
            yield* Queue.take(authorizationChanges)
            continue
          }
          if (failed) {
            yield* Effect.sleep(retryDelay)
            retryDelay = Math.min(retryDelay * 2, 5_000)
          } else {
            retryDelay = 500
          }
        }
      }).pipe(Effect.scoped)
    )
    return () => {
      connectionFiber.interruptUnsafe()
    }
  }, [instance.id, instance.relayId, queryClient, relayConnected])

  return null
}

function InstanceWorkspaceHeader() {
  const [error, setError] = React.useState<string | null>(null)
  const instance = useRouteWorkspaceInstance()

  return (
    <WorkspaceHeader
      identity={<InstanceIdentityBoundary error={error} instance={instance} />}
      center={<LiveResourceMetersBoundary instance={instance} />}
      actions={
        <InstancePowerControlsBoundary instance={instance} onError={setError} />
      }
    />
  )
}

function useRouteWorkspaceInstance() {
  const serverId = useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params
      return params &&
        "serverId" in params &&
        typeof params.serverId === "string"
        ? params.serverId
        : undefined
    },
  })
  const selectInstance = React.useMemo(
    () => selectInstanceWorkspaceInstance(serverId ?? ""),
    [serverId]
  )
  const { data: instance } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectInstance,
  })
  return instance
}

const InstanceIdentityBoundary = React.memo(function InstanceIdentityBoundary({
  error,
  instance,
}: {
  error: string | null
  instance: InstanceWorkspaceInstance | null | undefined
}) {
  return instance ? (
    <InstanceIdentity
      key={`${instance.relayId}:${instance.id}`}
      error={error}
      instance={instance}
    />
  ) : null
})

const LiveResourceMetersBoundary = React.memo(
  function LiveResourceMetersBoundary({
    instance,
  }: {
    instance: InstanceWorkspaceInstance | null | undefined
  }) {
    return instance ? (
      <LiveResourceMeters instanceId={instance.id} relayId={instance.relayId} />
    ) : null
  }
)

const InstancePowerControlsBoundary = React.memo(
  function InstancePowerControlsBoundary({
    instance,
    onError,
  }: {
    instance: InstanceWorkspaceInstance | null | undefined
    onError: (error: string | null) => void
  }) {
    const { data: capabilities } = useSuspenseQuery(
      accessCapabilitiesQueryOptions()
    )
    const powerPermissions = React.useMemo(() => {
      const can = (action: ServerAction) =>
        Boolean(
          instance &&
          canAccessInstancePermission(
            capabilities,
            instance,
            `instance.power.${action}`
          )
        )
      return {
        start: can("start"),
        stop: can("stop"),
        restart: can("restart"),
        kill: can("kill"),
      }
    }, [capabilities, instance])

    return instance ? (
      <InstancePowerControls
        powerPermissions={powerPermissions}
        instance={instance}
        onError={onError}
      />
    ) : null
  }
)

function InstanceAddressControl({ address }: { address: string }) {
  const { serverId } = useParams({ from: "/_app/server/$serverId" })
  const addressError = address.startsWith("Error:") ? address : null

  if (addressError) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            aria-label="Open Network and edit the game server port"
            className="flex min-w-0 flex-1 items-center gap-1 truncate font-mono font-semibold text-destructive transition-colors hover:text-destructive/80"
            params={{ serverId }}
            search={{ edit: "game-port" }}
            to="/server/$serverId/network"
          >
            <span className="truncate">ERROR</span>
            <TriangleAlert className="size-3 shrink-0" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Configure game server port
        </TooltipContent>
      </Tooltip>
    )
  }

  return <WorkspaceCopyValueButton label="server address" value={address} />
}

function InstanceIdentity({
  error,
  instance,
}: {
  error: string | null
  instance: InstanceWorkspaceInstance
}) {
  return (
    <WorkspaceIdentity
      error={error}
      name={instance.name}
      title={<InstanceRouteTitle />}
    >
      <span className="hidden shrink-0 items-center gap-1.5 @[30rem]:inline-flex">
        <span>
          {instance.implementation} {instance.version}
        </span>
        <WorkspaceMetaSeparator />
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
        <WorkspaceIdCopyButton
          id={instance.id}
          label="server ID"
          shortId={instance.shortId}
        />
        <WorkspaceMetaSeparator />
      </span>
      <InstanceAddressControl address={instance.connectAddress} />
    </WorkspaceIdentity>
  )
}

function InstanceRouteTitle() {
  const title = useRouterState({
    select: (state) => {
      if (
        state.matches.at(-1)?.routeId === "/_app/server/$serverId/$" ||
        state.matches.some(
          (match) => match.status === "notFound" || match._notFound
        )
      ) {
        return "Not found"
      }
      const pathname = state.location.pathname
      if (/\/files(?:\/|$)/.test(pathname)) return "Files"
      if (pathname.endsWith("/startup")) return "Startup"
      if (pathname.endsWith("/network")) return "Network"
      if (pathname.endsWith("/info")) return "Info"
      return "Console"
    },
  })
  return <>{title}</>
}

function InstancePowerControls({
  powerPermissions,
  instance,
  onError,
}: {
  powerPermissions: Record<ServerAction, boolean>
  instance: InstanceWorkspaceInstance
  onError: (error: string | null) => void
}) {
  const queryClient = useQueryClient()
  const selectObservedState = React.useMemo(
    () => selectInstanceObservedState(instance.id, instance.relayId),
    [instance.id, instance.relayId]
  )
  const { data: observedState } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectObservedState,
  })
  const selectRelayConnection = React.useMemo(
    () => selectRelayConnected(instance.relayId),
    [instance.relayId]
  )
  const { data: relayConnected = false } = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConnection,
  })
  const relayActionMutation = useMutation({
    mutationFn: performRelayAction,
    onSuccess: (updated) => {
      const reconciled = reconcilePendingPowerInstance(
        instance.relayId,
        updated
      )
      queryClient.setQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot,
        (snapshot) => replaceRelaySnapshotInstance(snapshot, reconciled)
      )
    },
  })
  const mutateRelayAction = relayActionMutation.mutateAsync
  const [action, setAction] = React.useState<ServerAction | null>(null)

  const handleAction = React.useCallback(
    async (nextAction: ServerAction) => {
      if (
        !powerPermissions[nextAction] ||
        !relayConnected ||
        !observedState ||
        instance.provisioning ||
        isPowerControlLocked(observedState)
      ) {
        return
      }
      const previousSnapshot = queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )
      const previousInstance = previousSnapshot?.instances.find(
        (item) => item.id === instance.id && item.relayId === instance.relayId
      )
      const pendingPowerAction = beginPendingPowerAction(
        instance.relayId,
        instance.id,
        nextAction,
        relayInstanceLifecycleEventTime(
          previousInstance?.lifecycle ?? [],
          "started"
        )
      )
      queryClient.setQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot,
        (snapshot) =>
          updateInstancePowerState(
            snapshot,
            instance.id,
            instance.relayId,
            pendingPowerAction.phase
          )
      )
      setAction(nextAction)
      onError(null)
      await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            mutateRelayAction({
              data: {
                instanceId: instance.id,
                relayId: instance.relayId,
                action: nextAction,
              },
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              finishPendingPowerAction(instance.relayId, instance.id)
              if (previousInstance) {
                queryClient.setQueryData<RelayFleetSnapshot>(
                  queryKeys.relay.snapshot,
                  (snapshot) =>
                    updateInstancePowerState(
                      snapshot,
                      instance.id,
                      instance.relayId,
                      previousInstance.observedState
                    )
                )
              }
              onError(
                cause instanceof Error ? cause.message : "Relay action failed"
              )
            })
          ),
          Effect.ensuring(Effect.sync(() => setAction(null)))
        )
      )
    },
    [
      instance.id,
      instance.provisioning,
      instance.relayId,
      mutateRelayAction,
      powerPermissions,
      onError,
      observedState,
      queryClient,
      relayConnected,
    ]
  )

  if (!observedState) {
    if (!Object.values(powerPermissions).some(Boolean)) return null
    return (
      <div
        className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 xl:col-start-3"
        aria-label="Loading server power controls"
      >
        <span className="hidden h-9 w-[4.75rem] animate-pulse bg-muted/35 md:block" />
        <span className="size-10 animate-pulse bg-muted/35" />
      </div>
    )
  }
  return (
    <WorkspacePowerControls
      action={action}
      killWarning="This immediately terminates the container. Unsaved world data may be lost."
      noun="server"
      powerPermissions={powerPermissions}
      target={{
        name: instance.name,
        observedState,
        provisioning: instance.provisioning,
      }}
      onAction={handleAction}
      relayConnected={relayConnected}
    />
  )
}

function updateInstancePowerState(
  snapshot: RelayFleetSnapshot | undefined,
  instanceId: string,
  relayId: string,
  observedState: RelayObservedState
): RelayFleetSnapshot | undefined {
  if (!snapshot) return snapshot
  return {
    ...snapshot,
    instances: snapshot.instances.map((instance) =>
      instance.id === instanceId && instance.relayId === relayId
        ? {
            ...instance,
            observedState,
          }
        : instance
    ),
  }
}

const RESOURCE_STYLES = {
  cpu: {
    indicator: "bg-sky-400/85",
    value: "text-sky-300/95",
    chart: "oklch(0.74 0.13 235)",
  },
  memory: {
    indicator: "bg-violet-400/85",
    value: "text-violet-300/95",
    chart: "oklch(0.7 0.15 292)",
  },
  storage: {
    indicator: "bg-emerald-400/80",
    value: "text-emerald-300/95",
    chart: "oklch(0.72 0.13 160)",
  },
  network: {
    indicator: "bg-cyan-300/85",
    value: "text-cyan-200/95",
    chart: "oklch(0.78 0.11 205)",
  },
} as const

type ResourceId = keyof typeof RESOURCE_STYLES
const RESOURCE_IDS: Array<ResourceId> = ["cpu", "memory", "storage", "network"]

function LiveResourceMeters({
  instanceId,
  relayId,
}: {
  instanceId: string
  relayId: string
}) {
  const historyStore = React.useMemo(
    () => resourceHistoryStore(relayId, instanceId),
    [instanceId, relayId]
  )

  return (
    <div
      className="hidden min-w-0 md:col-span-2 md:block xl:col-span-1 xl:col-start-2 xl:row-start-1"
      aria-label="Server resource usage"
    >
      <div className="grid h-14 min-w-0 grid-cols-[repeat(4,minmax(0,1fr))_5.5rem] divide-x divide-border/60 border border-border/80 bg-card/40 px-1.5 py-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_5.75rem]">
        {RESOURCE_IDS.map((resourceId) => (
          <LiveResourceMeter
            key={resourceId}
            instanceId={instanceId}
            relayId={relayId}
            resourceId={resourceId}
            historyStore={historyStore}
          />
        ))}
        <InstanceUptimeMeter instanceId={instanceId} relayId={relayId} />
      </div>
    </div>
  )
}

function LiveResourceMeter({
  instanceId,
  relayId,
  resourceId,
  historyStore,
}: {
  instanceId: string
  relayId: string
  resourceId: ResourceId
  historyStore: ResourceHistoryStore
}) {
  const selectObservedState = React.useMemo(
    () => (snapshot: RelayFleetSnapshot) => {
      const instance = snapshot.instances.find(
        (item) => item.id === instanceId && item.relayId === relayId
      )
      return instance?.observedState ?? null
    },
    [instanceId, relayId]
  )
  const { data: observedState } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectObservedState,
  })
  const resources = React.useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getCurrentSnapshot,
    () => null
  )
  if (!observedState) return null
  const resource = resourceItem({ observedState, resources }, resourceId)

  return (
    <ResourceHistoryPopover resource={resource} historyStore={historyStore}>
      <button
        type="button"
        className={`group min-w-0 text-left outline-none first:pl-1.5 focus-visible:bg-muted/25 ${resource.id === "network" ? "px-1.5" : "px-2.5"}`}
      >
        <div className="type-meta flex items-center justify-between gap-1.5 font-mono tracking-[0.065em]">
          <span className="shrink-0 font-medium text-muted-foreground transition-colors group-hover:text-foreground">
            {resource.label}
          </span>
          {resource.id === "network" ? (
            <NetworkTransferValue
              historyStore={historyStore}
              received={resource.receivedDisplayValue ?? "—"}
              sent={resource.sentDisplayValue ?? "—"}
            />
          ) : (
            <span
              className={`truncate font-medium tabular-nums ${resource.valueClassName}`}
            >
              {resource.displayValue}
            </span>
          )}
        </div>
        <ResourceBar resource={resource} className="mt-2" />
      </button>
    </ResourceHistoryPopover>
  )
}

function NetworkTransferValue({
  historyStore,
  received,
  sent,
}: {
  historyStore: ResourceHistoryStore
  received: string
  sent: string
}) {
  const sampleSequence = React.useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getLatestSampleSequence,
    () => 0
  )
  const isReceived = sampleSequence % 2 === 0
  return (
    <span
      className={`min-w-0 truncate font-medium tracking-[-0.045em] tabular-nums ${isReceived ? "text-cyan-200/95" : "text-primary/90"}`}
      aria-label={`Download ${received}, upload ${sent}`}
    >
      {isReceived ? "↓" : "↑"} {isReceived ? received : sent}
    </span>
  )
}

function InstanceUptimeMeter({
  instanceId,
  relayId,
}: {
  instanceId: string
  relayId: string
}) {
  const selectRuntime = React.useMemo(
    () => (snapshot: RelayFleetSnapshot) => {
      const instance = snapshot.instances.find(
        (item) => item.id === instanceId && item.relayId === relayId
      )
      return instance
        ? {
            id: instance.id,
            observedState: instance.observedState,
            relayId: instance.relayId,
            resources: null,
            lifecycle: instance.lifecycle,
          }
        : null
    },
    [instanceId, relayId]
  )
  const { data: instance } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectRuntime,
  })
  const uptime = useInstanceUptime(instance)
  const sessionStartedAt = relayInstanceLifecycleEventTime(
    instance?.lifecycle ?? [],
    "started"
  )
  const startedAt = useBrowserLocalTimestamp(sessionStartedAt)

  return (
    <HoverCard openDelay={160} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div
          className="type-meta min-w-0 px-1.5 font-mono outline-none focus-visible:bg-muted/25 xl:px-2"
          aria-label={`Instance uptime ${uptime ?? "unavailable"}`}
          tabIndex={startedAt ? 0 : undefined}
        >
          <span className="block font-medium tracking-[0.065em] text-muted-foreground">
            UPTIME
          </span>
          <div className="mt-2.5 flex h-2 items-center justify-center">
            <span className="type-code font-medium tracking-[-0.045em] whitespace-nowrap text-foreground tabular-nums">
              {uptime ?? "—"}
            </span>
          </div>
        </div>
      </HoverCardTrigger>
      {startedAt ? (
        <HoverCardContent
          align="end"
          side="bottom"
          sideOffset={8}
          collisionPadding={12}
          className="w-max max-w-[calc(100vw-1.5rem)] rounded-none border-border/90 bg-popover px-3 py-2 shadow-xl"
        >
          <div className="text-left">
            <p className="type-technical-label text-muted-foreground">
              Started on
            </p>
            <time
              dateTime={sessionStartedAt ?? undefined}
              className="type-code mt-1 block whitespace-nowrap text-foreground"
            >
              {startedAt}
            </time>
          </div>
        </HoverCardContent>
      ) : null}
    </HoverCard>
  )
}

interface ResourceItem {
  id: "cpu" | "memory" | "storage" | "network"
  label: string
  value: number | null
  barValue: number | null
  chartMax?: number
  displayValue: string
  historyDisplayValue?: string
  historySecondaryDisplayValue?: string
  receivedDisplayValue?: string
  sentDisplayValue?: string
  receivedValue?: number | null
  sentValue?: number | null
  detail: string
  historyDetail?: string
  indicatorClassName: string
  valueClassName: string
  chartColor: string
}

function useInstanceUptime(
  instance:
    | Pick<InstanceRuntime, "id" | "lifecycle" | "observedState">
    | null
    | undefined
): string | null {
  const [now, setNow] = React.useState<number | null>(null)
  const startedAt = Date.parse(
    relayInstanceLifecycleEventTime(instance?.lifecycle ?? [], "started") ?? ""
  )
  const running = instance?.observedState === "running"

  React.useEffect(() => {
    setNow(Date.now())
    if (!running || !Number.isFinite(startedAt)) return

    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [instance?.id, running, startedAt])

  if (!running || !Number.isFinite(startedAt) || now === null) return null
  return formatUptime(Math.max(0, Math.floor((now - startedAt) / 1_000)))
}

function useBrowserLocalTimestamp(value: string | null): string | null {
  return React.useSyncExternalStore(
    subscribeToBrowserLocale,
    () => formatBrowserLocalTimestamp(value),
    () => null
  )
}

function subscribeToBrowserLocale(): () => void {
  // Locale has no browser change event; this store only defers formatting until hydration.
  return () => undefined
}

function formatBrowserLocalTimestamp(value: string | null): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? localTimestampFormatter.format(new Date(timestamp))
    : null
}

function resourceItem(
  instance: Pick<InstanceRuntime, "observedState" | "resources">,
  id: ResourceId
): ResourceItem {
  const resources = instance.resources
  const unavailable =
    instance.observedState === "running" ? "Sampling" : "Stopped"

  if (id === "cpu") {
    return {
      id: "cpu",
      label: "CPU",
      value: resources?.cpu.percent ?? null,
      barValue: resources
        ? (resources.cpu.percent / resources.cpu.capacityPercent) * 100
        : null,
      chartMax: resources?.cpu.capacityPercent,
      displayValue: formatPercent(resources?.cpu.percent),
      detail: resources
        ? `${formatPercent(resources.cpu.percent)} of ${formatPercent(resources.cpu.capacityPercent)} · ${resources.cpu.capacityPercent / 100} threads`
        : unavailable,
      indicatorClassName: RESOURCE_STYLES.cpu.indicator,
      valueClassName: RESOURCE_STYLES.cpu.value,
      chartColor: RESOURCE_STYLES.cpu.chart,
    }
  }
  if (id === "memory") {
    return {
      id: "memory",
      label: "RAM",
      value: resources?.memory.percent ?? null,
      barValue: resources?.memory.percent ?? null,
      displayValue: formatPercent(resources?.memory.percent),
      historyDisplayValue: resources
        ? formatResourceBytePair(
            resources.memory.usedBytes,
            resources.memory.totalBytes
          )
        : "—",
      detail: resources
        ? `${formatBytes(resources.memory.usedBytes)} of ${formatBytes(resources.memory.totalBytes)}`
        : unavailable,
      indicatorClassName: RESOURCE_STYLES.memory.indicator,
      valueClassName: RESOURCE_STYLES.memory.value,
      chartColor: RESOURCE_STYLES.memory.chart,
    }
  }
  if (id === "storage") {
    const storage = resources?.storage
    const usageKnown = hasKnownStorageUsage(storage)
    return {
      id: "storage",
      label: "DISK",
      value: usageKnown ? storage.percent : null,
      barValue: usageKnown ? storage.percent : null,
      displayValue: usageKnown ? formatPercent(storage.percent) : "—",
      historyDisplayValue: usageKnown
        ? formatResourceBytePair(storage.usedBytes, storage.totalBytes)
        : storage
          ? "Scanning"
          : "—",
      historySecondaryDisplayValue: storage
        ? formatResourceBytePair(storage.nodeUsedBytes, storage.nodeTotalBytes)
        : "—",
      detail: usageKnown
        ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)} quota`
        : storage
          ? `Scanning folder usage · ${formatBytes(storage.totalBytes)} quota`
          : unavailable,
      historyDetail: storage
        ? `Node ${formatBytes(storage.nodeUsedBytes)} of ${formatBytes(storage.nodeTotalBytes)}`
        : unavailable,
      indicatorClassName: RESOURCE_STYLES.storage.indicator,
      valueClassName: RESOURCE_STYLES.storage.value,
      chartColor: RESOURCE_STYLES.storage.chart,
    }
  }
  return {
    id: "network",
    label: "NET",
    value: resources?.network
      ? networkActivityPercent(
          resources.network.receivedBytesPerSecond +
            resources.network.sentBytesPerSecond
        )
      : null,
    barValue: resources?.network
      ? networkActivityPercent(
          resources.network.receivedBytesPerSecond +
            resources.network.sentBytesPerSecond
        )
      : null,
    displayValue: resources?.network
      ? `${formatBytesPerSecond(
          resources.network.receivedBytesPerSecond +
            resources.network.sentBytesPerSecond
        )}`
      : "—",
    receivedDisplayValue: resources?.network
      ? formatCompactBytesPerSecond(resources.network.receivedBytesPerSecond)
      : "—",
    sentDisplayValue: resources?.network
      ? formatCompactBytesPerSecond(resources.network.sentBytesPerSecond)
      : "—",
    receivedValue: resources?.network
      ? networkActivityPercent(resources.network.receivedBytesPerSecond)
      : null,
    sentValue: resources?.network
      ? networkActivityPercent(resources.network.sentBytesPerSecond)
      : null,
    detail: resources?.network
      ? `↓ ${formatBytesPerSecond(resources.network.receivedBytesPerSecond)} · ↑ ${formatBytesPerSecond(resources.network.sentBytesPerSecond)} · ${formatBytes(resources.network.receivedBytes + resources.network.sentBytes)} total`
      : unavailable,
    historyDetail: resources?.network
      ? `${formatBytes(resources.network.receivedBytes + resources.network.sentBytes)} transferred`
      : unavailable,
    indicatorClassName: RESOURCE_STYLES.network.indicator,
    valueClassName: RESOURCE_STYLES.network.value,
    chartColor: RESOURCE_STYLES.network.chart,
  }
}

function ResourceBar({
  resource,
  className = "",
}: {
  resource: ResourceItem
  className?: string
}) {
  return (
    <div
      className={`h-3 ${resource.id === "network" ? "grid grid-rows-2 gap-px" : "overflow-hidden bg-muted/55"} ${className}`}
      role="progressbar"
      aria-label={`${resource.label} usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={
        resource.barValue === null
          ? undefined
          : Math.min(resource.barValue, 100)
      }
      aria-valuetext={
        resource.id === "network" || resource.value === null
          ? resource.detail
          : resource.displayValue
      }
    >
      {resource.id === "network" ? (
        <>
          <div className="overflow-hidden bg-muted/55">
            <div
              className="h-full bg-cyan-300/85 transition-[width] duration-500 ease-out"
              style={{
                width: `${clampResourcePercent(resource.receivedValue)}%`,
              }}
            />
          </div>
          <div className="overflow-hidden bg-muted/55">
            <div
              className="h-full bg-primary/75 transition-[width] duration-500 ease-out"
              style={{ width: `${clampResourcePercent(resource.sentValue)}%` }}
            />
          </div>
        </>
      ) : (
        <div
          className={`h-full transition-[width] duration-500 ease-out ${resource.indicatorClassName}`}
          style={{ width: `${clampResourcePercent(resource.barValue)}%` }}
        />
      )}
    </div>
  )
}

function ResourceHistoryPopover({
  resource,
  historyStore,
  children,
}: {
  resource: ResourceItem
  historyStore: ResourceHistoryStore
  children: React.ReactElement
}) {
  return (
    <HoverCard openDelay={160} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="center"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(20rem,calc(100vw-1.5rem))] border-border/90 bg-popover p-0 shadow-2xl"
      >
        <ResourceHistoryCard resource={resource} historyStore={historyStore} />
      </HoverCardContent>
    </HoverCard>
  )
}

function ResourceHistoryCard({
  resource,
  historyStore,
}: {
  resource: ResourceItem
  historyStore: ResourceHistoryStore
}) {
  const history = React.useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getSnapshot,
    historyStore.getSnapshot
  )
  const visibleHistory = React.useMemo(() => {
    const domainStart = Date.now() - RESOURCE_HISTORY_WINDOW_MS
    return history.filter((sample) => sample.timestamp >= domainStart)
  }, [history])
  const values = visibleHistory
    .map((sample) => sample[resource.id])
    .filter((value): value is number => value !== null)
  const average = values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null
  const peak = values.length ? Math.max(...values) : null
  const latest = visibleHistory.at(-1)
  const chartData = React.useMemo(
    () =>
      visibleHistory.map((sample) => ({
        timestamp: sample.timestamp,
        value: sample[resource.id],
        secondary: sample.storageNode,
        received: sample.networkReceived,
        sent: sample.networkSent,
      })),
    [resource.id, visibleHistory]
  )

  return (
    <div className="overflow-hidden rounded-[inherit]">
      <ResourceHistoryHeader
        resource={resource}
        average={average}
        peak={peak}
        networkReceived={latest?.networkReceived ?? null}
        networkSent={latest?.networkSent ?? null}
      />

      <div className="px-1.5 pt-2.5">
        <React.Suspense
          fallback={
            <div className="type-technical-label grid h-32 place-items-center border-y border-border/40 text-muted-foreground">
              Loading history
            </div>
          }
        >
          <ResourceHistoryChart
            data={chartData}
            resourceId={resource.id}
            label={resource.label}
            color={resource.chartColor}
            maxValue={resource.chartMax}
            formatValue={(value) => formatHistoryValue(resource.id, value)}
          />
        </React.Suspense>
      </div>
    </div>
  )
}

function ResourceHistoryHeader({
  resource,
  average,
  peak,
  networkReceived,
  networkSent,
}: {
  resource: ResourceItem
  average: number | null
  peak: number | null
  networkReceived: number | null
  networkSent: number | null
}) {
  if (resource.id === "network") {
    return (
      <div className="grid h-12 grid-cols-2 divide-x divide-border/55 border-b border-border/70 bg-muted/[0.08]">
        <NetworkHistoryValue direction="down" value={networkReceived} />
        <NetworkHistoryValue direction="up" value={networkSent} />
      </div>
    )
  }

  if (resource.id === "storage") {
    return (
      <div className="grid h-12 grid-cols-2 divide-x divide-border/55 border-b border-border/70 bg-muted/[0.08]">
        <DiskHistoryValue
          label="Server"
          value={resource.historyDisplayValue ?? "—"}
          valueClassName={resource.valueClassName}
        />
        <DiskHistoryValue
          label="Node"
          value={resource.historySecondaryDisplayValue ?? "—"}
          valueClassName="text-foreground"
        />
      </div>
    )
  }

  return (
    <div className="grid h-12 grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] divide-x divide-border/55 border-b border-border/70 bg-muted/[0.08]">
      <HistoryStat
        align="left"
        label="Now"
        value={resource.historyDisplayValue ?? resource.displayValue}
        valueClassName={resource.valueClassName}
      />
      <HistoryStat
        label="Avg"
        value={
          average === null ? "—" : formatHistoryValue(resource.id, average)
        }
      />
      <HistoryStat
        label="Peak"
        value={peak === null ? "—" : formatHistoryValue(resource.id, peak)}
      />
    </div>
  )
}

function DiskHistoryValue({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName: string
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
      <span className="type-technical-label text-muted-foreground">
        {label}
      </span>
      <span
        className={`type-code truncate leading-none font-medium tracking-[-0.035em] tabular-nums ${valueClassName}`}
      >
        {value}
      </span>
    </div>
  )
}

function HistoryStat({
  align = "right",
  label,
  value,
  valueClassName = "text-foreground",
}: {
  align?: "left" | "right"
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div
      className={`flex min-w-0 flex-col justify-center gap-1 px-2 ${align === "left" ? "text-left" : "text-right"}`}
    >
      <span className="type-technical-label text-muted-foreground">
        {label}
      </span>
      <span
        className={`type-code truncate leading-none font-medium tracking-[-0.025em] tabular-nums ${valueClassName}`}
      >
        {value}
      </span>
    </div>
  )
}

function NetworkHistoryValue({
  direction,
  value,
}: {
  direction: "down" | "up"
  value: number | null
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
      <span className="type-technical-label text-muted-foreground">
        {direction === "down" ? "↓ In" : "↑ Out"}
      </span>
      <span
        className={`type-code truncate leading-none font-medium tracking-[-0.035em] tabular-nums ${direction === "down" ? "text-cyan-200" : "text-primary"}`}
      >
        {value === null ? "—" : formatBytesPerSecond(value)}
      </span>
    </div>
  )
}

function formatHistoryValue(
  resource: ResourceItem["id"],
  value: number
): string {
  return resource === "network"
    ? formatBytesPerSecond(value)
    : formatPercent(value)
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "—"
  if (value >= 100) return `${Math.round(value)}%`
  return `${value.toFixed(value < 10 ? 1 : 0)}%`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function resourceByteValue(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "0", unit: "B" }
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** exponent
  return {
    value: String(Number(value.toPrecision(3))),
    unit: units[exponent] ?? "B",
  }
}

function formatResourceBytePair(usedBytes: number, totalBytes: number): string {
  const used = resourceByteValue(usedBytes)
  const total = resourceByteValue(totalBytes)
  return used.unit === total.unit
    ? `${used.value} / ${total.value} ${total.unit}`
    : `${used.value} ${used.unit} / ${total.value} ${total.unit}`
}

function formatBytesPerSecond(bytes: number): string {
  return `${formatBytes(bytes)}/s`
}

function formatCompactBytesPerSecond(bytes: number): string {
  return formatBytesPerSecond(bytes).replace(" ", "")
}

function formatUptime(totalSeconds: number): string {
  const totalMinutes = Math.floor(totalSeconds / 60)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function networkActivityPercent(bytesPerSecond: number): number {
  if (bytesPerSecond <= 0) return 0
  return Math.min(
    (Math.log10(bytesPerSecond + 1) / Math.log10(10 * 1024 * 1024 + 1)) * 100,
    100
  )
}
