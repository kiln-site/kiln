import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vite-plus/test"

import { uploadConsoleLogToMclogs } from "./mclogs.js"

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  )
})

/** A local stand-in for the mclo.gs API that records what Relay uploaded. */
async function fakeMclogs() {
  const uploads: Array<{ content: string }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      uploads.push(JSON.parse(body) as { content: string })
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify({
          expires: 1_800_000_000,
          id: "example",
          success: true,
          url: "https://mclo.gs/example",
        })
      )
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { endpoint: `http://127.0.0.1:${port}/1/log`, uploads }
}

describe("Relay mclo.gs uploads", () => {
  it("keeps player IP addresses out of a redacted share", async () => {
    const mclogs = await fakeMclogs()
    const content = [
      "Connected from 203.0.113.42",
      "Connected from 2001:db8::1",
    ].join("\n")

    const result = await Effect.runPromise(
      uploadConsoleLogToMclogs(
        mclogs.endpoint,
        {
          content,
          instanceId: "instance",
          path: "console.log",
          size: content.length,
        },
        {
          implementation: "Paper",
          redactSensitive: true,
          version: "1.21.11",
        }
      )
    )

    expect(result).toEqual({
      expires: 1_800_000_000,
      id: "example",
      url: "https://mclo.gs/example",
    })
    expect(mclogs.uploads).toHaveLength(1)
    const uploaded = mclogs.uploads[0]?.content ?? ""
    expect(uploaded).toContain("Connected from")
    expect(uploaded).not.toContain("203.0.113.42")
    expect(uploaded).not.toContain("2001:db8::1")
  })
})
