import { AppKindIcon } from "@/components/instance-kind-icon"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { inventoryInstanceState } from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useHydrated, useNavigate } from "@tanstack/react-router"
import { Rocket, Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { DeleteAppDialog } from "@/components/app/app-dialogs"
import {
  appRelayAvailable,
  showAppOperationError,
  type App,
} from "@/components/app/app-presentation"
import {
  AppWorkspaceContext,
  useAppWorkspace,
  type AppWorkspaceApp,
} from "@/components/app/app-workspace-context"
import { ProvisioningGate } from "@/components/provisioning-progress"
import {
  WorkspaceCopyValueButton,
  WorkspaceHeader,
  WorkspaceIdCopyButton,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import {
  ResourceWorkspaceBoundary,
  WorkspaceRouteTitle,
  useResourceWorkspaceQuery,
  useWorkspaceRouteParam,
  type ResourceWorkspaceQuery,
} from "@/components/resource-workspace"
import { WorkspaceFrame } from "@/components/workspace-frame"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import { recoverPromise } from "@/effect/promise"
import { appRouteIdentifier, resolveAppRoute } from "@/lib/app-route"
import type { ServerAction } from "@/lib/instance-power-state"
import { appDestinations } from "@/lib/navigation-destinations"
import { appDirectoryQueryOptions } from "@/lib/query-options"
import { deployApp, runAppAction } from "@/server/apps"

export const AppWorkspaceShell = React.memo(function AppWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  const routeId = useWorkspaceRouteParam("appId")
  const workspace = useAppWorkspaceQuery(routeId)

  return (
    <WorkspaceFrame header={<AppWorkspaceHeader workspace={workspace} />}>
      <div data-slot="app-workspace-surface" className="contents">
        <ResourceWorkspaceBoundary
          context={AppWorkspaceContext}
          icon={<AppKindIcon />}
          list={{ label: "All apps", to: "/infra/apps" }}
          noun={{ one: "app", other: "apps" }}
          workspace={workspace}
        >
          <AppProvisioningBoundary>{children}</AppProvisioningBoundary>
        </ResourceWorkspaceBoundary>
      </div>
    </WorkspaceFrame>
  )
})

// Until the Relay has created the app, every page shows how far it got,
// and one that failed can be deleted from there.
function AppProvisioningBoundary({ children }: { children: React.ReactNode }) {
  const { app } = useAppWorkspace()
  return (
    <ProvisioningGate
      failedActions={
        app.permissions.includes("app.delete") ? (
          <DeleteFailedApp app={app} />
        ) : null
      }
      id={app.id}
      kind="app"
      name={app.name}
      provisioning={app.provisioning}
      relayId={app.relayId}
    >
      {children}
    </ProvisioningGate>
  )
}

function DeleteFailedApp({ app }: { app: App }) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        size="sm"
        type="button"
        variant="destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 />
        Delete app
      </Button>
      {open ? (
        <DeleteAppDialog
          app={app}
          open
          onDeleted={() => void navigate({ to: "/infra/apps", replace: true })}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

function useAppWorkspaceQuery(
  routeId: string | undefined
): ResourceWorkspaceQuery<AppWorkspaceApp> {
  const select = React.useMemo(
    () =>
      (
        rows: Awaited<
          ReturnType<typeof import("@/server/apps").getAppDirectory>
        >
      ) => {
        const resolution = resolveAppRoute(rows, routeId)
        return resolution.status === "found"
          ? {
              directory: resolution.resource,
              routeId: appRouteIdentifier(rows, resolution.resource),
            }
          : null
      },
    [routeId]
  )
  const hydrated = useHydrated()
  const directory = useQuery({ ...appDirectoryQueryOptions(), select })
  const selected = directory.data
  const inventory = useQuery({
    ...instanceInventoryQueryOptions(
      {
        kind: "app",
        id: selected?.directory.id ?? "",
        relayId: selected?.directory.relayId ?? "",
      },
      "detail"
    ),
    enabled: Boolean(selected),
  })
  const state = inventoryInstanceState(inventory)
  // The details stream into a page while Hearth renders it, so they can
  // arrive before the browser hydrates. Until then the workspace opens as
  // Hearth rendered it, so the two renders match.
  const inventoryPending = inventory.isPending || !hydrated
  const data = React.useMemo(() => {
    if (!selected || inventoryPending) return null
    const value = inventory.data
    const detail =
      value?.kind === "app" && value.view === "detail" ? value.data : null
    const observation = state.phase === "ready" ? state.observation : undefined
    const { directory } = selected
    return {
      app: {
        // Without a Relay record the workspace still opens, so the app can
        // be inspected and deleted.
        ...(detail ?? {
          connectedDatabaseIds: [],
          containers: [],
          dataDirectory: "",
          deployment: null,
          hostname: `app-${directory.shortId}`,
          network: "",
          observedState: "failed" as const,
          status: "Unavailable",
        }),
        ...directory,
        runtimeStatus: state,
        observedState: observation?.runtime ?? undefined,
        inventoryStatus: observation?.inventory ?? ("unavailable" as const),
        relayStatus:
          observation?.reachability === "connected"
            ? ("connected" as const)
            : ("unreachable" as const),
        relayUpdating: observation?.updating ?? false,
        status: instanceStatePresentation(state).label,
        latestObservation: value?.observation,
      },
      routeId: selected.routeId,
    }
  }, [selected, inventoryPending, inventory.data, state])
  return useResourceWorkspaceQuery({
    data,
    isPending: directory.isPending || Boolean(selected && inventoryPending),
    isError: directory.isError,
  })
}

const AppWorkspaceHeader = React.memo(function AppWorkspaceHeader({
  workspace,
}: {
  workspace: ResourceWorkspaceQuery<AppWorkspaceApp>
}) {
  const [error, setError] = React.useState<string | null>(null)
  if (workspace.status !== "found") return <WorkspaceHeader identity={null} />
  const { app } = workspace.value

  return (
    <WorkspaceHeader
      identity={
        <WorkspaceIdentity
          error={error}
          name={app.name}
          statusConfirmed={
            app.runtimeStatus !== undefined &&
            app.runtimeStatus.phase !== "checking"
          }
          title={
            <WorkspaceRouteTitle
              destinations={appDestinations}
              fallback="Info"
              notFoundRouteId="/_app/app/$appId/$"
            />
          }
        >
          <span className="hidden shrink-0 items-center gap-1.5 @[30rem]:inline-flex">
            <span>{app.status}</span>
            <WorkspaceMetaSeparator />
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
            <WorkspaceIdCopyButton
              id={app.id}
              label="app ID"
              shortId={app.shortId}
            />
            <WorkspaceMetaSeparator />
          </span>
          <WorkspaceCopyValueButton
            label="internal address"
            value={app.hostname}
          />
        </WorkspaceIdentity>
      }
      actions={
        <AppPowerControls
          key={`${app.relayId}:${app.id}`}
          workspace={workspace.value}
          onError={setError}
        />
      }
    />
  )
})

function AppPowerControls({
  onError,
  workspace,
}: {
  onError: (error: string | null) => void
  workspace: AppWorkspaceApp
}) {
  const { app, routeId } = workspace
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const canManage = app.permissions.includes("app.manage")
  const deployed = app.containers.length > 0
  const powerPermissions = React.useMemo(
    () => ({
      kill: false,
      restart: canManage && deployed,
      start: canManage && deployed,
      stop: canManage && deployed,
    }),
    [canManage, deployed]
  )
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: instanceInventoryScope({
        kind: "app",
        relayId: app.relayId,
        id: app.id,
      }),
    })
  const action = useMutation({
    mutationFn: (nextAction: "restart" | "start" | "stop") =>
      runAppAction({
        data: { action: nextAction, appId: app.id, relayId: app.relayId },
      }),
    onMutate: () => onError(null),
    onSuccess: invalidate,
    onError: (cause) => {
      onError(cause.message)
      showAppOperationError("App action failed", cause)
    },
  })
  const deploy = useMutation({
    mutationFn: () =>
      deployApp({ data: { appId: app.id, relayId: app.relayId } }),
    onMutate: () => onError(null),
    onSuccess: async () => {
      await invalidate()
      // Follow the deployment as it happens.
      if (app.permissions.includes("app.logs.read")) {
        await navigate({
          params: { appId: routeId },
          search: { stream: "deployment" },
          to: "/app/$appId/logs",
        })
      }
    },
    onError: (cause) => {
      onError(cause.message)
      showAppOperationError("Deploy failed", cause)
    },
  })
  const runAction = action.mutateAsync
  const handleAction = React.useCallback(
    async (nextAction: ServerAction) => {
      if (nextAction === "kill") return
      // Failures surface through the mutation's onError.
      await recoverPromise(
        () => runAction(nextAction),
        () => undefined
      )
    },
    [runAction]
  )
  const relayConnected = appRelayAvailable(app)
  const deploying = relayConnected && app.deployment?.state === "running"

  if (!canManage) return null
  return (
    <WorkspacePowerControls
      action={action.isPending ? action.variables : null}
      noun="app"
      powerPermissions={powerPermissions}
      primaryAction={{
        disabled: !relayConnected || action.isPending,
        icon: <Rocket />,
        label: "Deploy",
        pending: deploy.isPending || deploying,
        pendingLabel: "Deploying",
        onClick: () => deploy.mutate(),
      }}
      target={{
        name: app.name,
        observedState: app.observedState,
        provisioning: app.provisioning ?? null,
      }}
      relayConnected={relayConnected}
      onAction={handleAction}
    />
  )
}
