import { ResourceLogsSession } from "@/components/console/resource-logs"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"

// The Relay container's own output, followed live.
export function RelayLogsPage() {
  const { relay } = useRelayWorkspace()
  const { connected } = useRelayLiveStatus(relay)
  return (
    <ResourceLogsSession
      key={relay.id}
      id={relay.id}
      kind="relay"
      relayAvailable={connected}
      relayId={relay.id}
    />
  )
}
