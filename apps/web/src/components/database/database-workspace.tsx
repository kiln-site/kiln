import { resourceDeletionQueryOptions } from "@/lib/resource-deletion-queries"
import { NO_RESOURCE_LIMITS } from "@workspace/contracts"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { inventoryInstanceState } from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { RefreshCw, Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { DeleteDatabaseDialog } from "@/components/database/database-dialogs"
import {
  databaseRelayAvailable,
  engineLabel,
  engineProductLabel,
  showDatabaseOperationError,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import {
  DatabaseWorkspaceContext,
  useDatabaseWorkspace,
  type DatabaseWorkspaceDatabase,
} from "@/components/database/database-workspace-context"
import { ProvisioningGate } from "@/components/provisioning-progress"
import { RedeployDialog } from "@/components/redeploy-dialog"
import {
  ResourceWorkspaceBoundary,
  WorkspaceRouteTitle,
  useResourceWorkspaceQuery,
  useWorkspaceRouteParam,
  type ResourceWorkspaceQuery,
} from "@/components/resource-workspace"
import { WorkspaceFrame } from "@/components/workspace-frame"
import { WorkloadResourceMeters } from "@/components/workload-resource-meters"
import {
  WorkspaceCopyValueButton,
  WorkspaceHeader,
  WorkspaceIdCopyButton,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import { heldPowerActions, useInstancePower } from "@/lib/use-instance-power"
import { databaseDestinations } from "@/lib/navigation-destinations"
import { managedDatabaseDirectoryQueryOptions } from "@/lib/query-options"
import {
  redeployManagedDatabase,
  runManagedDatabaseAction,
} from "@/server/databases"

export const DatabaseWorkspaceShell = React.memo(
  function DatabaseWorkspaceShell({ children }: { children: React.ReactNode }) {
    const databaseId = useWorkspaceRouteParam("databaseId")
    const workspace = useDatabaseWorkspaceQuery(databaseId)

    return (
      <WorkspaceFrame
        header={<DatabaseWorkspaceHeader workspace={workspace} />}
      >
        <div data-slot="database-workspace-surface" className="contents">
          <ResourceWorkspaceBoundary
            context={DatabaseWorkspaceContext}
            icon={<DatabaseKindIcon />}
            list={{ label: "All databases", to: "/infra/databases" }}
            noun={{ one: "database", other: "databases" }}
            workspace={workspace}
          >
            <DatabaseProvisioningBoundary>
              {children}
            </DatabaseProvisioningBoundary>
          </ResourceWorkspaceBoundary>
        </div>
      </WorkspaceFrame>
    )
  }
)

// Until the Relay has created the database, every page shows how far it
// got, and one that failed can be deleted from there.
function DatabaseProvisioningBoundary({
  children,
}: {
  children: React.ReactNode
}) {
  const { database } = useDatabaseWorkspace()
  return (
    <ProvisioningGate
      failedActions={
        database.permissions.includes("database.delete") ? (
          <DeleteFailedDatabase database={database} />
        ) : null
      }
      id={database.id}
      kind="database"
      name={database.name}
      provisioning={database.provisioning}
      relayId={database.relayId}
    >
      {children}
    </ProvisioningGate>
  )
}

function DeleteFailedDatabase({ database }: { database: ManagedDatabase }) {
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
        Delete database
      </Button>
      {open ? (
        <DeleteDatabaseDialog
          database={database}
          open
          onDeleted={() =>
            void navigate({ to: "/infra/databases", replace: true })
          }
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

function useDatabaseWorkspaceQuery(
  databaseId: string | undefined
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
        const directory = rows.find((row) => row.id === databaseId)
        return directory ? { directory } : null
      },
    [databaseId]
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
          containerId: null,
          diskUsedBytes: null,
          limits: NO_RESOURCE_LIMITS,
          members: [],
          observedState: "failed" as const,
          startedAt: null,
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
    }
  }, [selected, inventory.isPending, inventory.data, state])
  return useResourceWorkspaceQuery({
    data,
    isPending: directory.isPending || Boolean(selected && inventory.isPending),
    isError: directory.isError,
  })
}

// A database runs one container, with no services to choose between.
const noServices: ReadonlyArray<string> = []

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
          statusConfirmed={
            database.runtimeStatus !== undefined &&
            database.runtimeStatus.phase !== "checking"
          }
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
            <WorkspaceIdCopyButton id={database.id} label="database ID" />
            <WorkspaceMetaSeparator />
          </span>
          <WorkspaceCopyValueButton
            label="internal address"
            value={`${database.hostname}:${database.internalPort}`}
          />
        </WorkspaceIdentity>
      }
      center={
        <WorkloadResourceMeters
          id={database.id}
          kind="database"
          relayConnected={databaseRelayAvailable(database)}
          relayId={database.relayId}
          running={database.observedState === "running"}
          services={noServices}
          startedAt={database.startedAt}
        />
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

function DatabasePowerControls({
  onError,
  workspace,
}: {
  onError: (error: string | null) => void
  workspace: DatabaseWorkspaceDatabase
}) {
  const { database } = workspace
  const { data: deletion } = useQuery(
    resourceDeletionQueryOptions({
      kind: "database",
      relayId: database.relayId,
      resourceId: database.id,
    })
  )
  const powerPermissions = React.useMemo(
    () => heldPowerActions(database.permissions, !deletion),
    [database.permissions, deletion]
  )
  const power = useInstancePower({
    reference: {
      id: database.id,
      kind: "database",
      relayId: database.relayId,
    },
    run: (action) =>
      runManagedDatabaseAction({
        data: {
          action,
          databaseId: database.id,
          relayId: database.relayId,
        },
      }),
    onError,
    onFailure: (cause) =>
      showDatabaseOperationError("Database action failed", cause),
  })
  // Deploying is a permission of its own, apart from power.
  const canDeploy =
    !deletion && database.permissions.includes("instance.deploy")
  const [redeployOpen, setRedeployOpen] = React.useState(false)
  const navigate = useNavigate()
  const redeploy = useMutation({
    mutationFn: () =>
      redeployManagedDatabase({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onMutate: () => {
      setRedeployOpen(false)
      // Follow the deployment as it happens, as an App's is.
      if (database.permissions.includes("database.logs.read")) {
        void navigate({
          params: { databaseId: database.id },
          search: { stream: "deployment" },
          to: "/db/$databaseId/logs",
        })
      }
    },
    onSuccess: () =>
      showToast({ message: `${database.name} redeployed`, type: "success" }),
    onError: (cause) => showDatabaseOperationError("Redeploy failed", cause),
  })
  const relayConnected = databaseRelayAvailable(database)

  return (
    <>
      <WorkspacePowerControls
        action={power.action}
        killWarning="This immediately terminates the database's container. Changes it hasn't written to disk may be lost."
        menuAction={
          canDeploy
            ? {
                description: "Pull its image again and replace its container",
                disabled: !relayConnected || redeploy.isPending,
                icon: <RefreshCw className="size-3.5" />,
                label: "Redeploy",
                onClick: () => setRedeployOpen(true),
              }
            : undefined
        }
        noun="database"
        powerPermissions={powerPermissions}
        target={{
          name: database.name,
          observedState: database.observedState,
          provisioning: database.provisioning ?? null,
        }}
        relayConnected={relayConnected}
        onAction={power.onAction}
      />
      {canDeploy ? (
        <RedeployDialog
          error={null}
          name={database.name}
          open={redeployOpen}
          pending={false}
          onConfirm={() => redeploy.mutate()}
          onOpenChange={setRedeployOpen}
        >
          Pulls {engineProductLabel(database)} again and replaces the
          container over the same data. The database is unavailable until
          the new container is ready, and whatever is connected to it has
          to reconnect. If the new container doesn't get ready, the old one
          is started again, but anything a newer release already changed in
          the data stays changed. Back up first what you can't lose.
        </RedeployDialog>
      ) : null}
    </>
  )
}
