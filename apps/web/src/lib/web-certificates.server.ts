import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { activeRelay } from "@/lib/relay-registry"

/**
 * Has a Relay ask for the certificates of names whose records now point at
 * it. Told again, it only asks again for those still missing.
 */
export const releaseWebCertificatesEffect = Effect.fnUntraced(function* (
  relayId: string,
  hostnames: ReadonlyArray<string>
) {
  if (hostnames.length === 0) return
  yield* promiseEffect(async () => {
    const { relayRpc } = await import("@/lib/relay-connection")
    await relayRpc(
      await activeRelay(relayId),
      "relay.certificates.release",
      { hostnames },
      10_000
    )
  })
})
