import { describe, expect, it } from "vite-plus/test"

import { realtimeClientEventSchema } from "./realtime-events"

const cursor = {
  epoch: "00000000-0000-4000-8000-000000000001",
  sequence: 1,
}

describe("realtime client events", () => {
  it("validates scoped Hearth collection invalidations", () => {
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        topics: ["file-activity", "relays", "schedules"],
        type: "collections.invalidate",
      }).success
    ).toBe(true)
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        topics: ["files"],
        type: "collections.invalidate",
      }).success
    ).toBe(false)
  })

  it("requires reset events to state whether Hearth data was lost", () => {
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        clear: false,
        hearth: true,
        type: "reset",
      }).success
    ).toBe(true)
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        clear: false,
        type: "reset",
      }).success
    ).toBe(false)
  })
})
