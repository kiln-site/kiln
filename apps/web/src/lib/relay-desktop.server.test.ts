import { createHash } from "node:crypto"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { connect, type AddressInfo } from "node:net"
import type { Duplex } from "node:stream"

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"

vi.mock("@/lib/access-control", () => ({ requireRelayPermission: vi.fn() }))
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedRealtimeIdentityFromHeaders: vi.fn(),
}))
vi.mock("@/lib/relay-connection", () => ({ relayRpc: vi.fn(async () => ({})) }))
vi.mock("@/lib/relay-control-endpoint", () => ({
  relayControlEndpoint: (relay: unknown) => relay,
}))
vi.mock("@/lib/relay-registry", () => ({
  loadPersistedRelay: vi.fn(async () => null),
  loadRelayCredentials: vi.fn(async () => ({ caCertificatePem: null })),
}))
vi.mock("@/lib/relay-tunnel.server", () => ({
  openRelayTunnel: vi.fn(),
  relayReachedThroughTunnel: () => false,
}))

import { requireRelayPermission } from "@/lib/access-control"
import {
  getAuthenticatedRealtimeIdentityFromHeaders,
  type AuthenticatedUser,
} from "@/lib/auth-session"
import { kilnPublicUrl } from "@/lib/environment"
import { relayRpc } from "@/lib/relay-connection"
import {
  closeDesktopSession,
  desktopSessionOpen,
  handleDesktopUpgrade,
  openDesktopSession,
} from "@/lib/relay-desktop.server"
import type { PersistedRelay } from "@/lib/relay-registry"

const ticket = "t".repeat(43)
const user = {
  email: "ada@example.com",
  emailVerified: true,
  emailVerifiedAt: new Date(0).toISOString(),
  id: "user-1",
  status: "enabled",
} as AuthenticatedUser
const signedIn = { sessionId: "login-1", user }
const origin = kilnPublicUrl().origin

const servers: Array<Server> = []
const keys: Array<string> = []
let relayHeaders: Array<IncomingHttpHeaders & { path?: string }>
let hearthPort: number
let relay: PersistedRelay
let lastAnswer = ""
let relayAnswer: (headers: IncomingHttpHeaders) => Array<string> | null
let relaySockets: Array<Duplex>

const accept = (headers: IncomingHttpHeaders) =>
  createHash("sha1")
    .update(
      `${headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`
    )
    .digest("base64")

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    servers.push(server)
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port)
    )
  })

