import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import { uploadConsoleLogToMclogs } from "./mclogs.js"

afterEach(() => vi.unstubAllGlobals())

describe("Relay mclo.gs uploads", () => {
  it("uploads the current console from Relay and returns only the link result", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        content: string
        metadata: Array<{ key: string; value: string }>
      }
      expect(body.content).toBe("Connected from ***.***.***.***")
      expect(body.metadata).toContainEqual(
        expect.objectContaining({ key: "path", value: "console.log" })
      )
      return new Response(
        JSON.stringify({
          expires: 1_800_000_000,
          id: "example",
          success: true,
          url: "https://mclo.gs/example",
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      Effect.runPromise(
        uploadConsoleLogToMclogs(
          "https://api.mclo.gs/1/log",
          {
            content: "Connected from 203.0.113.42",
            instanceId: "instance",
            path: "console.log",
            size: 29,
          },
          {
            implementation: "Paper",
            redactSensitive: true,
            version: "1.21.11",
          }
        )
      )
    ).resolves.toEqual({
      expires: 1_800_000_000,
      id: "example",
      url: "https://mclo.gs/example",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
