import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import { CircleAlert, LoaderCircle, Plus, RotateCw } from "lucide-react"
import {
  instanceTailscaleMemberId,
  relayInstancePortInputSchema,
  isTailscaleNode,
} from "@workspace/contracts"
import type {
  RelayInstancePendingPrimaryPort,
  RelayInstancePortAllocation,
  RelayInstancePortInput,
  RelayInstancePortLease,
  RelayInstancePortProtocol,
  RelayInstanceWebRouteInput,
  RelayInstanceWebRouteState,
} from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { forkPromise, recoverPromise } from "@/effect/promise"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  useInstanceIdentity,
  useInstancePermissions,
  useInstanceRelayConnected,
} from "@/components/instance-workspace-context"
import {
  JoinAddressSection,
  usePrimaryJoinHostname,
} from "@/components/join-address-section"
import {
  formatHostPort,
  formatPortProtocol,
  PortFields,
  PortRow,
  PortRowActions,
  PortsDivider,
  PortsNote,
  PortsSection,
  PortsTable,
  RemovePortDialog,
  type PortNotice,
} from "@/components/ports-section"
import {
  TailscaleMembershipSection,
  type TailscaleMember,
} from "@/components/tailscale-network-membership"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import {
  WebRoutesSection,
  type WebRouteProxyChange,
  type WebRouteRow,
} from "@/components/web-routes-section"
import {
  accessCapabilitiesQueryOptions,
  webRoutesQueryOptions,
  queryKeys,
  replaceRelaySnapshotInstance,
} from "@/lib/query-options"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import {
  invalidateRelaySnapshots,
  updateRelaySnapshots,
} from "@/lib/server-workspace"
import { useServerSnapshot } from "@/lib/use-server-workspace"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  performRelayAction,
  removeInstanceDatabaseConnection,
  releaseInstancePort,
  reserveInstancePort,
  updateInstancePorts,
} from "@/server/relay"
import { updateWebRoutes } from "@/server/domains"

export function InstanceNetworkPage({
  editGamePort = false,
}: {
  editGamePort?: boolean
}) {
  const instance = useInstanceIdentity()
  const { data: isPlatformAdmin } = useSuspenseQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })

  if (isTailscaleNode(instance)) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-background/55 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          This internal service is managed from Infrastructure → Tailscale.
        </p>
      </div>
    )
  }

  return (
    <WebRoutesNetworkPage
      editGamePort={editGamePort}
      showTailscale={isPlatformAdmin}
    />
  )
}

function WebRoutesNetworkPage({
  editGamePort,
  showTailscale,
}: {
  editGamePort: boolean
  showTailscale: boolean
}) {
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()
  const dnsResource = React.useMemo(
    () => ({
      relayId: instance.relayId,
      resourceId: instance.id,
      resourceType: "instance" as const,
    }),
    [instance.id, instance.relayId]
  )
  const queryClient = useQueryClient()
  const queryKey = React.useMemo(
    () => queryKeys.relay.webRoutes(instance.relayId, instance.id),
    [instance.id, instance.relayId]
  )
  const routes = useQuery({
    ...webRoutesQueryOptions(dnsResource),
    enabled: permissions.networkRead,
  })
  const update = useMutation({
    mutationFn: ({
      proxy,
      routes: next,
    }: {
      proxy?: WebRouteProxyChange
      routes: Array<RelayInstanceWebRouteInput>
    }) => updateWebRoutes({ data: { ...dnsResource, proxy, routes: next } }),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  })
  const restart = useMutation({
    mutationFn: () =>
      performRelayAction({
        data: {
          action: "restart",
          instanceId: instance.id,
          relayId: instance.relayId,
        },
      }),
    onSuccess: async (updated) => {
      updateRelaySnapshots(queryClient, (snapshot) =>
        replaceRelaySnapshotInstance(snapshot, updated)
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        invalidateRelaySnapshots(queryClient),
      ])
    },
  })
  const restartPendingRoutes = React.useCallback(() => {
    if (!permissions.powerRestart || !relayConnected || restart.isPending)
      return
    restart.mutate()
  }, [permissions.powerRestart, relayConnected, restart])

  const saveWebRoutes = React.useCallback(
    (next: Array<WebRouteRow>, proxy?: WebRouteProxyChange) =>
      update.mutateAsync({
        proxy,
        routes: next.map(({ service: _service, ...route }) => route),
      }),
    [update]
  )

  if (!permissions.networkRead) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-background/55">
        <p className="text-sm text-muted-foreground">
          You do not have permission to view network routes.
        </p>
      </div>
    )
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background/55 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <DatabaseConnectionWarnings />
        <SavedDatabaseConnections />
        <JoinAddressSection />
        <ConfiguredRoutesSection
          key={editGamePort ? "edit-game-port" : "network"}
          canPublicPortWrite={permissions.networkPublicPortWrite}
          canRestart={permissions.powerRestart && relayConnected}
          canWrite={permissions.networkWrite}
          editGamePort={editGamePort}
          instance={instance}
          relayConnected={relayConnected}
          restarting={restart.isPending}
          onRestart={restartPendingRoutes}
        />
        <WebRoutesSection
          // Another server's routes start fresh, Undo included.
          key={`${instance.relayId}:${instance.id}`}
          canWrite={
            permissions.networkWrite &&
            instance.managedByRelay &&
            relayConnected
          }
          dnsResource={dnsResource}
          error={routes.error}
          kind="server"
          routes={routes.data?.routes}
          status={routes.data ? serverWebRouteStatus(routes.data) : null}
          statusAction={
            routes.data && routes.data.status !== "ready" ? (
              <RouteStatusButton
                canRestart={permissions.powerRestart && relayConnected}
                restarting={restart.isPending}
                state={routes.data}
                onRestart={restartPendingRoutes}
              />
            ) : null
          }
          onSave={saveWebRoutes}
        />
        {showTailscale ? <GameServerTailscale instance={instance} /> : null}
      </div>
    </main>
  )
}

