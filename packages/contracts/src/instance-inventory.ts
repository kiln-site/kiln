import { Schema } from "effect"
import type { RelayApp, RelayManagedDatabase } from "./index.js"
import {
  InstanceObservedStateSchema,
  InstanceReferenceSchema,
  type InstanceObservation,
} from "./instance-state.js"

/**
 * `status` is the observation alone. Apps add `table` (container counts and
 * search text) and `detail` (the full record); databases add `detail`.
 */
export const InstanceInventoryViewSchema = Schema.Literals([
  "status",
  "table",
  "detail",
])
export type InstanceInventoryView = typeof InstanceInventoryViewSchema.Type

const resourceId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
const relayId = InstanceReferenceSchema.fields.relayId
const resource = <K extends "app" | "database" | "server">(kind: K) =>
  Schema.Struct({ kind: Schema.Literal(kind), relayId, id: resourceId })

// Each kind accepts only the views it serves, so a read permission never
// reaches data that needs a stronger one.
export const InstanceInventoryRequestSchema = Schema.Union([
  Schema.Struct({
    reference: resource("app"),
    view: InstanceInventoryViewSchema,
  }),
  Schema.Struct({
    reference: resource("database"),
    view: Schema.Literals(["status", "detail"]),
  }),
  Schema.Struct({
    reference: resource("server"),
    view: Schema.Literal("status"),
  }),
  Schema.Struct({
    reference: Schema.Struct({
      kind: Schema.Literal("relay"),
      relayId,
      id: relayId,
    }),
    view: Schema.Literal("status"),
  }),
])
export type InstanceInventoryRequest =
  typeof InstanceInventoryRequestSchema.Type

export const RelayInventoryLookupSchema = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({
      id: resourceId,
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
  | {
      kind: InstanceInventoryRequest["reference"]["kind"]
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

/** One requested view as an updated Relay reports it. */
export const RelayInventoryItemSchema = Schema.Struct({
  id: Schema.String,
  view: InstanceInventoryViewSchema,
  observedState: InstanceObservedStateSchema,
  table: Schema.optionalKey(AppTableInventorySchema),
  app: Schema.optionalKey(Schema.Unknown),
  database: Schema.optionalKey(Schema.Unknown),
})
export interface RelayInventoryItem {
  id: string
  view: InstanceInventoryView
  observedState: typeof InstanceObservedStateSchema.Type
  table?: AppTableInventory
  app?: RelayApp
  database?: RelayManagedDatabase
}
