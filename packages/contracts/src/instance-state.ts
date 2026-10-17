import { Schema } from "effect"

export const InstanceReferenceSchema = Schema.Struct({
  kind: Schema.Literals(["server", "database", "app", "relay"]),
  relayId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(43)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})

export type InstanceReference = typeof InstanceReferenceSchema.Type
export type InstanceKind = InstanceReference["kind"]

export const InstanceStateLookupSchema = Schema.Struct({
  stateOnly: Schema.optionalKey(Schema.Boolean),
  ids: Schema.optionalKey(
    Schema.Array(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
    ).check(Schema.isMinLength(1), Schema.isMaxLength(128))
  ),
})

export const InstanceRuntimeStateSchema = Schema.Struct({
  id: Schema.String,
  observedState: Schema.Literals([
    "provisioning",
    "starting",
    "running",
    "stopping",
    "stopped",
    "failed",
  ]),
})

export type InstanceRuntimeState = typeof InstanceRuntimeStateSchema.Type

export interface InstanceObservation extends InstanceReference {
  reachability: "checking" | "connected" | "unreachable" | "paused"
  runtime: InstanceRuntimeState["observedState"] | null
  inventory: "available" | "missing" | "unavailable"
  updating: boolean
}

export type InstanceStateResult =
  | { reference: InstanceReference; observation: InstanceObservation }
  | { reference: InstanceReference; error: string }

export function instanceReferenceKey(reference: InstanceReference): string {
  return `${reference.kind}:${reference.relayId}:${reference.id}`
}