const noDatabaseWarnings: ReadonlyArray<string> = []

function DatabaseConnectionWarnings() {
  const instance = useInstanceIdentity()
  const select = React.useCallback(
    (snapshot: RelayFleetSnapshot) =>
      snapshot.instances.find(
        (server) =>
          server.id === instance.id && server.relayId === instance.relayId
      )?.databaseConnectionWarnings ?? noDatabaseWarnings,
    [instance.id, instance.relayId]
  )
  const { data: warnings = noDatabaseWarnings } = useServerSnapshot(select)
  if (warnings.length === 0) return null
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm light:bg-amber-500/10"
    >
      <p className="font-medium">Some database connections are unavailable</p>
      <p className="mt-1 text-muted-foreground">
        Saved connections are retained and retried on the next start or restart.
        Retry connecting from the Databases page, or remove the saved connection
        below.
      </p>
      <ul className="mt-2 list-inside list-disc break-all text-muted-foreground">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}

const noSavedDatabaseConnections: NonNullable<
  RelayFleetSnapshot["instances"][number]["savedDatabaseConnections"]
> = []

function SavedDatabaseConnections() {
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()
  const queryClient = useQueryClient()
  const select = React.useCallback(
    (snapshot: RelayFleetSnapshot) =>
      snapshot.instances.find(
        (server) =>
          server.id === instance.id && server.relayId === instance.relayId
      )?.savedDatabaseConnections ?? noSavedDatabaseConnections,
    [instance.id, instance.relayId]
  )
  const { data: connections = noSavedDatabaseConnections } =
    useServerSnapshot(select)
  const remove = useMutation({
    mutationFn: (connection: (typeof connections)[number]) =>
      removeInstanceDatabaseConnection({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          databaseId: connection.databaseId,
          databaseRelayId: connection.relayId,
        },
      }),
    onSuccess: (updated) => {
      updateRelaySnapshots(queryClient, (snapshot) =>
        replaceRelaySnapshotInstance(snapshot, updated)
      )
      forkPromise(() =>
        queryClient.invalidateQueries({
          queryKey: instanceInventoryScope({ kind: "database" }),
        })
      )
      showToast({
        type: "success",
        message: "Saved database connection removed",
      })
    },
    onError: (error) =>
      showToast({
        type: "error",
        message: `Could not remove the saved database connection: ${error.message}`,
      }),
  })
  if (connections.length === 0) return null
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-medium">Saved database connections</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Removing a connection stops automatic retries and disconnects this
        server when the network is available. The database is kept.
      </p>
      <ul className="mt-3 divide-y">
        {connections.map((connection) => (
          <li
            key={`${connection.relayId}:${connection.databaseId}`}
            className="flex items-center justify-between gap-4 py-3"
          >
            <div className="min-w-0 text-sm">
              <p className="font-mono break-all">{connection.databaseId}</p>
              {connection.relayId !== instance.relayId ? (
                <p className="text-xs break-all text-muted-foreground">
                  Relay: {connection.relayId}
                </p>
              ) : null}
            </div>
            {permissions.networkWrite ? (
              <Button
                size="sm"
                variant="outline"
                aria-label={`Remove saved connection to ${connection.databaseId}`}
                disabled={!relayConnected || remove.isPending}
                onClick={() => remove.mutate(connection)}
              >
                Remove
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

type RouteDialogState =
  | { mode: "add" }
  | { allocation: RelayInstancePortAllocation; mode: "edit-port" }
  | { mode: "recover-primary" }
  | null

type PendingNetworkRoute = {
  internalPort: number
  kind: "port"
  name: string
  protocol: RelayInstancePortProtocol
  publicPort?: number
}

type AddedNetworkRoute =
  | {
      allocation: RelayInstancePortAllocation
      clientId: string
      kind: "port"
      status: "ready"
    }
  | {
      clientId: string
      kind: "port"
      route: PendingNetworkRoute
      status: "pending"
    }

type RouteRemovalState = {
  allocation: RelayInstancePortAllocation
  kind: "port"
  placement: { source: "added" } | { index: number; source: "server" }
  phase: "confirming" | "removing"
}

function portRemovalKey(id: string) {
  return `port:${id}`
}

const ConfiguredRoutesSection = React.memo(function ConfiguredRoutesSection({
  canRestart,
  canPublicPortWrite,
  canWrite,
  editGamePort,
  instance,
  relayConnected,
  restarting,
  onRestart,
}: {
  canRestart: boolean
  canPublicPortWrite: boolean
  canWrite: boolean
  editGamePort: boolean
  instance: InstanceWorkspaceInstance
  relayConnected: boolean
  restarting: boolean
  onRestart: () => void
}) {
  const navigate = useNavigate({ from: "/server/$serverId/network" })
  const queryClient = useQueryClient()
  // Its ports are shown at the name players join by, or at the Relay's.
  const publicHost = usePrimaryJoinHostname() ?? instance.publicHost
  const primaryPort = instance.ports.find(
    (allocation) => allocation.kind === "primary"
  )
  const pendingPrimaryPort = primaryPort
    ? undefined
    : instance.pendingPrimaryPort
  const [dialog, setDialog] = React.useState<RouteDialogState>(() =>
    editGamePort && canWrite
      ? primaryPort
        ? { allocation: primaryPort, mode: "edit-port" }
        : { mode: "recover-primary" }
      : null
  )
  const [addedRoutes, setAddedRoutes] = React.useState<
    Array<AddedNetworkRoute>
  >([])
  const addedRouteSequence = React.useRef(0)
  const [removal, setRemoval] = React.useState<RouteRemovalState | null>(null)
  const [removedRouteKeys, setRemovedRouteKeys] = React.useState<
    ReadonlySet<string>
  >(() => new Set())
  const clearEditGamePortIntent = React.useCallback(() => {
    if (!editGamePort) return
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, edit: undefined }),
    })
  }, [editGamePort, navigate])
  const update = useMutation({
    mutationFn: (ports: Array<RelayInstancePortInput>) =>
      updateInstancePorts({
        data: {
          instanceId: instance.id,
          ports,
          relayId: instance.relayId,
        },
      }),
    onSuccess: async (updated) => {
      updateRelaySnapshots(queryClient, (snapshot) =>
        replaceRelaySnapshotInstance(snapshot, updated)
      )
      setDialog(null)
      clearEditGamePortIntent()
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.relay.connection,
        }),
        invalidateRelaySnapshots(queryClient),
      ])
      showToast({
        description: updated.pendingPrimaryPort
          ? "Restart the server when you are ready to apply it."
          : undefined,
        message: updated.pendingPrimaryPort
          ? "Default Server saved"
          : "Ports saved",
        type: "success",
      })
    },
  })
  const disabled =
    !canWrite || !instance.managedByRelay || !relayConnected || update.isPending
  const portInputs = React.useMemo(
    () =>
      instance.ports.map(({ id, internalPort, name, protocol }) => ({
        id,
        internalPort,
        name,
        protocol,
      })),
    [instance.ports]
  )
  const applyPort = React.useCallback(
    async (port: RelayInstancePortInput) => {
      const ports =
        dialog?.mode === "edit-port"
          ? portInputs.map((existing) =>
              existing.id === dialog.allocation.id ? port : existing
            )
          : dialog?.mode === "recover-primary"
            ? [port, ...portInputs]
            : [...portInputs, port]
      await update.mutateAsync(ports)
    },
    [dialog, portInputs, update]
  )
  const addPort = React.useCallback(
    async (port: RelayInstancePortInput) => {
      setAddedRoutes((current) =>
        current.map((route) =>
          route.kind === "port" && route.status === "pending"
            ? {
                ...route,
                route: { ...route.route, publicPort: port.externalPort },
              }
            : route
        )
      )
      return Effect.runPromise(
        Effect.tryPromise({
          try: () => update.mutateAsync([...portInputs, port]),
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap((updated) =>
            Effect.try({
              try: () => {
                const allocation = updated.ports.find(
                  (candidate) =>
                    candidate.kind === "custom" &&
                    candidate.externalPort === port.externalPort
                )
                if (!allocation) {
                  throw new Error(
                    "Relay did not return the new port allocation"
                  )
                }
                setAddedRoutes((current) =>
                  current.map((route) =>
                    route.kind === "port" && route.status === "pending"
                      ? {
                          allocation,
                          clientId: route.clientId,
                          kind: "port",
                          status: "ready",
                        }
                      : route
                  )
                )
              },
              catch: (cause) => cause,
            })
          ),
          Effect.tapError(() =>
            Effect.sync(() =>
              setAddedRoutes((current) =>
                current.filter(
                  (route) => route.kind !== "port" || route.status !== "pending"
                )
              )
            )
          ),
          Effect.asVoid
        )
      )
    },
    [portInputs, update]
  )
  const removePort = React.useCallback(
    (allocation: RelayInstancePortAllocation) => {
      if (allocation.kind !== "custom" || disabled) return
      const added = addedRoutes.some(
        (route) =>
          route.kind === "port" &&
          route.status === "ready" &&
          route.allocation.id === allocation.id
      )
      setRemoval({
        allocation,
        kind: "port",
        phase: "confirming",
        placement: added
          ? { source: "added" }
          : {
              index: Math.max(
                instance.ports.findIndex(
                  (current) => current.id === allocation.id
                ),
                0
              ),
              source: "server",
            },
      })
    },
    [addedRoutes, disabled, instance.ports]
  )
  const editPort = React.useCallback(
    (allocation: RelayInstancePortAllocation) => {
      update.reset()
      setDialog({ allocation, mode: "edit-port" })
    },
    [update]
  )
  const recoverPrimaryPort = React.useCallback(() => {
    update.reset()
    setDialog({ mode: "recover-primary" })
  }, [update])
  const confirmRemoval = React.useCallback(async () => {
    if (!removal || removal.phase !== "confirming") return
    setRemoval({ ...removal, phase: "removing" })
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          await update.mutateAsync(
            portInputs.filter((port) => port.id !== removal.allocation.id)
          )
          setRemovedRouteKeys((current) => {
            const next = new Set(current)
            next.add(portRemovalKey(removal.allocation.id))
            return next
          })
          setAddedRoutes((current) =>
            current.filter(
              (route) =>
                route.status !== "ready" ||
                route.allocation.id !== removal.allocation.id
            )
          )
        },
        catch: (cause) => cause,
      }).pipe(
        // Mutation state renders the Relay error below the table.
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.ensuring(Effect.sync(() => setRemoval(null)))
      )
    )
  }, [portInputs, removal, update])

  return (
    <PortsSection
      action={
        canWrite ? (
          <Button
            disabled={
              disabled ||
              primaryPort === undefined ||
              instance.ports.length >= 16 ||
              addedRoutes.some(({ status }) => status === "pending")
            }
            onClick={() => {
              update.reset()
              setDialog({ mode: "add" })
            }}
            size="sm"
            type="button"
          >
            <Plus />
            Add port
          </Button>
        ) : null
      }
      footer={
        !relayConnected ? (
          <PortsNote tone="warning">
            Port changes are unavailable while this Relay is disconnected.
          </PortsNote>
        ) : update.error && dialog === null ? (
          <PortsNote tone="error">{errorMessage(update.error)}</PortsNote>
        ) : null
      }
    >
      <ConfiguredRoutesTable
        addedRoutes={addedRoutes}
        canWrite={canWrite}
        disabled={disabled}
        instance={instance}
        publicHost={publicHost}
        canRestart={canRestart}
        restarting={restarting}
        removal={removal?.phase === "removing" ? removal : null}
        removedRouteKeys={removedRouteKeys}
        onEditPort={editPort}
        onRecoverPrimaryPort={recoverPrimaryPort}
        onRemovePort={removePort}
        onRestart={onRestart}
      />

      {dialog?.mode === "add" ? (
        <AddPortDialog
          canEditPublicPort={canPublicPortWrite}
          error={update.error ? errorMessage(update.error) : null}
          pending={update.isPending}
          instanceId={instance.id}
          relayId={instance.relayId}
          onOpenChange={(open) => {
            if (!open && !update.isPending) setDialog(null)
          }}
          onBeginSubmit={(route) => {
            addedRouteSequence.current += 1
            const clientId = `added-route-${addedRouteSequence.current}`
            setAddedRoutes((current) => [
              ...current,
              { clientId, kind: "port", route, status: "pending" },
            ])
          }}
          onCancelSubmit={() => {
            setAddedRoutes((current) =>
              current.filter(({ status }) => status !== "pending")
            )
          }}
          onSubmitPort={addPort}
        />
      ) : null}
      <PortAllocationDialog
        key={
          dialog?.mode === "edit-port"
            ? dialog.allocation.id
            : dialog?.mode === "recover-primary"
              ? "recover-primary"
              : "closed"
        }
        allocation={dialog?.mode === "edit-port" ? dialog.allocation : null}
        canEditPublicPort={canPublicPortWrite}
        error={update.error ? errorMessage(update.error) : null}
        open={
          dialog?.mode === "edit-port" || dialog?.mode === "recover-primary"
        }
        pending={update.isPending}
        instanceId={instance.id}
        pendingPrimaryPort={
          dialog?.mode === "recover-primary"
            ? (pendingPrimaryPort ?? null)
            : null
        }
        recoveringPrimary={dialog?.mode === "recover-primary"}
        relayId={instance.relayId}
        onOpenChange={(open) => {
          if (!open && !update.isPending) {
            setDialog(null)
            clearEditGamePortIntent()
          }
        }}
        onSubmit={applyPort}
      />
      {removal ? (
        <RemovePortDialog
          address={
            publicHost
              ? formatHostPort(publicHost, removal.allocation.externalPort)
              : String(removal.allocation.externalPort)
          }
          name={removal.allocation.name}
          open={removal.phase === "confirming"}
          onConfirm={() => void confirmRemoval()}
          onOpenChange={(open) => {
            if (!open && removal.phase === "confirming") setRemoval(null)
          }}
        />
      ) : null}
    </PortsSection>
  )
})

