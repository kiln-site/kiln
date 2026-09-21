import { showToast } from "@workspace/ui/components/sonner"

import { recoverPromise } from "@/effect/promise"

// Access surfaces render server timestamps verbatim so two admins comparing
// notes read the same instant regardless of their browser locale.
export function utcTimestamp(value: string | null | undefined): string {
  return value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "—"
}

// Clipboard writes reject when the document is not focused or permission is
// denied; both outcomes need transient feedback rather than a silent no-op.
export function copyWithToast(value: string, label: string): void {
  void recoverPromise(
    async () => {
      await navigator.clipboard.writeText(value)
      showToast({ type: "success", message: `${label} copied` })
    },
    () =>
      showToast({
        type: "error",
        message: `Could not copy the ${label.toLowerCase()}`,
      })
  )
}
