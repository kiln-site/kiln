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
import { relayServerLifecycleEventTime } from "@workspace/contracts"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  FileTreePreferencesContext,
  ServerIdentityContext,
  ServerPermissionsContext,
  ServerRelayConnectedContext,
} from "@/components/server-workspace-context"
import type {
  FileTreePreferences,
  ServerWorkspacePermissions,
} from "@/components/server-workspace-context"
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
  reconcilePendingPowerServer,
  type ServerAction,
} from "@/lib/server-power-state"
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
  selectServerObservedState,
  selectWorkspaceServer,
} from "@/lib/relay-selectors"
import {
  cachedRelayServer,
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
import type { WorkspaceServer } from "@/lib/relay-selectors"
import { performRelayAction } from "@/server/relay"

export function ServerWorkspace({
  children,
  instance,
  fileTreePreferences,
  permissions,
}: {
  children: React.ReactNode
  instance: WorkspaceServer
  fileTreePreferences: FileTreePreferences
  permissions: ServerWorkspacePermissions
}) {
  return (
    <ServerIdentityContext.Provider value={instance}>
      <ServerPermissionsContext.Provider value={permissions}>
        <FileTreePreferencesContext.Provider value={fileTreePreferences}>
          <ServerRelayConnectionBoundary instance={instance}>
            <ServerProvisioningBoundary instance={instance}>
              {children}
            </ServerProvisioningBoundary>
          </ServerRelayConnectionBoundary>
        </FileTreePreferencesContext.Provider>
      </ServerPermissionsContext.Provider>
    </ServerIdentityContext.Provider>
  )
}

export const ServerWorkspaceShell = React.memo(function ServerWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <WorkspaceFrame header={<ServerWorkspaceHeader />}>
      <div data-slot="server-workspace-surface" className="contents">
        {children}
      </div>
    </WorkspaceFrame>
  )
})

function ServerRelayConnectionBoundary({
  children,
  instance,
}: {
  children: React.ReactNode
  instance: WorkspaceServer
}) {
  const { data: relayConnected = false } = useServerRelay(
    selectServerRelayConnected
  )

  return (
    <ServerRelayConnectedContext.Provider value={relayConnected}>
      {!instance.provisioning ? (
        <RelayResourceStreamController
          instance={instance}
          relayConnected={relayConnected}
        />
      ) : null}
      {children}
    </ServerRelayConnectedContext.Provider>
  )
}

function ServerProvisioningBoundary({
  children,
  instance,
}: {
  children: React.ReactNode
  instance: WorkspaceServer
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
  instance: WorkspaceServer
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
                  const streamedInstance = reconcilePendingPowerServer(
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

function ServerWorkspaceHeader() {
  const [error, setError] = React.useState<string | null>(null)
  const instance = useRouteWorkspaceServer()
  const known = useKnownRouteServer(instance === undefined)

  return (
    <WorkspaceHeader
      identity={
        <ServerIdentityBoundary
          error={error}
          instance={instance}
          known={known}
        />
      }
      center={<LiveResourceMetersBoundary instance={instance} />}
      actions={
        <ServerPowerControlsBoundary instance={instance} onError={setError} />
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
      pending && serverId ? knownServer(queryClient, serverId) : undefined,
    [pending, queryClient, serverId]
  )
}

function useRouteWorkspaceServer() {
  const serverId = useRouteServerId()
  const selectInstance = React.useMemo(
    () => selectWorkspaceServer(serverId ?? ""),
    [serverId]
  )
  const { data: instance } = useServerSnapshot(selectInstance)
  return instance
}

const ServerIdentityBoundary = React.memo(function ServerIdentityBoundary({
  error,
  instance,
  known,
}: {
  error: string | null
  instance: WorkspaceServer | null | undefined
  known: KnownServer | undefined
}) {
  // The same element whether known or read, so the name never remounts.
  const shown = instance ?? known
  return shown ? (
    <ServerIdentity
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
    instance: WorkspaceServer | null | undefined
  }) {
    return instance ? (
      <LiveResourceMeters instanceId={instance.id} relayId={instance.relayId} />
    ) : null
  }
)

const ServerPowerControlsBoundary = React.memo(
  function ServerPowerControlsBoundary({
    instance,
    onError,
  }: {
    instance: WorkspaceServer | null | undefined
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
            `server.power.${action}`
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
      <ServerPowerControls
        powerPermissions={powerPermissions}
        instance={instance}
        onError={onError}
      />
    ) : null
  }
)

function ServerAddressControl({ address }: { address: string }) {
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

function ServerIdentity({
  error,
  instance,
  statusConfirmed,
}: {
  error: string | null
  instance: Pick<
    WorkspaceServer,
    "connectAddress" | "id" | "implementation" | "name" | "version"
  >
  // The server's own read carries its live state; the directory does not.
  statusConfirmed: boolean
}) {
  return (
    <WorkspaceIdentity
      error={error}
      name={instance.name}
      statusConfirmed={statusConfirmed}
      title={<ServerRouteTitle />}
    >
      <span className="hidden shrink-0 items-center gap-1.5 @[30rem]:inline-flex">
        <span>
          {instance.implementation} {instance.version}
        </span>
        <WorkspaceMetaSeparator />
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
        <WorkspaceIdCopyButton id={instance.id} label="server ID" />
        <WorkspaceMetaSeparator />
      </span>
      <ServerAddressControl address={instance.connectAddress} />
    </WorkspaceIdentity>
  )
}

function ServerRouteTitle() {
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

function ServerPowerControls({
  powerPermissions,
  instance,
  onError,
}: {
  powerPermissions: Record<ServerAction, boolean>
  instance: WorkspaceServer
  onError: (error: string | null) => void
}) {
  const queryClient = useQueryClient()
  const selectObservedState = React.useMemo(
    () => selectServerObservedState(instance.id, instance.relayId),
    [instance.id, instance.relayId]
  )
  const { data: observedState } = useServerSnapshot(selectObservedState)
  const { data: relayConnected = false } = useServerRelay(
    selectServerRelayConnected
  )
  const relayActionMutation = useMutation({
    mutationFn: performRelayAction,
    onSuccess: (updated) => {
      const reconciled = reconcilePendingPowerServer(instance.relayId, updated)
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
      const previousInstance = cachedRelayServer(
        queryClient,
        instance.relayId,
        instance.id
      )
      const pendingPowerAction = beginPendingPowerAction(
        instance.relayId,
        instance.id,
        nextAction,
        relayServerLifecycleEventTime(
          previousInstance?.lifecycle ?? [],
          "started"
        )
      )
      updateRelaySnapshots(queryClient, (snapshot) =>
        updateServerPowerState(
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
                  updateServerPowerState(
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
      restartButton
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

function updateServerPowerState(
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
      uptime={<ServerUptimeMeter instanceId={instanceId} relayId={relayId} />}
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

function ServerUptimeMeter({
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
            startedAt: relayServerLifecycleEventTime(
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
