import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { dismissToast, showToast } from "@workspace/ui/components/sonner"

import {
  accessCapabilitiesQueryOptions,
  recoveryKitStatusQueryOptions,
} from "@/lib/query-options"

const recoveryKitToastId = "recovery-kit-unsaved"

const selectIsPlatformAdmin = (capabilities: { isPlatformAdmin: boolean }) =>
  capabilities.isPlatformAdmin

/**
 * Asks platform administrators, across the app, to save Kiln's recovery kit:
 * a notification that stays until someone has said it's saved.
 */
export const RecoveryKitToast = React.memo(function RecoveryKitToast() {
  const router = useRouter()
  const { data: isPlatformAdmin } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectIsPlatformAdmin,
  })
  const { data: status } = useQuery({
    ...recoveryKitStatusQueryOptions(),
    enabled: isPlatformAdmin === true,
  })
  const unsaved =
    isPlatformAdmin === true &&
    status !== undefined &&
    !status.saved &&
    status.available !== "none"

  React.useEffect(() => {
    if (!unsaved) {
      dismissToast(recoveryKitToastId)
      return
    }
    showToast({
      id: recoveryKitToastId,
      type: "warning",
      message: "Save Kiln's recovery kit",
      description: "Without it, a lost machine can't be restored.",
      duration: Infinity,
      dismissible: false,
      closeButton: false,
      action: {
        label: "Save it",
        onClick: (event) => {
          // It stays until the kit is saved, not when it's clicked.
          event.preventDefault()
          void router.navigate({ to: "/kiln/security", hash: "recovery-kit" })
        },
      },
    })
    return () => {
      dismissToast(recoveryKitToastId)
    }
  }, [router, unsaved])

  return null
})
