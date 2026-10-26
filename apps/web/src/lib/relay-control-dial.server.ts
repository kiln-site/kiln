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
} from "@workspace/contracts"
import { Option, Result, Schema } from "effect"
import { WebSocketServer } from "ws"
import type { WebSocket } from "ws"

import { forkPromise } from "@/effect/promise"
import { reportAppError } from "@/effect/runtime"
import { adoptRelayControlSocket } from "@/lib/relay-connection"
import { loadPersistedRelay } from "@/lib/relay-registry"
import { assertRequestRateLimit } from "@/lib/request-rate-limit"

// Relays dialing Hearth: a Relay Hearth can't reach, such as one behind a
// home router, opens its control connection here instead
// (`relayControlDialPath`). Hearth speaks first, with a nonce the Relay's
// signed challenge must carry, then hands the socket to the Relay's
// connection (`adoptRelayControlSocket`), which runs the same session as
// one Hearth opened. Anyone can connect, so nothing is trusted until that
// challenge checks out, and sockets still waiting for one are capped.

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
  if (pathname !== relayControlDialPath) return false
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
    socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n")
    return true
  }
  server.handleUpgrade(request, socket, head, greet)
  return true
}

// Says hello and waits for the Relay's challenge, which names the Relay.
function greet(socket: WebSocket): void {
  if (socket.protocol !== relayControlProtocol) {
    socket.close(4400, "Expected the Relay control protocol")
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
  socket.on("error", () => undefined)
  const nonce = randomBytes(32).toString("base64url")
  socket.send(JSON.stringify({ nonce, type: "dial.hello", v: 1 }))
  socket.once("message", (data, binary) => {
    settle()
    const challenge = binary ? Option.none() : decodeChallenge(data.toString())
    if (Option.isNone(challenge) || !challenge.value.dial) {
      socket.close(4400, "Expected the Relay's challenge")
      return
    }
    forkPromise(
      async () => {
        const relay = await loadPersistedRelay(challenge.value.relayId)
        if (!relay) {
          socket.close(
            relayDialCloseCodes.unknownRelay,
            "Hearth doesn't know this Relay"
          )
          return
        }
        adoptRelayControlSocket(relay, socket, challenge.value, nonce)
      },
      (cause) => {
        reportAppError(cause, { operation: "relay.control.dial" })
        socket.close(1011, "Hearth couldn't take this connection")
      }
    )
  })
}
