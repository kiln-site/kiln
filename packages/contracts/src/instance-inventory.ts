import { Schema } from "effect"
import type {
  RelayApp,
  RelayManagedDatabase,
  RelayInstance,
  RelayNode,
} from "./index.js"
import {
  InstanceReferenceSchema,
  InstanceRuntimeStateSchema,
  type InstanceObservation,
} from "./instance-state.js"

export const InstanceInventoryViewSchema = Schema.Literals([
  "status",
  "table",
  "detail",
])
export type InstanceInventoryView = typeof InstanceInventoryViewSchema.Type
export const InstanceInventoryRequestSchema = Schema.Struct({
  reference: Schema.Union([
    Schema.Struct({
      kind: Schema.Literals(["app", "database", "server"]),
      relayId: InstanceReferenceSchema.fields.relayId,
      id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
    }),
    Schema.Struct({
      kind: Schema.Literal("relay"),
      relayId: InstanceReferenceSchema.fields.relayId,
      id: InstanceReferenceSchema.fields.relayId,
    }),
  ]),
  view: InstanceInventoryViewSchema,
})
export type InstanceInventoryRequest =
  typeof InstanceInventoryRequestSchema.Type
export const RelayInventoryLookupSchema = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
      view: InstanceInventoryViewSchema,
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type RelayInventoryLookup = typeof RelayInventoryLookupSchema.Type

export const AppTableInventorySchema = Schema.Struct({
  containerSearchText: Schema.String,
  containerCount: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  runningContainerCount: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  deploying: Schema.Boolean,
})
export type AppTableInventory = typeof AppTableInventorySchema.Type

type InventoryPayload =
  | { kind: "app"; view: "table"; data: AppTableInventory | null }
  | { kind: "app"; view: "detail"; data: RelayApp | null }
  | { kind: "database"; view: "detail"; data: RelayManagedDatabase | null }
  | { kind: "database"; view: "table"; data: null }
  | { kind: "server"; view: "table" | "detail"; data: RelayInstance | null }
  | { kind: "relay"; view: "table" | "detail"; data: RelayNode | null }
  | {
      kind: "app" | "database" | "server" | "relay"
      view: "status"
      data: null
    }

export type InstanceInventory = InventoryPayload & {
  observation: InstanceObservation
}
export type InstanceInventoryResult =
  | { request: InstanceInventoryRequest; value: InstanceInventory }
  | {
      request: InstanceInventoryRequest
      error: "unavailable" | "lookup_failed"
    }

export function instanceInventoryRequestKey(
  request: InstanceInventoryRequest
): string {
  const { kind, relayId, id } = request.reference
  return `${kind}:${relayId}:${id}:${request.view}`
}

export const RelayInventoryItemSchema = Schema.Struct({
  id: Schema.String,
  view: InstanceInventoryViewSchema,
  observedState: InstanceRuntimeStateSchema.fields.observedState,
  table: Schema.optionalKey(AppTableInventorySchema),
  app: Schema.optionalKey(Schema.Unknown),
  database: Schema.optionalKey(Schema.Unknown),
})
export interface RelayInventoryItem {
  id: string
  view: InstanceInventoryView
  observedState: typeof InstanceRuntimeStateSchema.Type.observedState
  table?: AppTableInventory
  app?: RelayApp
  database?: RelayManagedDatabase
}
