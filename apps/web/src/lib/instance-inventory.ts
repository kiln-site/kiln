import {
  queryOptions,
  replaceEqualDeep,
  type QueryClient,
} from "@tanstack/react-query"
import {
  instanceInventoryRequestKey,
  type InstanceInventory,
  type InstanceInventoryRequest,
  type InstanceReference,
  type InstanceInventoryView,
} from "@workspace/contracts"
import {
  Array as EffectArray,
  Effect,
  Exit,
  Request,
  RequestResolver,
  Schema,
  Semaphore,
} from "effect"
import { runBrowserEffect } from "@/lib/browser-telemetry"
import { getInstanceInventory } from "@/server/instance-inventory"

export class InstanceInventoryError extends Schema.TaggedError<InstanceInventoryError>()(
  "InstanceInventoryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

class ReadInstanceInventory extends Request.Class<
  {
    readonly lookup: InstanceInventoryRequest
    readonly signal: AbortSignal
  },
  InstanceInventory,
  InstanceInventoryError
> {}

function createInventoryResolver() {
  const pool = Semaphore.makeUnsafe(4)
  return RequestResolver.makeGrouped<ReadInstanceInventory, string>({
    key: ({ request }) =>
      `${request.lookup.reference.kind}:${request.lookup.reference.relayId}`,
    resolver: Effect.fn("Instances.inventoryBatch")(function* (entries) {
      yield* Effect.annotateCurrentSpan("instance.count", entries.length)
      yield* Effect.forEach(
        EffectArray.chunksOf(entries, 128),
        (batch) =>
          pool.withPermit(
            Effect.gen(function* () {
              // An executing batch can outlive individual Effect requests. Keep
              // its transport only while at least one Query still needs it.
              const abandoned = Effect.callback<never>((resume) => {
                const signals = batch.map(({ request }) => request.signal)
                const abort = () => {
                  if (signals.every((signal) => signal.aborted))
                    resume(Effect.interrupt)
                }
                for (const signal of signals)
                  signal.addEventListener("abort", abort, { once: true })
                abort()
                return Effect.sync(() => {
                  for (const signal of signals)
                    signal.removeEventListener("abort", abort)
                })
              })
              const response = yield* Effect.raceFirst(
                Effect.tryPromise({
                  try: (signal) =>
                    getInstanceInventory({
                      data: batch.map(({ request }) => request.lookup),
                      signal,
                    }),
                  catch: (cause) =>
                    new InstanceInventoryError({
                      message: "Could not read inventory",
                      cause,
                    }),
                }),
                abandoned
              ).pipe(Effect.result)
              const byKey =
                response._tag === "Success"
                  ? new Map(
                      response.success.map((item) => [
                        instanceInventoryRequestKey(item.request),
                        item,
                      ])
                    )
                  : undefined
              for (const entry of batch) {
                if (response._tag === "Failure") {
                  entry.completeUnsafe(Exit.fail(response.failure))
                  continue
                }
                const item = byKey?.get(
                  instanceInventoryRequestKey(entry.request.lookup)
                )
                entry.completeUnsafe(
                  item && "value" in item
                    ? Exit.succeed(item.value)
                    : Exit.fail(
                        new InstanceInventoryError({
                          message:
                            item && "error" in item
                              ? item.error === "unavailable"
                                ? "Resource unavailable"
                                : "Could not read inventory"
                              : "Inventory unavailable",
                        })
                      )
                )
              }
            })
          ),
        { concurrency: 4 }
      )
    }),
  })
}

const resolvers = new WeakMap<
  QueryClient,
  ReturnType<typeof createInventoryResolver>
>()

export function instanceInventoryQueryKey(
  reference: InstanceReference,
  view: InstanceInventoryView
) {
  return view === "status"
    ? ([
        "instance-states",
        reference.kind,
        reference.relayId,
        reference.id,
      ] as const)
    : ([
        "instance-inventory",
        reference.kind,
        reference.relayId,
        reference.id,
        view,
      ] as const)
}

export function instanceInventoryQueryOptions(
  reference: InstanceReference,
  view: InstanceInventoryView
) {
  return queryOptions({
    queryKey: instanceInventoryQueryKey(reference, view),
    queryFn: ({ client, signal }) => {
      let resolver = resolvers.get(client)
      if (!resolver) {
        resolver = createInventoryResolver()
        resolvers.set(client, resolver)
      }
      return runBrowserEffect(
        Effect.request(
          new ReadInstanceInventory({ lookup: { reference, view }, signal }),
          resolver
        ),
        { signal }
      )
    },
    enabled: typeof window !== "undefined",
    gcTime: 0,
    staleTime: 0,
    retry: false,
    structuralSharing: (previous, incoming) => {
      const before = previous as InstanceInventory | undefined
      const next = incoming as InstanceInventory
      // Keep workspace metadata and mounted editors through a Relay outage.
      // The new observation still clears runtime state and disables actions.
      if (
        next.view === "detail" &&
        next.observation.inventory === "unavailable" &&
        !next.data &&
        before?.kind === next.kind &&
        before.view === next.view &&
        before.observation.id === next.observation.id &&
        before.observation.relayId === next.observation.relayId
      )
        return replaceEqualDeep(previous, { ...next, data: before.data })
      return replaceEqualDeep(previous, incoming)
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => {
      const value = query.state.data
      return value?.kind === "app" &&
        ((value.view === "table" && value.data?.deploying) ||
          (value.view === "detail" &&
            value.data?.deployment?.state === "running"))
        ? 2_000
        : 5_000
    },
    refetchIntervalInBackground: false,
  })
}
