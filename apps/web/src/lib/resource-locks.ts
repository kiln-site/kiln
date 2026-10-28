import { Effect, Semaphore } from "effect"

import type { HostnameOwner } from "@/effect/hostname-claims"

// Changing a game server's or app's DNS reads what Kiln holds for it and
// then changes Cloudflare records. One permit per resource keeps two such
// changes, to its web routes or its domains, from interleaving. Hearth runs
// one application process, so a process-local lock is enough. Never take a
// resource's lock while holding it.
const locks = new Map<string, Semaphore.Semaphore>()

export function withResourceLock<A, E, R>(
  resource: HostnameOwner,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  const key = `${resource.relayId}:${resource.resourceType}:${resource.resourceId}`
  let lock = locks.get(key)
  if (!lock) {
    lock = Semaphore.makeUnsafe(1)
    locks.set(key, lock)
  }
  return lock.withPermit(effect)
}
