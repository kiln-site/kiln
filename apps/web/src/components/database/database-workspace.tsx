import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { Database, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  engineLabel,
  showDatabaseOperationError,
  type ManagedDatabaseOverview,
} from "@/components/database/database-presentation"
import {
  DatabaseWorkspaceContext,
  type DatabaseWorkspaceDatabase,
} from "@/components/database/database-workspace-context"
import { WorkspaceFrame } from "@/components/workspace-frame"
import { recoverPromise } from "@/effect/promise"
import {
  WorkspaceCopyValueButton,
  WorkspaceHeader,
  WorkspaceIdCopyButton,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import {
  databaseRouteIdentifier,
  resolveDatabaseRoute,
} from "@/lib/database-route"
import type { ServerAction } from "@/lib/instance-power-state"
import { managedDatabasesQueryOptions, queryKeys } from "@/lib/query-options"
import { runManagedDatabaseAction } from "@/server/databases"

export const DatabaseWorkspaceShell = React.memo(
  function DatabaseWorkspaceShell({ children }: { children: React.ReactNode }) {
    const routeId = useDatabaseRouteParam()
    const workspace = useDatabaseWorkspaceQuery(routeId)

    return (
      <WorkspaceFrame
        header={<DatabaseWorkspaceHeader workspace={workspace} />}
      >
        <div data-slot="database-workspace-surface" className="contents">
          <DatabaseWorkspaceBoundary workspace={workspace}>
            {children}
          </DatabaseWorkspaceBoundary>
        </div>
      </WorkspaceFrame>
    )
  }
)

function useDatabaseRouteParam(): string | undefined {
  return useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params
      return params &&
        "databaseId" in params &&
        typeof params.databaseId === "string"
        ? params.databaseId
        : undefined
    },
  })
}

type WorkspaceQuery =
  | { status: "pending" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "found"; value: DatabaseWorkspaceDatabase }

function useDatabaseWorkspaceQuery(
  routeId: string | undefined
): WorkspaceQuery {
  const select = React.useMemo(
    () => (overview: ManagedDatabaseOverview) => {
      const resolution = resolveDatabaseRoute(overview.databases, routeId)
      return resolution.status === "found"
        ? {
            database: resolution.database,
            routeId: databaseRouteIdentifier(
              overview.databases,
              resolution.database
            ),
          }
        : null
    },
    [routeId]
  )
  const query = useQuery({ ...managedDatabasesQueryOptions(), select })
  // Structural sharing keeps `query.data` stable while the database is
  // unchanged, so this object only changes when its content does.
  return React.useMemo(() => {
    if (query.data) return { status: "found", value: query.data }
    if (query.isPending) return { status: "pending" }
    if (query.isError) return { status: "error" }
    return { status: "missing" }
  }, [query.data, query.isError, query.isPending])
}

function DatabaseWorkspaceBoundary({
  children,
  workspace,
}: {
  children: React.ReactNode
  workspace: WorkspaceQuery
}) {
  if (workspace.status === "found") {
    return (
      <DatabaseWorkspaceContext.Provider value={workspace.value}>
        {children}
      </DatabaseWorkspaceContext.Provider>
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
          <Database className="size-5" />
        </div>
        <p className="text-sm font-semibold">
          {workspace.status === "error"
            ? "Databases could not be loaded"
            : "This database is no longer available"}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {workspace.status === "error"
            ? "Hearth could not reach the database inventory. Try again shortly."
            : "It may have been deleted, or your access to it changed."}
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to="/infra/databases">All databases</Link>
        </Button>
      </div>
    </div>
  )
}

const DatabaseWorkspaceHeader = React.memo(function DatabaseWorkspaceHeader({
  workspace,
}: {
  workspace: WorkspaceQuery
}) {
  const [error, setError] = React.useState<string | null>(null)
  if (workspace.status !== "found") return <WorkspaceHeader identity={null} />
  const { database } = workspace.value

  return (
    <WorkspaceHeader
      identity={
        <WorkspaceIdentity
          error={error}
          name={database.name}
          title={<DatabaseRouteTitle />}
        >
          <span className="hidden shrink-0 items-center gap-1.5 @[30rem]:inline-flex">
            <span>
              {engineLabel(database.engine)}{" "}
              {database.image.split(":").at(1) ?? ""}
            </span>
            <WorkspaceMetaSeparator />
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
            <WorkspaceIdCopyButton
              id={database.id}
              label="database ID"
              shortId={database.shortId}
            />
            <WorkspaceMetaSeparator />
          </span>
          <WorkspaceCopyValueButton
            label="internal address"
            value={`${database.hostname}:${database.internalPort}`}
          />
        </WorkspaceIdentity>
      }
      actions={
        <DatabasePowerControls
          key={`${database.relayId}:${database.id}`}
          workspace={workspace.value}
          onError={setError}
        />
      }
    />
  )
})

function DatabaseRouteTitle() {
  const title = useRouterState({
    select: (state) => {
      if (
        state.matches.at(-1)?.routeId === "/_app/db/$databaseId/$" ||
        state.matches.some(
          (match) => match.status === "notFound" || match._notFound
        )
      ) {
        return "Not found"
      }
      const pathname = state.location.pathname
      if (pathname.endsWith("/viewer")) return "Viewer"
      if (pathname.endsWith("/network")) return "Network"
      return "Info"
    },
  })
  return <>{title}</>
}

const databasePowerActions = ["start", "stop", "restart"] as const

function DatabasePowerControls({
  onError,
  workspace,
}: {
  onError: (error: string | null) => void
  workspace: DatabaseWorkspaceDatabase
}) {
  const { database } = workspace
  const queryClient = useQueryClient()
  const canPower = database.permissions.includes("database.power")
  const powerPermissions = React.useMemo(
    () => ({ kill: false, restart: canPower, start: canPower, stop: canPower }),
    [canPower]
  )
  const action = useMutation({
    mutationFn: (nextAction: (typeof databasePowerActions)[number]) =>
      runManagedDatabaseAction({
        data: {
          action: nextAction,
          databaseId: database.id,
          relayId: database.relayId,
        },
      }),
    onMutate: () => onError(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.list,
      })
    },
    onError: (cause) => {
      onError(cause.message)
      showDatabaseOperationError("Database action failed", cause)
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

  return (
    <WorkspacePowerControls
      action={action.isPending ? action.variables : null}
      noun="database"
      powerPermissions={powerPermissions}
      target={{ name: database.name, observedState: database.observedState }}
      relayConnected={database.inventoryStatus === "available"}
      onAction={handleAction}
    />
  )
}
