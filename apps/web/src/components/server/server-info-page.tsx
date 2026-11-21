import {
  InfoDangerAction,
  InfoDangerZone,
  InfoPage,
} from "@/components/info-page"
import { ServerDeleteDialog } from "@/components/server-delete-dialog"
import { ServerInfoRail } from "@/components/server/server-info-rail"
import { ServerContainerSection } from "@/components/server/server-limits-section"
import { ResourceMigrationSection } from "@/components/resource-migration-section"
import {
  ServerConnectionSettings,
  ServerProfile,
  ServerProvisioningSection,
} from "@/components/server/server-settings"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"
import { ResourceDeletionAlert } from "@/components/resource-deletion-alert"

// The game server's details, in the order every kind's Info page has: what
// it is and the Brick it runs, its container with its usage and limits,
// then what only a game server has, each section with the actions that
// change it, and a rail summing up where it runs and who can reach it.
// While it's provisioning, the attempt leads and the rest is left out.
export function ServerInfoPage({
  instance,
  node,
  onDeleted,
  permissions,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
  onDeleted: () => Promise<void> | void
  permissions: {
    configurationRead: boolean
    configurationWrite: boolean
    consoleRead: boolean
    copyServer: boolean
    deleteServer: boolean
    limitsWrite: boolean
    networkRead: boolean
    powerRestart: boolean
    shareLogs: boolean
  }
  relayConnected: boolean
}) {
  const provisioning = Boolean(instance.provisioning)
  return (
    <InfoPage rail={<ServerInfoRail instance={instance} node={node} />}>
      <ResourceDeletionAlert
        canDelete={permissions.deleteServer}
        name={instance.name}
        kind="instance"
        relayId={instance.relayId}
        resourceId={instance.id}
      />
      <ServerProvisioningSection instance={instance} />
      <ServerProfile
        canRename={permissions.configurationWrite && !provisioning}
        canShare={permissions.shareLogs}
        canViewStartup={permissions.configurationRead}
        instance={instance}
        relayConnected={relayConnected}
      />
      {provisioning ? null : (
        <ServerContainerSection
          canReadConsole={permissions.consoleRead}
          canRestart={permissions.powerRestart}
          editable={permissions.limitsWrite}
          instance={instance}
          relayConnected={relayConnected}
        />
      )}
      {provisioning ? null : (
        <ServerConnectionSettings
          canViewNetwork={permissions.networkRead}
          instance={instance}
        />
      )}
      {permissions.copyServer && !provisioning ? (
        <ResourceMigrationSection
          relayConnected={relayConnected}
          resource={{
            brickId: instance.brickId,
            brickSource: instance.brickSource,
            id: instance.id,
            implementation: instance.implementation,
            kind: "instance",
            name: instance.name,
            relayId: instance.relayId,
          }}
        />
      ) : null}
      {permissions.deleteServer ? (
        <ServerDangerZone
          instance={instance}
          onDeleted={onDeleted}
          relayConnected={relayConnected}
        />
      ) : null}
    </InfoPage>
  )
}

function ServerDangerZone({
  instance,
  onDeleted,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  onDeleted: () => Promise<void> | void
  relayConnected: boolean
}) {
  return (
    <InfoDangerZone>
      <InfoDangerAction
        disabledReason={
          relayConnected
            ? undefined
            : "Reconnect this server's Relay before deleting"
        }
        dialog={(onOpenChange) => (
          <ServerDeleteDialog
            open
            target={{
              backupAvailable: !instance.provisioning,
              id: instance.id,
              name: instance.name,
              relayId: instance.relayId,
            }}
            onDeleted={onDeleted}
            onOpenChange={onOpenChange}
          />
        )}
      >
        Delete server
      </InfoDangerAction>
    </InfoDangerZone>
  )
}

// Copies the server to a new one, on this Relay or another, or moves it to
// another Relay. The dialog mounts only while it's open.
