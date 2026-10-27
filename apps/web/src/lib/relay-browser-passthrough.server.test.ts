import { generateKeyPairSync, sign } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { beforeEach, expect, it, onTestFinished, vi } from "vite-plus/test"

vi.mock("@/lib/relay-registry", () => ({
  loadPersistedRelay: vi.fn(),
  loadRelayCredentials: vi.fn(),
}))
vi.mock("@/lib/relay-tunnel.server", () => ({
  openRelayTunnel: vi.fn(),
  relayReachedThroughTunnel: () => false,
}))

import { passRelayBrowserRequest } from "@/lib/relay-browser-passthrough.server"
import { relayPassthroughUsage } from "@/lib/relay-passthrough-limits.server"
import { loadPersistedRelay, loadRelayCredentials } from "@/lib/relay-registry"

const relayId = "relay-passthrough-test"
const clientId = "hearth-client"
const hearthKeys = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
})

// The Relay's listener, answering each request with `handle`.
async function relayListener(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  id = relayId
) {
  const server = createServer(handle)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  onTestFinished(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  vi.mocked(loadPersistedRelay).mockResolvedValue({
    hostname: "127.0.0.1",
    id,
    port: (server.address() as AddressInfo).port,
    useTls: false,
  } as Awaited<ReturnType<typeof loadPersistedRelay>>)
}

// A credential as Hearth signs them for the Relay: `<payload>.<signature>`.
function signed(
  payload: Record<string, unknown>,
  privateKey = hearthKeys.privateKey
): string {
  const encoded = Buffer.from(
    JSON.stringify({
      audience: relayId,
      expiresAt: Date.now() + 60_000,
      issuer: clientId,
      ...payload,
    })
  ).toString("base64url")
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`
}

// A browser's request for a file root's transfer, with a capability for it.
function fileRequest(
  instanceId: string,
  init: RequestInit = {},
  capability = signed({ instanceId })
): Request {
  return new Request("https://kiln.example/api", {
    ...init,
    headers: { authorization: `Kiln ${capability}`, ...init.headers },
  })
}

beforeEach(() => {
  vi.stubEnv("KILN_URL", "https://kiln.example")
  vi.mocked(loadRelayCredentials).mockResolvedValue({
    caCertificatePem: null,
    clientId,
    clientPublicKeyPem: hearthKeys.publicKey,
  } as Awaited<ReturnType<typeof loadRelayCredentials>>)
  return () => vi.unstubAllEnvs()
})

it("never lets what a Relay sends run as a page under Hearth's origin", async () => {
  await relayListener((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<script>fetch('/api/me')</script>")
  })
  const response = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root")
  )
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; sandbox"
  )
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
})

it("passes only a transfer's own route, its name encoded again", async () => {
  const paths: Array<string | undefined> = []
  await relayListener((request, response) => {
    paths.push(request.url)
    response.end()
  })
  const name = "..\\..\\v1\\trust"
  await passRelayBrowserRequest(relayId, `files/${name}`, fileRequest(name))
  const backup = "a b?c"
  await passRelayBrowserRequest(
    relayId,
    `backups/${backup}`,
    new Request(
      `https://kiln.example/api?token=${signed({ backupId: backup })}`
    )
  )
  expect(paths[0]).toBe("/v1/browser/files/..%5C..%5Cv1%5Ctrust")
  expect(paths[1]?.startsWith("/v1/browser/backups/a%20b%3Fc?token=")).toBe(
    true
  )
  for (const route of ["files/..", "files/.", "trust", "files/a/b"]) {
    const response = await passRelayBrowserRequest(
      relayId,
      route,
      fileRequest(route)
    )
    expect(response.status).toBe(404)
  }
})

it("spends nothing on a request without a credential Hearth signed for it", async () => {
  let reached = 0
  await relayListener((_request, response) => {
    reached += 1
    response.end()
  })
  const stranger = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  const refused = [
    new Request("https://kiln.example/api"),
    fileRequest("root", {}, "made.up"),
    fileRequest(
      "root",
      {},
      signed({ instanceId: "root" }, stranger.privateKey)
    ),
    fileRequest("root", {}, signed({ instanceId: "elsewhere" })),
    fileRequest(
      "root",
      {},
      signed({ expiresAt: Date.now() - 1, instanceId: "root" })
    ),
    fileRequest(
      "root",
      {},
      signed({ audience: "another-relay", instanceId: "root" })
    ),
  ]
  for (const request of refused) {
    const response = await passRelayBrowserRequest(
      relayId,
      "files/root",
      request
    )
    expect(response.status).toBe(401)
  }
  const backup = await passRelayBrowserRequest(
    relayId,
    "backups/b1",
    new Request(`https://kiln.example/api?token=${signed({ backupId: "b2" })}`)
  )
  expect(backup.status).toBe(401)
  expect(reached).toBe(0)
})

