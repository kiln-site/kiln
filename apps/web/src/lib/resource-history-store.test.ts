import { describe, expect, it, vi } from "vite-plus/test"
import { relayInstanceResourcesSchema } from "@workspace/contracts"

import {
  createResourceHistoryRecorder,
  resourceHistoryStore,
} from "./resource-history-store"

describe("resource history consumption", () => {
  it("merges delayed history after live usage without reverting current usage", () => {
    const now = Date.parse("2026-10-29T12:00:00Z")
    vi.spyOn(Date, "now").mockReturnValue(now)
    try {
      const sample = (offset: number, cpu: number) =>
        relayInstanceResourcesSchema.parse({
          sampledAt: new Date(now + offset).toISOString(),
          cpu: { percent: cpu },
          memory: { totalBytes: 100, usedBytes: 10, percent: 10 },
          storage: { totalBytes: 100, usedBytes: 10, percent: 10 },
        })
      const old = sample(-4_000, 10)
      const middle = sample(-2_000, 20)
      const live = sample(0, 30)
      const store = resourceHistoryStore("history-relay", "live-before-history")
      const record = createResourceHistoryRecorder(store)
      expect(record({ sequence: 2, history: [], resources: live })).toBe(true)
      expect(
        record({
          sequence: 1,
          history: [middle, old, middle],
          resources: middle,
        })
      ).toBe(false)
      expect(record({ sequence: 2, history: [old], resources: null })).toBe(
        false
      )

      expect(
        store.getSnapshot().map(({ timestamp, cpu }) => [timestamp, cpu])
      ).toEqual([
        [now - 4_000, 10],
        [now - 2_000, 20],
        [now, 30],
      ])
      expect(store.getCurrentSnapshot()).toEqual(live)
      const next = sample(1_000, 40)
      expect(record({ sequence: 3, history: [], resources: next })).toBe(true)
      expect(store.getCurrentSnapshot()).toEqual(next)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("keeps a delayed point that arrives as the window drops an old one", () => {
    let now = Date.parse("2026-10-29T12:00:00Z")
    vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const sample = (at: number) =>
        relayInstanceResourcesSchema.parse({
          sampledAt: new Date(at).toISOString(),
          cpu: { percent: 10 },
          memory: { totalBytes: 100, usedBytes: 10, percent: 10 },
          storage: { totalBytes: 100, usedBytes: 10, percent: 10 },
        })
      const start = now
      const store = resourceHistoryStore("history-relay", "window-backfill")
      const record = createResourceHistoryRecorder(store)
      const live = sample(start)
      record({
        sequence: 2,
        history: [sample(start - 359_000)],
        resources: live,
      })

      now = start + 2_000
      record({ sequence: 1, history: [sample(start - 2_000)], resources: null })

      expect(store.getSnapshot().map(({ timestamp }) => timestamp)).toEqual([
        start - 2_000,
        start,
      ])
    } finally {
      vi.restoreAllMocks()
    }
  })
})
