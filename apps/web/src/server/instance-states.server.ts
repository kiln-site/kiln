import {
  InstanceRuntimeStateSchema,
  instanceReferenceKey,
  type InstanceObservation,
  type InstanceReference,
  type InstanceStateResult,
} from "@workspace/contracts"
import { Context, Effect, Layer, Schema } from "effect"

import { RelayUnavailableError } from "@/effect/errors"
import { isPlatformAdmin, listUserGrantsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import {
  isRelayUpdating,
  relayConnectionInstances,
  relayConnectionState,
  relayRpc,
} from "@/lib/relay-connection"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"
import type { PersistedRelay } from "@/lib/relay-registry"
import { logException } from "@workspace/telemetry"

export class InstanceStateSource extends Context.Service<
  InstanceStateSource,
  {
    readonly read: (
      relay: PersistedRelay,
      references: ReadonlyArray<InstanceReference>
    ) => Effect.Effect<
      Array<InstanceStateResult>,
      RelayUnavailableError | Schema.SchemaError
    >
  }
>()("hearth/InstanceStateSource") {}

export const readInstanceStates = Effect.fn("Instances.readStates.batch")(
  function* (
    user: AuthenticatedUser,
    references: ReadonlyArray<InstanceReference>
  ) {
    yield* Effect.annotateCurrentSpan("instance.count", references.length)
    const { relays, grants } = yield* Effect.all(
      {
        relays: listPersistedRelaysEffect(),
        grants: isPlatformAdmin(user)
          ? Effect.succeed([])
          : listUserGrantsEffect(user.id),
      },
      { concurrency: 2 }
    )
    const groups = new Map<
      string,
      { relay: PersistedRelay; references: Array<InstanceReference> }
    >()
    const results: Array<InstanceStateResult> = []
    const source = yield* InstanceStateSource
    const relaysById = new Map(relays.map((relay) => [relay.id, relay]))
    for (const reference of new Map(
      references.map((reference) => [
        instanceReferenceKey(reference),
        reference,
      ])
    ).values()) {
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
          resourceId:
            resourceType === "relay" ? reference.relayId : reference.id,
          resourceType,
        }).has(permission)
      if (
        !relay ||
        !allowed ||
        (reference.kind === "relay" && reference.id !== reference.relayId)
      ) {
        results.push({ reference, error: "Resource unavailable" })
        continue
      }
      const key = `${reference.kind}:${relay.id}`
      const group = groups.get(key) ?? { relay, references: [] }
      group.references.push(reference)
      groups.set(key, group)
    }
    const batches = yield* Effect.forEach(
      [...groups.values()],
      ({ relay, references }) =>
        source.read(relay, references).pipe(
          Effect.catch((error) =>
            logException(error, {
              operation: "Instances.readStates",
              attributes: { "relay.id": relay.id },
            }).pipe(
              Effect.as(
                references.map((reference): InstanceStateResult => ({
                  reference,
                  error: "Could not check status",
                }))
              )
            )
          )
        ),
      { concurrency: 4 }
    )
    return [...results, ...batches.flat()]
  }
)

const readRelayInstanceStates = Effect.fn("Instances.readStates.relay")(
  function* (
    relay: PersistedRelay,
    references: ReadonlyArray<InstanceReference>
  ): Effect.fn.Return<
    Array<InstanceStateResult>,
    RelayUnavailableError | Schema.SchemaError
  > {
    const kind = references[0]!.kind
    yield* Effect.annotateCurrentSpan({
      "relay.id": relay.id,
      "instance.kind": kind,
      "instance.count": references.length,
    })
    const connection = relayConnectionState(relay.id)
    const reachability = !relay.enabled
      ? "paused"
      : connection.status === "authenticated"
        ? "connected"
        : connection.status === "connecting"
          ? "checking"
          : "unreachable"
    const base = {
      reachability,
      updating: isRelayUpdating(relay.id),
    } satisfies Pick<InstanceObservation, "reachability" | "updating">
    if (kind === "relay" || reachability !== "connected") {
      return references.map((reference) => ({
        reference,
        observation: {
          ...reference,
          ...base,
          runtime: null,
          inventory: reachability === "connected" ? "available" : "unavailable",
        },
      }))
    }
    if (kind === "server") {
      const instances = relayConnectionInstances(relay.id)
      return references.map((reference) => {
        const instance = instances?.find(
          (instance) => instance.id === reference.id
        )
        return {
          reference,
          observation: {
            ...reference,
            ...base,
            runtime: instance?.observedState ?? null,
            inventory:
              instances === null
                ? "unavailable"
                : instance
                  ? "available"
                  : "missing",
          },
        }
      })
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        relayRpc(
          relay,
          kind === "app" ? "app.list" : "database.list",
          {
            stateOnly: true,
            ids: references.map((reference) => reference.id),
          },
          10_000,
          undefined,
          signal
        ),
      catch: (cause) =>
        RelayUnavailableError.make({
          message: "Could not check instance status",
          cause,
        }),
    })
    const states = yield* Schema.decodeUnknownEffect(
      Schema.Array(InstanceRuntimeStateSchema)
    )(response)
    return references.map((reference) => {
      const state = states.find((state) => state.id === reference.id)
      const observation: InstanceObservation = {
        ...reference,
        ...base,
        runtime: state?.observedState ?? null,
        inventory: state ? "available" : "missing",
      }
      return { reference, observation }
    })
  }
)

export const InstanceStateSourceLive = Layer.succeed(InstanceStateSource, {
  read: readRelayInstanceStates,
})
