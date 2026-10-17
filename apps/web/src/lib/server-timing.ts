import type { QueryClient, QueryKey } from "@tanstack/react-query"

// Server-rendered pages wait for every read a loader awaits. Reads go
// through the request's QueryClient, so timing its fetches shows where the
// first byte goes in the browser's Server-Timing panel.
interface RequestTiming {
  startedAt: number
  fetching: Map<string, number>
  reads: Map<string, { count: number; ms: number }>
}

const timings = new WeakMap<QueryClient, RequestTiming>()

export function trackServerTiming(queryClient: QueryClient): void {
  const timing: RequestTiming = {
    startedAt: performance.now(),
    fetching: new Map(),
    reads: new Map(),
  }
  timings.set(queryClient, timing)
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return
    const { action, query } = event
    if (action.type === "fetch") {
      timing.fetching.set(query.queryHash, performance.now())
      return
    }
    if (action.type !== "success" && action.type !== "error") return
    const startedAt = timing.fetching.get(query.queryHash)
    if (startedAt === undefined) return
    timing.fetching.delete(query.queryHash)
    const label = readLabel(query.queryKey)
    const read = timing.reads.get(label) ?? { count: 0, ms: 0 }
    // Reads of one kind run in parallel; the slowest one is what waits.
    read.count += 1
    read.ms = Math.max(read.ms, performance.now() - startedAt)
    timing.reads.set(label, read)
  })
}

/** The request's reads so far, slowest first, plus the time since it began. */
export function serverTimingHeader(queryClient: QueryClient): string | null {
  const timing = timings.get(queryClient)
  if (!timing) return null
  const reads = [...timing.reads]
    .sort(([, left], [, right]) => right.ms - left.ms)
    .map(
      ([label, { count, ms }]) =>
        `${label};dur=${ms.toFixed(1)}${count > 1 ? `;desc="${count} reads"` : ""}`
    )
  const load = performance.now() - timing.startedAt
  return [`load;dur=${load.toFixed(1)}`, ...reads].join(", ")
}

// Query keys can hold Relay and instance IDs. Name a read by its first two
// static segments only.
function readLabel(queryKey: QueryKey): string {
  return (
    queryKey
      .slice(0, 2)
      .filter((part): part is string => typeof part === "string")
      .join(".")
      .replace(/[^A-Za-z0-9_.-]/g, "-") || "query"
  )
}
