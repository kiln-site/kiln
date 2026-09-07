import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const capability = vi.hoisted(() => ({ issue: vi.fn() }))

vi.mock("@/server/relay-capability", () => ({
  issueFileCapability: capability.issue,
}))
vi.mock("@/server/relay", () => ({ saveRelayFile: vi.fn() }))

import { inspectRelayFileDownload } from "./relay-file-transfer"

afterEach(() => {
  capability.issue.mockReset()
  vi.unstubAllGlobals()
})

describe("Relay file capability negotiation", () => {
  it("opts into v2 without changing the request proof transport", async () => {
    const payload = btoa(
      JSON.stringify({
        capabilityId: "capability-one",
        expiresAt: Date.now() + 30_000,
      })
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "")
    capability.issue.mockResolvedValue({
      browserOrigin: "https://relay.example.com",
      capability: `${payload}.signature`,
      expiresAt: Date.now() + 30_000,
      proxyMode: "none",
      relayId: "relay-one",
      version: 2,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          headers: {
            "Content-Length": "4096",
            "Last-Modified": "Wed, 02 Sep 2026 00:00:00 GMT",
            "X-Kiln-Download-Max-Size": "8192",
            "X-Kiln-Gzip-Size-Estimate": "2048",
            "X-Kiln-Zip-Size-Estimate": "1024",
          },
          status: 200,
        })
      )
    )

    const preview = await inspectRelayFileDownload({
      instanceId: "instance-one",
      path: "/server/world.zip",
      relayId: "relay-one",
    })

    expect(capability.issue).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "instance.files.download",
        optInV2: true,
      }),
    })
    expect(preview).toMatchObject({
      gzipSizeEstimate: 2048,
      maxSize: 8192,
      size: 4096,
      zipSizeEstimate: 1024,
    })
  })
})
