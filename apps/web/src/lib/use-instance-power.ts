import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { recoverPromise } from "@/effect/promise"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import type { ServerAction } from "@/lib/instance-power-state"

/**
 * Power for a database or an App: runs the action through the kind's own
 * server function, then reads the instance's state again. A game server's
 * state arrives on its Relay's stream, so its page keeps its own.
 */
export function useInstancePower({
  reference,
  run,
  onError,
  onFailure,
}: {
  reference: { id: string; kind: "app" | "database"; relayId: string }
  run: (action: ServerAction) => Promise<unknown>
  /** The message to show beside the controls, or null to clear it. */
  onError: (message: string | null) => void
  /** The kind's own notice that the action failed. */
  onFailure: (cause: Error) => void
}) {
  const queryClient = useQueryClient()
  const { id, kind, relayId } = reference
  const action = useMutation({
    mutationFn: run,
    onMutate: () => onError(null),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: instanceInventoryScope({ id, kind, relayId }),
      }),
    onError: (cause) => {
      onError(cause.message)
      onFailure(cause)
    },
  })
  const runAction = action.mutateAsync
  const onAction = React.useCallback(
    async (next: ServerAction) => {
      // Failures surface through the mutation's onError.
      await recoverPromise(
        () => runAction(next),
        () => undefined
      )
    },
    [runAction]
  )
  return {
    action: action.isPending ? action.variables : null,
    onAction,
    pending: action.isPending,
  }
}
