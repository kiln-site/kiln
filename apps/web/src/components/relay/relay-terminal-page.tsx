import * as React from "react"

import { RelayHostTerminalAccess } from "@/components/relay/relay-host-access"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import type { TerminalBackend } from "@/components/terminal-session"
import { relayTerminalStreamUrl } from "@/lib/database-terminal-stream"
import {
  claimRelayTerminal,
  restartRelayTerminal,
  writeRelayTerminal,
} from "@/server/relay-host"

const TerminalSession = React.lazy(async () => {
  const module = await import("@/components/terminal-session")
  return { default: module.TerminalSession }
})

export function RelayTerminalPage() {
  const { relay } = useRelayWorkspace()
  return (
    <RelayHostTerminalAccess>
      <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
        <RelayTerminalSession key={relay.id} relayId={relay.id} />
      </React.Suspense>
    </RelayHostTerminalAccess>
  )
}

function RelayTerminalSession({ relayId }: { relayId: string }) {
  const backend = React.useMemo<TerminalBackend>(
    () => ({
      claim: (input) => claimRelayTerminal({ data: { relayId, ...input } }),
      noun: "host shell",
      restart: () => restartRelayTerminal({ data: { relayId } }),
      streamUrl: (size) => relayTerminalStreamUrl({ relayId, ...size }),
      write: (sessionId, data) =>
        writeRelayTerminal({ data: { relayId, sessionId, data } }),
    }),
    [relayId]
  )
  return <TerminalSession backend={backend} />
}
