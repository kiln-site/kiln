import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { RelayFileActivity } from "@workspace/contracts"

import { queryKeys, relayFileActivityQueryOptions } from "@/lib/query-options"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { updateRelayFilePin } from "@/server/relay"

// Pins a file or a directory (paths ending in "/") to the server's Files home.
export function useFilePin(
  instance: Pick<FileWorkspaceInstance, "id" | "relayId">,
  path: string,
  { onError }: { onError?: (error: Error) => void } = {}
) {
  const queryClient = useQueryClient()
  const selectPinned = React.useCallback(
    (activity: RelayFileActivity) =>
      activity.files.find((entry) => entry.path === path)?.pinned ?? false,
    [path]
  )
  const pinQuery = useQuery({
    ...relayFileActivityQueryOptions(instance.relayId, instance.id),
    select: selectPinned,
  })
  const pinMutation = useMutation({
    mutationFn: updateRelayFilePin,
    onError,
    onSuccess: (nextActivity) => {
      queryClient.setQueryData(
        queryKeys.fileActivity(instance.relayId, instance.id),
        nextActivity
      )
    },
  })
  const updatePinned = pinMutation.mutate
  const setPinned = React.useCallback(
    (nextPinned: boolean) => {
      updatePinned({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          path,
          pinned: nextPinned,
        },
      })
    },
    [instance.id, instance.relayId, path, updatePinned]
  )

  return {
    error: pinMutation.error
      ? pinMutation.error.message || "Could not update pin"
      : null,
    loading: pinQuery.isPending,
    pinned: pinQuery.data ?? false,
    pinning: pinMutation.isPending,
    setPinned,
  }
}
