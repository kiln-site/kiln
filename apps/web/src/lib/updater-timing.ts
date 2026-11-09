import * as React from "react"
import { Effect } from "effect"

import { startBrowserSpan, type BrowserSpan } from "@/lib/browser-telemetry"

/**
 * How long the Updates dialog takes to become useful, from the click that
 * opened it: when it painted, when its targets did, when their update
 * actions did, and when the check for the latest release painted its answer. Each milestone, and each piece of work an
 * open waits on, is a `performance.measure` entry named
 * `kiln:updater:<name>`, readable in devtools and by measurement scripts,
 * and a child span of "Updater open".
 *
 * Every open has an ID, so a milestone of one that was closed or replaced
 * can't mark the next.
 */
// "actions" is when each target's update button painted, once its Relay
// said whether it can update.
export type UpdaterMilestone = "dialog" | "targets" | "actions" | "latest"
export type UpdaterWork = "module" | "overview" | "eligibility" | "releases"

const requiredMilestones: ReadonlyArray<UpdaterMilestone> = [
  "dialog",
  "targets",
  "actions",
  "latest",
]

interface UpdaterOpen {
  id: number
  startedAt: number
  marked: Set<UpdaterMilestone>
  recorded: Set<UpdaterMilestone>
  span: BrowserSpan
  timeout: ReturnType<typeof setTimeout>
}

const workSpanNames: Record<UpdaterWork, string> = {
  module: "Updater module",
  overview: "Updater overview read",
  eligibility: "Updater eligibility read",
  releases: "Updater release check",
}

// An open that never completes still ends, so its span is reported.
const maximumOpenMs = 30_000

let current: UpdaterOpen | null = null
let nextId = 1
const listeners = new Set<() => void>()

/** Starts timing an open of the dialog; one still running is replaced. */
export function startUpdaterOpen(attributes: Record<string, unknown>): void {
  finishUpdaterOpen("replaced")
  const startedAt = performance.now()
  const open: UpdaterOpen = {
    id: nextId++,
    startedAt,
    marked: new Set(),
    recorded: new Set(),
    span: startBrowserSpan("Updater open", {
      startedAt,
      attributes: { "kiln.operation": "ui.updater.open", ...attributes },
    }),
    timeout: setTimeout(() => {
      if (current === open) finishUpdaterOpen("timeout")
    }, maximumOpenMs),
  }
  current = open
  notify()
}

export function finishUpdaterOpen(
  result: "ready" | "replaced" | "closed" | "timeout"
): void {
  const open = current
  if (!open) return
  current = null
  clearTimeout(open.timeout)
  open.span.setAttribute("kiln.updater.result", result)
  open.span.end()
  notify()
}

/** Notes something about the open being timed, such as a cache hit. */
export function annotateUpdaterOpen(key: string, value: unknown): void {
  current?.span.setAttribute(key, value)
}

/**
 * Times work the open being timed waits on. Work started while no open is
 * timed, such as a refetch on focus, runs untimed: Hearth traces its side.
 */
export function traceUpdaterWork<TResult>(
  work: UpdaterWork,
  run: () => Promise<TResult>
): Promise<TResult> {
  const open = typeof window === "undefined" ? null : current
  if (!open) return run()
  const startedAt = performance.now()
  const span = startBrowserSpan(workSpanNames[work], {
    parent: open.span,
    attributes: { "kiln.operation": `ui.updater.${work}` },
  })
  const finish = (error?: unknown) => {
    const end = performance.now()
    performance.measure(`kiln:updater:${work}`, {
      start: startedAt,
      end,
      detail: { result: error === undefined ? "ok" : "error" },
    })
    if (current === open) {
      open.span.setAttribute(
        `kiln.updater.${work}_ms`,
        Math.round(end - startedAt)
      )
    }
    span.end(error, end)
  }
  return Effect.runPromise(
    Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
      Effect.tap(() => Effect.sync(() => finish())),
      Effect.tapError((cause) => Effect.sync(() => finish(cause)))
    )
  )
}

/** Marks a milestone of the open being timed once `reached` is true. */
export function useUpdaterMilestone(
  milestone: UpdaterMilestone,
  reached: boolean
): void {
  const openId = React.useSyncExternalStore(subscribe, currentOpenId, () => 0)
  React.useEffect(() => {
    if (reached && openId) markUpdaterMilestone(milestone, openId)
  }, [milestone, openId, reached])
}

// Recorded when next painted.
function markUpdaterMilestone(milestone: UpdaterMilestone, openId: number) {
  const open = current
  if (!open || open.id !== openId || open.marked.has(milestone)) return
  open.marked.add(milestone)
  requestAnimationFrame(() => {
    if (current !== open) return
    const end = Math.max(open.startedAt, performance.now())
    performance.measure(`kiln:updater:${milestone}`, {
      start: open.startedAt,
      end,
    })
    open.span.setAttribute(
      `kiln.updater.${milestone}_ms`,
      Math.round(end - open.startedAt)
    )
    startBrowserSpan(`Updater ${milestone}`, {
      parent: open.span,
      startedAt: open.startedAt,
      attributes: { "kiln.operation": `ui.updater.${milestone}` },
    }).end(undefined, end)
    open.recorded.add(milestone)
    if (requiredMilestones.every((required) => open.recorded.has(required))) {
      finishUpdaterOpen("ready")
    }
  })
}

function currentOpenId(): number {
  return current?.id ?? 0
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify() {
  for (const listener of listeners) listener()
}
