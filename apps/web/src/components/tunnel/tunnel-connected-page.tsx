import { Network } from "lucide-react"

import { InfoCard, InfoCardHeader } from "@/components/info-card"
import {
  TunnelConnectPicker,
  TunnelConnectedList,
} from "@/components/tunnel/tunnel-connected-list"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"

// What the tunnel connects to its tailnet, each at its address on the
// tunnel and by every name it has there.
export function TunnelConnectedPage() {
  const { tailnet, tunnel } = useTunnelWorkspace()
  const canWrite = tailnet.access.manage && !tailnet.cleanup
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background/55 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <InfoCard>
          <InfoCardHeader
            icon={<Network />}
            title={`Connected to ${tailnet.name}`}
            action={
              canWrite ? (
                <TunnelConnectPicker
                  relayId={tunnel.relayId}
                  tailnet={tailnet}
                />
              ) : null
            }
          />
          <TunnelConnectedList
            canWrite={canWrite}
            relayId={tunnel.relayId}
            tailnet={tailnet}
          />
        </InfoCard>
      </div>
    </main>
  )
}
