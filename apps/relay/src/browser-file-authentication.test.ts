import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

import { browserFileAuthenticationEffect } from "./browser-socket.js"
import type { IncomingMessage } from "node:http"

describe("browser file authentication", () => {
  it("destroys a request that exceeds the authentication deadline", async () => {
    const request = {
      destroyed: false,
      destroy: vi.fn(function (this: { destroyed: boolean }) {
        this.destroyed = true
      }),
    } as unknown as IncomingMessage

    await Effect.runPromiseExit(
      browserFileAuthenticationEffect(
        request,
        () => new Promise<never>(() => undefined),
        5
      )
    )

    expect(request.destroy).toHaveBeenCalledOnce()
  })
})
