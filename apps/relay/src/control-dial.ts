import {
  RelayDialHelloSchema,
  relayControlDialPath,
  relayControlMaxFrameBytes,
  relayControlProtocol,
  relayDialCloseCodes,
} from "@workspace/contracts"
import type { RelayDialBinding } from "@workspace/contracts"
import { Effect, Fiber, Option, Schema } from "effect"
import { WebSocket } from "ws"

import type { RelayStateStore } from "./effect/state.js"

// Dialing: besides answering the control connections Hearth opens, a Relay
// opens one to each Hearth that asked it to (`auth.response`'s `dial`, or
// the answer that paired it through a join). It's the same session, so a
// Relay Hearth can't reach, such as one behind a home router, is managed
// like any other. Hearth keeps one connection per Relay and closes extras
// (`relayDialCloseCodes`), so dialing stands by while Hearth's own
// connection holds and takes over when it can't.

const DIAL_METADATA_PREFIX = "control_dial:"
const RECONCILE_INTERVAL_MS = 15_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const HELLO_TIMEOUT_MS = 10_000
const MIN_RETRY_MS = 1_000
const MAX_RETRY_MS = 60_000
// A session that lasted this long starts its retries over.
const STABLE_SESSION_MS = 60_000
// Hearth kept another connection to this Relay.
const DUPLICATE_RETRY_MS = 2 * 60_000
// Hearth doesn't know this Relay, as when it was removed there. A few tries
// back off as usual first: one that just paired can dial before Hearth has
// saved it.
const REFUSED_RETRY_MS = 30 * 60_000
const REFUSALS_BEFORE_WAITING = 5

const decodeHello = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayDialHelloSchema)
)

export interface ControlDialOptions {
  /** Serves a connection the Relay opened, once Hearth said hello. */
  readonly adopt: (
    socket: WebSocket,
    binding: RelayDialBinding,
    peerAddress: string | undefined
  ) => void
  readonly state: RelayStateStore["Service"]
}

export interface ControlDials {
  readonly close: () => Promise<void>
  /** Saves where a Hearth client asked to be dialed, or forgets it. */
  readonly save: (clientId: string, url: string | null) => void
}

/**
 * Where a Hearth asked to be dialed, as a WebSocket URL, or null when it
 * isn't one the Relay dials: only Hearth's control path, over HTTP(S),
 * without credentials.
 */
