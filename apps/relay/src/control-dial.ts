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

import { listenForDialWake } from "./dial-wake.js"
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
  /**
   * The local socket another process, such as `kiln-relay pair join`, opens
   * to have the Relay dial a Hearth it just saved (dial-wake.ts).
   */
  readonly wakePath?: string
}

export interface ControlDials {
  readonly close: () => Promise<void>
  /** Saves where a Hearth client asked to be dialed, or forgets it. */
  readonly save: (clientId: string, url: string | null) => void
  /** Where the Relay dials a Hearth client, as a WebSocket URL, if it does. */
  readonly urlFor: (clientId: string) => Promise<URL | null>
  /**
   * Dials any Hearth saved since the last pass now, without the spread a
   * pass gives new dials: one that just paired is waiting for it.
   */
  readonly wake: () => void
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
  // Whether the log says when it first reaches Hearth, as for a Relay that
  // just joined.
  announce: boolean
  fiber: Fiber.Fiber<void> | null
  // While a session it opened is open, which ends on its own once Hearth no
  // longer wants it.
  inSession: boolean
  readonly url: string
}

/**
 * Saves where to dial a Hearth client, as the Relay's dialer reads it: a
 * running Relay picks it up within its next pass, even when another
 * process, such as `kiln-relay pair join`, saved it, or at once when that
 * process wakes it (`ControlDials.wake`).
 */
export const saveControlDial = (
  state: RelayStateStore["Service"],
  clientId: string,
  url: string | null
) =>
  state.setMetadata(
    `${DIAL_METADATA_PREFIX}${clientId}`,
    url && relayDialUrl(url) ? url : ""
  )

export function startControlDials(options: ControlDialOptions): ControlDials {
  const dials = new Map<string, Dial>()
  let closed = false

  const reconcile = (woken: boolean) =>
    Effect.gen(function* () {
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
        const dial: Dial = {
          announce: woken,
          fiber: null,
          inSession: false,
          url,
        }
        dials.set(clientId, dial)
        dial.fiber = Effect.runFork(
          dialLoop(
            options,
            clientId,
            dial,
            () => dials.get(clientId) === dial,
            woken
          )
        )
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Couldn't read which Hearths to dial", cause)
      )
    )

  const reconcileFiber = Effect.runFork(
    reconcile(false).pipe(
      Effect.andThen(Effect.sleep(RECONCILE_INTERVAL_MS)),
      Effect.forever
    )
  )

  const wake = () => {
    if (!closed) Effect.runFork(reconcile(true))
  }
  // Listens for as long as the dialer runs.
  const wakeFiber = options.wakePath
    ? Effect.runFork(
        listenForDialWake(options.wakePath, wake).pipe(
          Effect.andThen(Effect.never),
          Effect.scoped,
          Effect.catch((error) =>
            Effect.logWarning(
              "Couldn't listen for joins finishing, so the Relay finds them within 15 seconds instead",
              error
            )
          )
        )
      )
    : null

  return {
    close: () =>
      Effect.runPromise(
        Effect.suspend(() => {
          closed = true
          const fibers = [
            reconcileFiber,
            ...(wakeFiber ? [wakeFiber] : []),
            ...[...dials.values()].flatMap((dial) =>
              dial.fiber ? [dial.fiber] : []
            ),
          ]
          dials.clear()
          return Fiber.interruptAll(fibers)
        })
      ),
    urlFor: (clientId) =>
      Effect.runPromise(
        options.state
          .getMetadata(`${DIAL_METADATA_PREFIX}${clientId}`)
          .pipe(Effect.map((saved) => (saved ? relayDialUrl(saved) : null)))
      ),
    save: (clientId, url) => {
      const key = `${DIAL_METADATA_PREFIX}${clientId}`
      const value = url && relayDialUrl(url) ? url : ""
      Effect.runFork(
        options.state.getMetadata(key).pipe(
          Effect.flatMap((saved) =>
            (saved ?? "") === value
              ? Effect.void
              : saveControlDial(options.state, clientId, value).pipe(
                  Effect.andThen(reconcile(false))
                )
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Couldn't save where to dial Hearth", cause)
          )
        )
      )
    },
    wake,
  }
}

// Dials one Hearth client for as long as it wants it, waiting longer
// between attempts the more of them fail.
const dialLoop = (
  options: ControlDialOptions,
  clientId: string,
  dial: Dial,
  wanted: () => boolean,
  woken: boolean
) =>
  Effect.gen(function* () {
    let failures = 0
    let refusals = 0
    // Whether the log already says Hearth can't be reached, once a streak.
    let reported = false
    const origin = hearthOrigin(dial.url)
    // Spread out, so Relays don't all arrive at once after Hearth restarts;
    // not one that was woken, which Hearth is waiting for.
    if (!woken) yield* Effect.sleep(Math.floor(Math.random() * 2_000))
    while (wanted()) {
      const startedAt = Date.now()
      const ended = yield* dialOnce(options, clientId, dial)
      if (!wanted()) return
      if (ended.reached) {
        if (reported) console.log(`Reached Hearth at ${origin} again.`)
        reported = false
      } else if (!reported) {
        reported = true
        console.log(
          `Couldn't reach Hearth at ${origin}: ${ended.error ?? "no answer"}. Trying again.`
        )
      }
      refusals =
        ended.code === relayDialCloseCodes.unknownRelay ? refusals + 1 : 0
      if (refusals === REFUSALS_BEFORE_WAITING) {
        console.log(
          `Hearth at ${origin} doesn't know this Relay. Trying again in a while.`
        )
      }
      if (Date.now() - startedAt >= STABLE_SESSION_MS) failures = 0
      failures += 1
      yield* Effect.sleep(retryDelay(ended.code, failures, refusals))
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

// One connection, from dialing to its close. Ends with how it closed (null
// when it never opened), whether Hearth answered, and why it couldn't be
// reached.
const dialOnce = (options: ControlDialOptions, clientId: string, dial: Dial) =>
  Effect.callback<{
    readonly code: number | null
    readonly error: string | null
    readonly reached: boolean
  }>((resume) => {
    let adopted = false
    let error: string | null = null
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
      if (dial.announce) {
        dial.announce = false
        console.log(`Connected to Hearth at ${hearthOrigin(dial.url)}.`)
      }
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
    socket.on("error", (cause) => {
      error ??= cause.message
    })
    socket.once("close", (code) => {
      clearTimeout(helloTimer)
      dial.inSession = false
      resume(
        Effect.succeed({
          code: adopted || code !== 1006 ? code : null,
          error,
          reached: adopted,
        })
      )
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
