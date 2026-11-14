import * as React from "react"

import { RelayHostTerminalAccess } from "@/components/relay/relay-host-access"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import {
  relayTerminalInputKey,
  takeTerminalInput,
} from "@/lib/terminal-prefill"

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

const hostTarget = { kind: "relay" } as const
const hostStartFailure = {
  title: "Host shell couldn't start",
  detail: "The Relay couldn't start a shell on its node.",
}

function RelayTerminalSession({ relayId }: { relayId: string }) {
  const takeInitialInput = React.useCallback(
    () => takeTerminalInput(relayTerminalInputKey(relayId)),
    [relayId]
  )
  return (
    <TerminalSession
      noun="host shell"
      relayId={relayId}
      startFailure={hostStartFailure}
      takeInitialInput={takeInitialInput}
      target={hostTarget}
    />
  )
}
