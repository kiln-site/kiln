import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowRightLeft, Copy, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  InfoDangerAction,
  InfoDangerZone,
  InfoPage,
  InfoSection,
} from "@/components/info-page"
import { ServerDeleteDialog } from "@/components/server-delete-dialog"
import { ServerInfoRail } from "@/components/server/server-info-rail"
import {
  ServerMigrationDialog,
  type ServerMigrationMode,
} from "@/components/server/server-migration-dialog"
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
import { ResourceDeletionAlert } from "@/components/resource-deletion-alert"
import { ResourceSecurityAlert } from "@/components/resource-security-alert"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { serverMigrationPreviewQueryOptions } from "@/lib/server-migration-queries"

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
    copyServer: boolean
    deleteServer: boolean
    networkRead: boolean
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
        passwordRequired={passwordRequired}
        kind="instance"
        relayId={instance.relayId}
        resourceId={instance.id}
      />
      <ResourceSecurityAlert
        relayId={instance.relayId}
        resourceId={instance.id}
        resourceType="instance"
      />
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
      {permissions.copyServer && !provisioning ? (
        <ServerMigrationSection
          instance={instance}
          relayConnected={relayConnected}
        />
      ) : null}
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
            passwordRequired={passwordRequired}
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
function ServerMigrationSection({
  instance,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  relayConnected: boolean
}) {
  const [mode, setMode] = React.useState<ServerMigrationMode | null>(null)
  const [opening, setOpening] = React.useState<ServerMigrationMode | null>(null)
  const queryClient = useQueryClient()
  const previewOptions = serverMigrationPreviewQueryOptions({
    instanceId: instance.id,
    relayId: instance.relayId,
  })
  // Asked for as the pointer reaches a button, and waited for on click, so
  // the dialog opens whole rather than growing once it loads.
  const prefetch = () => {
    void queryClient.prefetchQuery(previewOptions)
  }
  const open = (next: ServerMigrationMode) => {
    setOpening(next)
    // The dialog shows a failed preview itself.
    void ensuringPromise(
      () =>
        recoverPromise(
          () => queryClient.fetchQuery(previewOptions),
          () => undefined
        ),
      () => {
        setOpening(null)
        setMode(next)
      }
    )
  }
  const unavailable = relayConnected
    ? undefined
    : "Reconnect this server's Relay first"
  return (
    <InfoSection
      icon={<ArrowRightLeft />}
      title="Move or duplicate"
      action={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={!relayConnected || opening !== null}
            title={unavailable}
            onClick={() => open("duplicate")}
            onFocus={prefetch}
            onPointerEnter={prefetch}
          >
            {opening === "duplicate" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Copy />
            )}
            Duplicate
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!relayConnected || opening !== null}
            title={unavailable}
            onClick={() => open("migrate")}
            onFocus={prefetch}
            onPointerEnter={prefetch}
          >
            {opening === "migrate" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <ArrowRightLeft />
            )}
            Move to another Relay
          </Button>
          {mode ? (
            <ServerMigrationDialog
              open
              initialMode={mode}
              server={{
                brickId: instance.brickId,
                brickSource: instance.brickSource,
                id: instance.id,
                implementation: instance.implementation,
                name: instance.name,
                relayId: instance.relayId,
              }}
              onOpenChange={(open) => {
                if (!open) setMode(null)
              }}
            />
          ) : null}
        </>
      }
    />
  )
}
