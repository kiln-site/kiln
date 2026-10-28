import { exclusive, shared, type LaneLock } from "@workspace/operations"
import type { Effect } from "effect"

import type { HostnameOwner } from "@/effect/hostname-claims"
import { quickOperation, runOperation } from "@/operations/run"

// Changing a game server's or app's DNS reads what Kiln holds for it and
// then changes Cloudflare records. Each change is an operation in Hearth's
// lanes that holds the resource's DNS exclusively and the resource itself
// shared, so two changes to its web routes or domains never interleave, and
// work on the whole resource, such as a move, waits for them. A change that
// spans two resources, as a move's hand-over does, takes both at once.
// Never start one while running another on the same resource: it would wait
// for itself.

export const dnsLocks = (owner: HostnameOwner): Array<LaneLock> => {
  const whole = `${owner.resourceType}:${owner.relayId}/${owner.resourceId}`
  return [shared(whole), exclusive(`${whole}/dns`)]
}

const kinds = new Map<
  string,
  ReturnType<typeof quickOperation<ReadonlyArray<HostnameOwner>>>
>()

/** Runs `effect` as the DNS change `kind` on `owners`, in their lanes. */
export function withDnsChange<A, E, R>(
  kind: string,
  owners: HostnameOwner | ReadonlyArray<HostnameOwner>,
  effect: Effect.Effect<A, E, R>
) {
  let operation = kinds.get(kind)
  if (!operation) {
    operation = quickOperation<ReadonlyArray<HostnameOwner>>({
      kind,
      locks: (resources) => resources.flatMap(dnsLocks),
      version: 1,
    })
    kinds.set(kind, operation)
  }
  const resources = Array.isArray(owners)
    ? (owners as ReadonlyArray<HostnameOwner>)
    : [owners as HostnameOwner]
  // Only who it's for: a hostname row carries more than the lanes need.
  return runOperation(
    operation,
    resources.map(({ relayId, resourceId, resourceType }) => ({
      relayId,
      resourceId,
      resourceType,
    })),
    effect
  )
}
