import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"

// Frames are flushed by the test; each milestone records on the next one.
let frames: Array<(time: number) => void> = []
let now = 0
vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
  frames.push(callback)
  return frames.length
})

type PageTiming = typeof import("@/lib/page-timing")
let timing: PageTiming

beforeEach(async () => {
  // Each test starts with no open page, as on a fresh document.
  vi.resetModules()
  timing = await import("@/lib/page-timing")
  frames = []
  now = 1_000
  vi.spyOn(performance, "now").mockImplementation(() => now)
  performance.clearMeasures()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function flushFrame(at = now) {
  const pending = frames
  frames = []
  for (const callback of pending) callback(at)
}

function measured(milestone: string) {
  return performance
    .getEntriesByName(`kiln:page:${milestone}`)
    .map((entry) => ({ start: entry.startTime, duration: entry.duration }))
}

it("finishes a client open only once its route, name, and status painted", () => {
  timing.startClientNavigation("/_app/db/$databaseId/info")
  now = 1_040
  // A cached page can paint its name and status before the route resolves.
  timing.markPageMilestone("identity")
  timing.markPageMilestone("status")
  flushFrame()
  expect(timing.currentPageOpenId()).not.toBe(0)

  now = 1_060
  timing.resolveClientNavigation()
  flushFrame()

  expect(timing.currentPageOpenId()).toBe(0)
  expect(measured("identity")).toEqual([{ start: 1_000, duration: 40 }])
  expect(measured("status")).toEqual([{ start: 1_000, duration: 40 }])
  expect(measured("route")).toEqual([{ start: 1_000, duration: 60 }])
})

it("ignores milestones from a page that is leaving", () => {
  timing.startClientNavigation("/_app/server/$serverId/console")
  timing.resolveClientNavigation()
  const leaving = timing.currentPageOpenId()
  now = 2_000
  timing.startClientNavigation("/_app/server/$serverId/files")

  // The previous console finishes loading after the navigation started.
  timing.markPageMilestone("content", leaving)
  flushFrame()

  expect(measured("content")).toEqual([])
  expect(timing.currentPageOpenId()).not.toBe(0)
})

it("keeps the original click time across a redirect", () => {
  timing.startClientNavigation("/_app/db/$databaseId/info")
  now = 1_030
  // A route redirects to its canonical URL before resolving.
  timing.startClientNavigation("/_app/db/$databaseId/info")
  now = 1_050
  timing.resolveClientNavigation()
  flushFrame()

  expect(measured("route")).toEqual([{ start: 1_000, duration: 50 }])
})

it("waits for the console's content unless the page reports none", () => {
  timing.startPageOpen("/_app/server/$serverId/console", "hard", 0)
  timing.markPageMilestone("identity")
  timing.markPageMilestone("status")
  flushFrame()
  expect(timing.currentPageOpenId()).not.toBe(0)

  // An aggregate console has no content milestone of its own.
  timing.skipPageContent(timing.currentPageOpenId())

  expect(timing.currentPageOpenId()).toBe(0)
})

it("ends an open that never completes", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  timing.startPageOpen("/_app/relay/$relayId/info", "hard", 0)

  vi.advanceTimersByTime(30_000)

  expect(timing.currentPageOpenId()).toBe(0)
})

it("does not time pages that are not instance pages", () => {
  timing.startClientNavigation("/_app/infra/servers")

  expect(timing.currentPageOpenId()).toBe(0)
})
