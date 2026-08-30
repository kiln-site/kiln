import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query"

import type {
  HearthRealtimeScope,
  HearthRealtimeTopic,
} from "@/lib/hearth-realtime-topics"
import { queryKeys } from "@/lib/query-options"
import type { BackupRunsPage } from "@/lib/backup-runs"
import {
  backupRunsInputFromQueryKey,
  patchBackupRunsData,
  resetBackupRunsToFirstPage,
} from "@/lib/backup-runs-cache"
import { getBackupRunForQuery } from "@/server/backups"

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
    exact(queryKeys.access.capabilities),
    exact(queryKeys.access.overview),
    prefix(["access", "instances"]),
  ],
  activity: [prefix(["activity"])],
  "backup-settings": [prefix(["backups", "policy"])],
  "backup-storage": [exact(queryKeys.backups.storage)],
  backups: [],
  "database-credentials": [prefix(["databases"])],
  "database-directory": [
    exact(queryKeys.databases.directory),
    exact(queryKeys.schedules.options),
  ],
  databases: [exact(queryKeys.databases.list)],
  domains: [prefix(["domains"])],
  "file-activity": [prefix(["file-activity"])],
  "instance-directory": [exact(queryKeys.schedules.options)],
  "instance-web-routes": [prefix(["web-routes"])],
  preferences: [exact(queryKeys.uiPreferences)],
  "relay-health": [exact(queryKeys.relays)],
  "relay-proxy": [prefix(["relays", "proxy"])],
  relays: [
    exact(queryKeys.relays),
    exact(queryKeys.databases.list),
    exact(queryKeys.databases.directory),
    exact(queryKeys.domains.settings),
    exact(queryKeys.schedules.all),
    exact(queryKeys.schedules.options),
    exact(queryKeys.tailscaleStacks),
    exact(queryKeys.access.overview),
    prefix(["activity"]),
    prefix(["relays", "proxy"]),
  ],
  schedules: [exact(queryKeys.schedules.all)],
  tailscale: [
    exact(queryKeys.tailscaleStacks),
    prefix(["tailscale", "relays"]),
  ],
} satisfies Record<HearthRealtimeTopic, ReadonlyArray<HearthRealtimeQueryScope>>

function queryScopes(
  topic: HearthRealtimeTopic,
  scope: HearthRealtimeScope | undefined
): ReadonlyArray<HearthRealtimeQueryScope> {
  if (topic === "access" && scope) {
    return [
      exact(queryKeys.access.capabilities),
      exact(queryKeys.access.overview),
      prefix(["access", "instances", scope.relayId]),
    ]
  }
  if (topic === "backup-settings" && scope) {
    return [prefix(["backups", "policy", scope.relayId])]
  }
  if (topic === "database-credentials" && scope?.databaseId) {
    return [
      exact(queryKeys.databases.credential(scope.relayId, scope.databaseId)),
    ]
  }
  if (topic === "domains" && scope?.instanceId) {
    return [exact(queryKeys.domains.instance(scope.relayId, scope.instanceId))]
  }
  if (topic === "file-activity" && scope?.instanceId) {
    return [exact(queryKeys.fileActivity(scope.relayId, scope.instanceId))]
  }
  if (topic === "instance-web-routes" && scope?.instanceId) {
    return [exact(queryKeys.relay.webRoutes(scope.relayId, scope.instanceId))]
  }
  if (topic === "relay-proxy" && scope) {
    return [exact(["relays", "proxy", scope.relayId])]
  }
  if (topic === "relays" && scope) {
    return [
      ...hearthRealtimeQueryScopes.relays.filter(
        ({ queryKey }) => queryKey[0] !== "relays"
      ),
      exact(queryKeys.relays),
      exact(["relays", "proxy", scope.relayId]),
      prefix(["databases", scope.relayId]),
    ]
  }
  if (topic === "tailscale" && scope) {
    return [
      exact(queryKeys.tailscaleStacks),
      exact(queryKeys.tailscale(scope.relayId)),
    ]
  }
  return hearthRealtimeQueryScopes[topic]
}

export async function refreshHearthRealtimeTopics(
  queryClient: QueryClient,
  topics: ReadonlyArray<HearthRealtimeTopic>,
  scope?: HearthRealtimeScope
): Promise<void> {
  if (topics.includes("backups") || topics.includes("relays")) {
    await refreshBackupRuns(queryClient, scope?.backupId)
  }
  const scopeHashes = new Set<string>()
  const requestedScopes: Array<HearthRealtimeQueryScope> = []
  for (const topic of topics) {
    for (const queryScope of queryScopes(topic, scope)) {
      const hash = `${queryScope.exact}:${JSON.stringify(queryScope.queryKey)}`
      if (scopeHashes.has(hash)) continue
      scopeHashes.add(hash)
      requestedScopes.push(queryScope)
    }
  }
  const scopesToRefresh = requestedScopes.filter(
    (candidate, candidateIndex) =>
      !requestedScopes.some(
        (possiblePrefix, prefixIndex) =>
          candidateIndex !== prefixIndex &&
          !possiblePrefix.exact &&
          possiblePrefix.queryKey.length < candidate.queryKey.length &&
          possiblePrefix.queryKey.every(
            (part, partIndex) =>
              JSON.stringify(part) ===
              JSON.stringify(candidate.queryKey[partIndex])
          )
      )
  )
  await Promise.all(
    scopesToRefresh.map(({ exact, queryKey }) =>
      queryClient.invalidateQueries({ exact, queryKey }, { throwOnError: true })
    )
  )
}

async function refreshBackupRuns(
  queryClient: QueryClient,
  backupId: string | undefined
): Promise<void> {
  const queries = queryClient.getQueryCache().findAll({
    queryKey: ["backups", "runs"],
  })
  await Promise.all(
    queries.map(async (query) => {
      const input = backupRunsInputFromQueryKey(query.queryKey)
      if (!input) return
      if (query.getObserversCount() === 0) {
        await queryClient.invalidateQueries({
          exact: true,
          queryKey: query.queryKey,
          refetchType: "none",
        })
        return
      }
      if (!backupId) {
        await resetBackupRunsToFirstPage(queryClient, input)
        return
      }
      const replacement = await getBackupRunForQuery({
        data: { ...input, backupId },
      })
      const current = queryClient.getQueryData<
        InfiniteData<BackupRunsPage, string | null>
      >(query.queryKey)
      const patch = patchBackupRunsData(
        current,
        backupId,
        replacement,
        input.sort
      )
      if (patch.kind === "reset") {
        await resetBackupRunsToFirstPage(queryClient, input)
        return
      }
      if (patch.kind === "update") {
        queryClient.setQueryData(query.queryKey, patch.data)
      }
    })
  )
}
