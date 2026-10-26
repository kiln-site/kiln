import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"

import { createHearthUpdateReload } from "./hearth-update-reload"

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("window", { setInterval, clearInterval })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it("counts down only after the update is ready and reaches reload once", () => {
  const store = createHearthUpdateReload()
  const displayed: Array<number | null> = []
  const unsubscribe = store.subscribe(() => displayed.push(store.getSnapshot()))
  vi.advanceTimersByTime(10_000)
  expect(store.getSnapshot()).toBeNull()

  const stop = store.start()
  vi.advanceTimersByTime(8_000)
  expect(displayed).toEqual([5, 4, 3, 2, 1, 0])
  unsubscribe()
  stop()
})

it("keeps the original deadline when an effect is restarted", () => {
  const store = createHearthUpdateReload()
  const stop = store.start()
  vi.advanceTimersByTime(2_000)
  stop()
  const stopAgain = store.start()
  expect(store.getSnapshot()).toBe(3)
  vi.advanceTimersByTime(3_000)
  expect(store.getSnapshot()).toBe(0)
  stopAgain()
})

it("uses elapsed time after a suspended tab and stops publishing on cleanup", () => {
  const store = createHearthUpdateReload()
  const stop = store.start()
  // Background tabs can miss timer ticks while wall time keeps moving.
  vi.setSystemTime(Date.now() + 30_000)
  vi.advanceTimersByTime(1_000)
  expect(store.getSnapshot()).toBe(0)
  stop()

  const other = createHearthUpdateReload()
  const stopOther = other.start()
  stopOther()
  vi.advanceTimersByTime(10_000)
  expect(other.getSnapshot()).toBe(5)
})