const ConfiguredRoutesTable = React.memo(function ConfiguredRoutesTable({
  addedRoutes,
  canRestart,
  canWrite,
  disabled,
  instance,
  publicHost,
  restarting,
  removal,
  removedRouteKeys,
  onEditPort,
  onRecoverPrimaryPort,
  onRemovePort,
  onRestart,
}: {
  addedRoutes: Array<AddedNetworkRoute>
  canRestart: boolean
  canWrite: boolean
  disabled: boolean
  instance: InstanceWorkspaceInstance
  publicHost: string | undefined
  restarting: boolean
  removal: RouteRemovalState | null
  removedRouteKeys: ReadonlySet<string>
  onEditPort: (allocation: RelayInstancePortAllocation) => void
  onRecoverPrimaryPort: () => void
  onRemovePort: (allocation: RelayInstancePortAllocation) => void
  onRestart: () => void
}) {
  const primaryPort = instance.ports.find(
    (allocation) => allocation.kind === "primary"
  )
  const pendingPrimaryPort = primaryPort
    ? undefined
    : instance.pendingPrimaryPort
  const displayedPrimaryPort = primaryPort ?? pendingPrimaryPort
  const displayedPorts = React.useMemo(() => {
    const current = instance.ports.filter(
      (allocation) => !removedRouteKeys.has(portRemovalKey(allocation.id))
    )
    if (
      removal?.kind !== "port" ||
      removal.placement.source !== "server" ||
      current.some((allocation) => allocation.id === removal.allocation.id)
    ) {
      return current
    }
    const next = [...current]
    next.splice(
      Math.min(removal.placement.index, next.length),
      0,
      removal.allocation
    )
    return next
  }, [instance.ports, removal, removedRouteKeys])
  const displayedAddedRoutes = React.useMemo(
    () =>
      addedRoutes.filter(
        (route) =>
          route.status === "pending" ||
          !removedRouteKeys.has(portRemovalKey(route.allocation.id))
      ),
    [addedRoutes, removedRouteKeys]
  )
  const hasAdditionalRoutes =
    displayedPorts.some((allocation) => allocation.kind !== "primary") ||
    displayedAddedRoutes.length > 0

  const primaryNotice = React.useMemo<PortNotice | undefined>(() => {
    if (!displayedPrimaryPort) {
      return {
        label: "View Default Server error",
        tone: "error",
        tooltip: "Default Server needs configuration",
        onClick: () =>
          showToast({
            description:
              "Edit the Default Server to assign its internal port and protocol.",
            message: "Default Server is not configured",
            type: "error",
          }),
      }
    }
    if (!pendingPrimaryPort) return undefined
    return {
      label: "View Default Server restart warning",
      tone: "warning",
      tooltip: "Restart required",
      onClick: () =>
        showPendingRestartToast({
          canRestart,
          message:
            "Restart this server when you are ready to apply its Default Server route.",
          restarting,
          onRestart,
        }),
    }
  }, [
    canRestart,
    displayedPrimaryPort,
    onRestart,
    pendingPrimaryPort,
    restarting,
  ])

  return (
    <PortsTable>
      <PortRow
        actions={
          canWrite ? (
            <PortRowActions
              disabled={disabled}
              name="Default Server"
              onEdit={() => {
                if (primaryPort) onEditPort(primaryPort)
                else onRecoverPrimaryPort()
              }}
            />
          ) : null
        }
        address={
          publicHost && primaryPort
            ? {
                copy: formatHostPort(publicHost, primaryPort.externalPort),
                label: "game server public address",
              }
            : null
        }
        detail={
          displayedPrimaryPort
            ? formatPortProtocol(displayedPrimaryPort.protocol)
            : "Not configured"
        }
        internalPort={displayedPrimaryPort?.internalPort ?? null}
        name="Default Server"
        notice={primaryNotice}
        primary
      />
      {hasAdditionalRoutes ? <PortsDivider /> : null}
      {displayedPorts.map((allocation) => {
        if (
          allocation.kind === "primary" ||
          addedRoutes.some(
            (addedRoute) =>
              addedRoute.kind === "port" &&
              (addedRoute.status === "ready"
                ? addedRoute.allocation.id === allocation.id
                : addedRoute.route.publicPort === allocation.externalPort)
          )
        ) {
          return null
        }
        return (
          <PortRouteRow
            key={allocation.id}
            allocation={allocation}
            canWrite={canWrite}
            deleting={
              removal?.kind === "port" &&
              removal.allocation.id === allocation.id
            }
            disabled={disabled}
            publicHost={publicHost}
            onEdit={onEditPort}
            onRemove={onRemovePort}
          />
        )
      })}
      {displayedAddedRoutes.map((addedRoute) => (
        <AddedRouteRow
          key={addedRoute.clientId}
          addedRoute={addedRoute}
          canWrite={canWrite}
          deleting={
            addedRoute.status === "ready" &&
            removal?.allocation.id === addedRoute.allocation.id
          }
          disabled={disabled}
          instance={instance}
          publicHost={publicHost}
          onEditPort={onEditPort}
          onRemovePort={onRemovePort}
        />
      ))}
    </PortsTable>
  )
})

