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

import { relayPeerTransferPath } from "@workspace/contracts"

import {
  passRelayBrowserRequest,
  passRelayPeerRequest,
} from "@/lib/relay-browser-passthrough.server"
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

it("passes a pull another Relay makes through Hearth on to the source", async () => {
  const paths: Array<string | undefined> = []
  await relayListener((request, response) => {
    paths.push(request.url)
    response.end()
  })
  // A Relay puts its usual route beneath the pass-through's path, which
  // arrives as the route here.
  const route = relayPeerTransferPath("transfer-1").slice(1)
  const grant = (transferId: string) => ({
    authorization: `KilnPeer ${signed({ transferId })}`,
  })
  const pulled = await passRelayPeerRequest(
    relayId,
    route,
    new Request("https://kiln.example/api?traceparent=t", {
      headers: grant("transfer-1"),
    })
  )
  expect(pulled.status).toBe(200)
  expect(paths).toEqual(["/v1/peer/transfers/transfer-1?traceparent=t"])

  // Only with the grant Hearth signed for that copy.
  for (const headers of [{}, grant("transfer-2")]) {
    const refused = await passRelayPeerRequest(
      relayId,
      route,
      new Request("https://kiln.example/api", { headers })
    )
    expect(refused.status).toBe(401)
  }
  const written = await passRelayPeerRequest(
    relayId,
    route,
    new Request("https://kiln.example/api", {
      body: "x",
      headers: grant("transfer-1"),
      method: "POST",
    })
  )
  expect(written.status).toBe(404)
  expect(paths).toHaveLength(1)
})
