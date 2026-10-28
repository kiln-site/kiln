import { Clock, Effect } from "effect"

import { nextInstanceDomainAttemptEffect } from "@/effect/domains"
import { runAppEffect, runAppEffectUntraced } from "@/effect/runtime"
import { nextWebHostnameAttemptEffect } from "@/effect/web-hostnames"
import { startPollingWorker, type WorkerPass } from "@/lib/polling-worker"
import { reconcileDueInstanceDomainsEffect } from "@/server/domains.server"
import { reconcileDueWebHostnamesEffect } from "@/server/web-hostnames.server"

/**
 * The DNS reconciler's schedule. It finishes DNS work requests left undone:
 * records Cloudflare refused or that a restart cut short, renames under
 * way, and deletes, from what MySQL holds. Requests do the work themselves
 * first; this is how it's finished whatever happened to them. Each
 * resource's attempt is a DNS change in Hearth's operation lanes, like a
 * request's, so the two never interleave (`dns-operations.ts`).
 */
export function startDnsWorker(): void {
  startPollingWorker("Domains.dns", passDnsWorker)
}

async function passDnsWorker(): Promise<WorkerPass> {
  const due = await runAppEffectUntraced(nextDnsAttemptEffect)
  if (due === null || due > Date.now()) {
    return { outcome: "idle", nextAttemptAt: due }
  }
  await runAppEffect("Domains.dns.pass", reconcileDueDnsEffect)
  return { outcome: "worked" }
}

const nextDnsAttemptEffect = Effect.all([
  nextWebHostnameAttemptEffect(),
  nextInstanceDomainAttemptEffect(),
]).pipe(
  Effect.map((attempts) => {
    const due = attempts.filter((attempt) => attempt !== null)
    return due.length > 0 ? Math.min(...due) : null
  })
)

/** One pass over every game server's and app's due DNS work. */
export const reconcileDueDnsEffect = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  yield* reconcileDueWebHostnamesEffect(now)
  yield* reconcileDueInstanceDomainsEffect(now)
})