const PortRouteRow = React.memo(function PortRouteRow({
  allocation,
  canWrite,
  deleting = false,
  disabled,
  publicHost,
  onEdit,
  onRemove,
}: {
  allocation: RelayInstancePortAllocation
  canWrite: boolean
  deleting?: boolean
  disabled: boolean
  publicHost?: string
  onEdit: (allocation: RelayInstancePortAllocation) => void
  onRemove: (allocation: RelayInstancePortAllocation) => void
}) {
  return (
    <PortRow
      actions={
        canWrite ? (
          <PortRowActions
            disabled={disabled || deleting}
            name={allocation.name}
            onEdit={() => onEdit(allocation)}
            onRemove={
              allocation.kind === "custom"
                ? () => onRemove(allocation)
                : undefined
            }
          />
        ) : null
      }
      address={
        publicHost
          ? {
              copy: formatHostPort(publicHost, allocation.externalPort),
              label: `${allocation.name} public address`,
            }
          : null
      }
      busy={deleting ? "Removing" : undefined}
      detail={formatPortProtocol(allocation.protocol)}
      internalPort={allocation.internalPort}
      name={allocation.name}
    />
  )
})

// A port added since the page opened: shown while the Relay adds it, then as
// the Relay reports it.
function AddedRouteRow({
  addedRoute,
  canWrite,
  deleting,
  disabled,
  instance,
  publicHost,
  onEditPort,
  onRemovePort,
}: {
  addedRoute: AddedNetworkRoute
  canWrite: boolean
  deleting: boolean
  disabled: boolean
  instance: InstanceWorkspaceInstance
  publicHost: string | undefined
  onEditPort: (allocation: RelayInstancePortAllocation) => void
  onRemovePort: (allocation: RelayInstancePortAllocation) => void
}) {
  const allocation =
    addedRoute.status === "ready"
      ? (instance.ports.find(({ id }) => id === addedRoute.allocation.id) ??
        addedRoute.allocation)
      : null
  const details = allocation
    ? {
        externalPort: allocation.externalPort,
        internalPort: allocation.internalPort,
        name: allocation.name,
        protocol: allocation.protocol,
      }
    : addedRoute.status === "pending"
      ? {
          externalPort: addedRoute.route.publicPort,
          internalPort: addedRoute.route.internalPort,
          name: addedRoute.route.name,
          protocol: addedRoute.route.protocol,
        }
      : null
  if (!details) return null
  const address =
    publicHost && details.externalPort
      ? formatHostPort(publicHost, details.externalPort)
      : "Allocating…"

  return (
    <PortRow
      actions={
        allocation && canWrite ? (
          <PortRowActions
            disabled={disabled || deleting}
            name={allocation.name}
            onEdit={() => onEditPort(allocation)}
            onRemove={() => onRemovePort(allocation)}
          />
        ) : null
      }
      address={
        allocation
          ? { copy: address, label: `${details.name} public address` }
          : address
      }
      busy={!allocation ? "Adding" : deleting ? "Removing" : undefined}
      detail={formatPortProtocol(details.protocol)}
      internalPort={details.internalPort}
      name={details.name}
    />
  )
}

