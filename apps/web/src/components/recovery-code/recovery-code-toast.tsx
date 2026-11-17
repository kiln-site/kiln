import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { dismissToast, showToast } from "@workspace/ui/components/sonner"

import {
  accessCapabilitiesQueryOptions,
  recoveryCodeStatusQueryOptions,
} from "@/lib/query-options"

const recoveryCodeToastId = "recovery-code-unsaved"

const selectIsPlatformAdmin = (capabilities: { isPlatformAdmin: boolean }) =>
  capabilities.isPlatformAdmin

/**
 * Asks platform administrators, across the app, to save Kiln's recovery code:
 * a notification that stays until someone has said it's saved.
 */
export const RecoveryCodeToast = React.memo(function RecoveryCodeToast() {
  const router = useRouter()
  const { data: isPlatformAdmin } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectIsPlatformAdmin,
  })
  const { data: status } = useQuery({
    ...recoveryCodeStatusQueryOptions(),
    enabled: isPlatformAdmin === true,
  })
  const unsaved =
    isPlatformAdmin === true &&
    status !== undefined &&
    !status.saved &&
    status.available !== "none"

  React.useEffect(() => {
    if (!unsaved) {
      dismissToast(recoveryCodeToastId)
      return
    }
    showToast({
      id: recoveryCodeToastId,
      type: "warning",
      message: "Save your recovery code",
      duration: Infinity,
      dismissible: false,
      closeButton: false,
      action: {
        label: "Save",
        onClick: (event) => {
          // It stays until the code is saved, not when it's clicked.
          event.preventDefault()
          void router.navigate({
            to: "/kiln/security",
            search: { recoveryCode: "save" },
          })
        },
      },
    })
    return () => {
      dismissToast(recoveryCodeToastId)
    }
  }, [router, unsaved])

  return null
})
