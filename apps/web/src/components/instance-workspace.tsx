import * as React from "react"
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
import {
  ResourceMeter,
  UptimeMeter,
  resourceItem,
  type ResourceId,
} from "@/components/resource-meters"
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
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { performRelayAction } from "@/server/relay"

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

const SERVER_RESOURCE_IDS: Array<ResourceId> = [
  "cpu",
  "memory",
  "storage",
  "network",
]

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
        {SERVER_RESOURCE_IDS.map((resourceId) => (
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
  const resource = resourceItem(resources, resourceId, {
    unavailable: observedState === "running" ? "Sampling" : "Stopped",
  })

  return <ResourceMeter resource={resource} historyStore={historyStore} />
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
            running: instance.observedState === "running",
            startedAt: relayInstanceLifecycleEventTime(
              instance.lifecycle,
              "started"
            ),
          }
        : null
    },
    [instanceId, relayId]
  )
  const { data: runtime } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectRuntime,
  })

  return (
    <UptimeMeter
      label="Instance uptime"
      running={runtime?.running ?? false}
      startedAt={runtime?.startedAt ?? null}
    />
  )
}
