import { randomBytes } from "node:crypto"
import { createServerFn } from "@tanstack/react-start"
import {
  relayIdSchema,
  relayVolumeIdSchema,
  relayVolumeNameSchema,
  relayVolumeSchema,
  relayVolumesSchema,
  relayVolumesV1Feature,
} from "@workspace/contracts"
import { z } from "zod"

import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { databaseRpc } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const targetSchema = z.object({ relayId: relayIdSchema })
const volumeSchema = targetSchema.extend({ volumeId: relayVolumeIdSchema })

// A Relay's Docker named volumes, with what mounts each. Docker measures
// every volume for their sizes, so this can take a while.
export const getRelayVolumes = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    const { relayConnectionFeatures } = await import("@/lib/relay-connection")
    const features = relayConnectionFeatures(relay.id)
    // An offline Relay has no features yet; asking it says why.
    if (features.size > 0 && !features.has(relayVolumesV1Feature)) {
      return { supported: false, volumes: [] }
    }
    const { volumes } = relayVolumesSchema.parse(
      await databaseRpc(relay, "relay.volumes.read", {}, 75_000)
    )
    return { supported: true, volumes }
  })

export const createRelayVolume = createServerFn({ method: "POST" })
  .validator(targetSchema.extend({ name: relayVolumeNameSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.configure"
    )
    const volume = relayVolumeSchema.parse(
      await databaseRpc(
        relay,
        "relay.volumes.create",
        { id: randomBytes(20).toString("hex"), name: data.name },
        30_000,
        user.id
      )
    )
    publishRelayVolumesChange(relay.id)
    return volume
  })

export const renameRelayVolume = createServerFn({ method: "POST" })
  .validator(volumeSchema.extend({ name: relayVolumeNameSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.configure"
    )
    await databaseRpc(
      relay,
      "relay.volumes.rename",
      { id: data.volumeId, name: data.name },
      30_000,
      user.id
    )
    publishRelayVolumesChange(relay.id)
    return { renamed: true }
  })

export const deleteRelayVolume = createServerFn({ method: "POST" })
  .validator(volumeSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.configure"
    )
    await databaseRpc(
      relay,
      "relay.volumes.delete",
      { id: data.volumeId },
      30_000,
      user.id
    )
    publishRelayVolumesChange(relay.id)
    return { deleted: true }
  })

function publishRelayVolumesChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["relay-volumes"],
    type: "hearth.invalidate",
  })
}
