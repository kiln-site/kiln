import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Boxes, Rocket } from "lucide-react"

import {
  appRelayAvailable,
  showAppOperationError,
  type AppOverview,
} from "@/components/app/app-presentation"
import {
  AppWorkspaceContext,
  type AppWorkspaceApp,
} from "@/components/app/app-workspace-context"
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
import { appsQueryOptions, queryKeys } from "@/lib/query-options"
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
          icon={<Boxes />}
          list={{ label: "All apps", to: "/infra/apps" }}
          noun={{ one: "app", other: "apps" }}
          workspace={workspace}
        >
          {children}
        </ResourceWorkspaceBoundary>
      </div>
    </WorkspaceFrame>
  )
})

function useAppWorkspaceQuery(
  routeId: string | undefined
): ResourceWorkspaceQuery<AppWorkspaceApp> {
  const select = React.useMemo(
    () => (overview: AppOverview) => {
      const resolution = resolveAppRoute(overview.apps, routeId)
      return resolution.status === "found"
        ? {
            app: resolution.resource,
            routeId: appRouteIdentifier(overview.apps, resolution.resource),
          }
        : null
    },
    [routeId]
  )
  return useResourceWorkspaceQuery(useQuery({ ...appsQueryOptions(), select }))
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
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.list })
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
  const deploying = app.deployment?.state === "running"
  const relayConnected = appRelayAvailable(app)

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
      target={{ name: app.name, observedState: app.observedState }}
      relayConnected={relayConnected}
      onAction={handleAction}
    />
  )
}
