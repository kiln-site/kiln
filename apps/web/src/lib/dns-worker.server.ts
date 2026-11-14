import { Clock, Effect } from "effect"

import { nextAddressAttemptEffect } from "@/effect/addresses"
import { runAppEffect, runAppEffectUntraced } from "@/effect/runtime"
import { startPollingWorker, type WorkerPass } from "@/lib/polling-worker"
import { reconcileDueAddressesEffect } from "@/server/addresses.server"

/**
 * The DNS reconciler's schedule. It finishes DNS work requests left undone:
 * records Cloudflare refused or that a restart cut short, renames under
 * way, and deletes, from what MySQL holds. Requests do the work themselves
 * first; this is how it's finished whatever happened to them. Each
 * resource's attempt is a DNS change in the lanes, like a request's, so the
 * two never interleave (`dns-operations.ts`).
 */
export function startDnsWorker(): void {
  startPollingWorker("Domains.dns", passDnsWorker)
}

async function passDnsWorker(): Promise<WorkerPass> {
  const due = await runAppEffectUntraced(nextAddressAttemptEffect())
  if (due === null || due > Date.now()) {
    return { outcome: "idle", nextAttemptAt: due }
  }
  await runAppEffect("Domains.dns.pass", reconcileDueDnsEffect)
  return { outcome: "worked" }
}

/** One pass over every instance's due DNS work. */
export const reconcileDueDnsEffect = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  yield* reconcileDueAddressesEffect(now)
})
