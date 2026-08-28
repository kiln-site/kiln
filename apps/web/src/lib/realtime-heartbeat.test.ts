import { describe, expect, it } from "vite-plus/test"

import {
  encodeRealtimeHeartbeat,
  realtimeStreamIsStale,
  realtimeWatchdogTimeoutMs,
} from "./realtime-heartbeat"

describe("realtime heartbeat", () => {
  it("emits an EventSource-visible ping while retaining a proxy comment", () => {
    expect(
      new TextDecoder().decode(encodeRealtimeHeartbeat(new TextEncoder()))
    ).toBe(": heartbeat\nevent: ping\ndata: {}\n\n")
  })

  it("declares a stream stale only after the watchdog timeout", () => {
    const connectedAt = 1_000

    expect(
      realtimeStreamIsStale(
        connectedAt,
        connectedAt + realtimeWatchdogTimeoutMs - 1
      )
    ).toBe(false)
    expect(
      realtimeStreamIsStale(
        connectedAt,
        connectedAt + realtimeWatchdogTimeoutMs
      )
    ).toBe(true)
  })
})
