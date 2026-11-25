import { relayProxyDiagnosticsSchema } from "@workspace/contracts"
import { z } from "zod"

import { recoverPromise } from "@/effect/promise"
import type { PersistedRelay } from "@/lib/relay-registry"

/** What a Relay says of serving websites itself. */
export interface RelayWebCapability {
  /** Why it can't, when it's certain not to; null when it may. */
  readonly cant: string | null
  /** Whether another proxy than Kiln's serves them, which it can't check. */
  readonly elsewhere: boolean
}

const proxySchema = z.object({ diagnostics: relayProxyDiagnosticsSchema })

/**
 * Whether a Relay can serve websites as it's set up: what it's certain of,
 * and never whether the internet reaches it. One that can't be asked may.
 */
export async function relayWebCapability(
  relay: PersistedRelay
): Promise<RelayWebCapability> {
  const { relayRpc } = await import("@/lib/relay-connection")
  const diagnostics = await recoverPromise(
    async () =>
      proxySchema.parse(await relayRpc(relay, "relay.proxy.read", {}, 10_000))
        .diagnostics,
    () => null
  )
  if (diagnostics === null) return { cant: null, elsewhere: false }
  const { name } = relay
  switch (diagnostics.mode) {
    case "hearth":
      return {
        cant: `${name} has no web proxy, so it can't serve websites`,
        elsewhere: false,
      }
    case "traefik": {
      const taken = diagnostics.ports.find((port) => !port.available)
      return {
        cant: taken
          ? `Port ${taken.port} on ${name} is used by ${taken.owner ?? "something else"}, so it can't serve websites`
          : diagnostics.containerRunning
            ? null
            : `Traefik isn't running on ${name}, so it can't serve websites`,
        elsewhere: false,
      }
    }
    case "coolify":
      return {
        cant: diagnostics.containerRunning
          ? null
          : `${name} couldn't find Coolify's proxy, so it can't serve websites`,
        elsewhere: true,
      }
    case "none":
      return { cant: null, elsewhere: true }
  }
}
