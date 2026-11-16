import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { CircleAlert, LoaderCircle, Network, Trash2 } from "lucide-react"
import { MAXIMUM_INSTANCE_NAME_LENGTH } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"

import { TailscaleLogo } from "@/components/brand-logos"
import {
  InfoDangerAction,
  InfoDangerZone,
  InfoPage,
  InfoRailGroup,
  InfoRailLink,
  InfoRailRow,
  InfoSection,
} from "@/components/info-page"
import { TunnelKindIcon } from "@/components/instance-kind-icon"
import {
  InstanceProfile,
  InstanceProfileBrick,
} from "@/components/instance-profile"
import { RenameButton } from "@/components/rename-dialog"
import { TunnelGatewaysSection } from "@/components/tunnel/tunnel-gateways-section"
import {
  tunnelSaveInput,
  useSetTunnels,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import { TunnelTldsSection } from "@/components/tunnel/tunnel-settings"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"
import { removeTunnel, saveTunnel } from "@/server/tunnels"

// What a tunnel is, on the Info page every instance has: its profile, its
// gateways, its TLDs with its Tailscale login behind Configure, and deleting
// it, with a rail summing up what it connects.
export function TunnelInfoPage() {
  const { tunnel } = useTunnelWorkspace()
  const canManage = tunnel.access.manage && !tunnel.cleanup
  return (
    <InfoPage rail={<TunnelInfoRail tunnel={tunnel} />}>
      {tunnel.cleanup ? <TunnelCleanupState tunnel={tunnel} /> : null}
      <InstanceProfile
        brick={
          <InstanceProfileBrick icon={<TailscaleLogo />}>
            {tunnel.brickSource ?? "Tailscale"}
          </InstanceProfileBrick>
        }
        favorite={null}
        icon={
          <span className="relative grid size-16 shrink-0 place-items-center rounded-xl border border-border/70 bg-background/60 text-muted-foreground [&_svg]:size-7">
            <TunnelKindIcon />
          </span>
        }
        id={tunnel.id}
        idLabel="tunnel ID"
        name={tunnel.name}
        rename={canManage ? <TunnelRenameButton tunnel={tunnel} /> : null}
      />
      <TunnelGatewaysSection tunnel={tunnel} />
      <TunnelTldsSection canManage={canManage} tunnel={tunnel} />
      {canManage ? (
        <InfoDangerZone>
          <InfoDangerAction
            dialog={(onOpenChange) => (
              <DeleteTunnelDialog tunnel={tunnel} onOpenChange={onOpenChange} />
            )}
          >
            Delete tunnel
          </InfoDangerAction>
        </InfoDangerZone>
      ) : null}
    </InfoPage>
  )
}

// What it connects and where, at a glance.
const TunnelInfoRail = React.memo(function TunnelInfoRail({
  tunnel,
}: {
  tunnel: TunnelOverview
}) {
  const connected = tunnel.bindings.length
  const gateways = tunnel.gateways.length
  return (
    <InfoRailGroup card>
      <InfoRailLink
        to="/tunnel/$tunnelId/connected"
        params={{ tunnelId: tunnel.id }}
        leading={<Network />}
        detail={connected}
      >
        Connected
      </InfoRailLink>
      <InfoRailRow leading={<TunnelKindIcon />} detail={gateways}>
        {gateways === 1 ? "Gateway" : "Gateways"}
      </InfoRailRow>
    </InfoRailGroup>
  )
})

// Hearth keeps the name, so renaming doesn't wait on its gateways.
function TunnelRenameButton({ tunnel }: { tunnel: TunnelOverview }) {
  const setTunnels = useSetTunnels()
  const rename = React.useCallback(
    async (name: string) =>
      setTunnels(await saveTunnel({ data: tunnelSaveInput(tunnel, { name }) })),
    [setTunnels, tunnel]
  )
  return (
    <RenameButton
      compact
      id={tunnel.id}
      maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
      name={tunnel.name}
      noun="tunnel"
      rename={rename}
    />
  )
}

function DeleteTunnelDialog({
  onOpenChange,
  tunnel,
}: {
  onOpenChange: (open: boolean) => void
  tunnel: TunnelOverview
}) {
  const setTunnels = useSetTunnels()
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => removeTunnel({ data: { id: tunnel.id } }),
    onSuccess: (next) => {
      setTunnels(next)
      showToast({
        message: `Deleting ${tunnel.name} in the background`,
        type: "success",
      })
      onOpenChange(false)
      void navigate({ replace: true, to: "/infra/tunnels" })
    },
  })
  const count = tunnel.gateways.length
  return (
    <Dialog
      open
      onOpenChange={(open) => !remove.isPending && onOpenChange(open)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {tunnel.name}?</DialogTitle>
          <DialogDescription>
            {count === 0
              ? "Its Tailscale login and split DNS are forgotten."
              : `Its ${count === 1 ? "gateway is" : `${count} gateways are`} removed, everything it connects is disconnected, and its Tailscale login and split DNS are forgotten. A Relay that's away finishes when it's back.`}
          </DialogDescription>
        </DialogHeader>
        {remove.error ? (
          <p className="text-xs text-destructive" role="alert">
            {remove.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete tunnel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const retryFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

/** A tunnel being deleted: how far it got, and when it tries again. */
function TunnelCleanupState({
  tunnel,
}: {
  tunnel: Pick<TunnelOverview, "cleanup" | "name">
}) {
  const cleanup = tunnel.cleanup
  if (!cleanup) return null
  const nextAttemptAt = cleanup.nextAttemptAt
    ? retryFormatter.format(new Date(cleanup.nextAttemptAt))
    : null
  return (
    <InfoSection
      icon={<LoaderCircle className="animate-spin text-primary-ink" />}
      title={`Deleting ${tunnel.name}`}
      content
    >
      <p className="type-support text-muted-foreground">
        {cleanup.pendingRelays}{" "}
        {cleanup.pendingRelays === 1 ? "Relay" : "Relays"} to go. It carries on
        by itself.
      </p>
      {cleanup.lastError ? (
        <div
          className="mt-3 flex items-start gap-2.5 border border-destructive/30 bg-destructive/5 px-3 py-2.5 light:bg-destructive/10"
          role="status"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-xs break-words text-destructive">
              {cleanup.lastError}
            </p>
            <p className="type-meta mt-1 text-muted-foreground">
              {nextAttemptAt
                ? `Tries again ${nextAttemptAt}`
                : "Tries again shortly"}
              {cleanup.attempts > 0
                ? ` · ${cleanup.attempts} ${cleanup.attempts === 1 ? "attempt" : "attempts"}`
                : ""}
            </p>
          </div>
        </div>
      ) : null}
    </InfoSection>
  )
}
