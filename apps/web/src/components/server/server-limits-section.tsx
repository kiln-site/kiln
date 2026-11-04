import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { ResourceLimits } from "@workspace/contracts"

import { ResourceLimitsSection } from "@/components/resource-limits/resource-limits-section"
import { instanceStartupQueryOptions } from "@/lib/query-options"
import {
  selectInstanceLimitsState,
  type InstanceSettingsInstance,
} from "@/lib/relay-selectors"
import { useServerSnapshot } from "@/lib/use-server-workspace"
import { updateInstanceLimits } from "@/server/bricks"

// A game server's limits are part of its container, so a running one
// restarts to take them, and a disk limit has to hold its files.
export function ServerLimitsSection({
  canRestart,
  editable,
  instance,
  relayConnected,
}: {
  canRestart: boolean
  editable: boolean
  instance: InstanceSettingsInstance
  relayConnected: boolean
}) {
  const { id, limits, relayId } = instance
  const queryClient = useQueryClient()
  const selectState = React.useMemo(
    () => selectInstanceLimitsState(id, relayId),
    [id, relayId]
  )
  const { data: state } = useServerSnapshot(selectState)
  const running = state?.running ?? false
  const groups = React.useMemo(() => [{ key: "server", limits }], [limits])
  const save = React.useCallback(
    async (next: Readonly<Record<string, ResourceLimits>>) => {
      const serverLimits = next.server
      if (!serverLimits) return
      await updateInstanceLimits({
        data: { instanceId: id, limits: serverLimits, relayId },
      })
      await queryClient.invalidateQueries({
        queryKey: instanceStartupQueryOptions(relayId, id).queryKey,
      })
    },
    [id, queryClient, relayId]
  )
  return (
    <ResourceLimitsSection
      disabledReason={
        !relayConnected
          ? "Reconnect this server's Relay first"
          : running && !canRestart
            ? "Changing a running server's limits takes permission to restart it."
            : undefined
      }
      diskFloorBytes={state?.diskUsedBytes}
      editable={editable}
      groups={groups}
      hint={
        running
          ? "Saving restarts the server to apply them."
          : "The server takes them the next time it starts."
      }
      saveLabel={running ? "Save & restart" : "Save limits"}
      target={{ id, kind: "server", relayId }}
      onSave={save}
    />
  )
}
