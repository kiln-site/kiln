import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight, CircleAlert, LoaderCircle, Plus } from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"

import {
  AddInstanceDialogHost,
  createAddInstanceDialogStore,
} from "@/components/add-instance-dialog"
import { InfoCard } from "@/components/info-card"
import { InstanceCard } from "@/components/instance-card"
import { TunnelKindIcon } from "@/components/instance-kind-icon"
import {
  tunnelStatus,
  useTailnets,
  type TailnetOverview,
} from "@/components/tunnel/tailnet-data"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

// Infrastructure → Tunnels: every tailnet the viewer sees, each with its
// tunnels. A tailnet opens its own page, a tunnel its workspace.

export function TunnelsPage() {
  const { data, error, isPending } = useTailnets()
  const { data: canAdd = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })
  const [addStore] = React.useState(() =>
    createAddInstanceDialogStore("tunnel")
  )

  return (
    <div className="mx-auto w-full max-w-[90rem] space-y-3 px-2 pb-5 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <p className="type-support text-muted-foreground">
          Reach game servers, Apps and databases by name from anywhere on a
          tailnet.
        </p>
        {canAdd ? (
          <Button type="button" size="sm" onClick={addStore.open}>
            <Plus />
            Add tunnel
          </Button>
        ) : null}
      </div>
      {data.unavailableRelays.length > 0 ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 light:bg-amber-500/20"
          role="status"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Not shown while away:{" "}
            {data.unavailableRelays.map(({ name }) => name).join(", ")}. A
            tailnet can't change until they're back.
          </span>
        </p>
      ) : null}
      {data.stacks.length > 0 ? (
        data.stacks.map((tailnet) => (
          <TailnetCard key={tailnet.id} tailnet={tailnet} />
        ))
      ) : isPending ? (
        <div className="grid place-items-center py-24">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <InfoCard>
          <div className="px-6 py-14 text-center">
            <TunnelKindIcon className="mx-auto size-6" />
            <p className="mt-3 text-sm font-semibold">
              {error ? error.message : "No tunnels yet"}
            </p>
            {error ? null : (
              <p className="type-support mx-auto mt-1 max-w-sm text-muted-foreground">
                A tunnel joins a Relay to your Tailscale tailnet, so what runs
                there answers to names like survival.kiln.
              </p>
            )}
            {canAdd && !error ? (
              <Button
                type="button"
                size="sm"
                className="mt-4"
                onClick={addStore.open}
              >
                <Plus />
                Add tunnel
              </Button>
            ) : null}
          </div>
        </InfoCard>
      )}
      {canAdd ? <AddInstanceDialogHost store={addStore} /> : null}
    </div>
  )
}

const TailnetCard = React.memo(function TailnetCard({
  tailnet,
}: {
  tailnet: TailnetOverview
}) {
  const connected = tailnet.bindings.length
  return (
    <InfoCard>
      <Link
        to="/tailnet/$tailnetId"
        params={{ tailnetId: tailnet.id }}
        preload="intent"
        className="group/tailnet flex min-h-14 items-center gap-3 border-b px-4 py-2.5 outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold transition-colors group-hover/tailnet:text-primary-ink">
              {tailnet.name}
            </span>
            {tailnet.domains.map((domain) => (
              <Badge
                key={domain}
                variant="outline"
                className="type-meta hidden font-mono sm:inline-flex"
              >
                .{domain}
              </Badge>
            ))}
          </p>
          <p className="type-meta mt-0.5 text-muted-foreground">
            {tailnet.cleanup
              ? "Being deleted"
              : `Tailnet · ${tailnet.deployments.length} ${tailnet.deployments.length === 1 ? "tunnel" : "tunnels"} · ${connected} connected`}
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
      {tailnet.deployments.length > 0 ? (
        <ul className="divide-y divide-border/65">
          {tailnet.deployments.map((tunnel) => (
            <li key={tunnel.id}>
              <Link
                to="/tunnel/$tunnelId/info"
                params={{ tunnelId: tunnel.id }}
                preload="intent"
                className="group/tunnel grid items-center gap-x-4 px-4 py-2.5 outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset sm:grid-cols-[minmax(0,1fr)_10rem_7rem]"
              >
                <InstanceCard
                  instance={{
                    id: tunnel.id,
                    kind: "tunnel",
                    relayId: tunnel.relayId,
                  }}
                  meta={`Tunnel · Tailscale on ${tunnel.relayName}`}
                  name={tunnel.name}
                  nameClassName="transition-colors group-hover/tunnel:text-primary-ink"
                  showFavorite={false}
                  status={tunnelStatus(tunnel)}
                />
                <span className="type-meta hidden truncate font-mono text-muted-foreground sm:block">
                  {tunnel.status.ipv4Address ?? "No Tailscale IP yet"}
                </span>
                <span className="type-meta hidden text-muted-foreground sm:block">
                  {
                    tailnet.bindings.filter(
                      (binding) => binding.relayId === tunnel.relayId
                    ).length
                  }{" "}
                  connected
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : tailnet.cleanup ? null : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          No tunnels. Open it to add one.
        </p>
      )}
    </InfoCard>
  )
})
