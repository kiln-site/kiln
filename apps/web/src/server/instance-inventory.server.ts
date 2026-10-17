import {
  AppTableInventorySchema,
  RelayInventoryItemSchema,
  instanceInventoryRequestKey,
  relayAppSchema,
  relayManagedDatabaseSchema,
  type InstanceInventory,
  type InstanceInventoryRequest,
  type InstanceInventoryResult,
  type InstanceObservation,
  type RelayInstance,
  type RelayNode,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Context, Effect, Layer, Schema } from "effect"

import { ExternalServiceError } from "@/effect/errors"
import { isPlatformAdmin, listUserGrantsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import {
  isRelayUpdating,
  relayConnectionInstances,
  relayConnectionNode,
  relayConnectionState,
  relayRpc,
} from "@/lib/relay-connection"

export class InstanceInventorySource extends Context.Service<
  InstanceInventorySource,
  {
    readonly read: (
      relay: PersistedRelay,
      requests: ReadonlyArray<InstanceInventoryRequest>
    ) => Effect.Effect<Array<InstanceInventoryResult>, ExternalServiceError>
  }
>()("hearth/InstanceInventorySource") {}

export const readInstanceInventory = Effect.fn("Instances.inventory.batch")(
  function* (
    user: AuthenticatedUser,
    requests: ReadonlyArray<InstanceInventoryRequest>
  ) {
    yield* Effect.annotateCurrentSpan("instance.count", requests.length)
    const { relays, grants } = yield* Effect.all(
      {
        relays: listPersistedRelaysEffect(),
        grants: isPlatformAdmin(user)
          ? Effect.succeed([])
          : listUserGrantsEffect(user.id),
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
    for (const request of new Map(
      requests.map((request) => [instanceInventoryRequestKey(request), request])
    ).values()) {
      const { reference } = request
      const relay = relaysById.get(reference.relayId)
      const resourceType =
        reference.kind === "server"
          ? "instance"
          : reference.kind === "database"
            ? "database"
            : "relay"
      const permission =
        reference.kind === "server"
          ? "instance.read"
          : reference.kind === "database"
            ? "database.read"
            : reference.kind === "app"
              ? "app.read"
              : "relay.read"
      const allowed =
        isPlatformAdmin(user) ||
        effectiveScopePermissions(grants, {
          relayId: reference.relayId,
          resourceType,
          resourceId:
            resourceType === "relay" ? reference.relayId : reference.id,
        }).has(permission)
      if (
        !relay ||
        !allowed ||
        (reference.kind === "relay" && reference.id !== relay.id)
      ) {
        denied.push({ request, error: "unavailable" })
        continue
      }
      const key = `${reference.kind}:${relay.id}`
      const group = groups.get(key) ?? { relay, requests: [] }
      group.requests.push(request)
      groups.set(key, group)
    }
    const results = yield* Effect.forEach(
      [...groups.values()],
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
    return [...denied, ...results.flat()]
  }
)

function inventoryValue(
  request: InstanceInventoryRequest,
  observation: InstanceObservation,
  payload?: {
    table?: typeof AppTableInventorySchema.Type
    app?: unknown
    database?: unknown
    server?: RelayInstance
    relay?: RelayNode | null
  }
): InstanceInventory {
  const { kind } = request.reference
  const { view } = request
  if (view === "status") return { kind, view, data: null, observation }
  if (kind === "app")
    return view === "table"
      ? { kind, view, data: payload?.table ?? null, observation }
      : {
          kind,
          view,
          data: payload?.app ? relayAppSchema.parse(payload.app) : null,
          observation,
        }
  if (kind === "database")
    return view === "table"
      ? { kind, view, data: null, observation }
      : {
          kind,
          view,
          data: payload?.database
            ? relayManagedDatabaseSchema.parse(payload.database)
            : null,
          observation,
        }
  if (kind === "server")
    return { kind, view, data: payload?.server ?? null, observation }
  return { kind, view, data: payload?.relay ?? null, observation }
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
  const reachability: InstanceObservation["reachability"] = !relay.enabled
    ? "paused"
    : connection.status === "authenticated"
      ? "connected"
      : connection.status === "connecting"
        ? "checking"
        : "unreachable"
  const base = { reachability, updating: isRelayUpdating(relay.id) }
  if (kind === "server" || kind === "relay" || reachability !== "connected") {
    const instances = relayConnectionInstances(relay.id)
    const byId = new Map(instances?.map((instance) => [instance.id, instance]))
    return requests.map((request): InstanceInventoryResult => {
      const instance = byId.get(request.reference.id)
      const observation: InstanceObservation = {
        ...request.reference,
        ...base,
        runtime:
          reachability === "connected"
            ? (instance?.observedState ?? null)
            : null,
        inventory:
          reachability !== "connected"
            ? "unavailable"
            : kind === "relay"
              ? "available"
              : instances === null
                ? "unavailable"
                : instance
                  ? "available"
                  : "missing",
      }
      return {
        request,
        value: inventoryValue(request, observation, {
          server: reachability === "connected" ? instance : undefined,
          relay:
            reachability === "connected" ? relayConnectionNode(relay.id) : null,
        }),
      }
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
  // Older Relays return full list records; normalize only requested items.
  // Updated Relays plan the requested views before inspecting containers.
  const items = yield* Schema.decodeUnknownEffect(
    Schema.Array(RelayInventoryItemSchema)
  )(response).pipe(
    Effect.map(
      (items) => new Map(items.map((item) => [`${item.id}:${item.view}`, item]))
    ),
    Effect.catch(() =>
      Effect.try({
        try: () => {
          const full =
            kind === "app"
              ? relayAppSchema.array().parse(response)
              : relayManagedDatabaseSchema.array().parse(response)
          const byId = new Map(full.map((item) => [item.id, item]))
          return new Map(
            requests.flatMap(({ reference, view }) => {
              const item = byId.get(reference.id)
              if (!item) return []
              const table =
                "containers" in item
                  ? {
                      containerSearchText: item.containers
                        .map(
                          (container) => `${container.name} ${container.image}`
                        )
                        .join(" "),
                      containerCount: item.containers.length,
                      runningContainerCount: item.containers.filter(
                        (container) => container.running
                      ).length,
                      deploying: item.deployment?.state === "running",
                    }
                  : undefined
              return [
                [
                  `${item.id}:${view}`,
                  {
                    ...item,
                    view,
                    table,
                    app: kind === "app" ? item : undefined,
                    database: kind === "database" ? item : undefined,
                  },
                ] as const,
              ]
            })
          )
        },
        catch: (cause) =>
          ExternalServiceError.make({
            service: "Relay",
            message: "Invalid inventory response",
            cause,
          }),
      })
    )
  )
  return yield* Effect.try({
    try: () =>
      requests.map((request): InstanceInventoryResult => {
        const item = items.get(`${request.reference.id}:${request.view}`)
        const observation: InstanceObservation = {
          ...request.reference,
          ...base,
          runtime: item?.observedState ?? null,
          inventory: item ? "available" : "missing",
        }
        return { request, value: inventoryValue(request, observation, item) }
      }),
    catch: (cause) =>
      ExternalServiceError.make({
        service: "Relay",
        message: "Invalid inventory fields",
        cause,
      }),
  })
})

export const InstanceInventorySourceLive = Layer.succeed(
  InstanceInventorySource,
  { read: readRelayInventory }
)
