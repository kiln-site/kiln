import { instanceInventoryScope } from "@/lib/instance-inventory"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { inventoryInstanceState } from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Database } from "lucide-react"

import {
  databaseRelayAvailable,
  engineLabel,
  showDatabaseOperationError,
} from "@/components/database/database-presentation"
import {
  DatabaseWorkspaceContext,
  type DatabaseWorkspaceDatabase,
} from "@/components/database/database-workspace-context"
import {
  ResourceWorkspaceBoundary,
  WorkspaceRouteTitle,
  useResourceWorkspaceQuery,
  useWorkspaceRouteParam,
  type ResourceWorkspaceQuery,
} from "@/components/resource-workspace"
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
import { databaseDestinations } from "@/lib/navigation-destinations"
import { managedDatabaseDirectoryQueryOptions } from "@/lib/query-options"
import { runManagedDatabaseAction } from "@/server/databases"

export const DatabaseWorkspaceShell = React.memo(
  function DatabaseWorkspaceShell({ children }: { children: React.ReactNode }) {
    const routeId = useWorkspaceRouteParam("databaseId")
    const workspace = useDatabaseWorkspaceQuery(routeId)

    return (
      <WorkspaceFrame
        header={<DatabaseWorkspaceHeader workspace={workspace} />}
      >
        <div data-slot="database-workspace-surface" className="contents">
          <ResourceWorkspaceBoundary
            context={DatabaseWorkspaceContext}
            icon={<Database />}
            list={{ label: "All databases", to: "/infra/databases" }}
            noun={{ one: "database", other: "databases" }}
            workspace={workspace}
          >
            {children}
          </ResourceWorkspaceBoundary>
        </div>
      </WorkspaceFrame>
    )
  }
)

function useDatabaseWorkspaceQuery(
  routeId: string | undefined
): ResourceWorkspaceQuery<DatabaseWorkspaceDatabase> {
  const select = React.useMemo(
    () =>
      (
        rows: Awaited<
          ReturnType<
            typeof import("@/server/databases").getManagedDatabaseDirectory
          >
        >
      ) => {
        const resolution = resolveDatabaseRoute(rows, routeId)
        return resolution.status === "found"
          ? {
              directory: resolution.resource,
              routeId: databaseRouteIdentifier(rows, resolution.resource),
            }
          : null
      },
    [routeId]
  )
  const directory = useQuery({
    ...managedDatabaseDirectoryQueryOptions(),
    select,
  })
  const selected = directory.data
  const inventory = useQuery({
    ...instanceInventoryQueryOptions(
      {
        kind: "database",
        id: selected?.directory.id ?? "",
        relayId: selected?.directory.relayId ?? "",
      },
      "detail"
    ),
    enabled: Boolean(selected),
  })
  const state = inventoryInstanceState(inventory)
  const data = React.useMemo(() => {
    if (!selected || inventory.isPending) return null
    const value = inventory.data
    const detail =
      value?.kind === "database" && value.view === "detail" ? value.data : null
    const observation = state.phase === "ready" ? state.observation : undefined
    const { directory } = selected
    return {
      database: {
        // Without a Relay record the workspace still opens, so the database
        // can be inspected and deleted.
        ...(detail ?? {
          connectedInstanceIds: [],
          containerId: null,
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
      },
      routeId: selected.routeId,
    }
  }, [selected, inventory.isPending, inventory.data, state])
  return useResourceWorkspaceQuery({
    data,
    isPending: directory.isPending || Boolean(selected && inventory.isPending),
    isError: directory.isError,
  })
}

const DatabaseWorkspaceHeader = React.memo(function DatabaseWorkspaceHeader({
  workspace,
}: {
  workspace: ResourceWorkspaceQuery<DatabaseWorkspaceDatabase>
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
          title={
            <WorkspaceRouteTitle
              destinations={databaseDestinations}
              fallback="Info"
              notFoundRouteId="/_app/db/$databaseId/$"
            />
          }
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
        queryKey: instanceInventoryScope({
          kind: "database",
          relayId: database.relayId,
          id: database.id,
        }),
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
      relayConnected={databaseRelayAvailable(database)}
      onAction={handleAction}
    />
  )
}
