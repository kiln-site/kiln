// Whether the person is using this tab right now: it's in front, focused,
// and they've touched, typed, scrolled, or moved the pointer recently. Kiln
// uses it to decide whether a notification it showed here was seen, so the
// same one needn't buzz their phone. It keeps one timestamp and never renders.

const activityEvents = [
  "keydown",
  "pointerdown",
  "pointermove",
  "touchstart",
  "wheel",
] as const

let lastActivityAt = 0
let tracking = false

function recordActivity() {
  lastActivityAt = Date.now()
}

/** Starts watching for input, once per page. */
export function startUserActivityTracking(): void {
  if (tracking || typeof window === "undefined") return
  tracking = true
  // Loading or returning to the page counts as activity.
  recordActivity()
  for (const event of activityEvents)
    window.addEventListener(event, recordActivity, {
      capture: true,
      passive: true,
    })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recordActivity()
  })
  window.addEventListener("focus", recordActivity)
}

/** Whether the tab is in front and had input within `idleMs`. */
export function isUserActive(idleMs: number): boolean {
  return (
    tracking &&
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    Date.now() - lastActivityAt < idleMs
  )
}
