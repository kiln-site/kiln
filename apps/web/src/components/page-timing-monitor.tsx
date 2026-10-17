import * as React from "react"
import { useRouter } from "@tanstack/react-router"

import {
  markPageMilestone,
  resolveClientNavigation,
  startClientNavigation,
  startPageOpen,
} from "@/lib/page-timing"

let hardLoadTimed = false

/**
 * Starts timing each instance page open: from the start of the document on
 * a fresh tab, or from the click on client navigation. Pages mark their own
 * milestones as they paint. Mounted for every page, including public ones,
 * so navigations through them are still seen.
 */
export function PageTimingMonitor() {
  const router = useRouter()
  // Started while rendering, before the page's own effects mark milestones.
  React.useState(() => {
    if (hardLoadTimed || typeof window === "undefined") return
    hardLoadTimed = true
    const leaf = router.state.matches.at(-1)
    if (!leaf) return
    startPageOpen(leaf.routeId, "hard", 0, hardLoadAttributes())
  })

  React.useEffect(() => {
    markPageMilestone("hydrated")
    const unsubscribeNavigate = router.subscribe(
      "onBeforeNavigate",
      (event) => {
        if (!event.pathChanged) return
        const path = event.toLocation.pathname
        const [routes] = router.getMatchedRoutes(path)
        startClientNavigation(path, routes.at(-1)?.id)
      }
    )
    const unsubscribeResolved = router.subscribe("onResolved", (event) =>
      resolveClientNavigation(event.toLocation.pathname)
    )
    return () => {
      unsubscribeNavigate()
      unsubscribeResolved()
    }
  }, [router])

  return null
}

// What the server and network cost this load, from the browser's own
// navigation timing and Hearth's Server-Timing header.
function hardLoadAttributes(): Record<string, unknown> {
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined
  if (!navigation) return {}
  const serverLoad = navigation.serverTiming.find(
    (entry) => entry.name === "load"
  )?.duration
  return {
    "kiln.page.ttfb_ms": Math.round(navigation.responseStart),
    "kiln.page.document_ms": Math.round(navigation.responseEnd),
    ...(serverLoad === undefined
      ? {}
      : { "kiln.page.server_load_ms": Math.round(serverLoad) }),
  }
}
