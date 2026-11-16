import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  Boxes,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  Network,
  Settings2,
  Trash2,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
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

import {
  CopyMetaRow,
  DangerZone,
  InfoCard,
  InfoCardHeader,
  MetaRow,
} from "@/components/info-card"
import { TunnelKindIcon } from "@/components/instance-kind-icon"
import { StatusIndicator } from "@/components/status-indicator"
import {
  tunnelStatus,
  useSetTunnels,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import {
  TunnelLoginCard,
  TunnelSettingsCard,
} from "@/components/tunnel/tunnel-settings"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"
import { removeTunnel } from "@/server/tunnels"

// What a tunnel is and what it shares: its state, its gateways and what it
// connects at a glance, its name and TLDs, its Tailscale login, and deleting
// it. Whoever manages it changes them here.
export function TunnelInfoPage() {
  const { tunnel } = useTunnelWorkspace()
  const canManage = tunnel.access.manage && !tunnel.cleanup
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background/55 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        {tunnel.cleanup ? <TunnelCleanupState tunnel={tunnel} /> : null}
        <InfoCard>
          <InfoCardHeader
            icon={<TunnelKindIcon />}
            title="Tunnel · Tailscale"
            action={<StatusIndicator status={tunnelStatus(tunnel)} />}
          />
          <CopyMetaRow label="Tunnel ID" value={tunnel.id} />
          <MetaRow
            icon={Boxes}
            label="Brick"
            value={tunnel.brickSource ?? "Kiln's Tailscale"}
            mono={tunnel.brickSource !== null}
          />
          <MetaRow
            icon={Network}
            label="Gateways"
            value={
              tunnel.gateways.length === 0
                ? "None yet. Connecting something adds one on its Relay."
                : tunnel.gateways.map(({ relayName }) => relayName).join(", ")
            }
          />
          <MetaRow
            icon={Network}
            label="Connected"
            value={`${tunnel.bindings.length} ${
              tunnel.bindings.length === 1 ? "instance" : "instances"
            }`}
          />
          <MetaRow
            icon={Settings2}
            label="TLDs"
            value={
              <span className="flex flex-wrap gap-1">
                {tunnel.domains.map((domain, index) => (
                  <Badge key={domain} variant="outline" className="font-mono">
                    .{domain}
                    {index === 0 ? " · generated names" : ""}
                  </Badge>
                ))}
              </span>
            }
          />
        </InfoCard>
        {canManage ? (
          <>
            <InfoCard>
              <InfoCardHeader icon={<Settings2 />} title="Name and TLDs" />
              <TunnelSettingsCard
                key={`${tunnel.name}:${tunnel.domains.join(" ")}`}
                canWrite
                tunnel={tunnel}
              />
            </InfoCard>
            <InfoCard>
              <InfoCardHeader icon={<KeyRound />} title="Tailscale login" />
              <TunnelLoginCard
                key={`${tunnel.integration?.clientId}:${tunnel.integration?.tags.join(" ")}`}
                tunnel={tunnel}
              />
            </InfoCard>
            <DeleteTunnel tunnel={tunnel} />
          </>
        ) : null}
      </div>
    </main>
  )
}

function DeleteTunnel({ tunnel }: { tunnel: TunnelOverview }) {
  const [open, setOpen] = React.useState(false)
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
      setOpen(false)
      void navigate({ replace: true, to: "/infra/tunnels" })
    },
  })
  const count = tunnel.gateways.length
  return (
    <>
      <DangerZone
        title="Delete this tunnel"
        action={
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setOpen(true)}
          >
            <Trash2 />
            Delete tunnel
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
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
              onClick={() => setOpen(false)}
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
    </>
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
    <InfoCard>
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <LoaderCircle className="size-6 animate-spin text-primary-ink" />
        <p className="mt-3 text-sm font-semibold">Deleting {tunnel.name}</p>
        <p className="type-support mt-1 text-muted-foreground">
          {cleanup.pendingRelays}{" "}
          {cleanup.pendingRelays === 1 ? "Relay" : "Relays"} to go. It carries
          on by itself.
        </p>
        {cleanup.lastError ? (
          <div
            className="mt-4 flex max-w-lg items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-left light:bg-destructive/10"
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
      </div>
    </InfoCard>
  )
}
