import type { QueryClient, QueryKey } from "@tanstack/react-query"

import type { HearthRealtimeTopic } from "@/lib/hearth-realtime-topics"
import { queryKeys } from "@/lib/query-options"

interface HearthRealtimeQueryScope {
  exact: boolean
  queryKey: QueryKey
}

const exact = (queryKey: QueryKey): HearthRealtimeQueryScope => ({
  exact: true,
  queryKey,
})

const prefix = (queryKey: QueryKey): HearthRealtimeQueryScope => ({
  exact: false,
  queryKey,
})

const hearthRealtimeQueryScopes = {
  access: [prefix(["access"])],
  domains: [prefix(["domains"])],
  "file-activity": [prefix(["file-activity"])],
  preferences: [exact(queryKeys.uiPreferences)],
  relays: [exact(queryKeys.relays)],
  schedules: [exact(queryKeys.schedules.all)],
} satisfies Record<HearthRealtimeTopic, ReadonlyArray<HearthRealtimeQueryScope>>

export async function refreshHearthRealtimeTopics(
  queryClient: QueryClient,
  topics: ReadonlyArray<HearthRealtimeTopic>
): Promise<void> {
  const scopeHashes = new Set<string>()
  const scopesToRefresh: Array<HearthRealtimeQueryScope> = []
  for (const topic of topics) {
    for (const scope of hearthRealtimeQueryScopes[topic]) {
      const hash = `${scope.exact}:${JSON.stringify(scope.queryKey)}`
      if (scopeHashes.has(hash)) continue
      scopeHashes.add(hash)
      scopesToRefresh.push(scope)
    }
  }
  await Promise.all(
    scopesToRefresh.map(({ exact, queryKey }) =>
      queryClient.invalidateQueries({ exact, queryKey }, { throwOnError: true })
    )
  )
}
