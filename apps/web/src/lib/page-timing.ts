import * as React from "react"

import { startBrowserSpan, type BrowserSpan } from "@/lib/browser-telemetry"

/**
 * How long an instance page takes to become useful, from the click or from
 * the start of a fresh tab: when its route resolved, its name painted, its
 * status was confirmed, and its main content was ready. Each milestone is a
 * `performance.measure` entry named `kiln:page:<milestone>`, readable in
 * devtools and by measurement scripts, and a child span of "Page open".
 *
 * Every open has an ID. Milestones are marked against the open they belong
 * to, so a page that is leaving cannot mark the one replacing it.
 */
export type PageMilestone =
  | "route"
  | "hydrated"
  | "identity"
  | "status"
  | "content"

type Navigation = "hard" | "client"

interface PageOpen {
  id: number
  routeId: string
  navigation: Navigation
  startedAt: number
  // The name was in the server's HTML, so it painted with the first paint.
  identityServerRendered: boolean
  // The page reports no content milestone, though its route usually does.
  contentSkipped: boolean
  // When the navigations that led here began, if one was still pending.
  chainStartedAt: number
  // Requested, and painted: a page can request several in one frame.
  marked: Set<PageMilestone>
  recorded: Set<PageMilestone>
  span: BrowserSpan
  timeout: ReturnType<typeof setTimeout> | undefined
}

const instanceRoute = /^\/_app\/(server|db|app|relay)\//u

// Pages whose open ends at a page-specific "content" milestone. The rest end
// once their route, name, and status are on screen.
const contentRoutes = new Set(["/_app/server/$serverId/console"])

// An open that never completes still ends, so its span is reported.
const maximumOpenMs = 30_000

let current: PageOpen | null = null
let nextId = 1
// When the earliest navigation still pending began. A navigation that starts
// before it resolves, such as a redirect, a second click, or one started by
// code, is timed from its own start and records when the chain began; the
// router does not say which of those it was.
let pendingClientStart: number | undefined
// Where the pending navigation is going; it may resolve somewhere else.
let pendingClientPath: string | undefined
const listeners = new Set<() => void>()

export function isInstanceRoute(routeId: string): boolean {
  return instanceRoute.test(routeId)
}

/** The open being timed, or 0 when none is. */
export function currentPageOpenId(): number {
  return current?.id ?? 0
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
  const open: PageOpen = {
    id: nextId++,
    routeId,
    navigation,
    startedAt,
    identityServerRendered:
      navigation === "hard" &&
      typeof document !== "undefined" &&
      document.querySelector("[data-page-identity]") !== null,
    contentSkipped: false,
    chainStartedAt: startedAt,
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
    timeout: undefined,
  }
  open.timeout = setTimeout(() => {
    if (current === open) finishPageOpen("timeout")
  }, maximumOpenMs)
  current = open
  notify()
}

/** A client navigation to `path` began, possibly redirecting another. */
export function startClientNavigation(
  path: string,
  routeId: string | undefined
): void {
  const startedAt = performance.now()
  const chainStartedAt = pendingClientStart ?? startedAt
  pendingClientStart = chainStartedAt
  pendingClientPath = path
  if (!routeId) {
    finishPageOpen("left")
    return
  }
  startPageOpen(routeId, "client", startedAt, {
    "kiln.page.chain_before_ms": Math.round(startedAt - chainStartedAt),
  })
  if (current) current.chainStartedAt = chainStartedAt
}

/**
 * A client navigation resolved at `path`. When that is not where the open
 * was going, the navigation was abandoned, such as by returning to the page
 * already shown, and the open is cancelled rather than completed.
 */
export function resolveClientNavigation(path: string): void {
  if (pendingClientStart === undefined) return
  const expected = pendingClientPath
  pendingClientStart = undefined
  pendingClientPath = undefined
  if (path !== expected) {
    finishPageOpen("cancelled")
    return
  }
  markPageMilestone("route")
  // Pages now show the new route's instance, so they may mark it.
  notify()
}

/**
 * Records a milestone of an open once, when it is next painted. Marks for an
 * open that has been replaced are ignored.
 */
export function markPageMilestone(
  milestone: PageMilestone,
  openId = currentPageOpenId()
): void {
  const open = current
  if (!open || open.id !== openId || open.marked.has(milestone)) return
  open.marked.add(milestone)
  requestAnimationFrame(() => {
    if (current !== open) return
    // The frame's own timestamp can precede the request in a busy frame;
    // the time the callback runs, just before the paint, cannot.
    record(open, milestone, paintedTime(open, milestone, performance.now()))
    open.recorded.add(milestone)
    finishIfReady(open)
  })
}

/** The page reports no content milestone, such as an aggregate console. */
export function skipPageContent(openId: number): void {
  const open = current
  if (!open || open.id !== openId) return
  open.contentSkipped = true
  finishIfReady(open)
}

export function finishPageOpen(
  result: "ready" | "replaced" | "left" | "cancelled" | "timeout"
): void {
  const open = current
  if (!open) return
  current = null
  clearTimeout(open.timeout)
  open.span.setAttribute("kiln.page.result", result)
  open.span.end()
  notify()
}

/** Marks a milestone of the open page once `reached` is true. */
export function usePageMilestone(milestone: PageMilestone, reached: boolean) {
  // Re-arms for each open once its route has resolved, so a header that
  // stays mounted reports for the new page, and only once it shows the new
  // page's instance rather than the previous one.
  const openId = usePageOpenId()
  React.useEffect(() => {
    if (reached && openId) markPageMilestone(milestone, openId)
  }, [milestone, openId, reached])
}

/** Declares, while `skipped`, that this page reports no content milestone. */
export function usePageContentSkipped(skipped: boolean) {
  const openId = usePageOpenId()
  React.useEffect(() => {
    if (skipped && openId) skipPageContent(openId)
  }, [openId, skipped])
}

function usePageOpenId(): number {
  return React.useSyncExternalStore(subscribe, resolvedPageOpenId, () => 0)
}

// The open, once its page shows the route it opened: at once on a fresh
// tab, and after the route resolves on client navigation.
function resolvedPageOpenId(): number {
  const open = current
  if (!open) return 0
  return open.navigation === "hard" || open.marked.has("route") ? open.id : 0
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify() {
  for (const listener of listeners) listener()
}

function finishIfReady(open: PageOpen) {
  if (current !== open) return
  const required: Array<PageMilestone> = ["identity", "status"]
  if (open.navigation === "client") required.push("route")
  if (contentRoutes.has(open.routeId) && !open.contentSkipped)
    required.push("content")
  if (required.every((milestone) => open.recorded.has(milestone)))
    finishPageOpen("ready")
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
  const end = Math.max(open.startedAt, at)
  performance.measure(`kiln:page:${milestone}`, {
    start: open.startedAt,
    end,
    detail: {
      route: open.routeId,
      navigation: open.navigation,
      chainStartedAt: open.chainStartedAt,
    },
  })
  open.span.setAttribute(
    `kiln.page.${milestone}_ms`,
    Math.round(end - open.startedAt)
  )
  startBrowserSpan(`Page ${milestone}`, {
    parent: open.span,
    startedAt: open.startedAt,
    attributes: { "kiln.operation": `ui.page.${milestone}` },
  }).end(undefined, end)
}
