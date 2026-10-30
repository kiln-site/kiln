import type { Effect } from "effect"

import type { HostnameOwner } from "@/effect/hostname-claims"
import { serialized } from "@/operations/serialized"

// Changing a game server's or app's DNS reads what Kiln holds for it and
// then changes Cloudflare records. Each change holds the resource's DNS, so
// two changes to its web routes or domains never interleave. A change that
// spans two resources takes both at once. Never start one while running
// another on the same resource: it would wait for itself.

const dnsKey = (owner: HostnameOwner) =>
  `dns:${owner.resourceType}:${owner.relayId}/${owner.resourceId}`

/** Runs `effect` as the DNS change `kind` on `owners`, one at a time. */
export function withDnsChange<A, E, R>(
  kind: string,
  owners: HostnameOwner | ReadonlyArray<HostnameOwner>,
  effect: Effect.Effect<A, E, R>
) {
  const resources = Array.isArray(owners)
    ? (owners as ReadonlyArray<HostnameOwner>)
    : [owners as HostnameOwner]
  return serialized(kind, resources.map(dnsKey), effect)
}
