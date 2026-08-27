import type { QueryClient, QueryKey } from "@tanstack/react-query"

import type { HearthRealtimeTopic } from "@/lib/hearth-realtime-topics"
import { queryKeys } from "@/lib/query-options"

const hearthRealtimeQueryKeys = {
  relays: [queryKeys.relays],
  schedules: [queryKeys.schedules.all],
} satisfies Record<HearthRealtimeTopic, ReadonlyArray<QueryKey>>

export async function refreshHearthRealtimeTopics(
  queryClient: QueryClient,
  topics: ReadonlyArray<HearthRealtimeTopic>
): Promise<void> {
  const queryHashes = new Set<string>()
  const queryKeysToRefresh: Array<QueryKey> = []
  for (const topic of topics) {
    for (const queryKey of hearthRealtimeQueryKeys[topic]) {
      const hash = JSON.stringify(queryKey)
      if (queryHashes.has(hash)) continue
      queryHashes.add(hash)
      queryKeysToRefresh.push(queryKey)
    }
  }
  await Promise.all(
    queryKeysToRefresh.map((queryKey) =>
      queryClient.invalidateQueries({ exact: true, queryKey })
    )
  )
}
