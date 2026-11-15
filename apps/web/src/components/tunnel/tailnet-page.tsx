import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeft,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  Network,
  Plus,
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
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"

import { InfoCard, InfoCardHeader } from "@/components/info-card"
import { InstanceCard } from "@/components/instance-card"
import { TunnelKindIcon } from "@/components/instance-kind-icon"
import {
  tunnelStatus,
  useSetTailnets,
  useTailnet,
  useTailnetSave,
  useTailscaleTunnelBrick,
  type TailnetOverview,
} from "@/components/tunnel/tailnet-data"
import {
  TailnetLoginCard,
  TailnetSettingsCard,
} from "@/components/tunnel/tailnet-settings"
import {
  TunnelConnectPicker,
  TunnelConnectedList,
} from "@/components/tunnel/tunnel-connected-list"
import { notALoginField } from "@/lib/not-a-login-field"
import { relaysQueryOptions } from "@/lib/query-options"
import { removeTailnet } from "@/server/tunnels"

// A tailnet: the tunnels of one Tailscale account, everything they connect
// with its names, its TLDs, its Tailscale login, and deleting it.

export function TailnetPage({ tailnetId }: { tailnetId: string }) {
  const { data: tailnet, isPending, error } = useTailnet(tailnetId)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-2 pb-6 sm:px-5">
      <Button asChild size="sm" variant="ghost" className="-ml-2">
        <Link to="/infra/tunnels">
          <ArrowLeft />
          Tunnels
        </Link>
      </Button>
      {tailnet ? (
        <TailnetContent tailnet={tailnet} />
      ) : isPending ? (
        <div className="grid place-items-center py-24">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="py-24 text-center">
          <Network className="mx-auto size-6 text-muted-foreground/60" />
          <p className="mt-3 text-sm font-semibold">
            {error ? error.message : "This tailnet is gone"}
          </p>
        </div>
      )}
    </div>
  )
}

