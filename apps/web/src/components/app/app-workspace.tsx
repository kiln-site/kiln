import { resourceDeletionQueryOptions } from "@/lib/resource-deletion-queries"
import { AppKindIcon } from "@/components/instance-kind-icon"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { inventoryInstanceState } from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useHydrated, useNavigate } from "@tanstack/react-router"
import { primaryWebRoute, webRouteUrl } from "@workspace/contracts"
import type { RelayInstanceWebRoute } from "@workspace/contracts"
import { Hammer, Rocket, Trash2, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { showToast } from "@workspace/ui/components/sonner"

import { DeleteAppDialog } from "@/components/app/app-dialogs"
import {
  appRelayAvailable,
  appServices,
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
  WorkspaceCopyLinkButton,
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
import { WorkloadResourceMeters } from "@/components/workload-resource-meters"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import { heldPowerActions, useInstancePower } from "@/lib/use-instance-power"
import { appDestinations } from "@/lib/navigation-destinations"
import {
  appConfigQueryOptions,
  appDirectoryQueryOptions,
  webRoutesQueryOptions,
} from "@/lib/query-options"
import { useAppDeployState } from "@/components/app/use-app-deploy-state"
import { cancelQueuedAppDeploy } from "@/server/app-deployments"
import { deployApp, runAppAction } from "@/server/apps"

export const AppWorkspaceShell = React.memo(function AppWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  const appId = useWorkspaceRouteParam("appId")
  const workspace = useAppWorkspaceQuery(appId)

  return (
    <WorkspaceFrame header={<AppWorkspaceHeader workspace={workspace} />}>
      <div data-slot="app-workspace-surface" className="contents">
        <ResourceWorkspaceBoundary
          context={AppWorkspaceContext}
          icon={<AppKindIcon />}
          list={{ label: "All Apps", to: "/infra/apps" }}
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
        Delete App
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
  appId: string | undefined
): ResourceWorkspaceQuery<AppWorkspaceApp> {
  const select = React.useMemo(
    () =>
      (
        rows: Awaited<
          ReturnType<typeof import("@/server/apps").getAppDirectory>
        >
      ) => {
        const directory = rows.find((row) => row.id === appId)
        return directory ? { directory } : null
      },
    [appId]
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
          hostname: `app-${directory.id}`,
          network: "",
          observedState: "failed" as const,
          savedDatabaseIds: [],
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
            <WorkspaceIdCopyButton id={app.id} label="app ID" />
            <WorkspaceMetaSeparator />
          </span>
          <AppHeaderAddress app={app} />
        </WorkspaceIdentity>
      }
      center={<AppResourceMeters app={app} />}
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

// The App's live usage, as a game server's header shows its own. It
// re-renders only when the App's services or running state change; the
// meters follow their samples themselves.
function AppResourceMeters({ app }: { app: App }) {
  const serviceList = appServices(app).join("\n")
  const services = React.useMemo(
    () => (serviceList ? serviceList.split("\n") : []),
    [serviceList]
  )
  const running = app.containers.filter((container) => container.running)
  const startedAt =
    running
      .flatMap((container) =>
        container.startedAt ? [container.startedAt] : []
      )
      .sort()[0] ?? null
  return (
    <WorkloadResourceMeters
      id={app.id}
      kind="app"
      relayConnected={appRelayAvailable(app)}
      relayId={app.relayId}
      running={running.length > 0}
      services={services}
      startedAt={startedAt}
    />
  )
}

// The app's primary domain, where people reach it, or its address inside
// the Relay's network when it has none.
function AppHeaderAddress({ app }: { app: App }) {
  const url = useQuery({
    ...webRoutesQueryOptions({
      relayId: app.relayId,
      resourceId: app.id,
      resourceType: "app",
    }),
    select: selectPrimaryUrl,
  }).data
  return url ? (
    <WorkspaceCopyLinkButton href={url} label="domain" />
  ) : (
    <WorkspaceCopyValueButton label="internal address" value={app.hostname} />
  )
}

function selectPrimaryUrl(state: {
  routes: ReadonlyArray<RelayInstanceWebRoute>
}): string | null {
  const route = primaryWebRoute(state.routes)
  return route ? webRouteUrl(route) : null
}

function AppPowerControls({
  onError,
  workspace,
}: {
  onError: (error: string | null) => void
  workspace: AppWorkspaceApp
}) {
  const { app } = workspace
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: deletion } = useQuery(
    resourceDeletionQueryOptions({
      kind: "app",
      relayId: app.relayId,
      resourceId: app.id,
    })
  )
  const canDeploy = !deletion && app.permissions.includes("instance.deploy")
  const deployed = app.containers.length > 0
  const deployLabel = deployed ? "Redeploy" : "Deploy"
  // An image is pulled, so it has no build cache to skip.
  const { data: sourceType } = useQuery({
    ...appConfigQueryOptions(app.relayId, app.id),
    enabled: canDeploy,
    select: ({ config }) => config.sourceType,
  })
  // Power and deploying are each a permission of their own.
  const powerPermissions = React.useMemo(
    () => heldPowerActions(app.permissions, !deletion && deployed),
    [app.permissions, deletion, deployed]
  )
  const canPower = Object.values(powerPermissions).some(Boolean)
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: instanceInventoryScope({
        kind: "app",
        relayId: app.relayId,
        id: app.id,
      }),
    })
  const power = useInstancePower({
    reference: { id: app.id, kind: "app", relayId: app.relayId },
    run: (action) =>
      runAppAction({
        data: { action, appId: app.id, relayId: app.relayId },
      }),
    onError,
    onFailure: (cause) => showAppOperationError("App action failed", cause),
  })
  const deploy = useMutation({
    mutationFn: (noCache: boolean) =>
      deployApp({
        data: {
          appId: app.id,
          relayId: app.relayId,
          ...(noCache && { noCache }),
        },
      }),
    onMutate: () => onError(null),
    onSuccess: async () => {
      // It runs once any deployment running ends.
      showToast({ message: `${deployLabel} queued`, type: "success" })
      await invalidate()
      // Follow the deployment as it happens.
      if (app.permissions.includes("app.logs.read")) {
        await navigate({
          params: { appId: app.id },
          search: { stream: "deployment" },
          to: "/app/$appId/logs",
        })
      }
    },
    onError: (cause) => {
      onError(cause.message)
      showAppOperationError(`${deployLabel} failed`, cause)
    },
  })
  const relayConnected = appRelayAvailable(app)
  const hearth = useAppDeployState(app.id)
  const deploying =
    (relayConnected && app.deployment?.state === "running") ||
    hearth?.deploying === true
  const queued = hearth?.queuedId ?? null
  const deployDisabled = !relayConnected || power.pending
  const deployPending = deploy.isPending || deploying || queued !== null

  if (!canDeploy && !canPower) return null
  return (
    <div className="flex items-center gap-1.5">
      {queued !== null ? (
        <CancelQueuedDeploy app={app} operationId={queued} />
      ) : null}
      <WorkspacePowerControls
        action={power.action}
        killWarning="This immediately terminates the App's containers. Anything they haven't saved may be lost."
        menuAction={
          canDeploy &&
          deployed &&
          sourceType !== undefined &&
          sourceType !== "image"
            ? {
                description: "Rebuild every layer from scratch",
                disabled: deployDisabled || deployPending,
                icon: <Hammer className="size-3.5" />,
                label: "Redeploy without cache",
                onClick: () => deploy.mutate(true),
              }
            : undefined
        }
        noun="app"
        powerPermissions={powerPermissions}
        primaryAction={
          canDeploy
            ? {
                disabled: deployDisabled,
                icon: <Rocket />,
                label: deployLabel,
                pending: deployPending,
                pendingLabel:
                  deploying || deploy.isPending ? "Deploying" : "Queued",
                onClick: () => deploy.mutate(false),
              }
            : undefined
        }
        target={{
          name: app.name,
          observedState: app.observedState,
          provisioning: app.provisioning ?? null,
        }}
        relayConnected={relayConnected}
        onAction={power.onAction}
      />
    </div>
  )
}

// Withdraws the deploy waiting its turn, the one shown.
function CancelQueuedDeploy({
  app,
  operationId,
}: {
  app: App
  operationId: string
}) {
  const cancel = useMutation({
    mutationFn: () =>
      cancelQueuedAppDeploy({
        data: { appId: app.id, operationId, relayId: app.relayId },
      }),
    onSuccess: () =>
      showToast({ message: "Queued deploy cancelled", type: "success" }),
    onError: (cause) => showAppOperationError("Couldn't cancel", cause),
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Cancel queued deploy"
          className="text-muted-foreground"
          disabled={cancel.isPending}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={() => cancel.mutate()}
        >
          <X />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Cancel queued deploy</TooltipContent>
    </Tooltip>
  )
}
