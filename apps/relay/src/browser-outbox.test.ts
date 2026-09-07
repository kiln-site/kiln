import { describe, expect, it, vi } from "vite-plus/test"
import { WebSocket } from "ws"

import { BrowserOutbox } from "./browser-outbox.js"

describe("browser outbox", () => {
  it("preserves console order and coalesces resources to the newest sample", () => {
    const callbacks: Array<(cause?: Error) => void> = []
    const sent: Array<string> = []
    const socket = {
      close: vi.fn(),
      readyState: WebSocket.OPEN,
      send: (encoded: string, callback: (cause?: Error) => void) => {
        sent.push(encoded)
        callbacks.push(callback)
      },
    } as unknown as WebSocket
    const outbox = new BrowserOutbox({
      authorize: () => true,
      maxBytes: 1024,
      maxMessages: 4,
      socket,
    })

    outbox.send("console-a", "console")
    outbox.send("resource-a", "resource")
    outbox.send("resource-b", "resource")
    outbox.send("console-b", "console")
    expect(sent).toEqual(["console-a"])
    callbacks.shift()?.()
    expect(sent).toEqual(["console-a", "console-b"])
    callbacks.shift()?.()
    expect(sent).toEqual(["console-a", "console-b", "resource-b"])
  })

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
    expect(socket.close).toHaveBeenCalledWith(
      1013,
      "Browser is not consuming messages"
    )
  })
})
