import {
  appTailscaleMember,
  databaseTailscaleMember,
  instanceTailscaleMember,
  relayTailscaleStackStatesSchema,
  type RelayTailscaleStackState,
} from "@workspace/contracts"
import { Effect, Schema } from "effect"
import { Activity } from "effect/workflow"

import { relayRpc } from "@/lib/relay-connection"
import { activeRelay, listPersistedRelays } from "@/lib/relay-registry"
import { tailscaleNetworkSettingsKey } from "@/lib/tailscale-lanes"
import { durableOperation, startDurableOperation } from "@/operations/durable"
import { exclusive } from "@/operations/lanes"

/**
 * Tailscale networks' DNS (docs/relay-operations.md). Hearth writes every
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
 * Rewrites the DNS of each network on every node of it from what each
 * Relay holds now. Every enabled Relay must answer, since one left out
 * would drop its members' records. Run it holding the networks'
 * `#settings`.
 */
export async function writeTailscaleNetworkDns(
  networkIds: ReadonlyArray<string>,
  subject?: string
): Promise<void> {
  if (networkIds.length === 0) return
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const held = await Promise.all(
    relays.map(async (relay) => ({
      relay,
      stacks: relayTailscaleStackStatesSchema.parse(
        await relayRpc(relay, "relay.tailscale.stack.state", {}, 15_000)
      ),
    }))
  )
  for (const id of networkIds) {
    const nodes = held.flatMap(({ relay, stacks }) =>
      stacks
        .filter((stack) => stack.id === id && !stack.removalPending)
        .map((stack) => ({ relay, stack }))
    )
    const records = nodes.flatMap(({ stack }) =>
      stack.bindings.flatMap(({ address, enabled, frozen, hostname }) =>
        enabled && !frozen ? [{ address, hostname }] : []
      )
    )
    await Promise.all(
      nodes.map(({ relay }) =>
        relayRpc(
          relay,
          "relay.tailscale.stack.dns",
          { id, records },
          60_000,
          subject
        )
      )
    )
  }
}

/** The networks a resource is a member of, as its Relay holds them. */
export async function tailscaleNetworksOf(resource: {
  readonly id: string
  readonly kind: "app" | "database" | "instance" | "volume"
  readonly relayId: string
}): Promise<Array<string>> {
  if (resource.kind === "volume") return []
  const stacks = relayTailscaleStackStatesSchema.parse(
    await relayRpc(
      await activeRelay(resource.relayId),
      "relay.tailscale.stack.state",
      {},
      15_000
    )
  )
  return stacks
    .filter((stack) =>
      stack.bindings.some(({ memberId }) => isMemberOf(resource, memberId))
    )
    .map(({ id }) => id)
    .sort()
}

function isMemberOf(
  resource: { readonly id: string; readonly kind: string },
  memberId: RelayTailscaleStackState["bindings"][number]["memberId"]
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
  input: Schema.Struct({ networkIds: Schema.Array(Schema.String) }),
  kind: "tailscale.network.dns",
  locks: ({ networkIds }) =>
    networkIds.map((id) => exclusive(tailscaleNetworkSettingsKey(id))),
  run: ({ networkIds }) =>
    Activity.make({
      name: "rewrite",
      error: TailscaleDnsError,
      execute: Effect.tryPromise({
        try: () => writeTailscaleNetworkDns(networkIds),
        catch: (cause) =>
          new TailscaleDnsError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
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
  resource: Parameters<typeof tailscaleNetworksOf>[0],
  options: { readonly idempotencyKey: string; readonly name: string }
) =>
  Effect.gen(function* () {
    const networkIds = yield* Activity.make({
      name: `${options.name}/networks`,
      success: Schema.Array(Schema.String),
      error: TailscaleDnsError,
      execute: Effect.tryPromise({
        try: () => tailscaleNetworksOf(resource),
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
        { networkIds },
        { idempotencyKey: options.idempotencyKey, initiator: "system" }
      ).pipe(Effect.orDie),
    })
    yield* rewriteTailscaleDns.workflow.execute({ operationId })
  })
