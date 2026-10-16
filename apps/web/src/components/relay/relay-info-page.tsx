import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { DangerZone } from "@/components/info-card"
import { InfoPage } from "@/components/info-page"
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
  const [open, setOpen] = React.useState(false)
  if (!canDelete) return null
  return (
    <>
      {/* At the bottom of the page, or after the sections when they're taller. */}
      <DangerZone
        className="mt-auto"
        title="Remove this Relay"
        action={
          <Button
            type="button"
            variant="destructive"
            className="shrink-0"
            onClick={() => setOpen(true)}
          >
            <Trash2 />
            Remove Relay
          </Button>
        }
      />
      {open ? (
        <RemoveRelayDialog
          name={relay.name}
          relayId={relay.id}
          onOpenChange={setOpen}
          onRemoved={() => navigate({ to: "/infra/relays" })}
        />
      ) : null}
    </>
  )
}
