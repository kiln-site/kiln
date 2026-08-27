import {
  relayIdSchema,
  relayInstanceSchema,
  relayNodeSchema,
} from "@workspace/contracts"
import { z } from "zod"

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

export const realtimeClientEventSchema = z.discriminatedUnion("type", [
  sequencedEventSchema.extend({
    clear: z.boolean(),
    type: z.literal("reset"),
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
  sequencedEventSchema.extend({ type: z.literal("relay.invalidate") }),
])

export type FleetInstance = z.infer<typeof fleetInstanceSchema>
export type FleetNode = z.infer<typeof fleetNodeSchema>
export type RealtimeClientEvent = z.infer<typeof realtimeClientEventSchema>
