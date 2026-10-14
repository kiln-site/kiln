import { useQuery } from "@tanstack/react-query"
import { RadioTower } from "lucide-react"
import type { ReactNode } from "react"

import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { getRelayHostAccess } from "@/server/relay-host"

export function RelayHostAccess({
  children,
  feature,
}: {
  children: ReactNode
  feature: "files" | "terminal"
}) {
  const { relay } = useRelayWorkspace()
  const { connected } = useRelayLiveStatus(relay)
  const access = useQuery({
    queryKey: ["relay-host-access", relay.id],
    queryFn: () => getRelayHostAccess({ data: { relayId: relay.id } }),
    enabled: connected,
    retry: false,
    staleTime: 30_000,
  })
  if (connected && access.isPending)
    return <div className="min-h-0 flex-1 bg-card" />
  if (connected && access.data?.[feature]) return children
  const label = feature === "files" ? "Host filesystem" : "Host terminal"
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
      <div className="max-w-sm">
        <RadioTower className="mx-auto mb-4 size-5 text-muted-foreground" />
        <p className="text-sm font-semibold">
          {connected ? `${label} unavailable` : "Waiting for the Relay"}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {!connected
            ? "This page will open when the Relay reconnects."
            : (access.error?.message ??
              (feature === "files"
                ? "Enable host access and mount the host filesystem on the Relay to browse it."
                : "Enable host access in the Relay's configuration to open a shell on this node."))}
        </p>
      </div>
    </div>
  )
}
