import * as React from "react"
import { Play } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import { gatewayPermissionsOf } from "@/components/tunnel/tunnel-data"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"

const TerminalSession = React.lazy(async () => {
  const module = await import("@/components/terminal-session")
  return { default: module.TerminalSession }
})

// A shell in one gateway's Tailscale container, where `tailscale status`
// and the rest of its CLI run. CoreDNS's image has no shell to open.
export function TunnelTerminalPage() {
  const { tunnel } = useTunnelWorkspace()
  const gateways = React.useMemo(
    () =>
      tunnel.gateways.filter((gateway) =>
        gatewayPermissionsOf(tunnel, gateway.id).includes("instance.terminal")
      ),
    [tunnel]
  )
  const [chosen, setChosen] = React.useState<string | null>(null)
  const gateway =
    gateways.find((candidate) => candidate.id === chosen) ?? gateways[0]

  if (!gateway) {
    return (
      <TerminalNote
        title="No gateway to open"
        detail={`Connect something to ${tunnel.name} and its gateway's terminal opens here.`}
      />
    )
  }
  const picker =
    gateways.length > 1 ? (
      <Select value={gateway.id} onValueChange={setChosen}>
        <SelectTrigger
          aria-label="Gateway"
          className="h-7 w-auto max-w-48 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {gateways.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.relayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null
  if (!gateway.components.tailscaleRunning) {
    return (
      <TerminalNote
        title={`Tailscale on ${gateway.relayName} is not running`}
        detail="Start the gateway to open its terminal."
        picker={picker}
      />
    )
  }
  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <TerminalSession
        key={`${gateway.relayId}:${gateway.id}`}
        noun="gateway"
        relayId={gateway.relayId}
        target={{ id: gateway.id, kind: "tunnel" }}
        toolbarActions={picker}
      />
    </React.Suspense>
  )
}

function TerminalNote({
  detail,
  picker,
  title,
}: {
  detail: string
  picker?: React.ReactNode
  title: string
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
          <Play className="size-5" />
        </div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
        {picker ? (
          <div className="mt-4 flex justify-center">{picker}</div>
        ) : null}
      </div>
    </div>
  )
}
