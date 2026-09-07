import {
  relayIdSchema,
  relayInstanceSchema,
  relayNodeSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { hearthRealtimeTopicSchema } from "@/lib/hearth-realtime-topics"

export const fleetInstanceSchema = relayInstanceSchema.extend({
  relayId: relayIdSchema,
  relayName: z.string().min(1),
  relayStatus: z.enum(["connected", "unreachable"]),
  routeId: z.string().min(1),
})

export const fleetNodeSchema = relayNodeSchema.extend({
  relayId: relayIdSchema,
  relayName: z.string().min(1),
  relayStatus: z.enum(["connected", "unreachable"]),
})

const sequencedEventSchema = z.object({
  epoch: z.uuid(),
  sequence: z.number().int().positive(),
})

const hearthScopeSchema = z.object({
  backupId: z.uuid().optional(),
  databaseId: z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .optional(),
  instanceId: relayInstanceSchema.shape.id.optional(),
  relayId: relayIdSchema,
})

export const realtimeClientEventSchema = z.discriminatedUnion("type", [
  sequencedEventSchema.extend({
    authorization: z.boolean().optional(),
    clear: z.boolean(),
    hearth: z.boolean(),
    type: z.literal("reset"),
  }),
  sequencedEventSchema.extend({
    scope: hearthScopeSchema.optional(),
    topics: z.array(hearthRealtimeTopicSchema).min(1).max(8),
    type: z.literal("collections.invalidate"),
  }),
  sequencedEventSchema.extend({
    deleted: z.array(
      z.object({
        instanceId: relayInstanceSchema.shape.id,
        relayId: relayIdSchema,
      })
    ),
    type: z.literal("instances.delta"),
    upserted: z.array(fleetInstanceSchema),
  }),
  sequencedEventSchema.extend({
    nodes: z.array(fleetNodeSchema),
    type: z.literal("nodes.delta"),
  }),
  sequencedEventSchema.extend({
    relayId: relayIdSchema,
    status: z.enum(["connected", "unreachable"]),
    type: z.literal("relay.status"),
  }),
  sequencedEventSchema.extend({
    scope: hearthScopeSchema.optional(),
    topics: z.array(hearthRealtimeTopicSchema).min(1).max(8).optional(),
    type: z.literal("relay.invalidate"),
  }),
])

export type FleetInstance = z.infer<typeof fleetInstanceSchema>
export type FleetNode = z.infer<typeof fleetNodeSchema>
export type RealtimeClientEvent = z.infer<typeof realtimeClientEventSchema>

export function realtimeEventRefreshesHearth(
  event: RealtimeClientEvent
): boolean {
  return (
    event.type === "collections.invalidate" ||
    (event.type === "relay.invalidate" && event.topics !== undefined)
  )
}
