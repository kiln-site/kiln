import type * as React from "react"
import { LoaderCircle, X } from "lucide-react"

/**
 * A short notice floating over the top of a live view (console output, a
 * terminal), so it never shifts the content below it.
 */
export function OverlayNotice({
  icon,
  loading = false,
  message,
  onDismiss,
  tone = "warning",
}: {
  icon?: React.ReactNode
  loading?: boolean
  message: string
  onDismiss?: () => void
  tone?: "info" | "warning"
}) {
  return (
    <div className="pointer-events-none absolute top-3 left-1/2 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2">
      <div
        role="status"
        className={`type-meta flex items-center gap-1.5 border bg-stone-950/90 px-2.5 py-1.5 font-mono shadow-lg shadow-black/35 backdrop-blur-sm ${
          tone === "warning"
            ? "border-amber-400/20 text-amber-200"
            : "border-sky-400/20 text-sky-200"
        }`}
      >
        {loading ? <LoaderCircle className="size-3 animate-spin" /> : icon}
        <span className="min-w-0 truncate">{message}</span>
        {onDismiss ? (
          <button
            type="button"
            aria-label="Dismiss"
            className="pointer-events-auto -mr-1 ml-0.5 text-current/60 hover:text-current"
            onClick={onDismiss}
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
