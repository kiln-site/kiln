import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { Boxes, LoaderCircle, Rocket } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

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
import { WorkspaceFrame } from "@/components/workspace-frame"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import { recoverPromise } from "@/effect/promise"
import { appRouteIdentifier, resolveAppRoute } from "@/lib/app-route"
import type { ServerAction } from "@/lib/instance-power-state"
import { appsQueryOptions, queryKeys } from "@/lib/query-options"
import { deployApp, runAppAction } from "@/server/apps"

export const AppWorkspaceShell = React.memo(function AppWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  const routeId = useAppRouteParam()
  const workspace = useAppWorkspaceQuery(routeId)

  return (
    <WorkspaceFrame header={<AppWorkspaceHeader workspace={workspace} />}>
      <div data-slot="app-workspace-surface" className="contents">
        <AppWorkspaceBoundary workspace={workspace}>
          {children}
        </AppWorkspaceBoundary>
      </div>
    </WorkspaceFrame>
  )
})

function useAppRouteParam(): string | undefined {
  return useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params
      return params && "appId" in params && typeof params.appId === "string"
        ? params.appId
        : undefined
    },
  })
}

type WorkspaceQuery =
  | { status: "pending" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "found"; value: AppWorkspaceApp }

function useAppWorkspaceQuery(routeId: string | undefined): WorkspaceQuery {
  const select = React.useMemo(
    () => (overview: AppOverview) => {
      const resolution = resolveAppRoute(overview.apps, routeId)
      return resolution.status === "found"
        ? {
            app: resolution.database,
            routeId: appRouteIdentifier(overview.apps, resolution.database),
          }
        : null
    },
    [routeId]
  )
  const query = useQuery({ ...appsQueryOptions(), select })
  // Structural sharing keeps `query.data` stable while the app is unchanged,
  // so this object only changes when its content does.
  return React.useMemo(() => {
    if (query.data) return { status: "found", value: query.data }
    if (query.isPending) return { status: "pending" }
    if (query.isError) return { status: "error" }
    return { status: "missing" }
  }, [query.data, query.isError, query.isPending])
}

function AppWorkspaceBoundary({
  children,
  workspace,
}: {
  children: React.ReactNode
  workspace: WorkspaceQuery
}) {
  if (workspace.status === "found") {
    return (
      <AppWorkspaceContext.Provider value={workspace.value}>
        {children}
      </AppWorkspaceContext.Provider>
    )
  }
  if (workspace.status === "pending") {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
          <Boxes className="size-5" />
        </div>
        <p className="text-sm font-semibold">
          {workspace.status === "error"
            ? "Apps could not be loaded"
            : "This app is no longer available"}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {workspace.status === "error"
            ? "Hearth could not reach the app inventory. Try again shortly."
            : "It may have been deleted, or your access to it changed."}
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to="/infra/apps">All apps</Link>
        </Button>
      </div>
    </div>
  )
}

const AppWorkspaceHeader = React.memo(function AppWorkspaceHeader({
  workspace,
}: {
  workspace: WorkspaceQuery
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
          title={<AppRouteTitle />}
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

function AppRouteTitle() {
  const title = useRouterState({
    select: (state) => {
      if (
        state.matches.at(-1)?.routeId === "/_app/app/$appId/$" ||
        state.matches.some(
          (match) => match.status === "notFound" || match._notFound
        )
      ) {
        return "Not found"
      }
      const pathname = state.location.pathname
      if (pathname.endsWith("/terminal")) return "Terminal"
      if (pathname.endsWith("/logs")) return "Logs"
      if (pathname.includes("/files")) return "Files"
      if (pathname.endsWith("/network")) return "Network"
      if (pathname.endsWith("/info")) return "Info"
      return "Overview"
    },
  })
  return <>{title}</>
}

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
