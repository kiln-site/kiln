import { describe, expect, it } from "vite-plus/test"

import {
  classifyRealtimeEvent,
  type RealtimeSourceEvent,
} from "./realtime-source.server"

const epoch = "00000000-0000-4000-8000-000000000001"
const identity = { sessionId: "session-one", userId: "user-one" }

describe("realtime source", () => {
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
})
