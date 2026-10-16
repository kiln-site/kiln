import * as React from "react"
import { Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { DangerZone } from "@/components/info-card"
import { InfoPage } from "@/components/info-page"
import { ServerDeleteDialog } from "@/components/server-delete-dialog"
import { ServerInfoRail } from "@/components/server/server-info-rail"
import {
  ServerBrickSettings,
  ServerConnectionSettings,
  ServerGeneralSettings,
  ServerProvisioningSection,
} from "@/components/server/server-settings"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"

// The game server's details, each section with the actions that change it,
// and a rail summing up where it runs and who can reach it. While it's
// provisioning, the attempt leads and the connection is left out.
export function ServerInfoPage({
  instance,
  node,
  onDeleted,
  passwordRequired,
  permissions,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
  onDeleted: () => Promise<void> | void
  passwordRequired: boolean
  permissions: {
    configurationRead: boolean
    configurationWrite: boolean
    deleteServer: boolean
    networkRead: boolean
    shareLogs: boolean
  }
  relayConnected: boolean
}) {
  const provisioning = Boolean(instance.provisioning)
  return (
    <InfoPage rail={<ServerInfoRail instance={instance} node={node} />}>
      <ServerProvisioningSection instance={instance} />
      <ServerGeneralSettings
        canRename={permissions.configurationWrite && !provisioning}
        instance={instance}
        relayConnected={relayConnected}
      />
      {provisioning ? null : (
        <ServerConnectionSettings
          canViewNetwork={permissions.networkRead}
          instance={instance}
        />
      )}
      <ServerBrickSettings
        canShare={permissions.shareLogs}
        canViewStartup={permissions.configurationRead}
        instance={instance}
      />
      {permissions.deleteServer ? (
        <ServerDangerZone
          instance={instance}
          onDeleted={onDeleted}
          passwordRequired={passwordRequired}
          relayConnected={relayConnected}
        />
      ) : null}
    </InfoPage>
  )
}

function ServerDangerZone({
  instance,
  onDeleted,
  passwordRequired,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  onDeleted: () => Promise<void> | void
  passwordRequired: boolean
  relayConnected: boolean
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      {/* At the bottom of the page, or after the sections when they're taller. */}
      <DangerZone
        className="mt-auto"
        title="Delete this server"
        action={
          <Button
            type="button"
            variant="destructive"
            className="shrink-0"
            disabled={!relayConnected}
            title={
              relayConnected
                ? undefined
                : "Reconnect this server's Relay before deleting"
            }
            onClick={() => setOpen(true)}
          >
            <Trash2 />
            Delete server
          </Button>
        }
      />
      {open ? (
        <ServerDeleteDialog
          open
          target={{
            backupAvailable: !instance.provisioning,
            id: instance.id,
            name: instance.name,
            relayId: instance.relayId,
          }}
          onDeleted={onDeleted}
          passwordRequired={passwordRequired}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}
