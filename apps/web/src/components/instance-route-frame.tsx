import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"

import { InstanceWorkspace } from "@/components/instance-workspace"
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaySnapshotQueryOptions,
  uiPreferencesQueryOptions,
} from "@/lib/query-options"
import type { UiPreferences } from "@/lib/query-options"
import { applyProvisioningInstance } from "@/lib/realtime-client"
import { selectInstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { getFreshRelaySnapshot } from "@/server/relay"

const initialProvisioningReconciliationDelayMs = 1_000
const maximumProvisioningReconciliationDelayMs = 10_000

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
    <>
      {instance.provisioning ? (
        <ProvisioningReconciler
          instanceId={instance.id}
          relayId={instance.relayId}
        />
      ) : null}
      <InstanceWorkspace
        instance={instance}
        fileTreePreferences={fileTreePreferences}
        permissions={permissions}
      >
        {children}
      </InstanceWorkspace>
    </>
  )
})

function ProvisioningReconciler({
  instanceId,
  relayId,
}: {
  instanceId: string
  relayId: string
}) {
  const queryClient = useQueryClient()

  React.useEffect(() => {
    let closed = false
    let inFlight = false
    let attempt = 0
    let nextAttemptAt =
      performance.now() + initialProvisioningReconciliationDelayMs

    const interval = setInterval(() => {
      if (inFlight || performance.now() < nextAttemptAt) return
      inFlight = true
      void getFreshRelaySnapshot()
        .then((snapshot) => {
          if (closed) return
          const updated = snapshot.instances.find(
            (item) => item.id === instanceId && item.relayId === relayId
          )
          if (updated) applyProvisioningInstance(queryClient, updated)
        })
        .catch(() => {
          // The realtime stream remains authoritative. This bounded backoff is
          // only a safety net when a short provisioning transition was missed.
        })
        .finally(() => {
          inFlight = false
          attempt += 1
          nextAttemptAt =
            performance.now() +
            Math.min(
              initialProvisioningReconciliationDelayMs * 2 ** attempt,
              maximumProvisioningReconciliationDelayMs
            )
        })
    }, initialProvisioningReconciliationDelayMs)

    return () => {
      closed = true
      clearInterval(interval)
    }
  }, [instanceId, queryClient, relayId])

  return null
}
