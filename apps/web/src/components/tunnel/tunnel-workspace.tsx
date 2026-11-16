import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { RefreshCw } from "lucide-react"

import { showToast } from "@workspace/ui/components/sonner"

import { TunnelKindIcon } from "@/components/instance-kind-icon"
import { RedeployDialog } from "@/components/redeploy-dialog"
import {
  ResourceWorkspaceBoundary,
  WorkspaceRouteTitle,
  useResourceWorkspaceQuery,
  useWorkspaceRouteParam,
  type ResourceWorkspaceQuery,
} from "@/components/resource-workspace"
import {
  selectTunnel,
  tunnelPermissionsOf,
  type TunnelOverview,
  type TunnelsResult,
} from "@/components/tunnel/tunnel-data"
import {
  TunnelWorkspaceContext,
  type TunnelWorkspaceValue,
} from "@/components/tunnel/tunnel-workspace-context"
import { WorkspaceFrame } from "@/components/workspace-frame"
import {
  WorkspaceHeader,
  WorkspaceIdCopyButton,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import { recoverPromise } from "@/effect/promise"
import type { ServerAction } from "@/lib/instance-power-state"
import { tunnelDestinations } from "@/lib/navigation-destinations"
import { queryKeys, tunnelsQueryOptions } from "@/lib/query-options"
import { heldPowerActions } from "@/lib/use-instance-power"
import {
  performTunnelAction,
  redeployTunnel,
  type GatewayOutcome,
} from "@/server/tunnel-instances"

// A tunnel's pages: Info, Gateways, Connected, Logs and Terminal, in the
// frame every instance's pages share. Its power and deploying it again act
// on every gateway it has.

export const TunnelWorkspaceShell = React.memo(function TunnelWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  const tunnelId = useWorkspaceRouteParam("tunnelId")
  const workspace = useTunnelWorkspaceQuery(tunnelId)
  return (
    <WorkspaceFrame header={<TunnelWorkspaceHeader workspace={workspace} />}>
      <ResourceWorkspaceBoundary
        context={TunnelWorkspaceContext}
        icon={<TunnelKindIcon />}
        list={{ label: "All tunnels", to: "/infra/tunnels" }}
        noun={{ one: "tunnel", other: "tunnels" }}
        workspace={workspace}
      >
        {children}
      </ResourceWorkspaceBoundary>
    </WorkspaceFrame>
  )
})

function useTunnelWorkspaceQuery(
  tunnelId: string | undefined
): ResourceWorkspaceQuery<TunnelWorkspaceValue> {
  const select = React.useCallback(
    (result: TunnelsResult): TunnelWorkspaceValue | null => {
      const tunnel = selectTunnel(result, tunnelId)
      return tunnel
        ? { permissions: tunnelPermissionsOf(tunnel), tunnel }
        : null
    },
    [tunnelId]
  )
  const query = useQuery({ ...tunnelsQueryOptions(), select })
  return useResourceWorkspaceQuery({
    data: query.data,
    isError: query.isError,
    isPending: query.isPending,
  })
}

const TunnelWorkspaceHeader = React.memo(function TunnelWorkspaceHeader({
  workspace,
}: {
  workspace: ResourceWorkspaceQuery<TunnelWorkspaceValue>
}) {
  const [error, setError] = React.useState<string | null>(null)
  if (workspace.status !== "found") return <WorkspaceHeader identity={null} />
  const { tunnel } = workspace.value
  return (
    <WorkspaceHeader
      identity={
        <WorkspaceIdentity
          error={error}
          name={tunnel.name}
          statusConfirmed
          title={
            <WorkspaceRouteTitle
              destinations={tunnelDestinations}
              fallback="Info"
              notFoundRouteId="/_app/tunnel/$tunnelId/$"
            />
          }
        >
          <span className="hidden shrink-0 items-center gap-1.5 @[30rem]:inline-flex">
            <span>Tunnel · Tailscale</span>
            <WorkspaceMetaSeparator />
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
            <WorkspaceIdCopyButton id={tunnel.id} label="tunnel ID" />
            <WorkspaceMetaSeparator />
          </span>
          <span className="min-w-0 truncate font-mono">
            {tunnel.domains.map((domain) => `.${domain}`).join(" ")}
          </span>
        </WorkspaceIdentity>
      }
      actions={
        <TunnelPowerControls
          key={tunnel.id}
          tunnel={tunnel}
          onError={setError}
        />
      }
    />
  )
})

// Its gateways as one: running while any runs, stopped once all are.
function tunnelObservedState(tunnel: TunnelOverview) {
  const states = tunnel.gateways.map(({ observedState }) => observedState)
  if (states.length === 0) return "stopped" as const
  if (states.includes("running")) return "running" as const
  if (states.every((state) => state === "stopped")) return "stopped" as const
  return states[0]!
}