export function relayDialUrl(value: string): URL | null {
  if (value.length > 512 || !URL.canParse(value)) return null
  const url = new URL(value)
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== relayControlDialPath
  ) {
    return null
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

interface Dial {
  fiber: Fiber.Fiber<void> | null
  // While a session it opened is open, which ends on its own once Hearth no
  // longer wants it.
  inSession: boolean
  readonly url: string
}

export function startControlDials(options: ControlDialOptions): ControlDials {
  const dials = new Map<string, Dial>()
  let closed = false

  const reconcile = Effect.gen(function* () {
    const clients = yield* options.state.listClients()
    const wanted = new Map<string, string>()
    for (const client of clients) {
      const saved = yield* options.state.getMetadata(
        `${DIAL_METADATA_PREFIX}${client.id}`
      )
      const url = saved ? relayDialUrl(saved) : null
      if (url) wanted.set(client.id, url.href)
    }
    if (closed) return
    for (const [clientId, dial] of dials) {
      if (wanted.get(clientId) === dial.url) continue
      dials.delete(clientId)
      if (!dial.inSession && dial.fiber) yield* Fiber.interrupt(dial.fiber)
    }
    for (const [clientId, url] of wanted) {
      if (dials.has(clientId)) continue
      const dial: Dial = { fiber: null, inSession: false, url }
      dials.set(clientId, dial)
      dial.fiber = Effect.runFork(
        dialLoop(options, clientId, dial, () => dials.get(clientId) === dial)
      )
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't read which Hearths to dial", cause)
    )
  )

  const reconcileFiber = Effect.runFork(
    reconcile.pipe(
      Effect.andThen(Effect.sleep(RECONCILE_INTERVAL_MS)),
      Effect.forever
    )
  )

  return {
    close: () =>
      Effect.runPromise(
        Effect.suspend(() => {
          closed = true
          const fibers = [
            reconcileFiber,
            ...[...dials.values()].flatMap((dial) =>
              dial.fiber ? [dial.fiber] : []
            ),
          ]
          dials.clear()
          return Fiber.interruptAll(fibers)
        })
      ),
    save: (clientId, url) => {
      const key = `${DIAL_METADATA_PREFIX}${clientId}`
      const value = url && relayDialUrl(url) ? url : ""
      Effect.runFork(
        options.state.getMetadata(key).pipe(
          Effect.flatMap((saved) =>
            (saved ?? "") === value
              ? Effect.void
              : options.state
                  .setMetadata(key, value)
                  .pipe(Effect.andThen(reconcile))
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Couldn't save where to dial Hearth", cause)
          )
        )
      )
    },
  }
}

// Dials one Hearth client for as long as it wants it, waiting longer
// between attempts the more of them fail.
const dialLoop = (
  options: ControlDialOptions,
  clientId: string,
  dial: Dial,
  wanted: () => boolean
) =>
  Effect.gen(function* () {
    let failures = 0
    let refusals = 0
    // Spread out, so Relays don't all arrive at once after Hearth restarts.
    yield* Effect.sleep(Math.floor(Math.random() * 2_000))
    while (wanted()) {
      const startedAt = Date.now()
      const code = yield* dialOnce(options, clientId, dial)
      if (!wanted()) return
      refusals = code === relayDialCloseCodes.unknownRelay ? refusals + 1 : 0
      if (Date.now() - startedAt >= STABLE_SESSION_MS) failures = 0
      failures += 1
      yield* Effect.sleep(retryDelay(code, failures, refusals))
    }
  })

function retryDelay(
  code: number | null,
  failures: number,
  refusals: number
): number {
  const base =
    code === relayDialCloseCodes.duplicate
      ? DUPLICATE_RETRY_MS
      : refusals >= REFUSALS_BEFORE_WAITING
        ? REFUSED_RETRY_MS
        : Math.min(MIN_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

// One connection, from dialing to its close. Ends with how it closed, or
// null when it never opened.
const dialOnce = (options: ControlDialOptions, clientId: string, dial: Dial) =>
  Effect.callback<number | null>((resume) => {
    let adopted = false
    const socket = new WebSocket(dial.url, relayControlProtocol, {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: relayControlMaxFrameBytes,
      perMessageDeflate: false,
    })
    const helloTimer = setTimeout(() => {
      socket.close(4408, "Hearth didn't say hello")
    }, HANDSHAKE_TIMEOUT_MS + HELLO_TIMEOUT_MS)
    helloTimer.unref()
    socket.once("message", (data, binary) => {
      clearTimeout(helloTimer)
      const hello = binary ? Option.none() : decodeHello(data.toString())
      if (Option.isNone(hello)) {
        socket.close(4400, "Expected Hearth's hello")
        return
      }
      adopted = true
      dial.inSession = true
      options.adopt(
        socket,
        {
          clientId,
          hearthNonce: hello.value.nonce,
          hearthOrigin: hearthOrigin(dial.url),
        },
        (socket as WebSocket & { _socket?: { remoteAddress?: string } })._socket
          ?.remoteAddress
      )
    })
    // Without a listener, a failed dial would throw.
    socket.on("error", () => undefined)
    socket.once("close", (code) => {
      clearTimeout(helloTimer)
      dial.inSession = false
      resume(Effect.succeed(adopted || code !== 1006 ? code : null))
    })
    return Effect.sync(() => {
      clearTimeout(helloTimer)
      socket.terminate()
    })
  })

// The Hearth origin a challenge names: the one the Relay dialed.
function hearthOrigin(url: string): string {
  const dialed = new URL(url)
  dialed.protocol = dialed.protocol === "wss:" ? "https:" : "http:"
  return dialed.origin
}
