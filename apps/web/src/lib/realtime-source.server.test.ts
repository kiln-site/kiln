import { AsyncLocalStorage } from "node:async_hooks"

import { describe, expect, it } from "vite-plus/test"

import {
  classifyRealtimeEvent,
  publishRealtimeChange,
  subscribeRealtimeChanges,
  type RealtimeSourceEvent,
} from "./realtime-source.server"

const epoch = "00000000-0000-4000-8000-000000000001"
const identity = { sessionId: "session-one", userId: "user-one" }

describe("realtime source", () => {
  it("runs listeners in their subscriber's context, not the publisher's", async () => {
    const request = new AsyncLocalStorage<string>()
    const seen = new Promise<string | undefined>((resolve) => {
      const unsubscribe = request.run("subscriber", () =>
        subscribeRealtimeChanges(() => {
          // Auth work finishes after the listener returns.
          void Promise.resolve().then(() => {
            unsubscribe()
            resolve(request.getStore())
          })
        })
      )
    })

    request.run("publisher", () =>
      publishRealtimeChange({ relayId: "relay", type: "relay.snapshot.reset" })
    )

    expect(await seen).toBe("subscriber")
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
})
