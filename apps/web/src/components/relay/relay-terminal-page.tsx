import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { TerminalSquare } from "lucide-react"

import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import type { TerminalBackend } from "@/components/terminal-session"
import { relayTerminalStreamUrl } from "@/lib/database-terminal-stream"
import {
  getRelayHostAccess,
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
  const access = useQuery({
    queryKey: ["relay-host-access", relay.id],
    queryFn: () => getRelayHostAccess({ data: { relayId: relay.id } }),
    retry: false,
  })
  if (access.isPending) return <div className="min-h-0 flex-1 bg-card" />
  if (access.error || !access.data?.terminal) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <TerminalSquare className="mx-auto mb-4 size-5 text-muted-foreground" />
          <p className="text-sm font-semibold">
            {access.error
              ? "Host terminal unavailable"
              : "Host access is disabled"}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {access.error
              ? access.error.message
              : "Enable host access in the Relay's configuration to open a shell on this node."}
          </p>
        </div>
      </div>
    )
  }
  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <RelayTerminalSession key={relay.id} relayId={relay.id} />
    </React.Suspense>
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
