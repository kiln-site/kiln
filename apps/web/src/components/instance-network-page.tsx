import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  AlertTriangle,
  BrickWall,
  Cable,
  Check,
  CircleAlert,
  Copy,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react"
import {
  relayInstancePortInputSchema,
  relayInstanceWebRouteInputSchema,
} from "@workspace/contracts"
import type {
  RelayInstancePendingPrimaryPort,
  RelayInstancePortAllocation,
  RelayInstancePortInput,
  RelayInstancePortLease,
  RelayInstancePortProtocol,
  RelayInstanceWebRoute,
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
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
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
import { GameServerTailscaleSection } from "@/components/tailscale-network-membership"
import {
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
} from "@/components/workspace-data-table"
import {
  accessCapabilitiesQueryOptions,
  queryKeys,
  replaceRelaySnapshotInstance,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  getInstanceWebRoutes,
  performRelayAction,
  releaseInstancePort,
  reserveInstancePort,
  updateInstancePorts,
  updateInstanceWebRoutes,
} from "@/server/relay"

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

  if (instance.implementation.toLowerCase() === "tailscale") {
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
  const queryClient = useQueryClient()
  const queryKey = React.useMemo(
    () => queryKeys.relay.webRoutes(instance.relayId, instance.id),
    [instance.id, instance.relayId]
  )
  const routes = useQuery({
    enabled: permissions.networkRead,
    queryFn: () =>
      getInstanceWebRoutes({
        data: { instanceId: instance.id, relayId: instance.relayId },
      }),
    queryKey,
  })
  const update = useMutation({
    mutationFn: (next: Array<RelayInstanceWebRouteInput>) =>
      updateInstanceWebRoutes({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          routes: next,
        },
      }),
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
      queryClient.setQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot,
        (snapshot) => replaceRelaySnapshotInstance(snapshot, updated)
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.relay.snapshot,
        }),
      ])
    },
  })
  const restartPendingRoutes = React.useCallback(() => {
    if (!permissions.power || !relayConnected || restart.isPending) return
    restart.mutate()
  }, [permissions.power, relayConnected, restart])

  const addWebRoute = React.useCallback(
    async (route: RelayInstanceWebRouteInput) => {
      if (!routes.data) throw new Error("Routes are not loaded yet")
      const existingIds = new Set(
        routes.data.routes.map((existing) => existing.id)
      )
      const next = await update.mutateAsync([...routes.data.routes, route])
      const added = next.routes.find(
        (candidate) => !existingIds.has(candidate.id)
      )
      if (!added) throw new Error("Relay did not return the new web route")
      return added
    },
    [routes.data, update]
  )
  const editWebRoute = React.useCallback(
    async (route: RelayInstanceWebRouteInput) => {
      if (!route.id || !routes.data) {
        throw new Error("The web route is not loaded yet")
      }
      await update.mutateAsync(
        routes.data.routes.map((existing) =>
          existing.id === route.id ? route : existing
        )
      )
    },
    [routes.data, update]
  )
  const removeWebRoute = React.useCallback(
    (routeId: string) =>
      update.mutateAsync(
        (routes.data?.routes ?? []).filter((route) => route.id !== routeId)
      ),
    [routes.data?.routes, update]
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
        <ConfiguredRoutesSection
          key={editGamePort ? "edit-game-port" : "network"}
          canRestart={permissions.power && relayConnected}
          canPublicPortWrite={permissions.networkPublicPortWrite}
          canWrite={permissions.networkWrite}
          editGamePort={editGamePort}
          instance={instance}
          relayConnected={relayConnected}
          routeError={routes.error ?? update.error}
          routePending={update.isPending}
          routeState={routes.data}
          routes={routes.data?.routes}
          restarting={restart.isPending}
          onAddWebRoute={addWebRoute}
          onEditWebRoute={editWebRoute}
          onRemoveWebRoute={removeWebRoute}
          onRestart={restartPendingRoutes}
        />
        {showTailscale ? (
          <GameServerTailscaleSection server={instance} />
        ) : null}
      </div>
    </main>
  )
}

type RouteDialogState =
  | { mode: "add" }
  | { allocation: RelayInstancePortAllocation; mode: "edit-port" }
  | { mode: "edit-web"; route: RelayInstanceWebRoute }
  | { mode: "recover-primary" }
  | null

type PendingNetworkRoute =
  | {
      internalPort: number
      kind: "port"
      name: string
      protocol: RelayInstancePortProtocol
      publicPort?: number
    }
  | {
      hostname: string
      kind: "web"
      name: string
      path: string | null
      targetPort: number
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
      route: PendingNetworkRoute & { kind: "port" }
      status: "pending"
    }
  | {
      clientId: string
      kind: "web"
      route: PendingNetworkRoute & { kind: "web" }
      status: "pending"
    }
  | {
      clientId: string
      kind: "web"
      route: RelayInstanceWebRoute
      status: "ready"
    }

type RouteRemovalState =
  | {
      allocation: RelayInstancePortAllocation
      kind: "port"
      placement: { source: "added" } | { index: number; source: "server" }
      phase: "confirming" | "removing"
    }
  | {
      kind: "web"
      placement: { source: "added" } | { index: number; source: "server" }
      phase: "confirming" | "removing"
      route: RelayInstanceWebRoute
    }

function portRemovalKey(id: string) {
  return `port:${id}`
}

function webRouteRemovalKey(id: string) {
  return `web:${id}`
}

