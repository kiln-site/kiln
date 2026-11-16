import * as React from "react"
import { Play } from "lucide-react"

import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"

const TerminalSession = React.lazy(async () => {
  const module = await import("@/components/terminal-session")
  return { default: module.TerminalSession }
})

// A shell in the tunnel's Tailscale container, where `tailscale status`
// and the rest of its CLI run.
export function TunnelTerminalPage() {
  const { tunnel } = useTunnelWorkspace()
  if (!tunnel.components.tailscaleRunning) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
            <Play className="size-5" />
          </div>
          <p className="text-sm font-semibold">{tunnel.name} is not running</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Start the tunnel to open its terminal.
          </p>
        </div>
      </div>
    )
  }
  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <TerminalSession
        key={`${tunnel.relayId}:${tunnel.id}`}
        noun="tunnel"
        relayId={tunnel.relayId}
        target={{ id: tunnel.id, kind: "tunnel" }}
      />
    </React.Suspense>
  )
}
