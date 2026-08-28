import { describe, expect, it } from "vite-plus/test"

import {
  realtimeClientEventSchema,
  realtimeEventRefreshesHearth,
} from "./realtime-events"

const cursor = {
  epoch: "00000000-0000-4000-8000-000000000001",
  sequence: 1,
}
const relayId = "r".repeat(43)
const instanceId = "a".repeat(40)

describe("realtime client events", () => {
  it("validates scoped Hearth collection invalidations", () => {
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        scope: { instanceId, relayId },
        topics: ["file-activity", "relays", "schedules"],
        type: "collections.invalidate",
      }).success
    ).toBe(true)
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        scope: { instanceId, relayId: "invalid" },
        topics: ["file-activity"],
        type: "collections.invalidate",
      }).success
    ).toBe(false)
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        topics: ["files"],
        type: "collections.invalidate",
      }).success
    ).toBe(false)
  })

  it("validates database-scoped collection invalidations", () => {
    const databaseId = "b".repeat(40)
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        scope: { databaseId, relayId },
        topics: ["database-credentials"],
        type: "collections.invalidate",
      }).success
    ).toBe(true)
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        scope: { databaseId: "invalid", relayId },
        topics: ["database-credentials"],
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

  it("can recover Relay identity and Hearth queries in one event", () => {
    const identity = realtimeClientEventSchema.parse({
      ...cursor,
      scope: { relayId },
      topics: ["relays"],
      type: "relay.invalidate",
    })

    expect(realtimeEventRefreshesHearth(identity)).toBe(true)
    expect(
      realtimeEventRefreshesHearth({
        ...cursor,
        type: "relay.invalidate",
      })
    ).toBe(false)
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        scope: { relayId: "invalid" },
        topics: ["relays"],
        type: "relay.invalidate",
      }).success
    ).toBe(false)
  })

  it("validates lightweight Relay reachability updates", () => {
    expect(
      realtimeClientEventSchema.safeParse({
        ...cursor,
        relayId,
        status: "unreachable",
        type: "relay.status",
      }).success
    ).toBe(true)
  })
})
