import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Settings2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  InfoCopyValue,
  InfoDetailRow,
  InfoDetails,
  InfoFact,
  InfoSection,
} from "@/components/info-page"
import { RelayVersion } from "@/components/relay/relay-version"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import type { AccessPermission } from "@/lib/permissions"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// Loaded when someone opens it, so the Relays page stays out of this route.
const EditRelayDialog = React.lazy(async () => {
  const module = await import("@/components/relays-page")
  return { default: module.EditRelayDialog }
})

// The Relay's details on its Info page; Configure changes them.

export function useRelayPermission(
  relayId: string,
  permission: AccessPermission
): boolean {
  const { data = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relayId, permission),
  })
  return data
}

export function RelayGeneralSettings({
  relay,
}: {
  relay: RelayDirectoryEntry
}) {
  return (
    <InfoSection title="Relay" action={<RelayConfigureButton relay={relay} />}>
      <InfoFact label="Name">
        <InfoCopyValue label="Relay name" mono={false} value={relay.name} />
      </InfoFact>
      <InfoFact label="ID">
        <InfoCopyValue label="Relay ID" value={relay.id} />
      </InfoFact>
      <InfoFact label="Version">
        <RelayVersion relay={relay} />
      </InfoFact>
      <InfoFact label="TLS">
        <InfoDetails title="TLS" trigger={tlsLabel(relay)}>
          <p>{tlsDescription(relay)}</p>
          <InfoDetailRow
            label="Browser origin"
            value={relay.browserOrigin || "Same as address"}
          />
          <p>Set when the Relay was paired.</p>
        </InfoDetails>
      </InfoFact>
      {relay.lastError ? (
        <InfoFact label="Last error">
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={relay.lastError}
          >
            {relay.lastError}
          </span>
        </InfoFact>
      ) : null}
    </InfoSection>
  )
}

// Opens the Relay's settings dialog: name, address, and proxy.
export function RelayConfigureButton({
  relay,
}: {
  relay: RelayDirectoryEntry
}) {
  const canConfigure = useRelayPermission(relay.id, "relay.configure")
  const [open, setOpen] = React.useState(false)
  if (!canConfigure) return null
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Settings2 />
        Configure
      </Button>
      {open ? (
        <React.Suspense fallback={null}>
          <EditRelayDialog relay={relay} open onOpenChange={setOpen} />
        </React.Suspense>
      ) : null}
    </>
  )
}

function tlsLabel(relay: RelayDirectoryEntry): string {
  if (!relay.useTls) return "Off"
  return relay.managedTls ? "Managed by the Relay" : "Custom certificate"
}

function tlsDescription(relay: RelayDirectoryEntry): string {
  if (!relay.useTls) {
    return "Traffic between Hearth and this Relay is not encrypted."
  }
  return relay.managedTls
    ? "The Relay issues its own certificate. Hearth trusts it through the certificate authority saved when the Relay was paired."
    : "The Relay serves a certificate from a public or custom certificate authority."
}
