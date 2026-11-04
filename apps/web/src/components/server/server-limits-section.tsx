import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { resourceLimitsEqual, type ResourceLimits } from "@workspace/contracts"
import { RotateCw } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { ResourceLimitsSection } from "@/components/resource-limits/resource-limits-section"
import { StatusIndicator } from "@/components/status-indicator"
import {
  instanceStartupQueryOptions,
  replaceRelaySnapshotInstance,
} from "@/lib/query-options"
import {
  selectInstanceLimitsState,
  type InstanceSettingsInstance,
} from "@/lib/relay-selectors"
import {
  invalidateRelaySnapshots,
  updateRelaySnapshots,
} from "@/lib/server-workspace"
import { useServerSnapshot } from "@/lib/use-server-workspace"
import { performRelayAction } from "@/server/relay"
import { updateInstanceLimits } from "@/server/resource-limits"

const PENDING_RESTART = {
  detail: "Restart this server to apply its saved limits.",
  label: "Pending restart",
  tone: "warning",
} as const

const PENDING_START = {
  detail: "The server takes its saved limits when it starts.",
  label: "Pending start",
  tone: "warning",
} as const

// A game server's limits are part of its container, so they save at once
// and it takes them when it next restarts, as its web routes do. A disk
// limit has to hold its files.
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
  const { id, limits, pendingLimits, relayId } = instance
  const queryClient = useQueryClient()
  const selectState = React.useMemo(
    () => selectInstanceLimitsState(id, relayId),
    [id, relayId]
  )
  const { data: state } = useServerSnapshot(selectState)
  const running = state?.running ?? false
  const saved = pendingLimits ?? limits
  const groups = React.useMemo(
    () => [{ key: "server", limits: saved }],
    [saved]
  )
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
  const restart = useMutation({
    mutationFn: () =>
      performRelayAction({
        data: { action: "restart", instanceId: id, relayId },
      }),
    onError: (error) => showToast({ message: error.message, type: "error" }),
    onSuccess: async (updated) => {
      updateRelaySnapshots(queryClient, (snapshot) =>
        replaceRelaySnapshotInstance(snapshot, updated)
      )
      await invalidateRelaySnapshots(queryClient)
    },
  })
  // What's saved can match what's running, if a restart applied it and then
  // couldn't say so.
  const pending =
    pendingLimits !== undefined && !resourceLimitsEqual(pendingLimits, limits)
  return (
    <ResourceLimitsSection
      action={
        pending && running && canRestart && relayConnected ? (
          <Button
            className="border-amber-400/30 bg-amber-400/5 text-amber-200 hover:bg-amber-400/10 hover:text-amber-100 light:bg-amber-400/10 light:text-amber-800 light:hover:bg-amber-400/20 light:hover:text-amber-800"
            disabled={restart.isPending}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => restart.mutate()}
          >
            <RotateCw className={restart.isPending ? "animate-spin" : ""} />
            {restart.isPending ? "Applying" : "Restart to apply"}
          </Button>
        ) : null
      }
      disabledReason={
        relayConnected ? undefined : "Reconnect this server's Relay first"
      }
      diskFloorBytes={state?.diskUsedBytes}
      editable={editable}
      groups={groups}
      hint={
        running
          ? "Limits save at once and apply the next time the server restarts."
          : "Limits save at once and apply when the server starts."
      }
      status={
        pending ? (
          <StatusIndicator status={running ? PENDING_RESTART : PENDING_START} />
        ) : null
      }
      target={{ id, kind: "server", relayId }}
      onSave={save}
    />
  )
}