function usePortLease({
  enabled,
  initialPort,
  instanceId,
  protocol,
  relayId,
}: {
  enabled: boolean
  initialPort?: number
  instanceId: string
  protocol: RelayInstancePortProtocol
  relayId: string
}) {
  const [error, setError] = React.useState<string | null>(null)
  const [lease, setLease] = React.useState<RelayInstancePortLease | null>(null)
  const [pending, setPending] = React.useState(enabled)
  const [portValue, setPortValueState] = React.useState("")
  const [sealed, setSealed] = React.useState(false)
  const generation = React.useRef(0)
  const leasePromiseRef = React.useRef<Promise<RelayInstancePortLease> | null>(
    null
  )
  const leaseRef = React.useRef<RelayInstancePortLease | null>(null)
  const portDirty = React.useRef(false)
  const portValueRef = React.useRef("")
  const sealedRef = React.useRef(false)
  const initialReservationProtocol =
    initialPort === undefined ? protocol : undefined

  React.useEffect(() => {
    const currentGeneration = generation.current + 1
    generation.current = currentGeneration
    if (!enabled) {
      leasePromiseRef.current = null
      leaseRef.current = null
      setError(null)
      setLease(null)
      setPending(false)
      setPortValueState("")
      portValueRef.current = ""
      sealedRef.current = false
      setSealed(false)
      return
    }

    setError(null)
    setLease(null)
    setPending(initialPort === undefined)
    setPortValueState(initialPort === undefined ? "" : String(initialPort))
    portDirty.current = false
    portValueRef.current = initialPort === undefined ? "" : String(initialPort)
    sealedRef.current = false
    setSealed(false)
    if (initialPort !== undefined) {
      return () => {
        generation.current += 1
        leasePromiseRef.current = null
        const currentLease = leaseRef.current
        leaseRef.current = null
        portValueRef.current = ""
        if (currentLease) {
          forkPromise(() =>
            releaseInstancePort({
              data: { instanceId, leaseId: currentLease.id, relayId },
            })
          )
        }
      }
    }
    if (initialReservationProtocol === undefined) return
    const leasePromise = reserveInstancePort({
      data: { instanceId, protocol: initialReservationProtocol, relayId },
    })
    leasePromiseRef.current = leasePromise
    Effect.runFork(
      Effect.tryPromise({
        try: () => leasePromise,
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((nextLease) =>
          Effect.sync(() => {
            if (generation.current !== currentGeneration) {
              forkPromise(() =>
                releaseInstancePort({
                  data: { instanceId, leaseId: nextLease.id, relayId },
                })
              )
              return
            }
            leaseRef.current = nextLease
            setLease(nextLease)
            portValueRef.current = String(nextLease.externalPort)
            setPortValueState(portValueRef.current)
          })
        ),
        Effect.catch((cause) =>
          Effect.sync(() => {
            if (generation.current === currentGeneration) {
              setError(errorMessage(cause))
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (generation.current === currentGeneration) {
              leasePromiseRef.current = null
              setPending(false)
            }
          })
        )
      )
    )

    return () => {
      generation.current += 1
      leasePromiseRef.current = null
      const currentLease = leaseRef.current
      leaseRef.current = null
      portValueRef.current = ""
      if (currentLease) {
        forkPromise(() =>
          releaseInstancePort({
            data: { instanceId, leaseId: currentLease.id, relayId },
          })
        )
      }
    }
  }, [enabled, initialPort, initialReservationProtocol, instanceId, relayId])

  React.useEffect(() => {
    if (!enabled || !lease || sealed) return
    let cancelled = false
    let timer = window.setTimeout(renew, 30_000)

    async function renew() {
      const currentLease = leaseRef.current
      if (!currentLease || currentLease.id !== lease?.id || sealedRef.current) {
        return
      }
      await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            reserveInstancePort({
              data: {
                instanceId,
                leaseId: currentLease.id,
                protocol,
                relayId,
              },
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.tap((nextLease) =>
            Effect.sync(() => {
              if (sealedRef.current) {
                if (nextLease.id !== currentLease.id) {
                  forkPromise(() =>
                    releaseInstancePort({
                      data: { instanceId, leaseId: nextLease.id, relayId },
                    })
                  )
                }
                return
              }
              if (cancelled || leaseRef.current?.id !== currentLease.id) {
                forkPromise(() =>
                  releaseInstancePort({
                    data: { instanceId, leaseId: nextLease.id, relayId },
                  })
                )
                return
              }
              leaseRef.current = nextLease
              setLease(nextLease)
              if (!portDirty.current) {
                portValueRef.current = String(nextLease.externalPort)
                setPortValueState(portValueRef.current)
              }
              setError(null)
            })
          ),
          Effect.catch((cause) =>
            Effect.sync(() => {
              if (!cancelled && !sealedRef.current) {
                setError(errorMessage(cause))
                timer = window.setTimeout(renew, 10_000)
              }
            })
          )
        )
      )
    }

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled, instanceId, lease, protocol, relayId, sealed])

  const setPortValue = React.useCallback((value: string) => {
    portDirty.current = true
    portValueRef.current = value
    setPortValueState(value)
  }, [])

  const commit = React.useCallback(async () => {
    let currentLease = leaseRef.current
    const currentGeneration = generation.current
    if (!currentLease && leasePromiseRef.current) {
      await leasePromiseRef.current
      if (generation.current !== currentGeneration) {
        throw new Error("Port reservation dialog was closed")
      }
      currentLease = leaseRef.current
    }
    if (!currentLease && initialPort === undefined) {
      throw new Error("Public port is still being reserved")
    }
    const externalPort = Number(portValueRef.current)
    if (
      !Number.isInteger(externalPort) ||
      externalPort < 1 ||
      externalPort > 65_535
    ) {
      throw new Error("Public port must be between 1 and 65535")
    }
    if (
      (currentLease && externalPort === currentLease.externalPort) ||
      (!currentLease && externalPort === initialPort)
    ) {
      portDirty.current = false
      return currentLease
    }

    setPending(true)
    setError(null)
    return Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const nextLease = await reserveInstancePort({
            data: {
              instanceId,
              protocol,
              relayId,
              externalPort,
              ...(currentLease ? { leaseId: currentLease.id } : {}),
            },
          })
          if (generation.current !== currentGeneration) {
            forkPromise(() =>
              releaseInstancePort({
                data: { instanceId, leaseId: nextLease.id, relayId },
              })
            )
            throw new Error("Port reservation dialog was closed")
          }
          leaseRef.current = nextLease
          portDirty.current = false
          setLease(nextLease)
          portValueRef.current = String(nextLease.externalPort)
          setPortValueState(portValueRef.current)
          return nextLease
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (generation.current === currentGeneration) {
              setError(errorMessage(cause))
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (generation.current === currentGeneration) {
              setPending(false)
            }
          })
        )
      )
    )
  }, [initialPort, instanceId, protocol, relayId])

  const commitForSubmit = React.useCallback(async () => {
    const currentGeneration = generation.current
    sealedRef.current = true
    setSealed(true)
    return Effect.runPromise(
      Effect.tryPromise({ try: commit, catch: (cause) => cause }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (generation.current === currentGeneration) {
              sealedRef.current = false
              setSealed(false)
            }
          })
        )
      )
    )
  }, [commit])

  return {
    commit,
    commitForSubmit,
    error,
    lease,
    pending,
    portValue,
    setPortValue,
  }
}

