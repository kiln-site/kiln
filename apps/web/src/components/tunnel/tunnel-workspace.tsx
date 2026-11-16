import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { RefreshCw } from "lucide-react"

import { showToast } from "@workspace/ui/components/sonner"

import { TunnelKindIcon } from "@/components/instance-kind-icon"
import { recoverPromise } from "@/effect/promise"
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
  type TailnetsResult,
  type TunnelView,
} from "@/components/tunnel/tailnet-data"
import { TunnelWorkspaceContext } from "@/components/tunnel/tunnel-workspace-context"
import { WorkspaceFrame } from "@/components/workspace-frame"
import {
  WorkspaceCopyValueButton,
  WorkspaceHeader,
  WorkspaceIdCopyButton,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"
import { tunnelDestinations } from "@/lib/navigation-destinations"
import { queryKeys, tailnetsQueryOptions } from "@/lib/query-options"
import type { ServerAction } from "@/lib/instance-power-state"
import { heldPowerActions } from "@/lib/use-instance-power"
import { performTunnelAction, redeployTunnel } from "@/server/tunnel-instances"

// A tunnel's pages: Info, Connected, Logs and Terminal, in the frame every
// instance's pages share, with its power and deploying it again.

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
): ResourceWorkspaceQuery<TunnelView> {
  const select = React.useCallback(
    (result: TailnetsResult) => selectTunnel(result, tunnelId),
    [tunnelId]
  )
  const query = useQuery({ ...tailnetsQueryOptions(), select })
  return useResourceWorkspaceQuery({
    data: query.data,
    isError: query.isError,
    isPending: query.isPending,
  })
}

const TunnelWorkspaceHeader = React.memo(function TunnelWorkspaceHeader({
  workspace,
}: {
  workspace: ResourceWorkspaceQuery<TunnelView>
}) {
  const [error, setError] = React.useState<string | null>(null)
  if (workspace.status !== "found") return <WorkspaceHeader identity={null} />
  const { tailnet, tunnel } = workspace.value
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
          {/* Its TLDs, login and names are its tailnet's, set there. */}
          <span className="inline-flex min-w-0 shrink items-center gap-1.5">
            <Link
              className="truncate transition-colors hover:text-foreground"
              params={{ tailnetId: tailnet.id }}
              title={`${tailnet.name}'s TLDs, login and names`}
              to="/tailnet/$tailnetId"
            >
              {tailnet.name}
            </Link>
            <WorkspaceMetaSeparator />
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
            <WorkspaceIdCopyButton id={tunnel.id} label="tunnel ID" />
            <WorkspaceMetaSeparator />
          </span>
          {tunnel.status.ipv4Address ? (
            <WorkspaceCopyValueButton
              label="Tailscale IP"
              value={tunnel.status.ipv4Address}
            />
          ) : (
            <span>No Tailscale IP yet</span>
          )}
        </WorkspaceIdentity>
      }
      actions={
        <TunnelPowerControls
          key={tunnel.id}
          view={workspace.value}
          onError={setError}
        />
      }
    />
  )
})

function TunnelPowerControls({
  onError,
  view,
}: {
  onError: (error: string | null) => void
  view: TunnelView
}) {
  const { permissions, tailnet, tunnel } = view
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // A tailnet being deleted takes its tunnels with it.
  const available = !tailnet.cleanup
  const powerPermissions = React.useMemo(
    () => heldPowerActions(permissions, available),
    [available, permissions]
  )
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.tailnets })
  const power = useMutation({
    mutationFn: (action: ServerAction) =>
      performTunnelAction({ data: { action, tunnelId: tunnel.id } }),
    onMutate: () => onError(null),
    onSettled: refresh,
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
      // Follow the deployment as it happens, as every kind's is.
      if (permissions.includes("instance.logs.read")) {
        void navigate({
          params: { tunnelId: tunnel.id },
          search: { stream: "deployment" },
          to: "/tunnel/$tunnelId/logs",
        })
      }
    },
    onSettled: refresh,
    onSuccess: () =>
      showToast({ message: `${tunnel.name} redeployed`, type: "success" }),
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
  return (
    <>
      <WorkspacePowerControls
        action={power.isPending ? power.variables : null}
        killWarning="This immediately stops Tailscale and CoreDNS. Names on the tailnet stop answering until it's started again."
        menuAction={
          canDeploy
            ? {
                description:
                  "Pull Tailscale and CoreDNS again and recreate both",
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
        target={{ name: tunnel.name, observedState: tunnel.observedState }}
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
          Pulls Tailscale and CoreDNS again and recreates both containers. It
          keeps its Tailscale identity, its subnet and every address, and names
          on {tailnet.name} stop answering through it for a moment.
        </RedeployDialog>
      ) : null}
    </>
  )
}
