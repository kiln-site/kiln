import type { QueryClient, QueryKey } from "@tanstack/react-query"

import type {
  HearthRealtimeScope,
  HearthRealtimeTopic,
} from "@/lib/hearth-realtime-topics"
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
  access: [
    exact(queryKeys.access.overview),
    prefix(["access", "instances"]),
  ],
  domains: [prefix(["domains"])],
  "file-activity": [prefix(["file-activity"])],
  preferences: [exact(queryKeys.uiPreferences)],
  relays: [exact(queryKeys.relays)],
  schedules: [exact(queryKeys.schedules.all)],
} satisfies Record<HearthRealtimeTopic, ReadonlyArray<HearthRealtimeQueryScope>>

function queryScopes(
  topic: HearthRealtimeTopic,
  scope: HearthRealtimeScope | undefined
): ReadonlyArray<HearthRealtimeQueryScope> {
  if (topic === "access" && scope) {
    return [
      exact(queryKeys.access.overview),
      prefix(["access", "instances", scope.relayId]),
    ]
  }
  if (topic === "domains" && scope?.instanceId) {
    return [exact(queryKeys.domains.instance(scope.relayId, scope.instanceId))]
  }
  if (topic === "file-activity" && scope?.instanceId) {
    return [exact(queryKeys.fileActivity(scope.relayId, scope.instanceId))]
  }
  return hearthRealtimeQueryScopes[topic]
}

export async function refreshHearthRealtimeTopics(
  queryClient: QueryClient,
  topics: ReadonlyArray<HearthRealtimeTopic>,
  scope?: HearthRealtimeScope
): Promise<void> {
  const scopeHashes = new Set<string>()
  const scopesToRefresh: Array<HearthRealtimeQueryScope> = []
  for (const topic of topics) {
    for (const queryScope of queryScopes(topic, scope)) {
      const hash = `${queryScope.exact}:${JSON.stringify(queryScope.queryKey)}`
      if (scopeHashes.has(hash)) continue
      scopeHashes.add(hash)
      scopesToRefresh.push(queryScope)
    }
  }
  await Promise.all(
    scopesToRefresh.map(({ exact, queryKey }) =>
      queryClient.invalidateQueries({ exact, queryKey }, { throwOnError: true })
    )
  )
}
