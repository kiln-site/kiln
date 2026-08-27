import { describe, expect, it } from "vite-plus/test"

import {
  allocateRealtimeCursor,
  classifyRealtimeEvent,
  publishRealtimeChange,
  subscribeRealtimeChanges,
  type RealtimeSourceEvent,
} from "./realtime-source.server"

const epoch = "00000000-0000-4000-8000-000000000001"
const identity = { sessionId: "session-one", userId: "user-one" }

describe("realtime source", () => {
  it("sequences semantic changes and stops delivery after unsubscribe", () => {
    const received: Array<number> = []
    const unsubscribe = subscribeRealtimeChanges((event) => {
      received.push(event.sequence)
    })

    const first = publishRealtimeChange({
      relayId: "relay-a",
      type: "relay.state",
    })
    unsubscribe()
    publishRealtimeChange({ relayId: "relay-a", type: "relay.state" })

    expect(received).toEqual([first.sequence])
    expect(first.epoch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(first.sequence).toBeGreaterThan(0)
  })

  it("reserves distinct sequence numbers for per-stream recovery events", () => {
    const first = allocateRealtimeCursor()
    const second = allocateRealtimeCursor()

    expect(second.epoch).toBe(first.epoch)
    expect(second.sequence).toBe(first.sequence + 1)
  })

  it("never coalesces targeted access policy changes as normal overflow", () => {
    const event = {
      epoch,
      reauthenticate: false,
      sequence: 1,
      type: "access.changed",
      userIds: [identity.userId],
    } satisfies RealtimeSourceEvent

    expect(classifyRealtimeEvent(event, identity)).toBe("ordered")
  })

  it("closes immediately for access and session revocation", () => {
    const access = {
      epoch,
      reauthenticate: true,
      sequence: 1,
      type: "access.changed",
      userIds: [identity.userId],
    } satisfies RealtimeSourceEvent
    const session = {
      epoch,
      sequence: 2,
      sessionIds: [identity.sessionId],
      type: "session.revoked",
    } satisfies RealtimeSourceEvent

    expect(classifyRealtimeEvent(access, identity)).toBe("close")
    expect(classifyRealtimeEvent(session, identity)).toBe("close")
  })

  it("ignores security events for other identities", () => {
    const event = {
      epoch,
      sequence: 1,
      sessionIds: ["session-two"],
      type: "session.revoked",
    } satisfies RealtimeSourceEvent

    expect(classifyRealtimeEvent(event, identity)).toBe("ignore")
  })

  it("keeps scoped Hearth invalidations on the bounded normal path", () => {
    const event = {
      audience: { kind: "relays", relayIds: ["relay-a"] },
      epoch,
      sequence: 1,
      topics: ["schedules"],
      type: "hearth.invalidate",
    } satisfies RealtimeSourceEvent

    expect(classifyRealtimeEvent(event, identity)).toBe("normal")
  })
})
