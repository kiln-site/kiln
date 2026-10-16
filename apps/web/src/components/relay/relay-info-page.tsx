import { useNavigate } from "@tanstack/react-router"

import {
  InfoDangerAction,
  InfoDangerZone,
  InfoPage,
} from "@/components/info-page"
import { RemoveRelayDialog } from "@/components/relay/relay-actions"
import { RelayInfoRail } from "@/components/relay/relay-info-rail"
import { RelayProxySettings } from "@/components/relay/relay-proxy-settings"
import {
  RelayGeneralSettings,
  useRelayPermission,
} from "@/components/relay/relay-settings"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// The Relay's settings, edited in place, with a rail summing up what it is,
// what runs on it, and the machine under it.
export function RelayInfoPage() {
  const { relay, routeId } = useRelayWorkspace()

  return (
    <InfoPage rail={<RelayInfoRail relay={relay} routeId={routeId} />}>
      <RelayGeneralSettings relay={relay} routeId={routeId} />
      <RelayProxySettings relay={relay} routeId={routeId} />
      <RelayDangerZone relay={relay} />
    </InfoPage>
  )
}

function RelayDangerZone({ relay }: { relay: RelayDirectoryEntry }) {
  const canDelete = useRelayPermission(relay.id, "relay.delete")
  const navigate = useNavigate()
  if (!canDelete) return null
  return (
    <InfoDangerZone>
      <InfoDangerAction
        dialog={(onOpenChange) => (
          <RemoveRelayDialog
            name={relay.name}
            relayId={relay.id}
            onOpenChange={onOpenChange}
            onRemoved={() => navigate({ to: "/infra/relays" })}
          />
        )}
      >
        Remove Relay
      </InfoDangerAction>
    </InfoDangerZone>
  )
}
