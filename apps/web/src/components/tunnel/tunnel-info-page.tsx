import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { Globe2, LoaderCircle, Network, Trash2 } from "lucide-react"

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

import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import { RelayKindIcon, TunnelKindIcon } from "@/components/instance-kind-icon"
import { StatusIndicator } from "@/components/status-indicator"
import {
  tunnelStatus,
  useTailnetSave,
  type TunnelView,
} from "@/components/tunnel/tailnet-data"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"

// What a tunnel is: its state and both containers, how its tailnet reaches
// it, where it runs, and deleting it.
export function TunnelInfoPage() {
  const view = useTunnelWorkspace()
  const { tailnet, tunnel } = view
  const connected = tailnet.bindings.filter(
    (binding) => binding.relayId === tunnel.relayId
  ).length
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background/55 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <InfoCard>
          <InfoCardHeader
            icon={<TunnelKindIcon />}
            title="Tunnel · Tailscale"
            action={<StatusIndicator status={tunnelStatus(tunnel)} />}
          />
          <dl className="grid gap-px bg-border/60 sm:grid-cols-2">
            <Fact label="Tailnet">
              <Link
                to="/tailnet/$tailnetId"
                params={{ tailnetId: tailnet.id }}
                className="font-medium hover:text-primary-ink"
              >
                {tailnet.name}
              </Link>
            </Fact>
            <Fact label="Relay">
              <Link
                to="/relay/$relayId"
                params={{ relayId: tunnel.relayId }}
                className="inline-flex items-center gap-1.5 font-medium hover:text-primary-ink"
              >
                <RelayKindIcon className="size-3.5" />
                {tunnel.relayName}
              </Link>
            </Fact>
            <Fact label="Tailscale">
              {tunnel.components.tailscaleRunning ? "Running" : "Stopped"}
            </Fact>
            <Fact label="CoreDNS">
              {tunnel.components.coreDnsRunning ? "Running" : "Stopped"}
            </Fact>
            <Fact label="Connected">{connected}</Fact>
            <Fact label="TLDs">
              <span className="flex flex-wrap gap-1">
                {tunnel.domains.map((domain) => (
                  <Badge key={domain} variant="outline" className="font-mono">
                    .{domain}
                  </Badge>
                ))}
              </span>
            </Fact>
          </dl>
          {tunnel.status.message ? (
            <p className="border-t px-4 py-3 text-xs text-muted-foreground">
              {tunnel.status.message}
            </p>
          ) : null}
        </InfoCard>

        <InfoCard>
          <InfoCardHeader icon={<Globe2 />} title="On the tailnet" />
          <CopyMetaRow
            copyable={tunnel.status.ipv4Address !== null}
            display={tunnel.status.ipv4Address ?? "Not yet"}
            label="Tailscale IPv4"
            value={tunnel.status.ipv4Address ?? ""}
          />
          {tunnel.status.ipv6Address ? (
            <CopyMetaRow
              label="Tailscale IPv6"
              value={tunnel.status.ipv6Address}
            />
          ) : null}
          <CopyMetaRow label="Machine name" value={tunnel.hostname} />
          <CopyMetaRow
            icon={Network}
            label="Subnet it routes"
            value={tunnel.subnet}
          />
        </InfoCard>

        {tailnet.access.manage && !tailnet.cleanup ? (
          <DeleteTunnel view={view} />
        ) : null}
      </div>
    </main>
  )
}

function Fact({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="min-w-0 bg-background/45 px-4 py-3">
      <dt className="type-technical-label text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 truncate text-sm">{children}</dd>
    </div>
  )
}

function DeleteTunnel({ view }: { view: TunnelView }) {
  const { tailnet, tunnel } = view
  const [open, setOpen] = React.useState(false)
  const save = useTailnetSave()
  const navigate = useNavigate()
  const connected = tailnet.bindings.filter(
    (binding) => binding.relayId === tunnel.relayId
  ).length
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">Delete this tunnel</p>
        <p className="type-meta mt-0.5 text-muted-foreground">
          Tailscale and CoreDNS leave {tunnel.relayName}. {tailnet.name} keeps
          its other tunnels.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 />
        Delete tunnel
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {tunnel.name}?</DialogTitle>
            <DialogDescription>
              {connected === 0
                ? `Tailscale and CoreDNS leave ${tunnel.relayName}, and the machine leaves ${tailnet.name}.`
                : `${connected} connected ${connected === 1 ? "instance is" : "instances are"} disconnected and ${connected === 1 ? "its" : "their"} names in ${tailnet.name} forgotten. Tailscale and CoreDNS leave ${tunnel.relayName}.`}
            </DialogDescription>
          </DialogHeader>
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
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    change: {
                      bindings: tailnet.bindings.filter(
                        (binding) => binding.relayId !== tunnel.relayId
                      ),
                      relayIds: tailnet.deployments
                        .map((deployment) => deployment.relayId)
                        .filter((relayId) => relayId !== tunnel.relayId),
                    },
                    doing: `Deleting its tunnel on ${tunnel.relayName}`,
                    done: `Its tunnel on ${tunnel.relayName} is deleted`,
                    tailnet,
                  },
                  {
                    onSuccess: () =>
                      void navigate({
                        params: { tailnetId: tailnet.id },
                        replace: true,
                        to: "/tailnet/$tailnetId",
                      }),
                  }
                )
              }
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete tunnel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