beforeEach(async () => {
  vi.mocked(getAuthenticatedRealtimeIdentityFromHeaders).mockReset()
  vi.mocked(getAuthenticatedRealtimeIdentityFromHeaders).mockResolvedValue(
    signedIn as never
  )
  vi.mocked(requireRelayPermission).mockReset()
  vi.mocked(requireRelayPermission).mockResolvedValue(undefined)
  relayHeaders = []
  const fakeRelay = createServer()
  relayAnswer = (headers) => [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept(headers)}`,
  ]
  relaySockets = []
  fakeRelay.on("upgrade", (request, socket) => {
    relayHeaders.push({ ...request.headers, path: request.url })
    relaySockets.push(socket)
    socket.on("error", () => undefined)
    socket.on("end", () => socket.destroy())
    socket.resume()
    const answer = relayAnswer(request.headers)
    if (answer) socket.end(`${answer.join("\r\n")}\r\n\r\n`)
  })
  relay = {
    hostname: "127.0.0.1",
    id: "relay-1",
    port: await listen(fakeRelay),
    useTls: false,
  } as PersistedRelay
  const hearth = createServer()
  hearth.on("upgrade", (request, socket, head) => {
    if (!handleDesktopUpgrade(request, socket, head)) socket.destroy()
  })
  hearthPort = await listen(hearth)
})

afterEach(async () => {
  for (const key of keys.splice(0)) closeDesktopSession(key, user.id)
  for (const socket of relaySockets) socket.destroy()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections()
          server.close(resolve)
        })
    )
  )
})

const open = () => {
  const key = openDesktopSession({
    authSessionId: signedIn.sessionId,
    relay,
    ticket,
    user,
  })
  keys.push(key)
  return key
}

// The status line Hearth answers a browser's handshake with.
const handshake = (input: {
  origin?: string
  path?: string
  relayId?: string
  session: string
}) =>
  new Promise<string>((resolve) => {
    const path =
      input.path ??
      `/desktop-client/ws?relay=${input.relayId ?? relay.id}&session=${input.session}`
    const socket = connect(hearthPort, "127.0.0.1", () =>
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          "Host: hearth",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Cookie: session=secret",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          ...(input.origin === undefined ? [] : [`Origin: ${input.origin}`]),
          "",
          "",
        ].join("\r\n")
      )
    )
    let answer = ""
    socket.on("data", (data) => {
      answer += data.toString()
    })
    socket.on("error", () => resolve(answer))
    socket.on("close", () => resolve(answer))
  }).then((answer) => {
    lastAnswer = answer
    return answer.split("\r\n")[0] ?? ""
  })

it("carries a signed-in person's stream to the Relay with the ticket, without their cookie", async () => {
  const answer = await handshake({ origin, session: open() })
  expect(answer).toContain("101")
  expect(relayHeaders).toHaveLength(1)
  expect(relayHeaders[0]?.path).toBe(`/v1/desktop/${ticket}/ws`)
  expect(relayHeaders[0]?.cookie).toBeUndefined()
})

it("answers the browser with its own handshake, not the Relay's headers", async () => {
  const honest = relayAnswer
  relayAnswer = (headers) => [
    ...(honest(headers) ?? []),
    "Set-Cookie: better-auth.session_token=attacker; Path=/",
    "X-From-Relay: yes",
  ]
  const answer = await handshake({ origin, session: open() })
  expect(answer).toContain("101")
  expect(lastAnswer.toLowerCase()).toContain("sec-websocket-accept")
  expect(lastAnswer.toLowerCase()).not.toContain("set-cookie")
  expect(lastAnswer.toLowerCase()).not.toContain("x-from-relay")
})

it("refuses a Relay's handshake that doesn't answer the browser's key", async () => {
  relayAnswer = () => [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: wrong",
  ]
  expect(await handshake({ origin, session: open() })).toContain("502")
})

it("counts streams waiting on a Relay, and drops them with their session", async () => {
  relayAnswer = () => null
  const session = open()
  const waiting = Array.from({ length: 4 }, () =>
    handshake({ origin, session })
  )
  await vi.waitFor(() => expect(relayHeaders).toHaveLength(4))
  expect(await handshake({ origin, session })).toContain("403")
  closeDesktopSession(session, user.id)
  await Promise.all(waiting)
  await vi.waitFor(() =>
    expect(relaySockets.every((socket) => socket.destroyed)).toBe(true)
  )
})

it("refuses another site's page, or none, even with a live session", async () => {
  const session = open()
  expect(
    await handshake({ origin: "https://evil.example", session })
  ).toContain("403")
  expect(await handshake({ session })).toContain("403")
  expect(relayHeaders).toEqual([])
})

it("refuses a session it doesn't know, or for another Relay", async () => {
  const session = open()
  expect(await handshake({ origin, session: "a".repeat(32) })).toContain("403")
  expect(await handshake({ origin, relayId: "relay-2", session })).toContain(
    "403"
  )
  expect(relayHeaders).toEqual([])
})

it("refuses a key without the sign-in that opened it", async () => {
  const session = open()
  const identity = vi.mocked(getAuthenticatedRealtimeIdentityFromHeaders)
  identity.mockResolvedValueOnce(null)
  expect(await handshake({ origin, session })).toContain("403")
  identity.mockResolvedValueOnce({ ...signedIn, sessionId: "login-2" } as never)
  expect(await handshake({ origin, session })).toContain("403")
  identity.mockResolvedValueOnce({
    sessionId: "login-1",
    user: { ...user, id: "user-2" },
  } as never)
  expect(await handshake({ origin, session })).toContain("403")
  expect(relayHeaders).toEqual([])
})

it("refuses someone who lost the permission", async () => {
  const session = open()
  vi.mocked(requireRelayPermission).mockRejectedValueOnce(new Error("denied"))
  expect(await handshake({ origin, session })).toContain("403")
  expect(relayHeaders).toEqual([])
})

it("leaves other upgrades alone", async () => {
  const answer = await handshake({ origin, path: "/api/other", session: "" })
  expect(answer).toBe("")
})

it("ends a session a page can't get a stream on, however often it retries", async () => {
  relayAnswer = () => ["HTTP/1.1 403 Forbidden", "Connection: close"]
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
  try {
    const session = open()
    for (let elapsed = 0; elapsed < 90_000; elapsed += 20_000) {
      await handshake({ origin, session })
      vi.advanceTimersByTime(20_000)
    }
    expect(desktopSessionOpen(session, user.id)).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it("keeps a session from anyone but its owner, and ends it on the Relay", async () => {
  const session = open()
  expect(desktopSessionOpen(session, "user-2")).toBe(false)
  closeDesktopSession(session, "user-2")
  expect(desktopSessionOpen(session, user.id)).toBe(true)
  closeDesktopSession(session, user.id)
  expect(desktopSessionOpen(session, user.id)).toBe(false)
  await vi.waitFor(() =>
    expect(relayRpc).toHaveBeenCalledWith(
      relay,
      "relay.desktop.detach",
      { ticket },
      expect.any(Number)
    )
  )
})
