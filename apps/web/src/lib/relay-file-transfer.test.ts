import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

const capability = vi.hoisted(() => ({ issue: vi.fn(), save: vi.fn() }))

vi.mock("@/server/relay-capability", () => ({
  issueFileCapability: capability.issue,
}))
vi.mock("@/server/relay", () => ({ saveRelayFile: capability.save }))

import {
  inspectRelayFileDownload,
  uploadRelayFile,
} from "./relay-file-transfer"

beforeEach(() => {
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
})

afterEach(() => {
  capability.issue.mockReset()
  capability.save.mockReset()
  vi.unstubAllGlobals()
})

describe("Relay file capability negotiation", () => {
  it("opts into v2 without changing the request proof transport", async () => {
    const controller = new AbortController()
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
      signal: controller.signal,
    })

    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ signal: controller.signal })
    )
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

function mockUploadRequest() {
  const request = {
    upload: {
      onprogress: null as ((event: { loaded: number }) => void) | null,
    },
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    status: 200,
    statusText: "OK",
    responseText: JSON.stringify({
      modifiedAt: "2026-10-06T00:00:00Z",
      path: "upload.txt",
      sha256: "a".repeat(64),
      size: 4,
    }),
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn((_file: File) => {
      request.upload.onprogress?.({ loaded: 2 })
      request.onload?.()
    }),
  }
  vi.stubGlobal("XMLHttpRequest", function () {
    return request
  })
  return request
}

describe("Relay upload progress", () => {
  const input = {
    instanceId: "instance-one",
    path: "upload.txt",
    relayId: "relay-one",
  }

  it("reports uploaded bytes while preserving the signed PUT request", async () => {
    const request = mockUploadRequest()
    const file = new File(["test"], "upload.txt")
    const onProgress = vi.fn()
    const result = await uploadRelayFile({ ...input, file, onProgress })

    expect(request.open).toHaveBeenCalledWith(
      "PUT",
      new URL(
        "https://relay.example.com/v1/browser/files/instance-one?path=upload.txt"
      )
    )
    expect(request.send).toHaveBeenCalledWith(file)
    expect(request.setRequestHeader.mock.calls.map(([name]) => name)).toEqual([
      "Authorization",
      "X-Kiln-Nonce",
      "X-Kiln-Proof",
      "X-Kiln-Public-Key",
      "X-Kiln-Requested-At",
    ])
    expect(onProgress.mock.calls).toEqual([[2], [4]])
    expect(result.size).toBe(4)
  })

  it("keeps Relay HTTP errors and does not retry them through Hearth", async () => {
    const request = mockUploadRequest()
    request.status = 403
    request.responseText = JSON.stringify({ error: "Upload permission denied" })

    await expect(
      uploadRelayFile({
        ...input,
        file: new File(["test"], "upload.txt"),
        onProgress: vi.fn(),
      })
    ).rejects.toThrow("Upload permission denied")
    expect(capability.save).not.toHaveBeenCalled()
  })

  it("resets partial progress when a connection failure falls back to Hearth", async () => {
    const request = mockUploadRequest()
    request.send.mockImplementation(() => {
      request.upload.onprogress?.({ loaded: 2 })
      request.onerror?.()
    })
    capability.save.mockResolvedValue({
      modifiedAt: "2026-10-06T00:00:00Z",
      path: "upload.txt",
    })
    const onProgress = vi.fn()

    await uploadRelayFile({
      ...input,
      file: new File(["test"], "upload.txt"),
      onProgress,
    })

    expect(onProgress.mock.calls).toEqual([[2], [0], [4]])
    expect(capability.save).toHaveBeenCalledWith({
      data: { ...input, content: "test" },
    })
  })
})
