import { connect } from "node:net"

import { relayWebReachResultSchema } from "@workspace/contracts"
import { Result } from "effect"

import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { relayWebCapability } from "@/lib/relay-web.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { relayPublicHostEffect } from "@/server/addresses.server"
import {
  assertRelayAddress,
  relayDestinationLookup,
} from "@/server/relay-join.server"
import { isPrivateAddress } from "@/server/relay-public-route.server"

const CONNECT_TIMEOUT_MS = 4_000
const WEB_PORTS = [80, 443] as const

/** Whether domains moved to a Relay would work there. */
export interface RelayWebServing {
  /** Where its names point, when it said. */
  readonly host: string | null
  /** What to know, when not simply that they would. */
  readonly reason: string | null
  /**
   * - `serves`: as far as anyone can tell from outside;
   * - `unchecked`: another proxy serves them, which Kiln can't ask;
   * - `unreachable`: nothing answers there from outside;
   * - `cant`: the Relay is certain not to, as it's set up, or couldn't be
   *   asked, which a moved name's record waits for too.
   */
  readonly state: "cant" | "serves" | "unchecked" | "unreachable"
}

/**
 * Whether websites on a Relay can be visited: as it's set up, and from
 * outside, as Hearth and then `beside`, usually on another network, reach
 * it. Hearth may share its network, which often can't reach its own public
 * address, so nothing is said to be unreachable on Hearth's word alone.
 */
export async function relayWebServing(
  relay: PersistedRelay,
  beside: PersistedRelay
): Promise<RelayWebServing> {
  const [{ answered, cant, elsewhere }, host] = await Promise.all([
    relayWebCapability(relay),
    recoverPromise(
      () => runAppEffect("relays.web.host", relayPublicHostEffect(relay.id)),
      () => null
    ),
  ])
  if (cant) return { host, reason: cant, state: "cant" }
  if (!answered) {
    return {
      host,
      reason: `${relay.name} couldn't be asked whether it can serve websites`,
      state: "cant",
    }
  }
  if (host === null) {
    return {
      host,
      reason: `${relay.name} hasn't said where it's reached`,
      state: "unchecked",
    }
  }
  if (isPrivateAddress(host)) {
    return {
      host,
      reason: `${host} is a private address: only its own network can visit`,
      state: "unreachable",
    }
  }
  if (!(await reachedFrom(host, beside))) {
    return {
      host,
      reason: `Nothing answered at ${host} on ports 80 and 443 from ${beside.name} or Hearth`,
      state: "unreachable",
    }
  }
  return elsewhere
    ? {
        host,
        reason: `${relay.name}'s websites are served by a proxy Kiln can't check`,
        state: "unchecked",
      }
    : { host, reason: null, state: "serves" }
}

async function reachedFrom(
  host: string,
  beside: PersistedRelay
): Promise<boolean> {
  const { relayRpc } = await import("@/lib/relay-connection")
  const asked = await Promise.all([
    Promise.all(WEB_PORTS.map((port) => opens(host, port))).then((ports) =>
      ports.every(Boolean)
    ),
    recoverPromise(
      async () =>
        relayWebReachResultSchema.parse(
          await relayRpc(beside, "relay.web.reach", { host }, 10_000)
        ).reached,
      () => false
    ),
  ])
  return asked.some(Boolean)
}

function opens(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const allowed = Result.try(() =>
      assertRelayAddress(host.replace(/^\[|\]$/gu, ""))
    )
    if (Result.isFailure(allowed)) {
      resolve(false)
      return
    }
    const socket = connect({ host, lookup: relayDestinationLookup, port })
    const done = (reached: boolean) => {
      socket.destroy()
      resolve(reached)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}
