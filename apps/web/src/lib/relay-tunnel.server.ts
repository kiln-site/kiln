import { randomBytes } from "node:crypto"
import { isIP } from "node:net"
import type { Duplex } from "node:stream"
import { checkServerIdentity, connect as tlsConnect } from "node:tls"

import { RelayTunnelOpenedSchema } from "@workspace/contracts"
import { Effect, Schema } from "effect"
import { createWebSocketStream } from "ws"
import type { WebSocket } from "ws"

import { relayConnectionOpener, relayRpc } from "@/lib/relay-connection"
import type { RelayEndpoint } from "@/lib/relay-control-endpoint"
import { loadRelayCredentials } from "@/lib/relay-registry"

// Tunnels: how Hearth reaches the listener of a Relay that dials it. Hearth
// asks over the control connection (`relay.tunnel.open`) with a token, and
// the Relay opens a connection back to Hearth (relay-control-dial.server.ts)
// that carries one connection to its listener. Hearth then speaks to the
// listener through it as it would directly, TLS and all, checking the
// Relay's certificate against the CA it pinned.

const ARRIVAL_TIMEOUT_MS = 15_000
const MAX_WAITING = 128

interface WaitingTunnel {
  readonly relayId: string
  readonly resolve: (socket: WebSocket) => void
}

declare global {
  var kilnRelayTunnels: Map<string, WaitingTunnel> | undefined
}

// Tunnels Hearth asked for, by token, until their Relay opens them.
const waiting: Map<string, WaitingTunnel> = (globalThis.kilnRelayTunnels ??=
  new Map())

/**
 * Whether Hearth reaches this Relay's listener through tunnels: while the
 * Relay holds the control connection it opened, Hearth may not be able to
 * reach it at all.
 */
export function relayReachedThroughTunnel(relayId: string): boolean {
  return relayConnectionOpener(relayId) === "relay"
}

/**
 * Opens a connection to the Relay's listener through a tunnel the Relay
 * opens, ready for HTTP or WebSocket traffic: through TLS when the listener
 * speaks it.
 */
export function openRelayTunnel(relay: RelayEndpoint): Promise<Duplex> {
  return Effect.runPromise(openRelayTunnelEffect(relay))
}

const openRelayTunnelEffect = Effect.fn("RelayTunnel.open")(function* (
  relay: RelayEndpoint
) {
  if (waiting.size >= MAX_WAITING) {
    return yield* Effect.fail(
      new Error("Too many tunnels to Relays are opening")
    )
  }
  const token = randomBytes(32).toString("base64url")
  let arrival: WebSocket | null = null
  let used = false
  const arrived = new Promise<WebSocket>((resolve) => {
    waiting.set(token, {
      relayId: relay.id,
      resolve: (socket) => {
        arrival = socket
        resolve(socket)
      },
    })
  })
  return yield* Effect.gen(function* () {
    const opened = yield* Effect.tryPromise(() =>
      relayRpc(relay, "relay.tunnel.open", { token }, ARRIVAL_TIMEOUT_MS)
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RelayTunnelOpenedSchema)))
    // The Relay answers once its tunnel is open, so it's here or close.
    const socket = yield* Effect.promise(() => arrived).pipe(
      Effect.timeoutOrElse({
        duration: ARRIVAL_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new Error("The Relay didn't open its tunnel in time")),
      })
    )
    const stream = createWebSocketStream(socket)
    if (!opened.tls) {
      used = true
      return stream as Duplex
    }
    const { caCertificatePem } = yield* Effect.tryPromise(() =>
      loadRelayCredentials(relay.id)
    )
    const secure = yield* Effect.callback<Duplex, Error>((resume) => {
      const secure = tlsConnect({
        ...(caCertificatePem
          ? {
              ca: caCertificatePem,
              // The tunnel reaches the Relay's own listener, whatever name
              // it's published under; its certificate must still chain to
              // the CA Hearth pinned for it.
              checkServerIdentity: () => undefined,
            }
          : // A publicly trusted certificate, for the name Hearth knows.
            {
              checkServerIdentity: (_, certificate) =>
                checkServerIdentity(relay.hostname, certificate),
              ...(isIP(relay.hostname) ? {} : { servername: relay.hostname }),
            }),
        socket: stream,
      })
      const failed = (cause: Error) => {
        secure.destroy()
        resume(Effect.fail(cause))
      }
      secure.once("error", failed)
      secure.once("secureConnect", () => {
        secure.off("error", failed)
        resume(Effect.succeed(secure))
      })
      return Effect.sync(() => secure.destroy())
    }).pipe(
      Effect.timeoutOrElse({
        duration: ARRIVAL_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new Error("The Relay's tunnel didn't secure in time")),
      })
    )
    used = true
    return secure
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        waiting.delete(token)
        // A tunnel that arrived for a request that failed isn't left open.
        if (!used) (arrival as WebSocket | null)?.terminate()
      })
    )
  )
})

/** Whether Hearth asked for a tunnel with this token that hasn't arrived. */
export function relayTunnelAwaited(token: string): boolean {
  return waiting.has(token)
}

/**
 * Hands a tunnel the Relay opened to whoever asked for it with its token.
 * False when nobody is waiting for that token.
 */
export function acceptRelayTunnel(socket: WebSocket, token: string): boolean {
  const tunnel = waiting.get(token)
  if (!tunnel) return false
  waiting.delete(token)
  tunnel.resolve(socket)
  return true
}
