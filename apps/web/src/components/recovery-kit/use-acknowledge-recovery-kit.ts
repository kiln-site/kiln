import { useMutation, useQueryClient } from "@tanstack/react-query"

import { showToast } from "@workspace/ui/components/sonner"

import { queryKeys } from "@/lib/query-options"
import { acknowledgeRecoveryKit } from "@/server/recovery-kit"

/** "I've saved it": records it, and stops asking. */
export function useAcknowledgeRecoveryKit(onSaved?: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => acknowledgeRecoveryKit(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.recoveryKit })
      onSaved?.()
    },
    onError: (error) =>
      showToast({
        message:
          error instanceof Error ? error.message : "That couldn't be recorded",
        type: "error",
      }),
  })
}
