import { logException } from "@workspace/telemetry"
import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { activeRelay } from "@/lib/relay-registry"

/**
 * Has a Relay ask for the certificates of names whose records now point at
 * it. Those it can't be told of are left to whoever sees one missing, which
 * never undoes what points there already.
 */
export const releaseWebCertificatesEffect = Effect.fnUntraced(
  function* (relayId: string, hostnames: ReadonlyArray<string>) {
    if (hostnames.length === 0) return
    yield* promiseEffect(async () => {
      const { relayRpc } = await import("@/lib/relay-connection")
      await relayRpc(
        await activeRelay(relayId),
        "relay.certificates.release",
        { hostnames },
        10_000
      )
    }).pipe(Effect.retry({ times: 1 }))
  },
  (effect, relayId) =>
    effect.pipe(
      Effect.catch((cause) =>
        logException(cause, {
          attributes: { "relay.id": relayId },
          operation: "webCertificates.release",
        })
      )
    )
)
