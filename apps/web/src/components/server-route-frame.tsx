import * as React from "react"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"

import { ServerWorkspace } from "@/components/server-workspace"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  uiPreferencesQueryOptions,
} from "@/lib/query-options"
import type { UiPreferences } from "@/lib/query-options"
import { applyProvisioningInstance } from "@/lib/realtime-client"
import { selectWorkspaceServer } from "@/lib/relay-selectors"
import { useServerSnapshot } from "@/lib/use-server-workspace"
import { getFreshRelayServer } from "@/server/relay"

const initialProvisioningReconciliationDelayMs = 1_000
const maximumProvisioningReconciliationDelayMs = 10_000

function selectFileTreePreferences(preferences: UiPreferences) {
  return {
    fileTreeCollapsed: preferences.fileTreeCollapsed,
    fileTreeWidth: preferences.fileTreeWidth,
  }
}

export const ServerRouteFrame = React.memo(function ServerRouteFrame({
  children,
  serverId,
}: {
  children: React.ReactNode
  serverId: string
}) {
  const selectInstance = React.useMemo(
    () => selectWorkspaceServer(serverId),
    [serverId]
  )
  const { data: instance } = useServerSnapshot(selectInstance)
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
      consoleRead: can("server.console.read"),
      consoleWrite: can("server.console.write"),
      // Copying a server, to duplicate or move it, reads its files and
      // settings; where it can go is up to the Relays.
      copyServer:
        can("server.files.read") && can("server.configuration.read"),
      deleteServer: can("server.delete"),
      filesWrite: can("server.files.write"),
      networkRead: can("server.network.read"),
      networkPublicPortWrite: can("server.network.public-port.write"),
      networkWrite: can("server.network.write"),
      powerStart: can("server.power.start"),
      powerRestart: can("server.power.restart"),
      configurationRead: can("server.configuration.read"),
      configurationWrite: can("server.configuration.write"),
      limitsWrite: can("server.limits.write"),
      shareLogs: can("server.logs.share"),
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
      <ServerWorkspace
        instance={instance}
        fileTreePreferences={fileTreePreferences}
        permissions={permissions}
      >
        {children}
      </ServerWorkspace>
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
      void ensuringPromise(
        () =>
          recoverPromise(
            () =>
              getFreshRelayServer({
                data: { instanceId, relayId },
              }).then((updated) => {
                if (closed) return
                if (updated) applyProvisioningInstance(queryClient, updated)
              }),
            () => undefined
          ),
        () => {
          inFlight = false
          attempt += 1
          nextAttemptAt =
            performance.now() +
            Math.min(
              initialProvisioningReconciliationDelayMs * 2 ** attempt,
              maximumProvisioningReconciliationDelayMs
            )
        }
      )
    }, initialProvisioningReconciliationDelayMs)

    return () => {
      closed = true
      clearInterval(interval)
    }
  }, [instanceId, queryClient, relayId])

  return null
}
