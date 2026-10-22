import * as React from "react"

export const mobileBreakpoint = 768

const mobileQuery = `(max-width: ${mobileBreakpoint - 1}px)`
const listeners = new Set<() => void>()
let mediaQuery: MediaQueryList | null = null

// Every caller shares one media query listener, and a breakpoint change
// renders each caller once.
function subscribe(listener: () => void) {
  if (!mediaQuery) {
    mediaQuery = window.matchMedia(mobileQuery)
    mediaQuery.addEventListener("change", notify)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0 || !mediaQuery) return
    mediaQuery.removeEventListener("change", notify)
    mediaQuery = null
  }
}

function notify() {
  for (const listener of listeners) listener()
}

function getSnapshot() {
  return (mediaQuery ?? window.matchMedia(mobileQuery)).matches
}

function getServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
