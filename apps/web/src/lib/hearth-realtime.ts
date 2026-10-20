import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query"

import type {
  HearthRealtimeScope,
  HearthRealtimeTopic,
} from "@/lib/hearth-realtime-topics"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import { queryKeys } from "@/lib/query-options"
import {
  backupRunsInputFromQueryKey,
  type BackupRunsPage,
} from "@/lib/backup-runs"
import {
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
    exact(queryKeys.relay.reachability),
    exact(queryKeys.servers.directory),
    prefix(queryKeys.servers.navigation),
    exact(queryKeys.apps.directory),
    exact(queryKeys.databases.directory),
    prefix(["infra-directory"]),
    prefix(["instance-inventory"]),
    exact(queryKeys.access.capabilities),
    prefix(["resource-access"]),
    prefix(["access-resources"]),
    prefix(["my-resource-invitations"]),
    prefix(["resource-invitation"]),
    prefix(["platform-invitations"]),
    prefix(["users"]),
  ],
  activity: [prefix(["activity"])],
  "app-deployments": [prefix(["app-deployments"])],
  "app-directory": [exact(queryKeys.apps.directory)],
  apps: [
    prefix(["apps"]),
    prefix(["instance-inventory", "app"]),
    prefix(["web-routes"]),
    // Whether an app shows its repository follows its source type.
    prefix(["app-deployments", "summary"]),
  ],
  "backup-settings": [
    prefix(["backups", "policy"]),
    prefix(["backups", "usage"]),
  ],
  "backup-storage": [exact(queryKeys.backups.storage)],
  backups: [prefix(["backups", "usage"])],
  "database-credentials": [prefix(["databases"])],
  "database-directory": [
    exact(queryKeys.databases.directory),
    exact(queryKeys.schedules.options),
  ],
  databases: [prefix(["instance-inventory", "database"])],
  domains: [
    exact(queryKeys.servers.directory),
    prefix(queryKeys.servers.navigation),
    prefix(["domains"]),
  ],
  favorites: [exact(queryKeys.instanceFavorites)],
  "file-activity": [prefix(["file-activity"])],
  "github-sync": [prefix(["github-sync"])],
  "instance-directory": [
    exact(queryKeys.servers.directory),
    prefix(queryKeys.servers.navigation),
    exact(queryKeys.schedules.options),
  ],
  "instance-web-routes": [prefix(["web-routes"])],
  notifications: [exact(queryKeys.notifications)],
  preferences: [exact(queryKeys.uiPreferences)],
  "relay-health": [
    exact(queryKeys.relays),
    prefix(["instance-inventory", "relay"]),
  ],
  "relay-proxy": [
    prefix(["relays", "proxy"]),
    exact(queryKeys.relayProxyModes),
    prefix(["web-routes"]),
  ],
  relays: [
    prefix(["infra-directory"]),
    prefix(["instance-inventory"]),
    exact(queryKeys.access.capabilities),
    exact(queryKeys.relay.reachability),
    exact(queryKeys.relays),
    exact(queryKeys.databases.directory),
    exact(queryKeys.servers.directory),
    prefix(queryKeys.servers.navigation),
    exact(queryKeys.apps.directory),
    exact(queryKeys.domains.settings),
    exact(queryKeys.schedules.all),
    exact(queryKeys.schedules.options),
    exact(queryKeys.tailscaleStacks),
    prefix(["activity"]),
    prefix(["relays", "proxy"]),
    exact(queryKeys.relayProxyModes),
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
    // One Relay's access edit: refresh that Relay's records and what the
    // viewer can reach, never the platform user or invitation lists.
    return [
      exact(queryKeys.relay.reachability),
      exact(queryKeys.servers.directory),
      prefix(queryKeys.servers.navigation),
      exact(queryKeys.apps.directory),
      exact(queryKeys.databases.directory),
      prefix(["infra-directory"]),
      prefix(["instance-inventory"]),
      exact(queryKeys.access.capabilities),
      prefix(["resource-access", scope.relayId]),
      prefix(["access-resources"]),
      prefix(["my-resource-invitations"]),
      prefix(["resource-invitation"]),
    ]
  }
  if (topic === "backup-settings" && scope) {
    return [
      prefix(["backups", "policy", scope.relayId]),
      prefix(["backups", "usage", scope.relayId]),
    ]
  }
  if (topic === "database-credentials" && scope?.databaseId) {
    return [
      exact(queryKeys.databases.credential(scope.relayId, scope.databaseId)),
    ]
  }
  if (topic === "domains" && scope?.instanceId) {
    return [
      exact(queryKeys.servers.directory),
      prefix(queryKeys.servers.navigation),
      exact(queryKeys.domains.settings),
      exact(queryKeys.domains.instance(scope.relayId, scope.instanceId)),
    ]
  }
  if (topic === "file-activity" && scope?.instanceId) {
    return [exact(queryKeys.fileActivity(scope.relayId, scope.instanceId))]
  }
  if (topic === "apps" && scope) {
    return [
      prefix(["apps"]),
      prefix(instanceInventoryScope({ kind: "app", relayId: scope.relayId })),
      exact(queryKeys.relayWebRoutes(scope.relayId)),
    ]
  }
  if (topic === "databases" && scope) {
    return [
      prefix(
        instanceInventoryScope({ kind: "database", relayId: scope.relayId })
      ),
    ]
  }
  if (topic === "instance-web-routes" && scope?.instanceId) {
    return [
      exact(queryKeys.relay.webRoutes(scope.relayId, scope.instanceId)),
      exact(queryKeys.relayWebRoutes(scope.relayId)),
    ]
  }
  if (topic === "relay-proxy" && scope) {
    return [
      prefix(queryKeys.relayProxy(scope.relayId)),
      exact(queryKeys.relayProxyModes),
      exact(queryKeys.relayWebRoutes(scope.relayId)),
      // The Traefik config only exists in Bundled mode.
      prefix(queryKeys.relayHostFiles(scope.relayId)),
    ]
  }
  if (topic === "relays" && scope) {
    return [
      ...hearthRealtimeQueryScopes.relays.filter(
        ({ queryKey }) => queryKey[0] !== "relays"
      ),
      exact(queryKeys.relays),
      prefix(queryKeys.relayProxy(scope.relayId)),
      exact(queryKeys.relayProxyModes),
      exact(queryKeys.relayWebRoutes(scope.relayId)),
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
  } else if (topics.includes("database-directory")) {
    await invalidateNameDependentBackupRuns(queryClient)
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

export function invalidateNameDependentBackupRuns(
  queryClient: QueryClient
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const input = backupRunsInputFromQueryKey(query.queryKey)
      return Boolean(input && (input.search.trim() || input.sort === "target"))
    },
  })
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