const ConfiguredRoutesSection = React.memo(function ConfiguredRoutesSection({
  canRestart,
  canPublicPortWrite,
  canWrite,
  editGamePort,
  instance,
  relayConnected,
  routeError,
  routePending,
  routeState,
  routes,
  restarting,
  onAddWebRoute,
  onEditWebRoute,
  onRemoveWebRoute,
  onRestart,
}: {
  canRestart: boolean
  canPublicPortWrite: boolean
  canWrite: boolean
  editGamePort: boolean
  instance: InstanceWorkspaceInstance
  relayConnected: boolean
  routeError: unknown
  routePending: boolean
  routeState: RelayInstanceWebRouteState | undefined
  routes: Array<RelayInstanceWebRoute> | undefined
  restarting: boolean
  onAddWebRoute: (
    route: RelayInstanceWebRouteInput
  ) => Promise<RelayInstanceWebRoute>
  onEditWebRoute: (route: RelayInstanceWebRouteInput) => Promise<void>
  onRemoveWebRoute: (routeId: string) => Promise<unknown>
  onRestart: () => void
}) {
  const navigate = useNavigate({ from: "/server/$serverId/network" })
  const queryClient = useQueryClient()
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
      queryClient.setQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot,
        (snapshot) => replaceRelaySnapshotInstance(snapshot, updated)
      )
      setDialog(null)
      clearEditGamePortIntent()
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.relay.connection,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.relay.snapshot,
        }),
      ])
      showToast({
        description: updated.pendingPrimaryPort
          ? "Restart the server when you are ready to apply it."
          : undefined,
        message: updated.pendingPrimaryPort
          ? "Default Server saved"
          : "Port allocations updated",
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
  const addWebRoute = React.useCallback(
    (route: RelayInstanceWebRouteInput) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => onAddWebRoute(route),
          catch: (cause) => cause,
        }).pipe(
          Effect.tap((added) =>
            Effect.sync(() => {
              setAddedRoutes((current) =>
                current.map((currentRoute) =>
                  currentRoute.kind === "web" &&
                  currentRoute.status === "pending"
                    ? {
                        clientId: currentRoute.clientId,
                        kind: "web",
                        route: added,
                        status: "ready",
                      }
                    : currentRoute
                )
              )
            })
          ),
          Effect.tapError(() =>
            Effect.sync(() =>
              setAddedRoutes((current) =>
                current.filter(
                  (currentRoute) =>
                    currentRoute.kind !== "web" ||
                    currentRoute.status !== "pending"
                )
              )
            )
          ),
          Effect.asVoid
        )
      ),
    [onAddWebRoute]
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
  const editWebRoute = React.useCallback((route: RelayInstanceWebRoute) => {
    setDialog({ mode: "edit-web", route })
  }, [])
  const removeWebRoute = React.useCallback(
    (route: RelayInstanceWebRoute) => {
      if (disabled || routePending) return
      const added = addedRoutes.some(
        (current) =>
          current.kind === "web" &&
          current.status === "ready" &&
          current.route.id === route.id
      )
      setRemoval({
        kind: "web",
        phase: "confirming",
        placement: added
          ? { source: "added" }
          : {
              index: Math.max(
                (routes ?? []).findIndex((current) => current.id === route.id),
                0
              ),
              source: "server",
            },
        route,
      })
    },
    [addedRoutes, disabled, routePending, routes]
  )
  const confirmRemoval = React.useCallback(async () => {
    if (!removal || removal.phase !== "confirming") return
    setRemoval({ ...removal, phase: "removing" })
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (removal.kind === "port") {
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
                  route.kind !== "port" ||
                  route.status !== "ready" ||
                  route.allocation.id !== removal.allocation.id
              )
            )
          } else {
            await onRemoveWebRoute(removal.route.id)
            setRemovedRouteKeys((current) => {
              const next = new Set(current)
              next.add(webRouteRemovalKey(removal.route.id))
              return next
            })
            setAddedRoutes((current) =>
              current.filter(
                (currentRoute) =>
                  currentRoute.kind !== "web" ||
                  currentRoute.status !== "ready" ||
                  currentRoute.route.id !== removal.route.id
              )
            )
          }
        },
        catch: (cause) => cause,
      }).pipe(
        // Mutation state renders the Relay error below the table.
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.ensuring(Effect.sync(() => setRemoval(null)))
      )
    )
  }, [onRemoveWebRoute, portInputs, removal, update])

  return (
    <section className="border border-border/80 bg-card/55">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div>
          <h1 className="font-heading text-base font-semibold tracking-tight">
            Configured routes
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {routeState && routeState.routes.length === 0 ? (
            <RouteStatusButton
              canRestart={canRestart}
              restarting={restarting}
              state={routeState}
              onRestart={onRestart}
            />
          ) : null}
          {canWrite ? (
            <Button
              disabled={
                disabled ||
                routes === undefined ||
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
              Add route
            </Button>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto">
        <ConfiguredRoutesTable
          addedRoutes={addedRoutes}
          canWrite={canWrite}
          disabled={disabled}
          instance={instance}
          canRestart={canRestart}
          routePending={routePending}
          routeState={routeState}
          routes={routes}
          restarting={restarting}
          removal={removal?.phase === "removing" ? removal : null}
          removedRouteKeys={removedRouteKeys}
          onEditPort={editPort}
          onEditWebRoute={editWebRoute}
          onRecoverPrimaryPort={recoverPrimaryPort}
          onRemovePort={removePort}
          onRemoveWebRoute={removeWebRoute}
          onRestart={onRestart}
        />
      </div>

      {!relayConnected ? (
        <p className="type-support border-t border-amber-400/20 bg-amber-400/5 px-4 py-2 text-amber-100">
          Port changes are unavailable while this Relay is disconnected.
        </p>
      ) : (update.error || routeError) && dialog === null ? (
        <p className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {errorMessage(update.error ?? routeError)}
        </p>
      ) : null}

      {dialog?.mode === "add" || dialog?.mode === "edit-web" ? (
        <AddNetworkRouteDialog
          canAddPort={primaryPort !== undefined && instance.ports.length < 16}
          canAddWebRoute={(routes?.length ?? 16) < 16}
          canEditPublicPort={canPublicPortWrite}
          error={
            update.error || routeError
              ? errorMessage(update.error ?? routeError)
              : null
          }
          pending={update.isPending || routePending}
          instanceId={instance.id}
          relayId={instance.relayId}
          webRoute={dialog.mode === "edit-web" ? dialog.route : undefined}
          onOpenChange={(open) => {
            if (!open && !update.isPending && !routePending) setDialog(null)
          }}
          onBeginSubmit={(route) => {
            addedRouteSequence.current += 1
            const clientId = `added-route-${addedRouteSequence.current}`
            setAddedRoutes((current) => [
              ...current,
              route.kind === "port"
                ? { clientId, kind: "port", route, status: "pending" }
                : { clientId, kind: "web", route, status: "pending" },
            ])
          }}
          onCancelSubmit={() => {
            setAddedRoutes((current) =>
              current.filter(({ status }) => status !== "pending")
            )
          }}
          onSubmitPort={addPort}
          onSubmitWebRoute={
            dialog.mode === "edit-web" ? onEditWebRoute : addWebRoute
          }
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
      <RemoveNetworkRouteDialog
        open={removal?.phase === "confirming"}
        publicHost={instance.publicHost}
        removal={removal}
        onConfirm={() => void confirmRemoval()}
        onOpenChange={(open) => {
          if (!open && removal?.phase === "confirming") setRemoval(null)
        }}
      />
    </section>
  )
})

const ConfiguredRoutesTable = React.memo(function ConfiguredRoutesTable({
  addedRoutes,
  canRestart,
  canWrite,
  disabled,
  instance,
  routePending,
  routeState,
  routes,
  restarting,
  removal,
  removedRouteKeys,
  onEditPort,
  onEditWebRoute,
  onRecoverPrimaryPort,
  onRemovePort,
  onRemoveWebRoute,
  onRestart,
}: {
  addedRoutes: Array<AddedNetworkRoute>
  canRestart: boolean
  canWrite: boolean
  disabled: boolean
  instance: InstanceWorkspaceInstance
  routePending: boolean
  routeState: RelayInstanceWebRouteState | undefined
  routes: Array<RelayInstanceWebRoute> | undefined
  restarting: boolean
  removal: RouteRemovalState | null
  removedRouteKeys: ReadonlySet<string>
  onEditPort: (allocation: RelayInstancePortAllocation) => void
  onEditWebRoute: (route: RelayInstanceWebRoute) => void
  onRecoverPrimaryPort: () => void
  onRemovePort: (allocation: RelayInstancePortAllocation) => void
  onRemoveWebRoute: (route: RelayInstanceWebRoute) => void
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
  const displayedWebRoutes = React.useMemo(() => {
    const current = (routes ?? []).filter(
      (route) => !removedRouteKeys.has(webRouteRemovalKey(route.id))
    )
    if (
      removal?.kind !== "web" ||
      removal.placement.source !== "server" ||
      current.some((route) => route.id === removal.route.id)
    ) {
      return current
    }
    const next = [...current]
    next.splice(
      Math.min(removal.placement.index, next.length),
      0,
      removal.route
    )
    return next
  }, [removal, removedRouteKeys, routes])
  const displayedAddedRoutes = React.useMemo(
    () =>
      addedRoutes.filter(
        (route) =>
          route.status === "pending" ||
          !removedRouteKeys.has(
            route.kind === "port"
              ? portRemovalKey(route.allocation.id)
              : webRouteRemovalKey(route.route.id)
          )
      ),
    [addedRoutes, removedRouteKeys]
  )
  const hasAdditionalRoutes =
    displayedPorts.some((allocation) => allocation.kind !== "primary") ||
    displayedWebRoutes.length > 0 ||
    displayedAddedRoutes.length > 0

  return (
    <table className="w-full min-w-[40rem] table-fixed border-collapse text-left">
      <WorkspaceTableHead>
        <WorkspaceTableHeading className="w-[27%]">Name</WorkspaceTableHeading>
        <WorkspaceTableHeading className="w-[15%]">
          Internal Port
        </WorkspaceTableHeading>
        <WorkspaceTableHeading>Public Address</WorkspaceTableHeading>
        <WorkspaceTableHeading className="w-[6.5rem] text-right">
          Actions
        </WorkspaceTableHeading>
      </WorkspaceTableHead>
      <tbody className="divide-y divide-border/70">
        <tr className="hover:bg-muted/10">
          <WorkspaceTableCell>
            <div className="flex min-w-0 items-center gap-2.5">
              <RouteRowIcon
                canRestart={canRestart}
                errorMessage={
                  displayedPrimaryPort
                    ? undefined
                    : "Edit the Default Server to assign its internal port and protocol."
                }
                kind="primary"
                pendingMessage={
                  pendingPrimaryPort
                    ? "Restart this server when you are ready to apply its Default Server route."
                    : undefined
                }
                restarting={restarting}
                onRestart={onRestart}
              />
              <div className="min-w-0">
                <span className="block truncate text-xs font-medium">
                  Default Server
                </span>
                <span className="type-technical-label mt-0.5 block text-muted-foreground">
                  {displayedPrimaryPort
                    ? formatPortProtocol(displayedPrimaryPort.protocol)
                    : "Not configured"}
                </span>
              </div>
              <span className="type-technical-label shrink-0 self-center border border-primary/30 bg-primary/8 px-2 py-1 text-primary">
                Primary
              </span>
            </div>
          </WorkspaceTableCell>
          <WorkspaceTableCell>
            <span className="font-mono text-xs text-foreground">
              {displayedPrimaryPort?.internalPort ?? "—"}
            </span>
          </WorkspaceTableCell>
          <WorkspaceTableCell>
            <PublicAddressCopy
              address={
                instance.publicHost && primaryPort
                  ? formatHostPort(
                      instance.publicHost,
                      primaryPort.externalPort
                    )
                  : null
              }
              label="game server public address"
              prominent
            />
          </WorkspaceTableCell>
          <WorkspaceTableCell className="px-2">
            <div className="flex justify-end">
              {canWrite ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Edit Default Server"
                      disabled={disabled}
                      onClick={() => {
                        if (primaryPort) onEditPort(primaryPort)
                        else onRecoverPrimaryPort()
                      }}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {primaryPort
                      ? "Edit allocation"
                      : pendingPrimaryPort
                        ? "Edit pending Default Server"
                        : "Assign Default Server"}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </WorkspaceTableCell>
        </tr>
        {hasAdditionalRoutes ? (
          <tr aria-hidden="true">
            <td
              className="h-3 border-y border-border/70 bg-muted/25 p-0"
              colSpan={4}
            />
          </tr>
        ) : null}
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
              publicHost={instance.publicHost}
              onEdit={onEditPort}
              onRemove={onRemovePort}
            />
          )
        })}
        {displayedWebRoutes.map((route) => {
          if (
            addedRoutes.some(
              (addedRoute) =>
                addedRoute.kind === "web" &&
                (addedRoute.status === "ready"
                  ? addedRoute.route.id === route.id
                  : addedRoute.route.hostname === route.hostname)
            )
          ) {
            return null
          }
          return (
            <WebRouteRow
              key={`web-${route.id}`}
              canRestart={canRestart}
              canWrite={canWrite}
              deleting={
                removal?.kind === "web" && removal.route.id === route.id
              }
              disabled={disabled || routePending}
              restarting={restarting}
              route={route}
              state={routeState}
              onEdit={onEditWebRoute}
              onRemove={onRemoveWebRoute}
              onRestart={onRestart}
            />
          )
        })}
        {displayedAddedRoutes.map((addedRoute) => (
          <AddedRouteRow
            key={addedRoute.clientId}
            addedRoute={addedRoute}
            canRestart={canRestart}
            canWrite={canWrite}
            deleting={
              addedRoute.status === "ready" &&
              (addedRoute.kind === "port"
                ? removal?.kind === "port" &&
                  removal.allocation.id === addedRoute.allocation.id
                : removal?.kind === "web" &&
                  removal.route.id === addedRoute.route.id)
            }
            disabled={disabled}
            instance={instance}
            restarting={restarting}
            routePending={routePending}
            routes={routes}
            state={routeState}
            onEditPort={onEditPort}
            onEditWebRoute={onEditWebRoute}
            onRemovePort={onRemovePort}
            onRemoveWebRoute={onRemoveWebRoute}
            onRestart={onRestart}
          />
        ))}
      </tbody>
    </table>
  )
})

function RemoveNetworkRouteDialog({
  open,
  publicHost,
  removal,
  onConfirm,
  onOpenChange,
}: {
  open: boolean
  publicHost?: string
  removal: RouteRemovalState | null
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  if (!removal) return null
  const name =
    removal.kind === "port" ? removal.allocation.name : removal.route.name
  const publicAddress =
    removal.kind === "port"
      ? publicHost
        ? formatHostPort(publicHost, removal.allocation.externalPort)
        : String(removal.allocation.externalPort)
      : `https://${removal.route.hostname}${removal.route.path ?? ""}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 aria-hidden="true" className="size-5 text-destructive" />
            Remove Route
          </DialogTitle>
        </DialogHeader>
        <div className="border border-border bg-muted/20 px-3 py-2.5">
          <span className="block truncate text-sm font-medium text-foreground">
            {name}
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
            {publicAddress}
          </span>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            <Trash2 />
            Remove route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
  const address = publicHost
    ? formatHostPort(publicHost, allocation.externalPort)
    : null

  return (
    <tr
      aria-label={deleting ? `Removing ${allocation.name}` : undefined}
      className="hover:bg-muted/10"
    >
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <RouteRowIcon
            busyLabel="Removing route"
            kind="port"
            settingUp={deleting}
          />
          <RouteName
            name={allocation.name}
            secondary={formatPortProtocol(allocation.protocol)}
          />
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <span className="font-mono text-xs text-foreground">
          {allocation.internalPort}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <PublicAddressCopy
          address={address}
          label={`${allocation.name} public address`}
          prominent
        />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-2">
        <div className="flex justify-end gap-0.5">
          {canWrite ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`Edit ${allocation.name}`}
                    disabled={disabled || deleting}
                    onClick={() => onEdit(allocation)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit allocation</TooltipContent>
              </Tooltip>
              {allocation.kind === "custom" ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={`Remove ${allocation.name}`}
                      disabled={disabled || deleting}
                      onClick={() => onRemove(allocation)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove allocation</TooltipContent>
                </Tooltip>
              ) : null}
            </>
          ) : null}
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

const WebRouteRow = React.memo(function WebRouteRow({
  canRestart,
  canWrite,
  deleting = false,
  disabled,
  restarting,
  route,
  state,
  onEdit,
  onRemove,
  onRestart,
}: {
  canRestart: boolean
  canWrite: boolean
  deleting?: boolean
  disabled: boolean
  restarting: boolean
  route: RelayInstanceWebRoute
  state: RelayInstanceWebRouteState | undefined
  onEdit: (route: RelayInstanceWebRoute) => void
  onRemove: (route: RelayInstanceWebRoute) => void
  onRestart: () => void
}) {
  const publicUrl = `https://${route.hostname}${route.path ?? ""}`

  return (
    <tr
      aria-label={deleting ? `Removing ${route.name}` : undefined}
      className="hover:bg-muted/10"
    >
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <RouteRowIcon
            busyLabel="Removing route"
            canRestart={canRestart}
            kind="web"
            restarting={restarting}
            settingUp={deleting}
            state={state}
            onRestart={onRestart}
          />
          <RouteName
            name={route.name}
            secondary={`HTTPS${route.path ? ` · ${route.path}` : ""}`}
          />
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <span className="font-mono text-xs text-foreground">
          {route.targetPort}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <PublicAddressCopy
          address={publicUrl}
          label={`${route.name} web route`}
          prominent
        />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-2">
        <div className="flex justify-end gap-0.5">
          {canWrite ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`Edit ${publicUrl}`}
                    disabled={disabled || deleting}
                    onClick={() => onEdit(route)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit web route</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`Remove ${publicUrl}`}
                    disabled={disabled || deleting}
                    onClick={() => onRemove(route)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove web route</TooltipContent>
              </Tooltip>
            </>
          ) : null}
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

function AddedRouteRow({
  addedRoute,
  canRestart,
  canWrite,
  deleting,
  disabled,
  instance,
  restarting,
  routePending,
  routes,
  state,
  onEditPort,
  onEditWebRoute,
  onRemovePort,
  onRemoveWebRoute,
  onRestart,
}: {
  addedRoute: AddedNetworkRoute
  canRestart: boolean
  canWrite: boolean
  deleting: boolean
  disabled: boolean
  instance: InstanceWorkspaceInstance
  restarting: boolean
  routePending: boolean
  routes: Array<RelayInstanceWebRoute> | undefined
  state: RelayInstanceWebRouteState | undefined
  onEditPort: (allocation: RelayInstancePortAllocation) => void
  onEditWebRoute: (route: RelayInstanceWebRoute) => void
  onRemovePort: (allocation: RelayInstancePortAllocation) => void
  onRemoveWebRoute: (route: RelayInstanceWebRoute) => void
  onRestart: () => void
}) {
  if (addedRoute.kind === "port") {
    const details =
      addedRoute.status === "ready"
        ? (() => {
            const allocation =
              instance.ports.find(
                ({ id }) => id === addedRoute.allocation.id
              ) ?? addedRoute.allocation
            return {
              allocation,
              externalPort: allocation.externalPort,
              internalPort: allocation.internalPort,
              name: allocation.name,
              protocol: allocation.protocol,
            }
          })()
        : {
            allocation: null,
            externalPort: addedRoute.route.publicPort,
            internalPort: addedRoute.route.internalPort,
            name: addedRoute.route.name,
            protocol: addedRoute.route.protocol,
          }
    const address =
      instance.publicHost && details.externalPort
        ? formatHostPort(instance.publicHost, details.externalPort)
        : "Allocating…"

    return (
      <ProvisioningRouteRow
        actions={
          details.allocation && canWrite ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`Edit ${details.allocation.name}`}
                    disabled={disabled || deleting}
                    onClick={() => onEditPort(details.allocation)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit allocation</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`Remove ${details.allocation.name}`}
                    disabled={disabled || deleting}
                    onClick={() => onRemovePort(details.allocation)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove allocation</TooltipContent>
              </Tooltip>
            </>
          ) : null
        }
        address={address}
        copyLabel={`${details.name} public address`}
        internalPort={details.internalPort}
        kind="port"
        name={details.name}
        secondary={formatPortProtocol(details.protocol)}
        settingUp={!details.allocation || deleting}
        showCopy={Boolean(details.allocation)}
        statusLabel={deleting ? "Removing" : "Adding"}
      />
    )
  }

  const readyRoute =
    addedRoute.status === "ready"
      ? (routes?.find(({ id }) => id === addedRoute.route.id) ??
        addedRoute.route)
      : null
  const route = readyRoute ?? addedRoute.route
  const settingUp = readyRoute === null
  const publicUrl = `https://${route.hostname}${route.path ?? ""}`

  return (
    <ProvisioningRouteRow
      actions={
        readyRoute && canWrite ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Edit ${publicUrl}`}
                  disabled={disabled || routePending || deleting}
                  onClick={() => onEditWebRoute(readyRoute)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit web route</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Remove ${publicUrl}`}
                  disabled={disabled || routePending || deleting}
                  onClick={() => onRemoveWebRoute(readyRoute)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove web route</TooltipContent>
            </Tooltip>
          </>
        ) : null
      }
      address={publicUrl}
      canRestart={canRestart}
      copyLabel={`${route.name} web route`}
      internalPort={route.targetPort}
      kind="web"
      name={route.name}
      restarting={restarting}
      secondary={`HTTPS${route.path ? ` · ${route.path}` : ""}`}
      settingUp={settingUp || deleting}
      showCopy={!settingUp}
      state={state}
      statusLabel={deleting ? "Removing" : "Adding"}
      onRestart={onRestart}
    />
  )
}

function ProvisioningRouteRow({
  actions,
  address,
  canRestart,
  copyLabel,
  internalPort,
  kind,
  name,
  restarting,
  secondary,
  settingUp,
  showCopy,
  state,
  statusLabel,
  onRestart,
}: {
  actions: React.ReactNode
  address: string
  canRestart?: boolean
  copyLabel: string
  internalPort: number
  kind: "port" | "web"
  name: string
  restarting?: boolean
  secondary: string
  settingUp: boolean
  showCopy: boolean
  state?: RelayInstanceWebRouteState
  statusLabel: "Adding" | "Removing"
  onRestart?: () => void
}) {
  return (
    <tr
      aria-label={settingUp ? `${statusLabel} ${name}` : undefined}
      className="hover:bg-muted/10"
    >
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <RouteRowIcon
            busyLabel={`${statusLabel} route`}
            canRestart={canRestart}
            kind={kind}
            restarting={restarting}
            settingUp={settingUp}
            state={state}
            onRestart={onRestart}
          />
          <RouteName name={name} secondary={secondary} />
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <span className="font-mono text-xs text-foreground">
          {internalPort}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        {showCopy ? (
          <PublicAddressCopy address={address} label={copyLabel} prominent />
        ) : (
          <span className="block truncate font-mono text-sm font-medium text-muted-foreground">
            {address}
          </span>
        )}
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-2">
        <div className="flex justify-end gap-0.5">{actions}</div>
      </WorkspaceTableCell>
    </tr>
  )
}

function RouteName({ name, secondary }: { name: string; secondary: string }) {
  return (
    <div className="min-w-0">
      <span className="block truncate text-xs font-medium">{name}</span>
      <span className="type-technical-label mt-0.5 block truncate text-muted-foreground">
        {secondary}
      </span>
    </div>
  )
}

const RouteRowIcon = React.memo(function RouteRowIcon({
  busyLabel = "Setting up route",
  canRestart = false,
  errorMessage,
  kind,
  pendingMessage,
  restarting = false,
  settingUp = false,
  state,
  onRestart,
}: {
  busyLabel?: string
  canRestart?: boolean
  errorMessage?: string
  kind: "port" | "primary" | "web"
  pendingMessage?: string
  restarting?: boolean
  settingUp?: boolean
  state?: RelayInstanceWebRouteState
  onRestart?: () => void
}) {
  const pending =
    pendingMessage !== undefined || state?.status === "pending_restart"
  const blocked = state?.status === "blocked" || errorMessage !== undefined
  const Icon = kind === "primary" ? BrickWall : kind === "web" ? Globe2 : Cable

  if (settingUp) {
    return (
      <div
        aria-label={busyLabel}
        className="grid size-7 shrink-0 place-items-center border border-primary/30 bg-primary/5 text-primary"
        role="status"
      >
        <LoaderCircle className="size-3.5 animate-spin" />
      </div>
    )
  }

  if (!pending && !blocked) {
    return (
      <div
        className={`grid size-7 shrink-0 place-items-center border ${
          kind === "primary"
            ? "border-primary/30 bg-primary/5 text-primary"
            : "border-emerald-400/25 bg-emerald-400/5 text-emerald-300"
        }`}
      >
        <Icon className="size-3.5" />
      </div>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={
            pending
              ? "View Default Server restart warning"
              : errorMessage
                ? "View Default Server error"
                : "View route error"
          }
          className={`grid size-7 shrink-0 place-items-center border transition-colors ${
            pending
              ? "border-amber-400/30 bg-amber-400/5 text-amber-300 hover:bg-amber-400/10"
              : "border-destructive/35 bg-destructive/5 text-destructive hover:bg-destructive/10"
          }`}
          onClick={() => {
            if (errorMessage) {
              showToast({
                description: errorMessage,
                message: "Default Server is not configured",
                type: "error",
              })
              return
            }
            if (pendingMessage) {
              showPendingRestartToast({
                canRestart,
                message: pendingMessage,
                restarting,
                onRestart,
              })
              return
            }
            if (!state) return
            showRouteStatusToast({
              canRestart,
              restarting,
              state,
              onRestart,
            })
          }}
          type="button"
        >
          {pending ? (
            <AlertTriangle className="size-3.5" />
          ) : (
            <CircleAlert className="size-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {pending
          ? "Restart required"
          : errorMessage
            ? "Default Server needs configuration"
            : "View route error"}
      </TooltipContent>
    </Tooltip>
  )
})

const PublicAddressCopy = React.memo(function PublicAddressCopy({
  address,
  label,
  prominent = false,
}: {
  address: string | null
  label: string
  prominent?: boolean
}) {
  const { copied, copy } = useCopyFeedback(address ?? "")

  if (!address) {
    return (
      <span className="type-code block truncate text-muted-foreground">
        Unavailable
      </span>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`Copy ${label}`}
          className={`flex max-w-full items-center gap-1 font-mono transition-colors ${
            prominent ? "type-control" : "type-meta"
          } ${
            copied ? "text-emerald-400" : "text-primary/75 hover:text-primary"
          }`}
          onClick={() => {
            void copy()
          }}
          type="button"
        >
          <span className="truncate">{address}</span>
          {copied ? (
            <Check className="size-3 shrink-0" />
          ) : (
            <Copy className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {copied ? "Address copied" : "Copy address"}
      </TooltipContent>
    </Tooltip>
  )
})

function useCopyFeedback(value: string) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function copy() {
    await copyToClipboard(value)
    setCopied(true)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1_800)
  }

  return { copied, copy }
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
      throw new Error("Public Port must be between 1 and 65535")
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

function ProtocolSelect({
  value,
  onChange,
}: {
  value: RelayInstancePortProtocol
  onChange: (protocol: RelayInstancePortProtocol) => void
}) {
  return (
    <Select
      name="protocol"
      value={value}
      onValueChange={(nextValue) => {
        const parsed =
          relayInstancePortInputSchema.shape.protocol.safeParse(nextValue)
        if (parsed.success) onChange(parsed.data)
      }}
    >
      <SelectTrigger aria-label="Protocol" className="h-8 w-full text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="tcp">TCP</SelectItem>
        <SelectItem value="udp">UDP</SelectItem>
        <SelectItem value="both">TCP + UDP</SelectItem>
      </SelectContent>
    </Select>
  )
}

function AddNetworkRouteDialog({
  canAddPort,
  canAddWebRoute,
  canEditPublicPort,
  error,
  instanceId,
  pending,
  relayId,
  webRoute,
  onBeginSubmit,
  onCancelSubmit,
  onOpenChange,
  onSubmitPort,
  onSubmitWebRoute,
}: {
  canAddPort: boolean
  canAddWebRoute: boolean
  canEditPublicPort: boolean
  error: string | null
  instanceId: string
  pending: boolean
  relayId: string
  webRoute?: RelayInstanceWebRoute
  onBeginSubmit: (route: PendingNetworkRoute) => void
  onCancelSubmit: () => void
  onOpenChange: (open: boolean) => void
  onSubmitPort: (port: RelayInstancePortInput) => Promise<void>
  onSubmitWebRoute: (route: RelayInstanceWebRouteInput) => Promise<void>
}) {
  const [routeType, setRouteType] = React.useState<"port" | "web">(
    webRoute ? "web" : canAddPort ? "port" : "web"
  )
  const [validationError, setValidationError] = React.useState<string | null>(
    null
  )
  const [protocol, setProtocol] =
    React.useState<RelayInstancePortProtocol>("tcp")
  const [internalPort, setInternalPort] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)
  const portLease = usePortLease({
    enabled: routeType === "port" && canAddPort && !webRoute,
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
          <p className="type-technical-label text-primary">
            {webRoute ? "Web route" : "New route"}
          </p>
          <DialogTitle>
            {webRoute ? "Edit web route" : "Add a network route"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {webRoute
              ? "Update where this hostname forwards inside the Ember."
              : "Publish a raw TCP or UDP port, or forward a hostname to an HTTP service inside this Ember."}
          </DialogDescription>
        </DialogHeader>

        {!webRoute ? (
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            <Button
              aria-checked={routeType === "port"}
              className="h-auto items-start justify-start px-3 py-2.5 text-left"
              disabled={!canAddPort || pending}
              onClick={() => {
                setRouteType("port")
                setValidationError(null)
              }}
              role="radio"
              type="button"
              variant={routeType === "port" ? "default" : "outline"}
            >
              <Cable className="mt-0.5" />
              <span>
                <span className="block text-xs">Port</span>
                <span className="type-meta mt-0.5 block">TCP or UDP</span>
              </span>
            </Button>
            <Button
              aria-checked={routeType === "web"}
              className="h-auto items-start justify-start px-3 py-2.5 text-left"
              disabled={!canAddWebRoute || pending}
              onClick={() => {
                setRouteType("web")
                setValidationError(null)
              }}
              role="radio"
              type="button"
              variant={routeType === "web" ? "default" : "outline"}
            >
              <Globe2 className="mt-0.5" />
              <span>
                <span className="block text-xs">Web route</span>
                <span className="type-meta mt-0.5 block">HTTPS hostname</span>
              </span>
            </Button>
          </div>
        ) : null}

        <form
          key={webRoute?.id ?? routeType}
          action={(form) => {
            void (async () => {
              if (routeType === "port") {
                const draft = relayInstancePortInputSchema.safeParse({
                  internalPort: Number(form.get("internalPort")),
                  name: String(form.get("name") ?? ""),
                  protocol,
                })
                if (!draft.success) {
                  setValidationError(
                    draft.error.issues[0]?.message ??
                      "Port allocation is invalid"
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
                return
              }

              const path = String(form.get("path") ?? "").trim()
              const parsed = relayInstanceWebRouteInputSchema.safeParse({
                id: webRoute?.id,
                hostname: String(form.get("hostname") ?? ""),
                name: String(form.get("name") ?? ""),
                path: path || null,
                stripPrefix: form.get("stripPrefix") === "on",
                targetPort: Number(form.get("targetPort")),
              })
              if (!parsed.success) {
                setValidationError(
                  parsed.error.issues[0]?.message ?? "Web route is invalid"
                )
                return
              }
              setValidationError(null)
              if (!webRoute) {
                onBeginSubmit({
                  hostname: parsed.data.hostname,
                  kind: "web",
                  name: parsed.data.name,
                  path: parsed.data.path,
                  targetPort: parsed.data.targetPort,
                })
                setSubmitted(true)
              }
              await Effect.runPromise(
                Effect.tryPromise({
                  try: () => onSubmitWebRoute(parsed.data),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.tap(() => Effect.sync(() => onOpenChange(false))),
                  Effect.catch(() =>
                    Effect.sync(() => {
                      if (!webRoute) {
                        onCancelSubmit()
                        setSubmitted(false)
                      }
                    })
                  )
                )
              )
            })()
          }}
          className="space-y-4"
        >
          {routeType === "port" ? (
            <>
              <label className="type-label block space-y-1.5">
                Name
                <Input
                  autoComplete="off"
                  maxLength={32}
                  name="name"
                  placeholder="Voice chat"
                  required
                />
              </label>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[7.5rem_7.5rem_minmax(0,1fr)]">
                <label className="type-label block space-y-1.5">
                  Internal Port
                  <Input
                    max={65_535}
                    min={1}
                    name="internalPort"
                    placeholder="24454"
                    required
                    type="number"
                    value={internalPort ?? portLease.portValue}
                    onChange={(event) => setInternalPort(event.target.value)}
                  />
                </label>
                <label className="type-label block space-y-1.5">
                  Public Port
                  <Input
                    aria-label="Public Port"
                    className="font-mono"
                    disabled={!canEditPublicPort || portLease.pending}
                    max={65_535}
                    min={1}
                    readOnly={!canEditPublicPort}
                    type="number"
                    value={portLease.portValue}
                    onBlur={() => {
                      if (canEditPublicPort && portLease.lease) {
                        forkPromise(portLease.commit)
                      }
                    }}
                    onChange={(event) =>
                      portLease.setPortValue(event.target.value)
                    }
                  />
                </label>
                <label className="type-label col-span-2 block space-y-1.5 sm:col-span-1">
                  Protocol
                  <ProtocolSelect value={protocol} onChange={setProtocol} />
                </label>
              </div>
            </>
          ) : (
            <>
              <label className="type-label block space-y-1.5">
                Name
                <Input
                  autoComplete="off"
                  defaultValue={webRoute?.name}
                  maxLength={32}
                  name="name"
                  placeholder="Live map"
                  required
                />
              </label>
              <label className="type-label block space-y-1.5">
                Hostname
                <Input
                  autoCapitalize="none"
                  autoCorrect="off"
                  defaultValue={webRoute?.hostname}
                  name="hostname"
                  placeholder="map.donutsmp.com"
                  required
                />
              </label>
              <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
                <label className="type-label block space-y-1.5">
                  Path (optional)
                  <Input
                    defaultValue={webRoute?.path ?? ""}
                    name="path"
                    placeholder="/map"
                  />
                </label>
                <label className="type-label block space-y-1.5">
                  Internal Port
                  <Input
                    defaultValue={webRoute?.targetPort}
                    max={65_535}
                    min={1}
                    name="targetPort"
                    placeholder="8080"
                    required
                    type="number"
                  />
                </label>
              </div>
              <label className="type-support flex items-center gap-2 text-muted-foreground">
                <input
                  className="accent-primary"
                  defaultChecked={webRoute?.stripPrefix ?? true}
                  name="stripPrefix"
                  type="checkbox"
                />
                Strip the configured path before forwarding
              </label>
              <div className="type-meta flex gap-2 border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-amber-100">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
                Point this hostname at the Relay before applying the route.
              </div>
            </>
          )}

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
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : webRoute ? (
                <Pencil />
              ) : (
                <Plus />
              )}
              {pending
                ? webRoute
                  ? "Applying"
                  : "Adding"
                : webRoute
                  ? "Save route"
                  : "Add route"}
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
  const editing = allocation !== null || recoveringPrimary
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
          <p className="type-technical-label text-primary">
            {isDefaultServer
              ? "Default Server"
              : editing
                ? "Port mapping"
                : "New allocation"}
          </p>
          <DialogTitle>
            {recoveringPrimary
              ? "Assign the Default Server"
              : isDefaultServer
                ? "Edit the Default Server"
                : editing
                  ? "Edit port allocation"
                  : "Allocate a port"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {recoveringPrimary
              ? "Choose the internal port and protocol used by this game server. Kiln assigns its public port automatically."
              : "Choose where traffic should arrive inside the Ember. Kiln assigns the public port automatically."}
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
          {isDefaultServer ? null : (
            <label className="type-label block space-y-1.5">
              Name
              <Input
                autoComplete="off"
                defaultValue={allocation?.name ?? ""}
                maxLength={32}
                name="name"
                placeholder="Voice chat"
                required
              />
            </label>
          )}
          <div
            className={
              recoveringPrimary
                ? "grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3"
                : "grid grid-cols-2 gap-3 sm:grid-cols-[7.5rem_7.5rem_minmax(0,1fr)]"
            }
          >
            <label className="type-label block space-y-1.5">
              Internal Port
              <Input
                defaultValue={allocation?.internalPort}
                max={65_535}
                min={1}
                name="internalPort"
                placeholder="24454"
                required
                type="number"
                value={recoveringPrimary ? internalPort : undefined}
                onChange={
                  recoveringPrimary
                    ? (event) => setInternalPort(event.target.value)
                    : undefined
                }
              />
            </label>
            {recoveringPrimary ? null : (
              <label className="type-label block space-y-1.5">
                Public Port
                <Input
                  aria-label="Public Port"
                  className="font-mono"
                  disabled={
                    !isDefaultServer ||
                    !canEditPublicPort ||
                    publicPortLease.pending
                  }
                  onChange={(event) =>
                    publicPortLease.setPortValue(event.target.value)
                  }
                  readOnly={!isDefaultServer || !canEditPublicPort}
                  type="number"
                  value={
                    isDefaultServer && canEditPublicPort
                      ? publicPortLease.portValue
                      : allocation
                        ? String(allocation.externalPort)
                        : ""
                  }
                />
              </label>
            )}
            <label
              className={
                recoveringPrimary
                  ? "type-label block space-y-1.5"
                  : "type-label col-span-2 block space-y-1.5 sm:col-span-1"
              }
            >
              Protocol
              <ProtocolSelect value={protocol} onChange={setProtocol} />
            </label>
          </div>

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
                ? "Applying"
                : recoveringPrimary
                  ? "Assign Default Server"
                  : editing
                    ? "Save allocation"
                    : "Allocate port"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
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
              ? "w-7 border-amber-400/30 bg-amber-400/5 px-0 text-amber-200 hover:bg-amber-400/10 hover:text-amber-100 sm:w-auto sm:px-3"
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

function formatHostPort(host: string, port: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`
}

function formatPortProtocol(protocol: RelayInstancePortProtocol): string {
  return protocol === "both" ? "TCP + UDP" : protocol.toUpperCase()
}

async function copyToClipboard(value: string) {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          const textarea = document.createElement("textarea")
          textarea.value = value
          textarea.style.position = "fixed"
          textarea.style.opacity = "0"
          document.body.append(textarea)
          textarea.select()
          document.execCommand("copy")
          textarea.remove()
        })
      )
    )
  )
}
