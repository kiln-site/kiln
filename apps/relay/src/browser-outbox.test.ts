import { describe, expect, it, vi } from "vite-plus/test"
import { WebSocket } from "ws"

import { BrowserOutbox } from "./browser-outbox.js"

describe("browser outbox", () => {
  it("closes instead of growing beyond its message bound", () => {
    const socket = {
      close: vi.fn(),
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket
    const outbox = new BrowserOutbox({
      authorize: () => true,
      maxBytes: 1024,
      maxMessages: 2,
      socket,
    })
    outbox.send("a", "console")
    outbox.send("b", "console")
    outbox.send("c", "console")
    outbox.send("d", "console")
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String))
  })
})
