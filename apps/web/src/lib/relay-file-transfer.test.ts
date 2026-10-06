import { relayBrowserRequestProofTranscript } from "@workspace/contracts"
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

afterEach(() => {
  capability.issue.mockReset()
  capability.save.mockReset()
  vi.unstubAllGlobals()
})

function issueCapability(expiresAt = Date.now() + 30_000) {
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ capabilityId: "capability-one", expiresAt })
    )
  )
  const issued = `${payload}.signature`
  capability.issue.mockResolvedValue({
    browserOrigin: "https://relay.example.com",
    capability: issued,
    expiresAt,
    proxyMode: "none",
    relayId: "relay-one",
    version: 2,
  })
  return issued
}

describe("Relay file transfer requests", () => {
  it("carries a verifiable X-Kiln proof and reads the Relay's X-Kiln size headers", async () => {
    const expiresAt = Date.now() + 30_000
    const issuedCapability = issueCapability(expiresAt)
    const controller = new AbortController()
    const requests: Array<{ init: RequestInit; url: string }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn((url: URL, init: RequestInit) => {
        requests.push({ init, url: url.toString() })
        return Promise.resolve(
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
      })
    )

    const preview = await inspectRelayFileDownload({
      instanceId: "instance-one",
      path: "/server/world.zip",
      relayId: "relay-one",
      signal: controller.signal,
    })

    expect(preview).toMatchObject({
      gzipSizeEstimate: 2048,
      maxSize: 8192,
      size: 4096,
      zipSizeEstimate: 1024,
    })
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.url).toBe(
      "https://relay.example.com/v1/browser/files/instance-one?path=%2Fserver%2Fworld.zip"
    )
    expect(request?.init.method).toBe("HEAD")
    expect(request?.init.signal).toBe(controller.signal)
    const headers = request?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Kiln ${issuedCapability}`)

    // The Relay verifies this exact transcript against the advertised key.
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(
        new TextDecoder().decode(fromBase64Url(headers["X-Kiln-Public-Key"]))
      ) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    )
    const verified = await crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      publicKey,
      fromBase64Url(headers["X-Kiln-Proof"]),
      new TextEncoder().encode(
        relayBrowserRequestProofTranscript({
          capabilityId: "capability-one",
          expiresAt,
          instanceId: "instance-one",
          method: "HEAD",
          nonce: headers["X-Kiln-Nonce"] ?? "",
          path: "/server/world.zip",
          relayId: "relay-one",
          requestedAt: Number(headers["X-Kiln-Requested-At"]),
        })
      )
    )
    expect(verified).toBe(true)
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
  beforeEach(() => {
    issueCapability()
  })

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
    expect(
      new Set(request.setRequestHeader.mock.calls.map(([name]) => name))
    ).toEqual(
      new Set([
        "Authorization",
        "X-Kiln-Nonce",
        "X-Kiln-Proof",
        "X-Kiln-Public-Key",
        "X-Kiln-Requested-At",
      ])
    )
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

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function fromBase64Url(value: string | undefined): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value ?? "", "base64url"))
}
