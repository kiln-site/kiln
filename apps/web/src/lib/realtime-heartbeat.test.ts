import { describe, expect, it } from "vite-plus/test"

import { encodeRealtimeHeartbeat } from "./realtime-heartbeat"

describe("realtime heartbeat", () => {
  it("emits an EventSource-visible ping while retaining a proxy comment", () => {
    expect(
      new TextDecoder().decode(encodeRealtimeHeartbeat(new TextEncoder()))
    ).toBe(": heartbeat\nevent: ping\ndata: {}\n\n")
  })
})
