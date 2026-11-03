import { randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import type { IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Duplex } from "node:stream"

import {
  relayDesktopHeartbeatSchema,
  type RelayControlOperation,
} from "@workspace/contracts"

import { forkPromise, recoverPromise } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import { isEligibleAccount } from "@/lib/account-policy"
import {
  getAuthenticatedRealtimeIdentityFromHeaders,
  type AuthenticatedUser,
} from "@/lib/auth-session"
import { kilnPublicUrl } from "@/lib/environment"
import { relayControlEndpoint } from "@/lib/relay-control-endpoint"
import {
  loadPersistedRelay,
  loadRelayCredentials,
  type PersistedRelay,
} from "@/lib/relay-registry"
import {
  openRelayTunnel,
  relayReachedThroughTunnel,
} from "@/lib/relay-tunnel.server"

// Desktop streams through Hearth. A page that may watch a Relay's desktop
// gets a session here, which holds the Relay's ticket for its stream
// (`relay.desktop.attach`) and never shows it to the browser. The page is
// voxl's own client, served from Hearth (public/desktop-client), and its
// WebSocket comes back to `/desktop-client/ws?relay=<id>&session=<key>`.
// Hearth checks the sign-in and access, then carries the connection, bytes
// unchanged, to the Relay's `/v1/desktop/<ticket>/ws`, over its listener or
// a tunnel as file transfers go. While anything is open, Hearth renews the
// ticket and checks access again every 20 seconds; a page that lost access,
// or a session nobody has used for a minute, is closed.

export const desktopClientPath = "/desktop-client/"
const SOCKET_PATH = `${desktopClientPath}ws`
const HEARTBEAT_INTERVAL_MS = 20_000
const IDLE_MS = 60_000
const MAX_SESSIONS_PER_USER = 8
const MAX_SOCKETS_PER_SESSION = 4

interface DesktopSession {
  readonly authSessionId: string
  readonly key: string
  readonly relay: PersistedRelay
  readonly sockets: Set<Duplex>
  readonly ticket: string
  readonly timer: ReturnType<typeof setInterval>
  readonly userId: string
  // The sign-in the last stream opened with, checked again on each renewal.
  headers: Headers | null
  idleSince: number
}

declare global {
  var kilnDesktopSessions: Map<string, DesktopSession> | undefined
}

// Shared across the dev server's module reloads, like Relay tunnels.
const sessions: Map<string, DesktopSession> =
  (globalThis.kilnDesktopSessions ??= new Map())

/** A session for one page, holding the Relay's ticket. Returns its key. */
export function openDesktopSession(input: {
  authSessionId: string
  relay: PersistedRelay
  ticket: string
  user: AuthenticatedUser
}): string {
  const owned = [...sessions.values()].filter(
    (session) => session.userId === input.user.id
  )
  // The oldest of this person's sessions makes room for a new one.
  if (owned.length >= MAX_SESSIONS_PER_USER) endSession(owned[0]!)
  const key = randomBytes(24).toString("base64url")
  const session: DesktopSession = {
    authSessionId: input.authSessionId,
    headers: null,
    idleSince: Date.now(),
    key,
    relay: input.relay,
    sockets: new Set(),
    ticket: input.ticket,
    timer: setInterval(() => renew(session), HEARTBEAT_INTERVAL_MS),
    userId: input.user.id,
  }
  session.timer.unref()
  sessions.set(key, session)
  return key
}

/** Whether a page's session still stands; a page without one opens another. */
export function desktopSessionOpen(key: string, userId: string): boolean {
  return findSession(key)?.userId === userId
}

/** Ends a page's session, as when it leaves the Desktop tab. */
export function closeDesktopSession(key: string, userId: string): void {
  const session = findSession(key)
  if (session && session.userId === userId) endSession(session)
}

/**
 * Takes a desktop page's WebSocket upgrade. False for any other path, which
 * the caller turns away.
 */
export function handleDesktopUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const url = URL.canParse(request.url ?? "", "http://hearth")
    ? new URL(request.url ?? "", "http://hearth")
    : null
  if (url?.pathname !== SOCKET_PATH) return false
  socket.on("error", () => socket.destroy())
  forkPromise(
    () => admit(request, socket, head, url),
    () => refuse(socket, 502, "Bad Gateway")
  )
  return true
}

