import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query"
import {
  instanceReferenceKey,
  type InstanceObservation,
  type InstanceReference,
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
import { getInstanceStates } from "@/server/instance-states"

export type InstanceState =
  | { phase: "checking" }
  | { phase: "error"; error: Error }
  | { phase: "ready"; observation: InstanceObservation }

export class InstanceStateError extends Schema.TaggedError<InstanceStateError>()(
  "InstanceStateError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

class ReadInstanceState extends Request.Class<
  {
    readonly reference: InstanceReference
    readonly signal: AbortSignal
  },
  InstanceObservation,
  InstanceStateError
> {}

function createStateResolver() {
  const pool = Semaphore.makeUnsafe(4)
  return RequestResolver.makeGrouped<ReadInstanceState, string>({
    key: ({ request }) =>
      `${request.reference.kind}:${request.reference.relayId}`,
    resolver: Effect.fn("Instances.statusBatch")(function* (entries) {
      yield* Effect.annotateCurrentSpan("instance.count", entries.length)
      yield* Effect.forEach(
        EffectArray.chunksOf(entries, 128),
        (batch) =>
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
                  getInstanceStates({
                    data: batch.map(({ request }) => request.reference),
                    signal,
                  }),
                catch: (cause) =>
                  new InstanceStateError({
                    message: "Could not check status",
                    cause,
                  }),
              }),
              abandoned
            ).pipe(Effect.result)
            for (const entry of batch) {
              if (response._tag === "Failure") {
                entry.completeUnsafe(Exit.fail(response.failure))
                continue
              }
              const item = response.success.find(
                (item) =>
                  instanceReferenceKey(item.reference) ===
                  instanceReferenceKey(entry.request.reference)
              )
              entry.completeUnsafe(
                item && "observation" in item
                  ? Exit.succeed(item.observation)
                  : Exit.fail(
                      new InstanceStateError({
                        message:
                          item && "error" in item
                            ? item.error
                            : "Status unavailable",
                      })
                    )
              )
            }
          }),
        { concurrency: 4 }
      )
    }, pool.withPermit),
  })
}

const resolvers = new WeakMap<
  QueryClient,
  ReturnType<typeof createStateResolver>
>()

export function instanceStateQueryKey(reference: InstanceReference) {
  return [
    "instance-states",
    reference.kind,
    reference.relayId,
    reference.id,
  ] as const
}

export function instanceStateQueryOptions(reference: InstanceReference) {
  return queryOptions({
    queryKey: instanceStateQueryKey(reference),
    queryFn: ({ client, signal }) => {
      let resolver = resolvers.get(client)
      if (!resolver) {
        resolver = createStateResolver()
        resolvers.set(client, resolver)
      }
      return runBrowserEffect(
        Effect.request(new ReadInstanceState({ reference, signal }), resolver),
        { signal }
      )
    },
    enabled: typeof window !== "undefined",
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  })
}

export function useInstanceState(
  reference: InstanceReference,
  enabled = true
): InstanceState {
  const query = useQuery({
    ...instanceStateQueryOptions(reference),
    enabled: enabled && typeof window !== "undefined",
  })
  // Query retains data during refetches; runtime state must be checked again
  // before this observer presents it as current.
  if (query.fetchStatus !== "idle" || !query.isFetchedAfterMount)
    return { phase: "checking" }
  if (query.error) return { phase: "error", error: query.error }
  return query.data
    ? { phase: "ready", observation: query.data }
    : { phase: "checking" }
}