const TailnetContent = React.memo(function TailnetContent({
  tailnet,
}: {
  tailnet: TailnetOverview
}) {
  const [deleting, setDeleting] = React.useState(false)
  const canManage = tailnet.access.manage
  return (
    <>
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border bg-background">
          <TunnelKindIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-heading text-xl font-semibold tracking-tight">
            {tailnet.name}
          </h1>
          <p className="type-meta mt-0.5 flex flex-wrap items-center gap-1 text-muted-foreground">
            Tailnet · Tailscale
            {tailnet.domains.map((domain) => (
              <Badge key={domain} variant="outline" className="font-mono">
                .{domain}
              </Badge>
            ))}
          </p>
        </div>
        {canManage && !tailnet.cleanup ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
            onClick={() => setDeleting(true)}
          >
            <Trash2 />
            Delete tailnet
          </Button>
        ) : null}
      </header>

      {tailnet.cleanup ? (
        <TailnetCleanupState tailnet={tailnet} />
      ) : (
        <>
          <InfoCard>
            <InfoCardHeader
              icon={<TunnelKindIcon />}
              title="Tunnels"
              action={canManage ? <AddTunnelButton tailnet={tailnet} /> : null}
            />
            <TailnetTunnels tailnet={tailnet} />
          </InfoCard>
          <InfoCard>
            <InfoCardHeader
              icon={<Network />}
              title="Connected"
              action={
                canManage ? <TunnelConnectPicker tailnet={tailnet} /> : null
              }
            />
            <TunnelConnectedList canWrite={canManage} tailnet={tailnet} />
          </InfoCard>
          {canManage ? (
            <>
              <InfoCard>
                <InfoCardHeader icon={<Settings2 />} title="Name and TLDs" />
                <TailnetSettingsCard
                  key={`${tailnet.name}:${tailnet.domains.join(" ")}`}
                  canWrite
                  tailnet={tailnet}
                />
              </InfoCard>
              <InfoCard>
                <InfoCardHeader icon={<KeyRound />} title="Tailscale login" />
                <TailnetLoginCard
                  key={`${tailnet.integration?.clientId}:${tailnet.integration?.tags.join(" ")}`}
                  tailnet={tailnet}
                />
              </InfoCard>
            </>
          ) : null}
        </>
      )}
      {deleting ? (
        <DeleteTailnetDialog
          tailnet={tailnet}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </>
  )
})

const TailnetTunnels = React.memo(function TailnetTunnels({
  tailnet,
}: {
  tailnet: TailnetOverview
}) {
  if (tailnet.deployments.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">
        No tunnels yet. Add one on a Relay to connect what runs there.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-border/65">
      {tailnet.deployments.map((tunnel) => {
        const connected = tailnet.bindings.filter(
          (binding) => binding.relayId === tunnel.relayId
        ).length
        return (
          <li key={tunnel.id}>
            <Link
              to="/tunnel/$tunnelId/info"
              params={{ tunnelId: tunnel.id }}
              preload="intent"
              className="group/tunnel grid items-center gap-x-4 gap-y-1 px-4 py-3 outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset sm:grid-cols-[minmax(0,1fr)_10rem_8rem]"
            >
              <InstanceCard
                instance={{
                  id: tunnel.id,
                  kind: "tunnel",
                  relayId: tunnel.relayId,
                }}
                meta={`On ${tunnel.relayName}`}
                name={tunnel.name}
                nameClassName="transition-colors group-hover/tunnel:text-primary-ink"
                showFavorite={false}
                status={tunnelStatus(tunnel)}
              />
              <span className="type-meta truncate font-mono text-muted-foreground">
                {tunnel.status.ipv4Address ?? "No Tailscale IP yet"}
              </span>
              <span className="type-meta text-muted-foreground">
                {connected} connected
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
})

/** Adds a tunnel to a tailnet on a Relay it has none on. */
export function AddTunnelButton({ tailnet }: { tailnet: TailnetOverview }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Plus />
        Add tunnel
      </Button>
      {open ? (
        <AddTunnelDialog tailnet={tailnet} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

function AddTunnelDialog({
  tailnet,
  onClose,
}: {
  tailnet: TailnetOverview
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { data: relays = [] } = useQuery({
    ...relaysQueryOptions(),
    select: (all) => all.filter((relay) => relay.enabled),
  })
  const available = React.useMemo(
    () =>
      relays.filter(
        (relay) =>
          !tailnet.deployments.some(({ relayId }) => relayId === relay.id)
      ),
    [relays, tailnet.deployments]
  )
  const [chosen, setChosen] = React.useState<string | null>(null)
  const relayId = chosen ?? available[0]?.id ?? ""
  const [authKey, setAuthKey] = React.useState("")
  // Without a Tailscale login, one tunnel at a time logs in with a key.
  const needsKey = tailnet.integration === null
  const save = useTailnetSave()
  // The Brick a tunnel is made from: Kiln's Tailscale one.
  const brick = useTailscaleTunnelBrick()
  const relayName = available.find(({ id }) => id === relayId)?.name ?? ""
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!relayId) return
            save.mutate(
              {
                change: {
                  ...(needsKey ? { authKey: authKey.trim() } : {}),
                  brick,
                  relayIds: [
                    ...tailnet.deployments.map(
                      (deployment) => deployment.relayId
                    ),
                    relayId,
                  ],
                },
                doing: `Adding a tunnel on ${relayName}`,
                done: `${tailnet.name} has a tunnel on ${relayName}`,
                tailnet,
              },
              {
                onSuccess: (next) => {
                  onClose()
                  const tunnel = next.stacks
                    .find(({ id }) => id === tailnet.id)
                    ?.deployments.find(
                      (deployment) => deployment.relayId === relayId
                    )
                  if (tunnel) {
                    void navigate({
                      params: { tunnelId: tunnel.id },
                      to: "/tunnel/$tunnelId/info",
                    })
                  }
                },
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a tunnel to {tailnet.name}</DialogTitle>
            <DialogDescription>
              Tailscale and CoreDNS run on the Relay, and what runs there can
              connect to {tailnet.name} through it.
            </DialogDescription>
          </DialogHeader>
          {available.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {tailnet.name} has a tunnel on every Relay.
            </p>
          ) : (
            <label className="grid gap-2">
              <span className="text-xs font-medium">Relay</span>
              <Select value={relayId} onValueChange={setChosen}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {available.map((relay) => (
                    <SelectItem key={relay.id} value={relay.id}>
                      {relay.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {needsKey ? (
            <label className="grid gap-2">
              <span className="text-xs font-medium">Tailscale auth key</span>
              <Input
                {...notALoginField}
                type="password"
                value={authKey}
                placeholder="tskey-auth-…"
                className="font-mono"
                onChange={(event) => setAuthKey(event.target.value)}
              />
              <span className="type-meta text-muted-foreground">
                {tailnet.name} has no Tailscale login, so this tunnel logs in
                with a key.
              </span>
            </label>
          ) : null}
          {save.error ? (
            <p className="text-xs text-destructive" role="alert">
              {save.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !relayId ||
                !brick ||
                save.isPending ||
                (needsKey && !authKey.trim())
              }
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              Add tunnel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteTailnetDialog({
  tailnet,
  onClose,
}: {
  tailnet: TailnetOverview
  onClose: () => void
}) {
  const setTailnets = useSetTailnets()
  const remove = useMutation({
    mutationFn: () => removeTailnet({ data: { id: tailnet.id } }),
    onSuccess: (next) => {
      setTailnets(next)
      showToast({
        message: `Deleting ${tailnet.name} in the background`,
        type: "success",
      })
      onClose()
    },
  })
  const count = tailnet.deployments.length
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {tailnet.name}?</DialogTitle>
          <DialogDescription>
            {count === 0
              ? "Its Tailscale login and split DNS are forgotten."
              : `Its ${count === 1 ? "tunnel is" : `${count} tunnels are`} deleted with it, and everything they connect is disconnected. A Relay that's away finishes when it's back.`}
          </DialogDescription>
        </DialogHeader>
        {remove.error ? (
          <p className="text-xs text-destructive" role="alert">
            {remove.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
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
            Delete tailnet
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

/** A tailnet being deleted: how far it got, and when it tries again. */
export function TailnetCleanupState({
  tailnet,
}: {
  tailnet: Pick<TailnetOverview, "cleanup" | "name">
}) {
  const cleanup = tailnet.cleanup
  if (!cleanup) return null
  const nextAttemptAt = cleanup.nextAttemptAt
    ? retryFormatter.format(new Date(cleanup.nextAttemptAt))
    : null
  return (
    <InfoCard>
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <LoaderCircle className="size-6 animate-spin text-primary-ink" />
        <p className="mt-3 text-sm font-semibold">Deleting {tailnet.name}</p>
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
