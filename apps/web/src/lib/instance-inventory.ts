import {
  environmentManager,
  queryOptions,
  replaceEqualDeep,
  type QueryClient,
  type QueryFilters,
  type QueryKey,
} from "@tanstack/react-query"
import {
  instanceInventoryRequestKey,
  type InstanceInventory,
  type InstanceInventoryRequest,
  type InstanceKind,
  type InstanceReference,
  type InstanceInventoryView,
} from "@workspace/contracts"
import {
  Effect,
  Exit,
  Request,
  RequestResolver,
  Schema,
  Semaphore,
  type Request as RequestNs,
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

type InventoryEntry = RequestNs.Entry<ReadInstanceInventory>

// Matches the endpoint's request limit.
const maxBatchSize = 128
const transports = Semaphore.makeUnsafe(4)

// A running batch outlives the queries that joined it. Interrupt its
// transport only once every one of them has been cancelled.
const untilAllAborted = (signals: ReadonlyArray<AbortSignal>) =>
  Effect.callback<never>((resume) => {
    const abort = () => {
      if (signals.every((signal) => signal.aborted)) resume(Effect.interrupt)
    }
    for (const signal of signals)
      signal.addEventListener("abort", abort, { once: true })
    abort()
    return Effect.sync(() => {
      for (const signal of signals) signal.removeEventListener("abort", abort)
    })
  })

const lookupFailure = (error: "unavailable" | "lookup_failed" | undefined) =>
  new InstanceInventoryError({
    message:
      error === "unavailable"
        ? "Resource unavailable"
        : error === "lookup_failed"
          ? "Could not read inventory"
          : "Inventory unavailable",
  })

const readBatch = Effect.fn("Instances.inventoryBatch")(function* (
  entries: ReadonlyArray<InventoryEntry>
) {
  yield* Effect.annotateCurrentSpan("instance.count", entries.length)
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      getInstanceInventory({
        data: entries.map(({ request }) => request.lookup),
        signal,
      }),
    catch: (cause) =>
      new InstanceInventoryError({
        message: "Could not read inventory",
        cause,
      }),
  }).pipe(
    transports.withPermit,
    Effect.raceFirst(
      untilAllAborted(entries.map(({ request }) => request.signal))
    ),
    Effect.exit
  )
  if (Exit.isFailure(response)) {
    const failed = Exit.failCause(response.cause)
    for (const entry of entries) entry.completeUnsafe(failed)
    return
  }
  const results = new Map(
    response.value.map((item) => [
      instanceInventoryRequestKey(item.request),
      item,
    ])
  )
  for (const entry of entries) {
    const item = results.get(instanceInventoryRequestKey(entry.request.lookup))
    entry.completeUnsafe(
      item && "value" in item
        ? Exit.succeed(item.value)
        : Exit.fail(lookupFailure(item?.error))
    )
  }
})

// One request per Relay and kind, so a slow Relay never holds back another
// Relay's rows. Lookups made within a few milliseconds share that request.
const inventoryResolver = RequestResolver.makeGrouped<
  ReadInstanceInventory,
  string
>({
  key: ({ request }) =>
    `${request.lookup.reference.kind}:${request.lookup.reference.relayId}`,
  resolver: readBatch,
}).pipe(RequestResolver.batchN(maxBatchSize), RequestResolver.setDelay(10))

export function instanceInventoryQueryKey(
  reference: InstanceReference,
  view: InstanceInventoryView
) {
  return [
    "instance-inventory",
    reference.kind,
    reference.relayId,
    reference.id,
    view,
  ] as const
}

/** A key prefix matching every view of the instances a reference narrows to. */
export function instanceInventoryScope(
  reference: {
    kind?: InstanceKind
    relayId?: string
    id?: string
  } = {}
): QueryKey {
  const { kind, relayId, id } = reference
  if (!kind) return ["instance-inventory"]
  if (!relayId) return ["instance-inventory", kind]
  if (!id) return ["instance-inventory", kind, relayId]
  return ["instance-inventory", kind, relayId, id]
}

/**
 * Rereads observations after a pushed change. A read already in flight may
 * predate the change, and Query reuses a first read rather than refetching,
 * so cancel it before invalidating.
 */
export async function recheckInstanceObservations(
  queryClient: QueryClient,
  filters: QueryFilters
) {
  await queryClient.cancelQueries(filters)
  await queryClient.invalidateQueries(filters)
}

// Game servers and Relays push their changes through Hearth's realtime
// stream, which invalidates these queries. Apps and databases are read from
// Docker on demand, so they poll while visible, including after a failed
// first read.
function pollInterval(
  kind: InstanceKind,
  inventory: InstanceInventory | undefined
) {
  if (kind === "server" || kind === "relay") return false
  // Provisioning moves through its phases in seconds.
  if (inventory?.observation.runtime === "provisioning") return 1_000
  if (
    inventory?.kind === "app" &&
    ((inventory.view === "table" && inventory.data?.deploying) ||
      (inventory.view === "detail" &&
        inventory.data?.deployment?.state === "running"))
  )
    return 2_000
  return 5_000
}

// While Hearth renders a page, a read runs as that page's request. A batch
// runs as whichever request started it, so these never join one.
async function readRenderedInventory(
  lookup: InstanceInventoryRequest,
  signal: AbortSignal
) {
  const [item] = await getInstanceInventory({ data: [lookup], signal })
  if (item && "value" in item) return item.value
  throw lookupFailure(item?.error)
}

export function instanceInventoryQueryOptions(
  reference: InstanceReference,
  view: InstanceInventoryView
) {
  // The endpoint rejects views a kind does not serve.
  const lookup = { reference, view } as InstanceInventoryRequest
  return queryOptions({
    queryKey: instanceInventoryQueryKey(reference, view),
    queryFn: ({ signal }) =>
      environmentManager.isServer()
        ? readRenderedInventory(lookup, signal)
        : runBrowserEffect(
            Effect.request(
              new ReadInstanceInventory({ lookup, signal }),
              inventoryResolver
            ),
            { signal }
          ),
    // Cached views let a revisited workspace render at once; its runtime
    // state still shows as checking until this mount confirms it.
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
        before.view === next.view
      )
        return replaceEqualDeep(previous, { ...next, data: before.data })
      return replaceEqualDeep(previous, incoming)
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => pollInterval(reference.kind, query.state.data),
    refetchIntervalInBackground: false,
  })
}
