import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link, useParams, useRouterState } from "@tanstack/react-router"
import { TriangleAlert } from "lucide-react"
import { Effect, Queue, Stream } from "effect"
import {
  shouldWaitForRelayBrowserAuthorization,
  relayBrowserAuthorizationChanges,
} from "@/lib/authenticated-relay-socket"
import type { RelayObservedState } from "@workspace/contracts"
import { relayInstanceLifecycleEventTime } from "@workspace/contracts"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

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
  ResourceMeterStrip,
  UptimeMeter,
  resourceItem,
  type ResourceId,
} from "@/components/resource-meters"
import { PageContent } from "@/components/page-content"
import { ProvisioningProgress } from "@/components/provisioning-progress"
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
import {
  beginPendingPowerAction,
  finishPendingPowerAction,
  isPowerControlLocked,
  reconcilePendingPowerInstance,
  type ServerAction,
} from "@/lib/instance-power-state"
import { openRelayResourceStream } from "@/lib/relay-resource-stream"
import {
  createResourceHistoryRecorder,
  resourceHistoryStore,
  type ResourceHistoryStore,
} from "@/lib/resource-history-store"
import {
  accessCapabilitiesQueryOptions,
  replaceRelaySnapshotInstance,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import {
  selectInstanceObservedState,
  selectInstanceWorkspaceInstance,
} from "@/lib/relay-selectors"
import {
  cachedRelayInstance,
  knownServer,
  updateRelaySnapshots,
  type KnownServer,
} from "@/lib/server-workspace"
import {
  selectServerRelayConnected,
  useRouteServerId,
  useServerRelay,
  useServerSnapshot,
} from "@/lib/use-server-workspace"
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
  const { data: relayConnected = false } = useServerRelay(
    selectServerRelayConnected
  )

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
  // Completes a fresh tab's open. A client navigation shown here never
  // resolves its route, because the router waits for the matches this
  // replaces to render, so that open still ends at its timeout.
  return (
    <>
      <PageContent
        view={
          instance.provisioning.phase === "failed" ? "unavailable" : "waiting"
        }
      />
      <ProvisioningProgress
        id={instance.id}
        kind="server"
        name={instance.name}
        provisioning={instance.provisioning}
        relayId={instance.relayId}
      />
    </>
  )
}

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
            const record = createResourceHistoryRecorder(
              resourceHistoryStore(instance.relayId, instance.id)
            )
            return openRelayResourceStream(instance.relayId, instance.id).pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  retryDelay = 500
                  if (
                    !record({
                      sequence: event.sequence,
                      history: event.history,
                      resources: event.instance.resources,
                    })
                  ) {
                    return
                  }
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
                    updateRelaySnapshots(queryClient, (snapshot) => {
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
                    })
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
  const known = useKnownRouteServer(instance === undefined)

  return (
    <WorkspaceHeader
      identity={
        <InstanceIdentityBoundary
          error={error}
          instance={instance}
          known={known}
        />
      }
      center={<LiveResourceMetersBoundary instance={instance} />}
      actions={
        <InstancePowerControlsBoundary instance={instance} onError={setError} />
      }
    />
  )
}

// A server the page knows from the directory, shown while its own read is in
// flight after the route opened at once.
function useKnownRouteServer(pending: boolean) {
  const queryClient = useQueryClient()
  const serverId = useRouteServerId()
  return React.useMemo(
    () =>
      pending && serverId
        ? knownServer(queryClient, serverId)?.server
        : undefined,
    [pending, queryClient, serverId]
  )
}

function useRouteWorkspaceInstance() {
  const serverId = useRouteServerId()
  const selectInstance = React.useMemo(
    () => selectInstanceWorkspaceInstance(serverId ?? ""),
    [serverId]
  )
  const { data: instance } = useServerSnapshot(selectInstance)
  return instance
}

const InstanceIdentityBoundary = React.memo(function InstanceIdentityBoundary({
  error,
  instance,
  known,
}: {
  error: string | null
  instance: InstanceWorkspaceInstance | null | undefined
  known: KnownServer | undefined
}) {
  // The same element whether known or read, so the name never remounts.
  const shown = instance ?? known
  return shown ? (
    <InstanceIdentity
      key={`${shown.relayId}:${shown.id}`}
      error={error}
      instance={shown}
      statusConfirmed={Boolean(instance)}
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
  statusConfirmed,
}: {
  error: string | null
  instance: Pick<
    InstanceWorkspaceInstance,
    "connectAddress" | "id" | "implementation" | "name" | "shortId" | "version"
  >
  // The server's own read carries its live state; the directory does not.
  statusConfirmed: boolean
}) {
  return (
    <WorkspaceIdentity
      error={error}
      name={instance.name}
      statusConfirmed={statusConfirmed}
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
  const { data: observedState } = useServerSnapshot(selectObservedState)
  const { data: relayConnected = false } = useServerRelay(
    selectServerRelayConnected
  )
  const relayActionMutation = useMutation({
    mutationFn: performRelayAction,
    onSuccess: (updated) => {
      const reconciled = reconcilePendingPowerInstance(
        instance.relayId,
        updated
      )
      updateRelaySnapshots(queryClient, (snapshot) =>
        replaceRelaySnapshotInstance(snapshot, reconciled)
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
      const previousInstance = cachedRelayInstance(
        queryClient,
        instance.relayId,
        instance.id
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
      updateRelaySnapshots(queryClient, (snapshot) =>
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
                updateRelaySnapshots(queryClient, (snapshot) =>
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
        className="flex shrink-0 items-center justify-end gap-1.5"
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
    <ResourceMeterStrip
      columns={4}
      label="Server resource usage"
      uptime={<InstanceUptimeMeter instanceId={instanceId} relayId={relayId} />}
    >
      {SERVER_RESOURCE_IDS.map((resourceId) => (
        <LiveResourceMeter
          key={resourceId}
          instanceId={instanceId}
          relayId={relayId}
          resourceId={resourceId}
          historyStore={historyStore}
        />
      ))}
    </ResourceMeterStrip>
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
  const { data: observedState } = useServerSnapshot(selectObservedState)
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
  const { data: runtime } = useServerSnapshot(selectRuntime)

  return (
    <UptimeMeter
      label="Instance uptime"
      running={runtime?.running ?? false}
      startedAt={runtime?.startedAt ?? null}
    />
  )
}
