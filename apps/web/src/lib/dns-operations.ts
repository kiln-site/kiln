import type { Effect } from "effect"

import type { HostnameOwner } from "@/effect/hostname-claims"
import { exclusive, partKey, resourceKey } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"

// Changing a game server's or app's DNS reads what Kiln holds for it and
// then changes Cloudflare records. Each change holds the resource's DNS,
// and the resource shared, so two changes to its web routes or domains
// never interleave, and deleting it waits for them or turns them away. A
// change that spans two resources takes both at once.

/** The lane key of a game server's or App's DNS. */
export const dnsKey = (owner: HostnameOwner) =>
  partKey(
    resourceKey(owner.resourceType, owner.relayId, owner.resourceId),
    "dns"
  )

/** Runs `effect` as the DNS change `kind` on `owners`, one at a time. */
export function withDnsChange<A, E, R>(
  kind: string,
  owners: HostnameOwner | ReadonlyArray<HostnameOwner>,
  effect: Effect.Effect<A, E, R>
) {
  const resources = Array.isArray(owners)
    ? (owners as ReadonlyArray<HostnameOwner>)
    : [owners as HostnameOwner]
  return inLanes(
    kind,
    "Changing its DNS records",
    resources.map((owner) => exclusive(dnsKey(owner))),
    effect
  )
}
