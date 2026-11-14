import * as React from "react"

import { useInstanceIdentity } from "@/components/instance-workspace-context"

const TerminalSession = React.lazy(async () => {
  const module = await import("@/components/terminal-session")
  return { default: module.TerminalSession }
})

// A shell in a game server's container, beside its console, which is the
// game's own process.
export function ServerTerminalPage() {
  const instance = useInstanceIdentity()
  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <TerminalSession
        key={`${instance.relayId}:${instance.id}`}
        noun="server"
        relayId={instance.relayId}
        target={{ kind: "instance", id: instance.id }}
      />
    </React.Suspense>
  )
}
