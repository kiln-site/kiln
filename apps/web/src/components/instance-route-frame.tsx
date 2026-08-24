import * as React from "react"
import { useQuery, useSuspenseQuery } from "@tanstack/react-query"

import { InstanceWorkspace } from "@/components/instance-workspace"
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaySnapshotQueryOptions,
  uiPreferencesQueryOptions,
} from "@/lib/query-options"
import type { UiPreferences } from "@/lib/query-options"
import { selectInstanceWorkspaceInstance } from "@/lib/relay-selectors"

function selectFileTreePreferences(preferences: UiPreferences) {
  return {
    fileTreeCollapsed: preferences.fileTreeCollapsed,
    fileTreeWidth: preferences.fileTreeWidth,
  }
}

export const InstanceRouteFrame = React.memo(function InstanceRouteFrame({
  children,
  serverId,
}: {
  children: React.ReactNode
  serverId: string
}) {
  const selectInstance = React.useMemo(
    () => selectInstanceWorkspaceInstance(serverId),
    [serverId]
  )
  const { data: instance } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectInstance,
  })
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { data: uiPreferences } = useSuspenseQuery({
    ...uiPreferencesQueryOptions(),
    select: selectFileTreePreferences,
  })
  const instanceId = instance?.id
  const relayId = instance?.relayId

  const fileTreePreferences = React.useMemo(
    () => ({
      collapsed: uiPreferences.fileTreeCollapsed,
      width: uiPreferences.fileTreeWidth,
    }),
    [uiPreferences.fileTreeCollapsed, uiPreferences.fileTreeWidth]
  )
  const permissions = React.useMemo(() => {
    const can = (
      permission: Parameters<typeof canAccessInstancePermission>[2]
    ): boolean =>
      instanceId && relayId
        ? canAccessInstancePermission(
            capabilities,
            { id: instanceId, relayId },
            permission
          )
        : false

    return {
      consoleWrite: can("instance.console.write"),
      deleteServer: can("instance.delete"),
      filesWrite: can("instance.files.write"),
      networkRead: can("instance.network.read"),
      networkPublicPortWrite: can("instance.network.public-port.write"),
      networkWrite: can("instance.network.write"),
      power: can("instance.power"),
      settings: can("instance.settings"),
      shareLogs: can("instance.logs.share"),
    }
  }, [capabilities, instanceId, relayId])

  if (!instance) return null

  return (
    <InstanceWorkspace
      instance={instance}
      fileTreePreferences={fileTreePreferences}
      permissions={permissions}
    >
      {children}
    </InstanceWorkspace>
  )
})
