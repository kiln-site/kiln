import { describe, expect, it, vi } from "vite-plus/test"
import { Effect, Fiber, Queue, Stream } from "effect"

import { createSocketInbox } from "./relay-console-stream"

describe("Relay console socket inbox", () => {
  it("retains a terminal error after queued messages are consumed", async () => {
    const socket = new FakeWebSocket()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createSocketInbox(socket as unknown as WebSocket)

          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "console.line" }),
            })
          )
          const close = new Event("close")
          Object.assign(close, { code: 1006, reason: "Relay disconnected" })
          socket.dispatchEvent(close)

          const message = yield* Queue.take(inbox.messages)
          const terminal = yield* Queue.take(inbox.messages).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => new Error("Expected the inbox to fail"),
            })
          )
          return { message, terminal }
        })
      )
    )

    expect(result.message).toEqual({ type: "console.line" })
    expect(result.terminal).toEqual(new Error("Relay disconnected"))
  })

  it("removes browser listeners when its Effect scope closes", async () => {
    const socket = new FakeWebSocket()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* createSocketInbox(socket as unknown as WebSocket)
          expect(socket.listenerCount).toBe(3)
        })
      )
    )

    expect(socket.listenerCount).toBe(0)
  })

  it("keeps the first terminal error when error and close both fire", async () => {
    const socket = new FakeWebSocket()
    const terminal = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createSocketInbox(socket as unknown as WebSocket)
          socket.dispatchEvent(new Event("error"))
          const close = new Event("close")
          Object.assign(close, { code: 1006, reason: "Relay disconnected" })

          expect(() => socket.dispatchEvent(close)).not.toThrow()
          return yield* Queue.take(inbox.messages).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => new Error("Expected the inbox to fail"),
            })
          )
        })
      )
    )

    expect(terminal).toEqual(new Error("Unable to connect to Relay"))
  })

  it("does not recover a cancelled inbox as a typed stream failure", async () => {
    const socket = new FakeWebSocket()
    const fallbackOpened = vi.fn()
    const fiber = Effect.runFork(
      Effect.scoped(
        Stream.unwrap(
          createSocketInbox(socket as unknown as WebSocket).pipe(
            Effect.map(({ messages }) => Stream.fromQueue(messages))
          )
        ).pipe(
          Stream.catch(() => {
            fallbackOpened()
            return Stream.empty
          }),
          Stream.runDrain
        )
      )
    )

    await vi.waitFor(() => expect(socket.listenerCount).toBe(3))
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(fallbackOpened).not.toHaveBeenCalled()
    expect(socket.listenerCount).toBe(0)
  })
})

class FakeWebSocket extends EventTarget {
  listenerCount = 0

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    this.listenerCount += 1
    super.addEventListener(type, callback, options)
  }

  close(): void {}

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    this.listenerCount -= 1
    super.removeEventListener(type, callback, options)
  }
}
