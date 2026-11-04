import { randomBytes } from "node:crypto"
import { BlockList, isIP } from "node:net"

import {
  RELAY_PROXY_TRIAL_PATH,
  relayProxyTrialResultSchema,
  type RelayProxyTrialInput,
} from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import { relayRpc } from "@/lib/relay-connection"
import { publishRelayProxyChange } from "@/lib/relay-proxy-realtime.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { readRelayRoute } from "@/lib/relay-route-read.server"
import { outsideOperation } from "@/operations/current"
import { exclusive, partKey, relayKey } from "@/operations/lanes"
import { operation, runOperation } from "@/operations/operation"

// A Relay added connecting to Hearth stays reachable the whole time this
// runs: its route is only proven beside what it already has, and it moves
// once, restarting, when there's nothing left to go wrong. See
// docs/self-hosting.md.

// Traefik was just started, so this covers it coming up.
const PLAIN_ROUTE_WAIT_MS = 15_000
// Let's Encrypt usually takes seconds; the Relay gives up on the trial after
// five minutes.
const CERTIFICATE_WAIT_MS = 180_000
const READ_INTERVAL = "2 seconds"

export type RelayPublicRouteOutcome =
  | { readonly status: "direct" }
  | { readonly reason: string; readonly status: "through-hearth" }

const throughHearth = (reason: string): RelayPublicRouteOutcome => ({
  reason,
  status: "through-hearth",
})

// Addresses Let's Encrypt can't check, so looking would only open ports.
const privateAddresses = (() => {
  const list = new BlockList()
  list.addSubnet("10.0.0.0", 8, "ipv4")
  list.addSubnet("100.64.0.0", 10, "ipv4")
  list.addSubnet("127.0.0.0", 8, "ipv4")
  list.addSubnet("172.16.0.0", 12, "ipv4")
  list.addSubnet("192.168.0.0", 16, "ipv4")
  list.addSubnet("fc00::", 7, "ipv6")
  list.addAddress("::1", "ipv6")
  return list
})()

function isPrivateAddress(host: string): boolean {
  const family = isIP(host)
  return (
    family !== 0 && privateAddresses.check(host, family === 6 ? "ipv6" : "ipv4")
  )
}

const answersWithin = Effect.fnUntraced(function* (
  url: URL,
  answer: string,
  waitMs: number
) {
  const deadline = (yield* Clock.currentTimeMillis) + waitMs
  while (true) {
    if ((yield* promiseEffect(() => readRelayRoute(url))) === answer) {
      return true
    }
    if ((yield* Clock.currentTimeMillis) >= deadline) return false
    yield* Effect.sleep(READ_INTERVAL)
  }
})

function publicAddress(relay: PersistedRelay): string {
  return isIP(relay.hostname) === 6 ? `[${relay.hostname}]` : relay.hostname
}

/**
 * Tries a Hearth-mode Relay's public route and moves the Relay to it if it
 * works from outside, end to end. `automatic` asks only of a Relay installed
 * to look for one. However it ends short of that, the Relay carries on as it
 * was.
 */
export const tryRelayPublicRoute = Effect.fn("relayPublicRoute.try")(function* (
  relay: PersistedRelay,
  input: { readonly automatic: boolean; readonly subject?: string }
) {
  yield* Effect.annotateCurrentSpan({
    "relay.id": relay.id,
    "relay_public_route.automatic": input.automatic,
  })
  if (isPrivateAddress(relay.hostname)) {
    return throughHearth(
      `${relay.hostname} is a private address, which the internet can't reach.`
    )
  }
  const secret = () => randomBytes(32).toString("base64url")
  const id = secret()
  const answer = secret()
  const path = `${RELAY_PROXY_TRIAL_PATH}/${id}`
  const address = publicAddress(relay)
  const step = (payload: RelayProxyTrialInput) =>
    promiseEffect(() =>
      relayRpc(relay, "relay.proxy.trial", payload, 240_000, input.subject)
    ).pipe(
      Effect.map((result) => relayProxyTrialResultSchema.parse(result).problem)
    )

  const started = yield* step({
    answer,
    automatic: input.automatic,
    id,
    step: "start",
  })
  if (started) return throughHearth(started)

  let committed = false
  return yield* Effect.gen(function* () {
    const plain = new URL(path, `http://${address}`)
    if (!(yield* answersWithin(plain, answer, PLAIN_ROUTE_WAIT_MS))) {
      return throughHearth(`Port 80 at ${address} doesn't lead to this Relay.`)
    }
    const certificate = yield* step({ id, step: "certificate" })
    if (certificate) return throughHearth(certificate)
    const secure = new URL(path, `https://${address}`)
    if (!(yield* answersWithin(secure, answer, CERTIFICATE_WAIT_MS))) {
      return throughHearth(
        `HTTPS at ${address} isn't working: Let's Encrypt gave no certificate, or port 443 doesn't lead to this Relay.`
      )
    }
    const commit = yield* step({ id, step: "commit" })
    if (commit) return throughHearth(commit)
    committed = true
    return { status: "direct" } satisfies RelayPublicRouteOutcome
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        committed
          ? Effect.void
          : step({ id, step: "stop" }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "Couldn't end the Relay's public route trial; it ends by itself",
                  cause
                )
              )
            )
      )
    )
  )
})

// Hearth's own check of a Relay just added. Nothing waits on it: a person
// sees the Relay's proxy change, or can ask again from its page.
const checkAddedRelay = operation<string>()({
  name: "relay.publicRoute.added",
  doing: "Checking this Relay's public route",
  authorize: ({ input }) =>
    promiseEffect(async () => {
      const { activeRelay } = await import("@/lib/relay-registry")
      return { relay: await activeRelay(input) }
    }),
  locks: ({ input }) => [exclusive(partKey(relayKey(input), "proxy"))],
  run: ({ context: { relay } }) =>
    tryRelayPublicRoute(relay, { automatic: true }),
  audit: ({ input }) => ({ id: input, kind: "relay", relayId: input }),
  publish: ({ input }) => publishRelayProxyChange(input),
})

/** Looks for a public route for a Relay just added, in the background. */
export function checkAddedRelayPublicRoute(relayId: string): void {
  outsideOperation(() =>
    forkAppWorker(
      runOperation(checkAddedRelay, relayId, { user: null }).pipe(
        Effect.tap((outcome) =>
          Effect.logInfo(
            outcome.status === "direct"
              ? "The Relay moved to its public route"
              : `The Relay stays connected through Hearth: ${outcome.reason}`
          )
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Couldn't check the Relay's public route", cause)
        ),
        Effect.withSpan("relayPublicRoute.added", { root: true })
      )
    )
  )
}
