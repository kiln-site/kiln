import * as React from "react"
import { useRouter } from "@tanstack/react-router"

import {
  finishPageOpen,
  markPageMilestone,
  startPageOpen,
} from "@/lib/page-timing"

let hardLoadTimed = false

/**
 * Starts timing each instance page open: from the start of the document on
 * a fresh tab, or from the click on client navigation. Pages mark their own
 * milestones as they paint.
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
    let navigationStartedAt: number | undefined
    const unsubscribeNavigate = router.subscribe(
      "onBeforeNavigate",
      (event) => {
        if (!event.pathChanged) return
        navigationStartedAt = performance.now()
        const [routes] = router.getMatchedRoutes(event.toLocation.pathname)
        const leaf = routes.at(-1)
        if (leaf) startPageOpen(leaf.id, "client", navigationStartedAt)
        else finishPageOpen("left")
      }
    )
    const unsubscribeResolved = router.subscribe("onResolved", () => {
      if (navigationStartedAt === undefined) return
      navigationStartedAt = undefined
      markPageMilestone("route")
    })
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