async function admit(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL
) {
  // Only Hearth's own page: browsers let any site open a WebSocket here.
  if (request.headers.origin !== kilnPublicUrl().origin) {
    return refuse(socket, 403, "Forbidden")
  }
  const session = findSession(url.searchParams.get("session") ?? "")
  if (
    !session ||
    session.relay.id !== url.searchParams.get("relay") ||
    session.sockets.size >= MAX_SOCKETS_PER_SESSION
  ) {
    return refuse(socket, 403, "Forbidden")
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value)
  }
  const identity = await getAuthenticatedRealtimeIdentityFromHeaders(headers)
  if (
    !identity ||
    identity.user.id !== session.userId ||
    identity.sessionId !== session.authSessionId ||
    !(await mayWatch(identity.user, session.relay.id))
  ) {
    return refuse(socket, 403, "Forbidden")
  }
  session.headers = headers
  await carry(session, request, socket, head)
}

// Opens the same handshake on the Relay and, once it answers, joins the two
// connections.
async function carry(
  session: DesktopSession,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) {
  const relay = (await loadPersistedRelay(session.relay.id)) ?? session.relay
  const credentials = await loadRelayCredentials(relay.id)
  const control = relayControlEndpoint(relay)
  const tunnel = relayReachedThroughTunnel(relay.id)
    ? await openRelayTunnel(relay)
    : null
  const send = tunnel || !control.useTls ? httpRequest : httpsRequest
  const headers: Record<string, string> = {
    connection: "Upgrade",
    upgrade: "websocket",
  }
  for (const name of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
  ]) {
    const value = request.headers[name]
    if (typeof value === "string") headers[name] = value
  }
  const outgoing = send({
    ...(tunnel
      ? { createConnection: () => tunnel }
      : {
          ca: control.useTls
            ? (credentials.caCertificatePem ?? undefined)
            : undefined,
          host: control.hostname,
          port: control.port,
          rejectUnauthorized: control.useTls,
        }),
    headers,
    method: "GET",
    path: `/v1/desktop/${session.ticket}/ws`,
  })
  outgoing.once("response", (response) => {
    response.resume()
    refuse(socket, response.statusCode === 403 ? 403 : 502, "Bad Gateway")
  })
  outgoing.once("error", () => refuse(socket, 502, "Bad Gateway"))
  outgoing.once("upgrade", (response, upstream, upstreamHead) => {
    if (socket.destroyed) {
      upstream.destroy()
      return
    }
    const lines = ["HTTP/1.1 101 Switching Protocols"]
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      lines.push(
        `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`
      )
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstream.write(head)
    session.sockets.add(socket)
    const close = () => {
      if (session.sockets.delete(socket) && session.sockets.size === 0) {
        session.idleSince = Date.now()
      }
      upstream.destroy()
      socket.destroy()
    }
    upstream.once("error", close)
    upstream.once("close", close)
    socket.once("close", close)
    if ("setNoDelay" in upstream) upstream.setNoDelay(true)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  outgoing.end()
}

// Renews the ticket and checks access again; ends the session once it's no
// longer used, or no longer allowed.
function renew(session: DesktopSession) {
  if (session.sockets.size === 0 && Date.now() - session.idleSince > IDLE_MS) {
    endSession(session)
    return
  }
  forkPromise(
    async () => {
      if (session.headers) {
        const identity = await getAuthenticatedRealtimeIdentityFromHeaders(
          session.headers
        )
        if (
          !identity ||
          identity.sessionId !== session.authSessionId ||
          !(await mayWatch(identity.user, session.relay.id))
        ) {
          endSession(session)
          return
        }
      }
      const reply = relayDesktopHeartbeatSchema.parse(
        await relayRpc(session.relay, "relay.desktop.heartbeat", {
          tickets: [session.ticket],
        })
      )
      if (!reply.tickets.includes(session.ticket)) endSession(session)
    },
    () => undefined
  )
}

function endSession(session: DesktopSession) {
  if (sessions.get(session.key) !== session) return
  sessions.delete(session.key)
  clearInterval(session.timer)
  for (const socket of session.sockets) socket.destroy()
  session.sockets.clear()
  forkPromise(() =>
    relayRpc(session.relay, "relay.desktop.detach", { ticket: session.ticket })
  )
}

async function mayWatch(user: AuthenticatedUser, relayId: string) {
  if (!isEligibleAccount(user)) return false
  return recoverPromise(
    async () => {
      await requireRelayPermission({
        permission: "relay.terminal",
        relayId,
        user,
      })
      return true
    },
    () => false
  )
}

function findSession(key: string): DesktopSession | null {
  return sessions.get(key) ?? null
}

function refuse(socket: Duplex, status: number, reason: string) {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`, () =>
    socket.destroy()
  )
}

async function relayRpc(
  relay: PersistedRelay,
  operation: RelayControlOperation,
  payload: unknown
) {
  const { relayRpc: rpc } = await import("@/lib/relay-connection")
  return rpc(relay, operation, payload, 15_000)
}
