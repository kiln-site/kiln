import { publishRealtimeChange } from "@/lib/realtime-source.server"

// Operations change in bursts, a grant ending one and starting the next, and
// every change makes watchers read the list again; they hear of a burst once.
const COALESCE_MS = 250

let pending: ReturnType<typeof setTimeout> | null = null

/** Tells platform administrators' open operation views to read them again. */
export function publishOperationsChange(): void {
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    publishRealtimeChange({
      audience: { kind: "platform-admins" },
      topics: ["operations"],
      type: "hearth.invalidate",
    })
  }, COALESCE_MS)
  pending.unref?.()
}
