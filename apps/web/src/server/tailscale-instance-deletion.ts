import {
  relaySnapshotSchema,
  relayTailscaleStackSchema,
  relayTailscaleStacksSchema,
} from "@workspace/contracts"
import type { RelayControlOperation } from "@workspace/contracts"

import type { RelayEndpoint } from "@/lib/relay-control-endpoint"
import { listPersistedRelays } from "@/lib/relay-registry"
import { tapPromiseError } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  synchronizeInstanceDeletionDnsEffect,
  type TailscaleDeploymentOperations,
  type TailscaleDeploymentState,
} from "@/server/tailscale-orchestration"

type TailscaleDeletionDeployment = TailscaleDeploymentState

type RelayRpc = (
  relay: RelayEndpoint,
  operation: RelayControlOperation,
  payload: unknown,
  timeoutMs?: number
) => Promise<unknown>

export async function synchronizeTailscaleInstanceDeletion(
  input: {
    // The game server, App service, or database being deleted.
    memberId: string
    mode: "prepare" | "rollback"
    relayId: string
    stackIds: ReadonlyArray<string>
  },
  relayRpc: RelayRpc,
  signal?: AbortSignal
): Promise<void> {
  throwIfTailscalePrepareCancelled(input.mode, signal)
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const relayById = new Map(relays.map((relay) => [relay.id, relay]))
  if (!relayById.has(input.relayId)) {
    throw new Error("The deleting server's Relay is unavailable")
  }

  const results = await tapPromiseError(
    () =>
      Promise.all(
        relays.map(async (relay) => {
          const snapshot = relaySnapshotSchema.parse(
            await relayRpc(relay, "relay.snapshot", {}, 5_000)
          )
          if (!snapshot.node.capabilities.includes("tailscale-stacks"))
            return []
          return relayTailscaleStacksSchema
            .parse(
              await relayRpc(relay, "relay.tailscale.stack.list", {}, 5_000)
            )
            .map<TailscaleDeletionDeployment>((deployment) => ({
              ...deployment,
              relayId: relay.id,
              relayName: relay.name,
            }))
        })
      ),
    (cause) => {
      throw new Error(
        `Could not inspect every Relay before deleting the server: ${
          cause instanceof Error ? cause.message : "unknown Relay error"
        }`,
        { cause }
      )
    }
  )
  throwIfTailscalePrepareCancelled(input.mode, signal)
  const current = results.flat()
  const operations: Pick<
    TailscaleDeploymentOperations<TailscaleDeletionDeployment>,
    "syncDns"
  > = {
    syncDns: async (deployment, records) => {
      throwIfTailscalePrepareCancelled(input.mode, signal)
      const relay = relayById.get(deployment.relayId)
      if (!relay) throw new Error("The network's Relay is unavailable")
      const synchronized = relayTailscaleStackSchema.parse(
        await relayRpc(
          relay,
          "relay.tailscale.stack.dns",
          { id: deployment.id, records },
          60_000
        )
      )
      return {
        ...synchronized,
        relayId: relay.id,
        relayName: relay.name,
      }
    },
  }

  await runAppEffect(
    "tailscale.instanceDeletion.synchronizeDns",
    synchronizeInstanceDeletionDnsEffect({
      current,
      memberId: input.memberId,
      mode: input.mode,
      operations,
      relayId: input.relayId,
      signal,
      stackIds: input.stackIds,
    })
  )
}

function throwIfTailscalePrepareCancelled(
  mode: "prepare" | "rollback",
  signal?: AbortSignal
): void {
  if (mode === "prepare" && signal?.aborted) {
    throw new Error("Tailscale DNS preparation was cancelled")
  }
}
