import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Result } from "effect"
import { KeyRound, X } from "lucide-react"

import {
  accessCapabilitiesQueryOptions,
  recoveryKitStatusQueryOptions,
} from "@/lib/query-options"

const dismissedKey = "kiln:recovery-kit:banner-dismissed"

// Storage can be missing or refuse, as in a private window; then it's
// simply not remembered.
function readDismissed(): boolean {
  if (typeof window === "undefined") return false
  return Result.getOrElse(
    Result.try(() => sessionStorage.getItem(dismissedKey) === "1"),
    () => false
  )
}

const selectIsPlatformAdmin = (capabilities: { isPlatformAdmin: boolean }) =>
  capabilities.isPlatformAdmin

/**
 * Asks platform administrators, across the app, to save Kiln's recovery kit
 * until someone has. Dismissing it lasts until this tab closes.
 */
export const RecoveryKitBanner = React.memo(function RecoveryKitBanner() {
  const { data: isPlatformAdmin } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectIsPlatformAdmin,
  })
  const { data: status } = useQuery({
    ...recoveryKitStatusQueryOptions(),
    enabled: isPlatformAdmin === true,
  })
  const [dismissed, setDismissed] = React.useState(readDismissed)
  if (
    !isPlatformAdmin ||
    !status ||
    status.saved ||
    status.available === "none" ||
    dismissed
  ) {
    return null
  }

  function dismiss() {
    setDismissed(true)
    Result.try(() => sessionStorage.setItem(dismissedKey, "1"))
  }

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-amber-400/30 bg-amber-400/8 px-4 py-2 light:bg-amber-400/16"
    >
      <KeyRound className="size-4 shrink-0 text-amber-300 light:text-amber-700" />
      <p className="type-meta min-w-0 flex-1">
        Save Kiln's recovery kit. Without it, a lost machine can't be restored.
      </p>
      <Link
        to="/kiln/security"
        hash="recovery-kit"
        className="type-control-sm shrink-0 font-medium text-amber-300 underline-offset-4 hover:underline light:text-amber-700"
      >
        Save it
      </Link>
      <button
        type="button"
        aria-label="Dismiss for now"
        onClick={dismiss}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
})
