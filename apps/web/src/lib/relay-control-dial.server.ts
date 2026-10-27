import { randomBytes } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import {
  RelayAuthChallengeSchema,
  relayAuthenticationWindowMs,
  relayControlDialPath,
  relayControlMaxFrameBytes,
  relayControlProtocol,
  relayDialCloseCodes,
  relayTunnelPath,
  relayTunnelProtocol,
  relayTunnelTokenHeader,
} from "@workspace/contracts"
import { Option, Result, Schema } from "effect"
import { WebSocketServer } from "ws"
import type { WebSocket } from "ws"

import { forkPromise } from "@/effect/promise"
import { reportAppError } from "@/effect/runtime"
import { adoptRelayControlSocket } from "@/lib/relay-connection"
import { loadPersistedRelay } from "@/lib/relay-registry"
import {
  acceptRelayTunnel,
  relayTunnelAwaited,
} from "@/lib/relay-tunnel.server"
import { assertRequestRateLimit } from "@/lib/request-rate-limit"

// Relays dialing Hearth: a Relay Hearth can't reach, such as one behind a
// home router, opens its control connection here instead
// (`relayControlDialPath`). Hearth speaks first, with a nonce the Relay's
// signed challenge must carry, then hands the socket to the Relay's
// connection (`adoptRelayControlSocket`), which runs the same session as
// one Hearth opened. Anyone can connect, so nothing is trusted until that
// challenge checks out, and sockets still waiting for one are capped.
//
// Relays open tunnels here too (`relayTunnelPath`, relay-tunnel.server.ts):
// each upgrade names the token Hearth asked for it with.

const MAX_WAITING = 256
// Per minute, by the address the connection came from.
const CONNECTIONS_PER_ADDRESS = 120

const decodeChallenge = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAuthChallengeSchema)
)

let waiting = 0

const server = new WebSocketServer({
  clientTracking: false,
  handleProtocols: (protocols) =>
    protocols.has(relayControlProtocol) ? relayControlProtocol : false,
  maxPayload: relayControlMaxFrameBytes,
  noServer: true,
  perMessageDeflate: false,
})
const tunnels = new WebSocketServer({
  clientTracking: false,
  handleProtocols: (protocols) =>
    protocols.has(relayTunnelProtocol) ? relayTunnelProtocol : false,
  maxPayload: 1024 * 1024,
  noServer: true,
  perMessageDeflate: false,
})

/**
 * Takes a WebSocket upgrade for Hearth's Relay control path. Returns false
 * for any other upgrade, which it leaves alone.
 */
export function handleRelayControlUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const pathname = Result.getOrNull(
    Result.try(() => new URL(request.url ?? "/", "http://hearth").pathname)
  )
  if (pathname !== relayControlDialPath && pathname !== relayTunnelPath) {
    return false
  }
  // Tunnels come as often as transfers through Hearth do, so they don't
  // count against control connections; only one named for a tunnel Hearth
  // waits for is taken at all.
  if (pathname === relayTunnelPath) {
    const token = request.headers[relayTunnelTokenHeader]
    if (typeof token === "string" && relayTunnelAwaited(token)) {
      tunnels.handleUpgrade(request, socket, head, (tunnel) =>
        receiveTunnel(tunnel, token)
      )
    } else {
      refuseUpgrade(socket, "401 Unauthorized")
    }
    return true
  }
  const forwarded = request.headers["x-forwarded-for"]
  const address =
    (typeof forwarded === "string"
      ? forwarded.split(",")[0]?.trim()
      : undefined) ||
    request.socket.remoteAddress ||
    "unknown"
  const admitted =
    waiting < MAX_WAITING &&
    Result.isSuccess(
      Result.try(() =>
        assertRequestRateLimit(
          `relay.control:${address}`,
          CONNECTIONS_PER_ADDRESS,
          60_000
        )
      )
    )
  if (!admitted) {
    refuseUpgrade(socket, "429 Too Many Requests")
    return true
  }
  server.handleUpgrade(request, socket, head, greet)
  return true
}

// Answers an upgrade Hearth won't take, then lets go of its socket, whether
// or not the other end closes its side.
function refuseUpgrade(socket: Duplex, status: string): void {
  socket.on("error", () => undefined)
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () =>
    socket.destroy()
  )
}

// Hands a tunnel to whoever asked for it with its token.
function receiveTunnel(socket: WebSocket, token: string): void {
  socket.on("error", () => undefined)
  if (socket.protocol !== relayTunnelProtocol) {
    socket.terminate()
  } else if (!acceptRelayTunnel(socket, token)) {
    socket.close(4401, "Hearth didn't ask for this tunnel")
  }
}

// Says hello and waits for the Relay's challenge, which names the Relay.
function greet(socket: WebSocket): void {
  // Before anything else: a bad frame is an error on the socket.
  socket.on("error", () => undefined)
  // Not a Relay at all, so it isn't owed a closing handshake.
  if (socket.protocol !== relayControlProtocol) {
    socket.terminate()
    return
  }
  waiting += 1
  let counted = true
  const settle = () => {
    if (!counted) return
    counted = false
    waiting -= 1
    clearTimeout(timer)
  }
  const timer = setTimeout(() => {
    socket.close(4401, "Authentication timed out")
  }, relayAuthenticationWindowMs)
  timer.unref()
  socket.once("close", settle)
  const nonce = randomBytes(32).toString("base64url")
  socket.send(JSON.stringify({ nonce, type: "dial.hello", v: 1 }))
  socket.once("message", (data, binary) => {
    const challenge = binary ? Option.none() : decodeChallenge(data.toString())
    if (Option.isNone(challenge) || !challenge.value.dial) {
      settle()
      socket.close(4400, "Expected the Relay's challenge")
      return
    }
    // It still waits, and counts, until its challenge is checked.
    forkPromise(
      async () => {
        const relay = await loadPersistedRelay(challenge.value.relayId)
        if (!relay) {
          settle()
          socket.close(
            relayDialCloseCodes.unknownRelay,
            "Hearth doesn't know this Relay"
          )
          return
        }
        await adoptRelayControlSocket(relay, socket, challenge.value, nonce)
        settle()
      },
      (cause) => {
        settle()
        reportAppError(cause, { operation: "relay.control.dial" })
        socket.close(1011, "Hearth couldn't take this connection")
      }
    )
  })
}
