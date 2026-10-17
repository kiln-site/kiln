import { Schema } from "effect"

export const InstanceReferenceSchema = Schema.Struct({
  kind: Schema.Literals(["server", "database", "app", "relay"]),
  relayId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(43)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})

export type InstanceReference = typeof InstanceReferenceSchema.Type
export type InstanceKind = InstanceReference["kind"]

export const InstanceObservedStateSchema = Schema.Literals([
  "provisioning",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
])

export type InstanceObservedState = typeof InstanceObservedStateSchema.Type

/**
 * What Hearth last confirmed about an instance. Reachability belongs to its
 * Relay, runtime to the workload, and inventory to whether the Relay still
 * reports it, so an unreachable Relay never reads as a failed workload.
 */
export interface InstanceObservation extends InstanceReference {
  reachability: "checking" | "connected" | "unreachable" | "paused"
  runtime: InstanceObservedState | null
  inventory: "available" | "missing" | "unavailable"
  updating: boolean
}
