import { Network } from "lucide-react"

import { InfoCard, InfoCardHeader } from "@/components/info-card"
import {
  TunnelConnectPicker,
  TunnelConnectedList,
} from "@/components/tunnel/tunnel-connected-list"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"

// What the tunnel connects, on every Relay, each at its address on the
// gateway there and by every name it has on the tunnel.
export function TunnelConnectedPage() {
  const { tunnel } = useTunnelWorkspace()
  const canWrite = tunnel.access.manage && !tunnel.cleanup
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background/55 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <InfoCard>
          <InfoCardHeader
            icon={<Network />}
            title="Connected"
            action={canWrite ? <TunnelConnectPicker tunnel={tunnel} /> : null}
          />
          <TunnelConnectedList canWrite={canWrite} tunnel={tunnel} />
        </InfoCard>
      </div>
    </main>
  )
}
