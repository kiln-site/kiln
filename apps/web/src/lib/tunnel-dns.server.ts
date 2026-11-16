import {
  appTailscaleMember,
  databaseTailscaleMember,
  instanceTailscaleMember,
  tunnelStatesSchema as gatewayStatesSchema,
  type TunnelState as GatewayState,
} from "@workspace/contracts"
import { Effect, Schema } from "effect"
import { Activity } from "effect/workflow"

import { recoverPromise } from "@/effect/promise"
import {
  markTunnelDnsPendingEffect,
  recordTunnelDnsEffect,
} from "@/effect/tunnel-gateways"
import { tunnelRelaysEffect } from "@/effect/tunnels"
import { runAppEffect } from "@/effect/runtime"
import { listTunnelNamesEffect, tunnelNameOf } from "@/effect/tunnel-names"
import { wakePollingWorker } from "@/lib/polling-worker"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay, listPersistedRelays } from "@/lib/relay-registry"
import { tunnelSettingsKey } from "@/lib/tunnel-lanes"
import { durableOperation, startDurableOperation } from "@/operations/durable"
import { exclusive } from "@/operations/lanes"

/**
 * tunnels' DNS (docs/relay-operations.md). Hearth writes every
 * node's records, each time from what the Relays hold now: the enabled
 * members of the nodes not being removed, leaving out those frozen for
 * their deletion. What writes them holds each network's `#settings`, so a
 * save and a rewrite go one after the other, and the last one read the
 * latest state.
 */

export class TailscaleDnsError extends Schema.TaggedError<TailscaleDnsError>()(
  "TailscaleDnsError",
  { message: Schema.String }
) {}

/**
 * Rewrites a network's DNS on every node of it from what those nodes hold
 * now. It asks only the Relays it names, the ones the network is on, and
 * each of them must answer, a paused one included: one left out would drop
 * its members' records. A Relay that's been removed took its node with it.
 * Run it holding the network's `#settings`; it returns only once every
 * write it sent has ended, so none outlives the lane.
 */
export async function writeTunnelDns(
  network: { readonly id: string; readonly relayIds: ReadonlyArray<string> },
  subject?: string
): Promise<void> {
  // Due until it's written, so the DNS worker finishes a write a failure or
  // a restart cut short.
  await runAppEffect(
    "tunnelDns.markPending",
    markTunnelDnsPendingEffect(network.id)
  )
  const relayIds = new Set(network.relayIds)
  const read = await recoverPromise(
    async () => {
      const relays = (await listPersistedRelays()).filter((relay) =>
        relayIds.has(relay.id)
      )
      const paused = relays.find((relay) => !relay.enabled)
      if (paused) throw new Error(`${paused.name} is paused`)
      return (
        await Promise.all(
          relays.map(async (relay) =>
            gatewayStatesSchema
              .parse(await relayRpc(relay, "tunnel.state", {}, 15_000))
              .filter(
                (stack) =>
                  stack.tailnetId === network.id && !stack.removalPending
              )
              .map((stack) => ({ relay, stack }))
          )
        )
      ).flat()
    },
    (cause) => ({ cause })
  )
  // Without every gateway's members, no file would be whole: none is sent.
  if ("cause" in read) {
    await runAppEffect(
      "tunnelDns.record",
      recordTunnelDnsEffect(network.id, {
        everyFailed: errorMessageOf(read.cause),
      })
    )
    wakePollingWorker("Domains.dns")
    throw read.cause
  }
  const nodes = read
  // Each name a member has in the tunnel, at the address it has on its
  // own Relay's tunnel.
  const names = await runAppEffect(
    "tunnelNames.list",
    listTunnelNamesEffect([network.id])
  )
  const namesOf = (memberId: string) =>
    names.filter((name) => name.memberId === memberId)
  const records = nodes.flatMap(({ stack }) =>
    stack.bindings.flatMap(({ address, enabled, frozen, memberId }) =>
      enabled && !frozen
        ? namesOf(memberId).map((name) => ({
            address,
            name: tunnelNameOf(name),
          }))
        : []
    )
  )
  const written = await Promise.allSettled(
    nodes.map(({ relay, stack }) =>
      relayRpc(relay, "tunnel.dns", { id: stack.id, records }, 60_000, subject)
    )
  )
  const failed = written.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            error: errorMessageOf(result.reason),
            id: nodes[index]!.stack.id,
            relayName: nodes[index]!.relay.name,
          },
        ]
      : []
  )
  await runAppEffect(
    "tunnelDns.record",
    recordTunnelDnsEffect(network.id, { failed })
  )
  if (failed.length > 0) {
    wakePollingWorker("Domains.dns")
    throw new Error(
      failed.map(({ error, relayName }) => `${relayName}: ${error}`).join("; ")
    )
  }
}

function errorMessageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The networks a resource is a member of, as its Relay holds them. */
export async function tunnelsOf(resource: {
  readonly id: string
  readonly kind: "app" | "database" | "instance" | "volume"
  readonly relayId: string
}): Promise<Array<string>> {
  if (resource.kind === "volume") return []
  const stacks = gatewayStatesSchema.parse(
    await relayRpc(
      await activeRelay(resource.relayId),
      "tunnel.state",
      {},
      15_000
    )
  )
  return stacks
    .filter((stack) =>
      stack.bindings.some(({ memberId }) => isMemberOf(resource, memberId))
    )
    .map(({ tailnetId }) => tailnetId)
    .sort()
}

function isMemberOf(
  resource: { readonly id: string; readonly kind: string },
  memberId: GatewayState["bindings"][number]["memberId"]
): boolean {
  switch (resource.kind) {
    case "app":
      return appTailscaleMember(memberId)?.appId === resource.id
    case "database":
      return databaseTailscaleMember(memberId) === resource.id
    case "instance":
      return instanceTailscaleMember(memberId) === resource.id
    default:
      return false
  }
}

/**
 * Rewrites the DNS of the networks it names, as Hearth's own work in their
 * `#settings`: queued behind a save of any of them, then run from what the
 * Relays hold once its turn comes. A resource's deletion and its keeping
 * wait for it, after the freeze and after letting it go.
 */
export const rewriteTailscaleDns = durableOperation({
  doing: () => "Updating Tailscale DNS",
  error: TailscaleDnsError,
  input: Schema.Struct({
    networkIds: Schema.Array(Schema.String),
    // Relays known to be on the networks besides those Hearth recorded,
    // such as the one a deleted resource's member is on.
    alsoOn: Schema.Array(Schema.String),
  }),
  kind: "tunnel.dns",
  locks: ({ networkIds }) =>
    networkIds.map((id) => exclusive(tunnelSettingsKey(id))),
  run: ({ alsoOn, networkIds }) =>
    Activity.make({
      name: "rewrite",
      error: TailscaleDnsError,
      execute: Effect.gen(function* () {
        // The Relays each network is on, as Hearth recorded them when it
        // last saved it, read once its turn has come.
        const deployed = yield* tunnelRelaysEffect(networkIds)
        yield* Effect.tryPromise({
          try: async () => {
            for (const id of networkIds) {
              await writeTunnelDns({
                id,
                relayIds: [...(deployed.get(id) ?? []), ...alsoOn],
              })
            }
          },
          catch: (cause) =>
            new TailscaleDnsError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        })
      }).pipe(
        Effect.catchTag("DatabaseError", (cause) =>
          Effect.fail(new TailscaleDnsError({ message: cause.message }))
        )
      ),
    }),
  version: 1,
})

/**
 * Inside a durable operation: rewrites the DNS of the networks a resource
 * is a member of now, and waits for it to succeed. The rewrite takes its own
 * lanes, which its caller doesn't hold; its ID is kept in the caller's
 * journal under `name`, so a run that resumes waits on the same one.
 */
export const rewriteTailscaleDnsOf = (
  resource: Parameters<typeof tunnelsOf>[0],
  options: { readonly idempotencyKey: string; readonly name: string }
) =>
  Effect.gen(function* () {
    const networkIds = yield* Activity.make({
      name: `${options.name}/networks`,
      success: Schema.Array(Schema.String),
      error: TailscaleDnsError,
      execute: Effect.tryPromise({
        try: () => tunnelsOf(resource),
        catch: (cause) =>
          new TailscaleDnsError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    })
    if (networkIds.length === 0) return
    const operationId = yield* Activity.make({
      name: `${options.name}/start`,
      success: Schema.String,
      execute: startDurableOperation(
        rewriteTailscaleDns,
        { alsoOn: [resource.relayId], networkIds },
        { idempotencyKey: options.idempotencyKey, initiator: "system" }
      ).pipe(Effect.orDie),
    })
    yield* rewriteTailscaleDns.workflow.execute({ operationId })
  })
