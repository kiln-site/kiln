import {
  RelayInventoryItemSchema,
  instanceInventoryRequestKey,
  relayAppSchema,
  relayManagedDatabaseSchema,
  type AppTableInventory,
  type InstanceInventory,
  type InstanceInventoryRequest,
  type InstanceInventoryResult,
  type InstanceObservation,
  type RelayManagedDatabase,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Context, Effect, Layer, Option, Schema } from "effect"

import { ExternalServiceError } from "@/effect/errors"
import { isPlatformAdmin, listUserGrantsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { withVisibleDatabaseMembers } from "@/lib/database-member-visibility"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import {
  isRelayUpdating,
  relayConnectionInstances,
  relayConfirmsPause,
  relayConnectionState,
  relayReportsPaused,
  relayRpc,
} from "@/lib/relay-connection"

type Kind = InstanceInventoryRequest["reference"]["kind"]

/** Reads one Relay's share of a batch. Tests replace the Relay here. */
export class InstanceInventorySource extends Context.Service<
  InstanceInventorySource,
  {
    readonly read: (
      relay: PersistedRelay,
      requests: ReadonlyArray<InstanceInventoryRequest>
    ) => Effect.Effect<Array<InstanceInventoryResult>, ExternalServiceError>
  }
>()("hearth/InstanceInventorySource") {}

// The grant that reads each kind, and the scope it is checked against.
const readAccess: Record<
  Kind,
  {
    resourceType: "instance" | "database" | "relay" | "app"
    permission: AccessPermission
  }
> = {
  app: { resourceType: "app", permission: "app.read" },
  database: { resourceType: "database", permission: "database.read" },
  relay: { resourceType: "relay", permission: "relay.read" },
  server: { resourceType: "instance", permission: "instance.read" },
}

/**
 * Answers a batch of observations the user may read, one Relay at a time.
 * Requests the user cannot read are reported unavailable before any Relay is
 * contacted, and a failing Relay only fails its own requests.
 */
export const readInstanceInventory = Effect.fnUntraced(function* (
  user: AuthenticatedUser,
  requests: ReadonlyArray<InstanceInventoryRequest>
) {
  yield* Effect.annotateCurrentSpan("instance.count", requests.length)
  const admin = isPlatformAdmin(user)
  const { relays, grants } = yield* Effect.all(
    {
      relays: listPersistedRelaysEffect(),
      grants: admin ? Effect.succeed([]) : listUserGrantsEffect(user.id),
    },
    { concurrency: 2 }
  )
  const source = yield* InstanceInventorySource
  const relaysById = new Map(relays.map((relay) => [relay.id, relay]))
  const groups = new Map<
    string,
    { relay: PersistedRelay; requests: Array<InstanceInventoryRequest> }
  >()
  const denied: Array<InstanceInventoryResult> = []
  const unique = new Map(
    requests.map((request) => [instanceInventoryRequestKey(request), request])
  )
  for (const request of unique.values()) {
    const { kind, relayId, id } = request.reference
    const relay = relaysById.get(relayId)
    const { resourceType, permission } = readAccess[kind]
    const allowed =
      admin ||
      effectiveScopePermissions(grants, {
        relayId,
        resourceType,
        resourceId: resourceType === "relay" ? relayId : id,
      }).has(permission)
    // A Relay reference names the Relay itself, never a resource on it.
    if (!relay || !allowed || (kind === "relay" && id !== relayId)) {
      denied.push({ request, error: "unavailable" })
      continue
    }
    const key = `${kind}:${relay.id}`
    const group = groups.get(key) ?? { relay, requests: [] }
    group.requests.push(request)
    groups.set(key, group)
  }
  const results = yield* Effect.forEach(
    groups.values(),
    ({ relay, requests }) =>
      source.read(relay, requests).pipe(
        Effect.catch((error) =>
          logException(error, {
            operation: "Instances.inventory",
            attributes: { "relay.id": relay.id },
          }).pipe(
            Effect.as(
              requests.map((request): InstanceInventoryResult => ({
                request,
                error: "lookup_failed",
              }))
            )
          )
        )
      ),
    { concurrency: 4 }
  )
  // A database's members are shown only to those who may read them.
  const visible = results.flat().map((result): InstanceInventoryResult => {
    if (
      !("value" in result) ||
      result.value.kind !== "database" ||
      result.value.view !== "detail" ||
      !result.value.data
    )
      return result
    return {
      ...result,
      value: {
        ...result.value,
        data: withVisibleDatabaseMembers(result.value.data, {
          admin,
          grants,
          relayId: result.request.reference.relayId,
        }),
      },
    }
  })
  return [...denied, ...visible]
})

type ReportedItem = {
  observedState: InstanceObservation["runtime"] & {}
  table?: AppTableInventory
  app?: unknown
  database?: unknown
}

const decodeItem = Schema.decodeUnknownOption(RelayInventoryItemSchema)

// The Relay answers each requested view with an item of its own.
function reportedItems(response: unknown) {
  const items = new Map<string, ReportedItem>()
  if (!Array.isArray(response)) return items
  for (const raw of response) {
    const item = decodeItem(raw)
    if (Option.isSome(item))
      items.set(`${item.value.id}:${item.value.view}`, item.value)
  }
  return items
}

function inventoryValue(
  request: InstanceInventoryRequest,
  observation: InstanceObservation,
  item: ReportedItem | undefined
): InstanceInventory {
  if (request.view === "status")
    return {
      kind: request.reference.kind,
      view: "status",
      data: null,
      observation,
    }
  if (request.reference.kind === "database")
    return {
      kind: "database",
      view: "detail",
      data: item?.database
        ? (relayManagedDatabaseSchema.parse(
            item.database
          ) as RelayManagedDatabase)
        : null,
      observation,
    }
  return request.view === "table"
    ? { kind: "app", view: "table", data: item?.table ?? null, observation }
    : {
        kind: "app",
        view: "detail",
        data: item?.app ? relayAppSchema.parse(item.app) : null,
        observation,
      }
}

const readRelayInventory = Effect.fn("Instances.inventory.relay")(function* (
  relay: PersistedRelay,
  requests: ReadonlyArray<InstanceInventoryRequest>
) {
  const kind = requests[0]!.reference.kind
  yield* Effect.annotateCurrentSpan({
    "relay.id": relay.id,
    "instance.kind": kind,
    "instance.count": requests.length,
  })
  const connection = relayConnectionState(relay.id)
  // Paused only once the Relay has the pause, whichever Hearth holds it.
  const reachability: InstanceObservation["reachability"] = !relay.enabled
    ? relayConfirmsPause(relay.id)
      ? "paused"
      : "pausing"
    : connection.status === "authenticated"
      ? relayReportsPaused(relay.id)
        ? "paused"
        : "connected"
      : connection.status === "connecting"
        ? "checking"
        : "unreachable"
  const base = { reachability, updating: isRelayUpdating(relay.id) }
  const observe = (
    request: InstanceInventoryRequest,
    runtime: InstanceObservation["runtime"],
    inventory: InstanceObservation["inventory"]
  ): InstanceObservation => ({
    ...request.reference,
    ...base,
    runtime: reachability === "connected" ? runtime : null,
    inventory: reachability === "connected" ? inventory : "unavailable",
  })

  // Hearth holds game server and Relay state from the Relay's own stream.
  if (kind === "server" || kind === "relay" || reachability !== "connected") {
    const instances = relayConnectionInstances(relay.id)
    const byId = new Map(instances?.map((instance) => [instance.id, instance]))
    return requests.map((request): InstanceInventoryResult => {
      const instance = byId.get(request.reference.id)
      const observation = observe(
        request,
        kind === "relay" ? null : (instance?.observedState ?? null),
        kind === "relay"
          ? "available"
          : instances === null
            ? "unavailable"
            : instance
              ? "available"
              : "missing"
      )
      return { request, value: inventoryValue(request, observation, undefined) }
    })
  }

  const response = yield* Effect.tryPromise({
    try: (signal) =>
      relayRpc(
        relay,
        kind === "app" ? "app.list" : "database.list",
        {
          requests: requests.map(({ reference, view }) => ({
            id: reference.id,
            view,
          })),
        },
        10_000,
        undefined,
        signal
      ),
    catch: (cause) =>
      ExternalServiceError.make({
        service: "Relay",
        message: "Could not read inventory",
        cause,
      }),
  })
  const items = reportedItems(response)
  return yield* Effect.forEach(requests, (request) => {
    const item = items.get(`${request.reference.id}:${request.view}`)
    const observation = observe(
      request,
      item?.observedState ?? null,
      item ? "available" : "missing"
    )
    // One malformed record fails only its own request.
    return Effect.try((): InstanceInventoryResult => ({
      request,
      value: inventoryValue(request, observation, item),
    })).pipe(
      Effect.catch((cause) =>
        logException(cause, {
          operation: "Instances.inventory.decode",
          attributes: {
            "relay.id": relay.id,
            "instance.id": request.reference.id,
          },
        }).pipe(
          Effect.as<InstanceInventoryResult>({
            request,
            error: "lookup_failed",
          })
        )
      )
    )
  })
})

export const InstanceInventorySourceLive = Layer.succeed(
  InstanceInventorySource,
  { read: readRelayInventory }
)
