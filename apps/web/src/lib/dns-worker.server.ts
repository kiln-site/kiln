import { Clock, Effect } from "effect"

import { nextAddressAttemptEffect } from "@/effect/addresses"
import { runAppEffect, runAppEffectUntraced } from "@/effect/runtime"
import {
  dueTunnelDnsEffect,
  nextTunnelDnsAttemptEffect,
} from "@/effect/tunnel-gateways"
import { startPollingWorker, type WorkerPass } from "@/lib/polling-worker"
import { rewriteTailscaleDns } from "@/lib/tunnel-dns.server"
import { startDurableOperation } from "@/operations/durable"
import { reconcileDueAddressesEffect } from "@/server/addresses.server"

/**
 * The DNS reconciler's schedule. It finishes DNS work requests left undone:
 * records Cloudflare refused or that a restart cut short, renames under
 * way, and deletes, from what MySQL holds; and a tunnel's hosts file on a
 * gateway that missed a change. Requests do the work themselves first; this
 * is how it's finished whatever happened to them. Each resource's attempt
 * is a DNS change in the lanes, like a request's, and each tunnel's a
 * rewrite in its `#settings`, so the two never interleave
 * (`dns-operations.ts`, `tunnel-dns.server.ts`).
 */
export function startDnsWorker(): void {
  startPollingWorker("Domains.dns", passDnsWorker)
}

async function passDnsWorker(): Promise<WorkerPass> {
  const [addressDue, tunnelDue] = await Promise.all([
    runAppEffectUntraced(nextAddressAttemptEffect()),
    runAppEffectUntraced(nextTunnelDnsAttemptEffect()),
  ])
  const due =
    addressDue === null
      ? tunnelDue
      : tunnelDue === null
        ? addressDue
        : Math.min(addressDue, tunnelDue)
  if (due === null || due > Date.now()) {
    return { outcome: "idle", nextAttemptAt: due }
  }
  await runAppEffect("Domains.dns.pass", reconcileDueDnsEffect)
  return { outcome: "worked" }
}

/** One pass over every instance's and tunnel's due DNS work. */
export const reconcileDueDnsEffect = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  yield* reconcileDueAddressesEffect(now)
  // A tunnel's rewrite runs as its own operation in its lanes; one already
  // started for this due time isn't started again.
  const tunnels = yield* dueTunnelDnsEffect(now)
  yield* Effect.forEach(
    tunnels,
    ({ due, tunnelId }) =>
      startDurableOperation(
        rewriteTailscaleDns,
        { alsoOn: [], networkIds: [tunnelId] },
        {
          idempotencyKey: `tunnel-dns:${tunnelId}:${due}`,
          initiator: "system",
        }
      ).pipe(Effect.ignore),
    { discard: true }
  )
})