/** What a change to every gateway left undone, by Relay. */
function failedOutcomes(
  tunnel: TunnelOverview,
  outcomes: ReadonlyArray<GatewayOutcome>
): string | null {
  const failed = outcomes.filter(({ error }) => error !== null)
  if (failed.length === 0) return null
  return failed
    .map(({ error, relayId }) => {
      const relay =
        tunnel.gateways.find((gateway) => gateway.relayId === relayId)
          ?.relayName ?? relayId
      return `${relay}: ${error}`
    })
    .join("; ")
}

function TunnelPowerControls({
  onError,
  tunnel,
}: {
  onError: (error: string | null) => void
  tunnel: TunnelOverview
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const permissions = React.useMemo(() => tunnelPermissionsOf(tunnel), [tunnel])
  // A tunnel being deleted takes its gateways with it, and one without any
  // has nothing to power.
  const available = !tunnel.cleanup && tunnel.gateways.length > 0
  const powerPermissions = React.useMemo(
    () => heldPowerActions(permissions, available),
    [available, permissions]
  )
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.tunnels })
  const reportOutcomes = (
    outcomes: ReadonlyArray<GatewayOutcome>,
    failure: string,
    success?: string
  ) => {
    const failed = failedOutcomes(tunnel, outcomes)
    if (failed) {
      onError(failed)
      showToast({ description: failed, message: failure, type: "error" })
    } else if (success) {
      showToast({ message: success, type: "success" })
    }
  }
  const power = useMutation({
    mutationFn: (action: ServerAction) =>
      performTunnelAction({ data: { action, tunnelId: tunnel.id } }),
    onMutate: () => onError(null),
    onSettled: refresh,
    onSuccess: (outcomes) =>
      reportOutcomes(outcomes, "Some gateways' power didn't change"),
    onError: (cause) => {
      onError(cause.message)
      showToast({
        description: cause.message,
        message: "The tunnel's power didn't change",
        type: "error",
      })
    },
  })
  const canDeploy = available && permissions.includes("instance.deploy")
  const [redeployOpen, setRedeployOpen] = React.useState(false)
  const redeploy = useMutation({
    mutationFn: () => redeployTunnel({ data: { tunnelId: tunnel.id } }),
    onMutate: () => {
      setRedeployOpen(false)
      // Follow the deployments as they happen, as every kind's are.
      if (permissions.includes("instance.logs.read")) {
        void navigate({
          params: { tunnelId: tunnel.id },
          search: { stream: "deployment" },
          to: "/tunnel/$tunnelId/logs",
        })
      }
    },
    onSettled: refresh,
    onSuccess: (outcomes) =>
      reportOutcomes(
        outcomes,
        "Some gateways weren't redeployed",
        `${tunnel.name} redeployed`
      ),
    onError: (cause) =>
      showToast({
        description: cause.message,
        message: "Redeploy failed",
        type: "error",
      }),
  })
  const onAction = React.useCallback(
    async (action: ServerAction) => {
      // Failures surface through the mutation's onError.
      await recoverPromise(
        () => power.mutateAsync(action),
        () => undefined
      )
    },
    [power]
  )
  const count = tunnel.gateways.length
  return (
    <>
      <WorkspacePowerControls
        action={power.isPending ? power.variables : null}
        killWarning="This immediately stops Tailscale and CoreDNS on every gateway. Names on the tunnel stop answering until it's started again."
        menuAction={
          canDeploy
            ? {
                description:
                  "Pull Tailscale and CoreDNS again and recreate every gateway",
                disabled: redeploy.isPending,
                icon: <RefreshCw className="size-3.5" />,
                label: "Redeploy",
                onClick: () => setRedeployOpen(true),
              }
            : undefined
        }
        noun="tunnel"
        powerPermissions={powerPermissions}
        relayConnected
        target={{
          name: tunnel.name,
          observedState: tunnelObservedState(tunnel),
        }}
        onAction={onAction}
      />
      {canDeploy ? (
        <RedeployDialog
          error={null}
          name={tunnel.name}
          open={redeployOpen}
          pending={false}
          onConfirm={() => redeploy.mutate()}
          onOpenChange={setRedeployOpen}
        >
          Pulls Tailscale and CoreDNS again and recreates{" "}
          {count === 1 ? "its gateway" : `its ${count} gateways, one by one`}.
          Each keeps its Tailscale identity, its subnet and every address, and
          names stop answering through it for a moment.
        </RedeployDialog>
      ) : null}
    </>
  )
}
