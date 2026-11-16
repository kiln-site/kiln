import { Effect, Schema } from "effect"
import { Activity } from "effect/workflow"

import { tunnelSettingsKey } from "@/lib/tunnel-lanes"
import { durableOperation, startDurableOperation } from "@/operations/durable"
import { exclusive } from "@/operations/lanes"
import {
  pruneEmptyGateways,
  tunnelsWithEmptyGateways,
} from "@/server/tunnels.server"

// A gateway goes once nothing on its Relay is connected. Disconnecting takes
// it in the same save; deleting the last thing connected there leaves it
// behind on the Relay, so a deletion ends by pruning it here, in each
// tunnel's `#settings` like a save.

export class TunnelPruneError extends Schema.TaggedError<TunnelPruneError>()(
  "TunnelPruneError",
  { message: Schema.String }
) {}

export const pruneTunnelGateways = durableOperation({
  doing: () => "Removing gateways that connect nothing",
  error: TunnelPruneError,
  input: Schema.Struct({ networkIds: Schema.Array(Schema.String) }),
  kind: "tunnel.gateways.prune",
  locks: ({ networkIds }) =>
    networkIds.map((id) => exclusive(tunnelSettingsKey(id))),
  run: ({ networkIds }) =>
    Activity.make({
      name: "prune",
      error: TunnelPruneError,
      execute: Effect.tryPromise({
        try: async () => {
          for (const id of networkIds) await pruneEmptyGateways(id, "system")
        },
        catch: (cause) =>
          new TunnelPruneError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    }),
  version: 1,
})

/**
 * Inside a durable operation: prunes every tunnel's gateways that connect
 * nothing, and waits for it. A tunnel it can't prune now, such as one with
 * a Relay away, is pruned by its next save, so failing doesn't fail its
 * caller.
 */
export const pruneTunnelGatewaysAfter = (options: {
  readonly idempotencyKey: string
  readonly name: string
}) =>
  Effect.gen(function* () {
    const networkIds = yield* Activity.make({
      name: `${options.name}/networks`,
      success: Schema.Array(Schema.String),
      execute: Effect.tryPromise(() => tunnelsWithEmptyGateways()).pipe(
        Effect.catch(() => Effect.succeed([]))
      ),
    })
    if (networkIds.length === 0) return
    const operationId = yield* Activity.make({
      name: `${options.name}/start`,
      success: Schema.String,
      execute: startDurableOperation(
        pruneTunnelGateways,
        { networkIds },
        { idempotencyKey: options.idempotencyKey, initiator: "system" }
      ).pipe(Effect.orDie),
    })
    yield* pruneTunnelGateways.workflow
      .execute({ operationId })
      .pipe(Effect.catch(() => Effect.void))
  })