it("finds a native download's credential in its form, and passes the form on", async () => {
  const bodies: Array<string> = []
  await relayListener((request, response) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString())
      response.end()
    })
  })
  const form = new URLSearchParams({
    authorization: `Kiln ${signed({ instanceId: "root" })}`,
    path: "world",
  }).toString()
  const response = await passRelayBrowserRequest(
    relayId,
    "files/root",
    new Request("https://kiln.example/api", {
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  )
  expect(response.status).toBe(200)
  expect(bodies).toEqual([form])
})

it("fails the request, not Hearth, when an upload breaks off", async () => {
  await relayListener((request) => {
    request.resume()
  })
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("The browser went away"))
    },
  })
  await expect(
    passRelayBrowserRequest(
      relayId,
      "files/root",
      fileRequest("root", {
        body,
        duplex: "half",
        method: "PUT",
      } as RequestInit)
    )
  ).rejects.toThrow("The browser went away")
})

it("answers for a Relay whose status no response can carry", async () => {
  let status = 205
  await relayListener((_request, response) => {
    response.writeHead(status, { "content-length": "4" })
    response.end(status === 205 ? undefined : "body")
  })
  const reset = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root")
  )
  expect(reset.status).toBe(205)
  expect(reset.body).toBeNull()

  status = 600
  const invalid = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root")
  )
  expect(invalid.status).toBe(502)
})

it("keeps what a download will weigh, which browsers ask before one", async () => {
  const sizes = {
    "x-kiln-compressed-size-estimate": "10",
    "x-kiln-download-max-size": "30",
    "x-kiln-gzip-size-estimate": "10",
    "x-kiln-zip-size-estimate": "20",
  }
  await relayListener((_request, response) => {
    response.writeHead(200, sizes).end()
  })
  const response = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root", { method: "HEAD" })
  )
  for (const [name, value] of Object.entries(sizes)) {
    expect(response.headers.get(name)).toBe(value)
  }
})

it("carries a few transfers to a Relay at once, and counts what it carries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  // A Relay of its own, whose slots no other test holds.
  const busyRelay = "relay-passthrough-busy"
  const request = () =>
    fileRequest("root", {}, signed({ audience: busyRelay, instanceId: "root" }))
  const held: Array<ServerResponse> = []
  await relayListener((_request, response) => {
    response.writeHead(200)
    response.write("a".repeat(100))
    held.push(response)
  }, busyRelay)
  const before = relayPassthroughUsage(busyRelay)
  const open = await Promise.all(
    Array.from({ length: 8 }, () =>
      passRelayBrowserRequest(busyRelay, "files/root", request())
    )
  )
  const reader = open[0]!.body!.getReader()
  await reader.read()
  expect(relayPassthroughUsage(busyRelay).open).toBe(before.open + 8)

  // A ninth waits for a slot, then is turned away.
  const ninth = passRelayBrowserRequest(busyRelay, "files/root", request())
  await vi.advanceTimersByTimeAsync(5_000)
  const busy = await ninth
  expect(busy.status).toBe(503)
  expect(busy.headers.get("retry-after")).toBe("5")

  // One ending frees its slot for the next.
  const next = passRelayBrowserRequest(busyRelay, "files/root", request())
  held[0]!.end()
  await reader.read()
  await expect(next).resolves.toMatchObject({ status: 200 })
  expect(relayPassthroughUsage(busyRelay).bytesFromRelay).toBeGreaterThan(
    before.bytesFromRelay
  )
  for (const response of [...open.slice(1), await next]) {
    await response.body?.cancel()
  }
})

it("ends a transfer through Hearth that stalls", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const stalling = "relay-passthrough-stalling"
  await relayListener((_request, response) => {
    response.writeHead(200)
    response.write("first")
  }, stalling)
  const response = await passRelayBrowserRequest(
    stalling,
    "files/root",
    fileRequest("root", {}, signed({ audience: stalling, instanceId: "root" }))
  )
  const reader = response.body!.getReader()
  await reader.read()
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(reader.read()).rejects.toThrow()
  expect(relayPassthroughUsage(stalling).open).toBe(0)
})