function AddPortDialog({
  canEditPublicPort,
  error,
  instanceId,
  pending,
  relayId,
  onBeginSubmit,
  onCancelSubmit,
  onOpenChange,
  onSubmitPort,
}: {
  canEditPublicPort: boolean
  error: string | null
  instanceId: string
  pending: boolean
  relayId: string
  onBeginSubmit: (route: PendingNetworkRoute) => void
  onCancelSubmit: () => void
  onOpenChange: (open: boolean) => void
  onSubmitPort: (port: RelayInstancePortInput) => Promise<void>
}) {
  const [validationError, setValidationError] = React.useState<string | null>(
    null
  )
  const [protocol, setProtocol] =
    React.useState<RelayInstancePortProtocol>("tcp")
  const [internalPort, setInternalPort] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)
  const portLease = usePortLease({
    enabled: true,
    instanceId,
    protocol,
    relayId,
  })

  return (
    <Dialog
      open={!submitted}
      onOpenChange={(open) => {
        if (!open && !submitted) onOpenChange(false)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add port</DialogTitle>
          <DialogDescription className="sr-only">
            Publish a TCP or UDP port from this server.
          </DialogDescription>
        </DialogHeader>

        <form
          action={(form) => {
            void (async () => {
              const draft = relayInstancePortInputSchema.safeParse({
                internalPort: Number(form.get("internalPort")),
                name: String(form.get("name") ?? ""),
                protocol,
              })
              if (!draft.success) {
                setValidationError(
                  draft.error.issues[0]?.message ?? "Port allocation is invalid"
                )
                return
              }
              const reservedPublicPort = Number(portLease.portValue)
              onBeginSubmit({
                internalPort: draft.data.internalPort,
                kind: "port",
                name: draft.data.name,
                protocol: draft.data.protocol,
                publicPort: Number.isInteger(reservedPublicPort)
                  ? reservedPublicPort
                  : undefined,
              })
              setValidationError(null)
              setSubmitted(true)
              const lease = await recoverPromise(
                portLease.commitForSubmit,
                (cause) => {
                  onCancelSubmit()
                  setSubmitted(false)
                  setValidationError(errorMessage(cause))
                  return null
                }
              )
              if (!lease) return
              const parsed = relayInstancePortInputSchema.safeParse({
                externalPort: lease.externalPort,
                internalPort: draft.data.internalPort,
                leaseId: lease.id,
                name: draft.data.name,
                protocol: draft.data.protocol,
              })
              if (!parsed.success) {
                onCancelSubmit()
                setSubmitted(false)
                setValidationError(
                  parsed.error.issues[0]?.message ??
                    "Port allocation is invalid"
                )
                return
              }
              setValidationError(null)
              await recoverPromise(
                () => onSubmitPort(parsed.data),
                () => {
                  onCancelSubmit()
                  onOpenChange(false)
                }
              )
            })()
          }}
          className="space-y-4"
        >
          <PortFields
            both
            internalPort={{
              value: internalPort ?? portLease.portValue,
              onChange: setInternalPort,
            }}
            name={{}}
            protocol={protocol}
            publicPort={{
              disabled: !canEditPublicPort || portLease.pending,
              readOnly: !canEditPublicPort,
              value: portLease.portValue,
              onBlur: () => {
                if (canEditPublicPort && portLease.lease) {
                  forkPromise(portLease.commit)
                }
              },
              onChange: portLease.setPortValue,
            }}
            onProtocolChange={setProtocol}
          />
          {validationError || portLease.error || error ? (
            <p className="text-xs text-destructive">
              {validationError ?? portLease.error ?? error}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose
              render={
                <Button disabled={pending} type="button" variant="outline" />
              }
            >
              Cancel
            </DialogClose>
            <Button disabled={pending} type="submit">
              {pending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {pending ? "Adding" : "Add port"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PortAllocationDialog({
  allocation,
  canEditPublicPort,
  error,
  instanceId,
  open,
  pending,
  pendingPrimaryPort,
  relayId,
  recoveringPrimary = false,
  onOpenChange,
  onSubmit,
}: {
  allocation: RelayInstancePortAllocation | null
  canEditPublicPort: boolean
  error: string | null
  instanceId: string
  open: boolean
  pending: boolean
  pendingPrimaryPort: RelayInstancePendingPrimaryPort | null
  relayId: string
  recoveringPrimary?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (port: RelayInstancePortInput) => Promise<void>
}) {
  const [validationError, setValidationError] = React.useState<string | null>(
    null
  )
  const isDefaultServer = recoveringPrimary || allocation?.kind === "primary"
  const [protocol, setProtocol] = React.useState<RelayInstancePortProtocol>(
    allocation?.protocol ?? pendingPrimaryPort?.protocol ?? "tcp"
  )
  const [internalPort, setInternalPort] = React.useState(
    pendingPrimaryPort ? String(pendingPrimaryPort.internalPort) : ""
  )
  const publicPortLease = usePortLease({
    enabled:
      isDefaultServer && allocation?.kind === "primary" && canEditPublicPort,
    initialPort:
      allocation?.kind === "primary" ? allocation.externalPort : undefined,
    instanceId,
    protocol,
    relayId,
  })
  const dialogPending = pending || publicPortLease.pending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {recoveringPrimary
              ? "Assign the Default Server"
              : isDefaultServer
                ? "Edit the Default Server"
                : "Edit port"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose the port inside this server and its protocol. Kiln picks the
            public port.
          </DialogDescription>
        </DialogHeader>

        <form
          key={
            allocation?.id ??
            pendingPrimaryPort?.internalPort ??
            (recoveringPrimary ? "primary" : "new")
          }
          action={async (form) => {
            const parsed = relayInstancePortInputSchema.safeParse({
              id: allocation?.id ?? (recoveringPrimary ? "primary" : undefined),
              internalPort: Number(form.get("internalPort")),
              name: isDefaultServer
                ? "Default Server"
                : String(form.get("name") ?? ""),
              protocol,
            })
            if (!parsed.success) {
              setValidationError(
                parsed.error.issues[0]?.message ?? "Port allocation is invalid"
              )
              return
            }
            setValidationError(null)
            const publicPortLeaseResult =
              isDefaultServer &&
              allocation?.kind === "primary" &&
              canEditPublicPort
                ? await recoverPromise(
                    () => publicPortLease.commitForSubmit(),
                    (cause) => {
                      setValidationError(errorMessage(cause))
                      return undefined
                    }
                  )
                : null
            if (publicPortLeaseResult === undefined) return
            const port = publicPortLeaseResult
              ? {
                  ...parsed.data,
                  externalPort: publicPortLeaseResult.externalPort,
                  leaseId: publicPortLeaseResult.id,
                }
              : parsed.data
            await recoverPromise(
              () => onSubmit(port),
              () => undefined
            )
          }}
          className="space-y-4"
        >
          <PortFields
            both
            internalPort={
              recoveringPrimary
                ? { value: internalPort, onChange: setInternalPort }
                : { defaultValue: allocation?.internalPort }
            }
            name={
              isDefaultServer ? undefined : { defaultValue: allocation?.name }
            }
            protocol={protocol}
            publicPort={
              recoveringPrimary
                ? undefined
                : {
                    disabled:
                      !isDefaultServer ||
                      !canEditPublicPort ||
                      publicPortLease.pending,
                    readOnly: !isDefaultServer || !canEditPublicPort,
                    value:
                      isDefaultServer && canEditPublicPort
                        ? publicPortLease.portValue
                        : allocation
                          ? String(allocation.externalPort)
                          : "",
                    onChange: publicPortLease.setPortValue,
                  }
            }
            onProtocolChange={setProtocol}
          />

          {validationError || publicPortLease.error || error ? (
            <p className="text-xs text-destructive">
              {validationError ?? publicPortLease.error ?? error}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose
              render={
                <Button
                  disabled={dialogPending}
                  type="button"
                  variant="outline"
                />
              }
            >
              Cancel
            </DialogClose>
            <Button disabled={dialogPending} type="submit">
              {dialogPending ? <LoaderCircle className="animate-spin" /> : null}
              {dialogPending
                ? "Saving"
                : recoveringPrimary
                  ? "Assign Default Server"
                  : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function serverWebRouteStatus(
  state: RelayInstanceWebRouteState
): IdentityStatusPresentation {
  if (state.status === "ready")
    return { detail: state.message, label: "Live", tone: "success" }
  if (state.status === "pending_restart")
    return { detail: state.message, label: "Pending restart", tone: "warning" }
  return { detail: state.message, label: "Unavailable", tone: "danger" }
}

function RouteStatusButton({
  state,
  canRestart,
  restarting,
  onRestart,
}: {
  state: RelayInstanceWebRouteState
  canRestart: boolean
  restarting: boolean
  onRestart: () => void
}) {
  if (state.status === "ready") return null
  const pending = state.status === "pending_restart"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={
            pending
              ? restarting
                ? "Applying route changes"
                : "Restart to apply route changes"
              : "View route error"
          }
          className={
            pending
              ? "w-7 border-amber-400/30 bg-amber-400/5 px-0 text-amber-200 hover:bg-amber-400/10 hover:text-amber-100 sm:w-auto sm:px-3 light:bg-amber-400/10 light:text-amber-800 light:hover:bg-amber-400/20 light:hover:text-amber-800"
              : "w-7 px-0 sm:w-auto sm:px-3"
          }
          onClick={() => {
            showRouteStatusToast({
              canRestart,
              restarting,
              state,
              onRestart,
            })
          }}
          size="sm"
          type="button"
          variant={pending ? "outline" : "destructive"}
          aria-live="polite"
        >
          {pending ? (
            <RotateCw className={restarting ? "animate-spin" : undefined} />
          ) : (
            <CircleAlert />
          )}
          <span className="hidden sm:inline">
            {pending
              ? restarting
                ? "Applying"
                : "Restart to apply"
              : "Route error"}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{state.message}</TooltipContent>
    </Tooltip>
  )
}

function showRouteStatusToast({
  canRestart,
  restarting,
  state,
  onRestart,
}: {
  canRestart: boolean
  restarting: boolean
  state: RelayInstanceWebRouteState
  onRestart?: () => void
}) {
  const pending = state.status === "pending_restart"
  if (pending) {
    showPendingRestartToast({
      canRestart,
      message: state.message,
      restarting,
      onRestart,
    })
    return
  }
  showToast({
    description: state.message,
    message: "Edge route error",
    type: "error",
  })
}

function showPendingRestartToast({
  canRestart,
  message,
  restarting,
  onRestart,
}: {
  canRestart: boolean
  message: string
  restarting: boolean
  onRestart?: () => void
}) {
  showToast({
    description: message,
    duration: Infinity,
    message: "Restart required",
    type: "warning",
    ...(canRestart && !restarting && onRestart
      ? {
          action: {
            label: "Restart and apply",
            onClick: onRestart,
          },
        }
      : {}),
  })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The network change failed."
}

// The game server's Tailscale networks, as a member of each.
function GameServerTailscale({
  instance: { id, name, relayId, relayName },
}: {
  instance: Omit<TailscaleMember, "memberId">
}) {
  const member = React.useMemo(
    () => ({
      id,
      memberId: instanceTailscaleMemberId(id),
      name,
      relayId,
      relayName,
    }),
    [id, name, relayId, relayName]
  )
  return <TailscaleMembershipSection member={member} />
}
