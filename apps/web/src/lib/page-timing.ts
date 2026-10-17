import * as React from "react"

import { startBrowserSpan, type BrowserSpan } from "@/lib/browser-telemetry"

/**
 * How long an instance page takes to become useful, from the click or from
 * the start of a fresh tab: when its route resolved, its name painted, its
 * status was confirmed, and its main content was ready. Each milestone is a
 * `performance.measure` entry named `kiln:page:<milestone>`, readable in
 * devtools and by measurement scripts, and a child span of "Page open".
 */
export type PageMilestone =
  | "route"
  | "hydrated"
  | "identity"
  | "status"
  | "content"

type Navigation = "hard" | "client"

interface PageOpen {
  routeId: string
  navigation: Navigation
  startedAt: number
  // The name was in the server's HTML, so it painted with the first paint.
  identityServerRendered: boolean
  span: BrowserSpan
  // Requested, and painted: a page can request several in one frame.
  marked: Set<PageMilestone>
  recorded: Set<PageMilestone>
}

const instanceRoute = /^\/_app\/(server|db|app|relay)\//u

// Pages whose open ends at a page-specific "content" milestone. The rest end
// once their name and status are on screen.
const contentRoutes = new Set(["/_app/server/$serverId/console"])

let current: PageOpen | null = null

export function isInstanceRoute(routeId: string): boolean {
  return instanceRoute.test(routeId)
}

/** Starts timing a page open; any open still running is replaced. */
export function startPageOpen(
  routeId: string,
  navigation: Navigation,
  startedAt: number,
  attributes: Record<string, unknown> = {}
): void {
  finishPageOpen("replaced")
  if (!isInstanceRoute(routeId)) return
  current = {
    routeId,
    navigation,
    startedAt,
    identityServerRendered:
      navigation === "hard" &&
      document.querySelector("[data-page-identity]") !== null,
    marked: new Set(),
    recorded: new Set(),
    span: startBrowserSpan("Page open", {
      startedAt,
      attributes: {
        "kiln.operation": "ui.page.open",
        "kiln.page.route": routeId,
        "kiln.page.navigation": navigation,
        "kiln.instance.kind": instanceRoute.exec(routeId)?.[1],
        ...attributes,
      },
    }),
  }
}

/** Records a milestone of the open page once, when it is next painted. */
export function markPageMilestone(milestone: PageMilestone): void {
  const open = current
  if (!open || open.marked.has(milestone)) return
  open.marked.add(milestone)
  requestAnimationFrame((paintedAt) => {
    if (current !== open) return
    record(open, milestone, paintedTime(open, milestone, paintedAt))
    open.recorded.add(milestone)
    if (
      milestone === "content" ||
      (!contentRoutes.has(open.routeId) &&
        open.recorded.has("identity") &&
        open.recorded.has("status"))
    )
      finishPageOpen("ready")
  })
}

export function finishPageOpen(result: "ready" | "replaced" | "left"): void {
  const open = current
  if (!open) return
  current = null
  open.span.setAttribute("kiln.page.result", result)
  open.span.end()
}

function paintedTime(
  open: PageOpen,
  milestone: PageMilestone,
  frame: number
): number {
  if (milestone !== "identity" || !open.identityServerRendered) return frame
  const firstPaint = performance
    .getEntriesByType("paint")
    .find((entry) => entry.name === "first-contentful-paint")
  return firstPaint ? Math.min(firstPaint.startTime, frame) : frame
}

function record(open: PageOpen, milestone: PageMilestone, at: number) {
  const elapsed = Math.max(0, at - open.startedAt)
  performance.measure(`kiln:page:${milestone}`, {
    start: open.startedAt,
    end: Math.max(open.startedAt, at),
    detail: { route: open.routeId, navigation: open.navigation },
  })
  open.span.setAttribute(`kiln.page.${milestone}_ms`, Math.round(elapsed))
  startBrowserSpan(`Page ${milestone}`, {
    parent: open.span,
    startedAt: open.startedAt,
    attributes: { "kiln.operation": `ui.page.${milestone}` },
  }).end()
}

/** Marks a milestone of the open page once `reached` is true. */
export function usePageMilestone(milestone: PageMilestone, reached: boolean) {
  React.useEffect(() => {
    if (reached) markPageMilestone(milestone)
  }, [milestone, reached])
}
