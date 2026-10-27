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
import { loadPersistedRelay } from "@/lib/relay-registry"

const relayId = "relay-passthrough-test"

// The Relay's listener, answering each request with `handle`.
async function relayListener(
  handle: (request: IncomingMessage, response: ServerResponse) => void
) {
  const server = createServer(handle)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  )
  vi.mocked(loadPersistedRelay).mockResolvedValue({
    hostname: "127.0.0.1",
    id: relayId,
    port: (server.address() as AddressInfo).port,
    useTls: false,
  } as Awaited<ReturnType<typeof loadPersistedRelay>>)
}

beforeEach(() => {
  vi.stubEnv("KILN_URL", "https://kiln.example")
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
    new Request("https://kiln.example/api/relays/r/browser/files/root")
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
  for (const route of ["files/..\\..\\v1\\trust", "backups/a b?c"]) {
    await passRelayBrowserRequest(
      relayId,
      route,
      new Request("https://kiln.example/api")
    )
  }
  expect(paths).toEqual([
    "/v1/browser/files/..%5C..%5Cv1%5Ctrust",
    "/v1/browser/backups/a%20b%3Fc",
  ])
  for (const route of ["files/..", "files/.", "trust", "files/a/b"]) {
    const response = await passRelayBrowserRequest(
      relayId,
      route,
      new Request("https://kiln.example/api")
    )
    expect(response.status).toBe(404)
  }
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
      new Request("https://kiln.example/api", {
        body,
        duplex: "half",
        method: "PUT",
      } as RequestInit)
    )
  ).rejects.toThrow("The browser went away")
})
