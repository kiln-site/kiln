import { createServerFn } from "@tanstack/react-start"
import {
  relayHostAccessSchema,
  relayHostTerminalClaimSchema,
  relayHostTerminalWriteSchema,
  relayIdSchema,
  relayInstanceResourcesSchema,
  relayResourceHistoryMaxSamples,
  relayResourcesV1Feature,
  relayRestartV1Feature,
} from "@workspace/contracts"
import { z } from "zod"

import type { PersistedRelay } from "@/lib/relay-registry"
import { databaseRpc } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const targetSchema = z.object({ relayId: relayIdSchema })

export const getRelayHostAccess = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    return relayHostAccessSchema.parse(
      await databaseRpc(relay, "relay.host.read", {}, 15_000)
    )
  })

export const mountRelayHostFiles = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.files.mount"
    )
    await databaseRpc(relay, "relay.host.files.mount", {}, 60_000, user.id)
    return { started: true }
  })

export const writeRelayTerminal = createServerFn({ method: "POST" })
  .validator(relayHostTerminalWriteSchema.extend(targetSchema.shape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { relay, user } = await authorizedRelay(relayId, "relay.terminal")
    await databaseRpc(relay, "relay.terminal.write", input, 15_000, user.id)
    return { accepted: true }
  })

export const claimRelayTerminal = createServerFn({ method: "POST" })
  .validator(relayHostTerminalClaimSchema.extend(targetSchema.shape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { relay, user } = await authorizedRelay(relayId, "relay.terminal")
    return z
      .object({ seq: z.number().int().nonnegative() })
      .parse(
        await databaseRpc(relay, "relay.terminal.claim", input, 15_000, user.id)
      )
  })

export const restartRelayTerminal = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.terminal"
    )
    await databaseRpc(relay, "relay.terminal.restart", {}, 30_000, user.id)
    return { restarted: true }
  })

// Requires `relay.update`, as updating already restarts the Relay. Game
// servers, apps, and databases keep running.
export const restartRelay = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(data.relayId, "relay.update")
    await requireRelayRestart(relay)
    await databaseRpc(relay, "relay.restart", {}, 30_000, user.id)
    return { restarting: true }
  })

// Requires `relay.terminal`, as a root shell on the host could reboot it
// anyway, and the account password, as it takes down everything on the host.
export const restartRelayHost = createServerFn({ method: "POST" })
  .validator(targetSchema.extend({ password: z.string().max(128) }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.terminal"
    )
    const { requireAccountPassword } = await import("@/lib/auth-password")
    await requireAccountPassword(user, data.password)
    await requireRelayRestart(relay)
    await databaseRpc(relay, "relay.host.restart", {}, 120_000, user.id)
    return { restarting: true }
  })

async function requireRelayRestart(relay: PersistedRelay): Promise<void> {
  const { isRelayUpdating, relayConnectionFeatures } =
    await import("@/lib/relay-connection")
  if (!relayConnectionFeatures(relay.id).has(relayRestartV1Feature)) {
    throw new Error("Update this Relay to restart it from Hearth.")
  }
  // A restart could interrupt the update replacing the Relay.
  if (isRelayUpdating(relay.id)) {
    throw new Error("Wait for this Relay's update to finish.")
  }
}

// The Relay's latest sample of its own usage, from the node this process's
// control socket last received: no Relay round trip, so the Relay's meters
// can poll it.
export const getRelayResources = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    await authorizedRelay(data.relayId, "relay.read")
    const { relayConnectionFeatures, relayConnectionNode } =
      await import("@/lib/relay-connection")
    const node = relayConnectionNode(data.relayId)
    return {
      resources: node?.relayResources ?? null,
      startedAt: node?.startedAt ?? null,
      supported: relayConnectionFeatures(data.relayId).has(
        relayResourcesV1Feature
      ),
    }
  })

// Recent samples, to fill the meters' history when they open.
export const getRelayResourceHistory = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    const { relayConnectionFeatures } = await import("@/lib/relay-connection")
    if (!relayConnectionFeatures(relay.id).has(relayResourcesV1Feature)) {
      return []
    }
    return relayResourceHistorySchema.parse(
      await databaseRpc(relay, "relay.resources.read", {}, 15_000)
    ).history
  })

const relayResourceHistorySchema = z.object({
  history: z
    .array(relayInstanceResourcesSchema)
    .max(relayResourceHistoryMaxSamples),
})
