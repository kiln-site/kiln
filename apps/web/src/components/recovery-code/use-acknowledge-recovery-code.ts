import { useMutation, useQueryClient } from "@tanstack/react-query"

import { showToast } from "@workspace/ui/components/sonner"

import { queryKeys } from "@/lib/query-options"
import { acknowledgeRecoveryCode } from "@/server/recovery-code"

/** "I've saved it": records it, and stops asking. */
export function useAcknowledgeRecoveryCode(onSaved?: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => acknowledgeRecoveryCode(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.recoveryCode })
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
