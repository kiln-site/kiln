import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  databaseIdSchema,
  relayIdSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { z } from "zod"

import {
  canReadRelayNode,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import {
  instanceCapacity,
  relayAllocations,
} from "@/lib/resource-limits.server"
import { requireEligibleResourceUser } from "@/server/auth"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"

// What a node can still give one instance, for the limits editor of any
// kind of instance. Only people who may see the node's capacity get it.

const capacityInputSchema = z.strictObject({
  id: databaseIdSchema.or(appIdSchema),
  kind: z.enum(["app", "database"]),
  relayId: relayIdSchema,
})

export const getResourceLimitsCapacity = createServerFn({ method: "GET" })
  .validator(capacityInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission(
      data.kind === "database"
        ? {
            databaseId: data.id,
            permission: "database.read",
            relayId: relay.id,
            user,
          }
        : { appId: data.id, permission: "app.read", relayId: relay.id, user }
    )
    const grants = isPlatformAdmin(user)
      ? []
      : await listUserGrants(user.id, relay.id)
    if (!canReadRelayNode(user, relay.id, grants)) return null
    const snapshot = relaySnapshotSchema.parse(
      await databaseRpc(relay, "relay.snapshot", {}, 30_000)
    )
    const capacity = instanceCapacity(
      snapshot.node,
      await relayAllocations(relay, snapshot),
      { id: data.id, kind: data.kind }
    )
    if (!capacity) {
      throw new Error(
        data.kind === "database" ? "Database not found" : "App not found"
      )
    }
    return capacity
  })
