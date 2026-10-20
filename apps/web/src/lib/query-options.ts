import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
} from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import type {
  BackupTarget,
  RelayConsoleResource,
  RelayFileEntry,
  RelayInstance,
} from "@workspace/contracts"

import { getAccessCapabilities, getInvitationPreview } from "@/server/access"
import { getActivity } from "@/server/activity"
import {
  getBackupPolicy,
  getBackupRunsPage,
  getBackupUsage,
} from "@/server/backups"
import { getBackupStorage } from "@/server/backup-storage"
import {
  getBrickCatalog,
  getBrickIconPresentations,
  getBrickVersions,
  getInstanceRecipe,
  getInstanceStartup,
} from "@/server/bricks"
import {
  getBrickCatalogDetails,
  listBrickCatalogs,
} from "@/server/brick-catalogs"
import {
  getGitHubSourceRepositoryCount,
  getGitHubSources,
  getGitHubSyncOverview,
  getGitHubSyncRuns,
  listGitHubBranches,
  listGitHubFolders,
  listGitHubRepositories,
} from "@/server/github-sync"
import { getDomainSettings, getInstanceDomain } from "@/server/domains"
import { getHearthEdge } from "@/server/hearth-edge"
import { getResourceLimitsCapacity } from "@/server/resource-limits"
import {
  getManagedDatabaseCredential,
  getManagedDatabaseContainer,
  getManagedDatabaseDirectory,
} from "@/server/databases"
import {
  isMinecraftUsername,
  minecraftUsernameKey,
} from "@/lib/minecraft-profile"
import { getUiPreferences } from "@/server/preferences"
import {
  getInstanceFavorites,
  setInstanceFavorite,
} from "@/server/instance-favorites"
import {
  instanceFavoriteKey,
  type InstanceFavorite,
} from "@/lib/instance-favorites"
import { getMinecraftProfile } from "@/server/minecraft"
import { getRelayResources } from "@/server/relay-host"
import { isDatabaseFilePath } from "@/lib/database-files"
import { traceFileWork } from "@/lib/file-timing"
import { reconcilePendingPowerSnapshot } from "@/lib/instance-power-state"
import { systemUpdateOverviewRefetchPolicy } from "@/lib/system-update-presence"
import {
  getRelayConnectionState,
  getRelayReachability,
  getRelayDirectoryPage,
  getRelayFileEntry,
  getRelayFile,
  getRelayFileActivity,
  getInstanceWebRoutes,
  getRelayNodeReadings,
  getRelayProxyModes,
  getRelaySnapshot,
  getRelayTree,
} from "@/server/relay"
import {
  getRelayOwnerMinecraftProfiles,
  getRelayProxy,
  getRelayWebRoutes,
  getRelayHostFiles,
  getRelayTailscale,
  getRelays,
} from "@/server/relays"
import { getTailscaleStacks } from "@/server/tailscale"
import { getAuthState } from "@/server/auth"
import type { ReleaseHistoryCursor } from "@/effect/kiln-release-feed"
import {
  getRelayRelease,
  getReleaseHistory,
  getUpdateOverview,
} from "@/server/updates"
import {
  getResourceOwner,
  getResourceOwnerMinecraftProfileId,
  getResourceUserCount,
} from "@/server/resource-access"
import { getScheduleOptions, getSchedules } from "@/server/schedules"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { readRelayReachability } from "@/lib/relay-reachability"
import type { ServerNavigationInput } from "@/lib/server-navigation"
import {
  getInfraServerDirectory,
  getServerNavigation,
} from "@/server/infra-directory"
import {
  getAppConfig,
  getAppDirectory,
  getAppOwner,
  getAppOwnerMinecraftProfileId,
  getAppWebRoutes,
} from "@/server/apps"
import {
  backupRunScopesEqual,
  backupRunsInputFromQueryKey,
  backupRunsQueryKey,
  normalizeBackupRunsQuery,
  type BackupRunsQuery,
} from "@/lib/backup-runs"

export type UiPreferences = Awaited<ReturnType<typeof getUiPreferences>>

export type RelayConnection = Awaited<
  ReturnType<typeof getRelayConnectionState>
>

const connectedRelayPollDelayMs = 5_000
const disconnectedRelayPollDelayMs = 15_000
const relayPollHeaders = { "x-kiln-request-purpose": "relay-poll" }

export const queryKeys = {
  auth: {
    state: ["auth", "state"] as const,
  },
  minecraft: {
    profile: (displayName: string) =>
      ["minecraft", "profile", displayName] as const,
    relayOwners: (ownerNames: string) =>
      ["minecraft", "relay-owner-profiles", ownerNames] as const,
  },
  access: {
    capabilities: ["access", "capabilities"] as const,
    invitation: (token: string) => ["access", "invitation", token] as const,
  },
  activity: (from?: string, to?: string) => ["activity", { from, to }] as const,
  backups: {
    runs: backupRunsQueryKey,
    policy: (relayId: string, target: BackupTarget) =>
      ["backups", "policy", relayId, target.kind, target.id] as const,
    storage: ["backups", "storage"] as const,
    usage: (relayId: string, target: BackupTarget) =>
      ["backups", "usage", relayId, target.kind, target.id] as const,
  },
  bricks: ["bricks", "catalog"] as const,
  brickIcons: ["bricks", "icons"] as const,
  brickCatalogs: {
    all: ["bricks", "catalogs"] as const,
    detail: (catalogId: string) => ["bricks", "catalogs", catalogId] as const,
  },
  brickVersions: (type: string, variant: string) =>
    ["bricks", "versions", type, variant] as const,
  domains: {
    instance: (relayId: string, instanceId: string) =>
      ["domains", "instances", relayId, instanceId] as const,
    settings: ["domains", "settings"] as const,
  },
  github: {
    branches: (connectionId: string, repository: string) =>
      ["github-sync", "branches", connectionId, repository] as const,
    folders: (connectionId: string, repository: string, branch: string) =>
      ["github-sync", "folders", connectionId, repository, branch] as const,
    overview: ["github-sync", "overview"] as const,
    repositories: (connectionId: string) =>
      ["github-sync", "repositories", connectionId] as const,
    repositoryCount: (connectionId: string) =>
      ["github-sync", "repository-count", connectionId] as const,
    runs: ["github-sync", "runs"] as const,
    sources: ["github-sync", "sources"] as const,
  },
  hearthEdge: ["hearth", "edge"] as const,
  servers: {
    directory: ["servers", "directory"] as const,
    navigation: ["servers", "navigation"] as const,
  },
  apps: {
    all: ["apps"] as const,
    config: (relayId: string, appId: string) =>
      ["apps", relayId, appId, "config"] as const,
    directory: ["apps", "directory"] as const,
    webRoutes: (relayId: string, appId: string) =>
      ["apps", relayId, appId, "web-routes"] as const,
  },
  databases: {
    all: ["databases"] as const,
    credential: (relayId: string, databaseId: string) =>
      ["databases", relayId, databaseId, "credential"] as const,
    directory: ["databases", "directory"] as const,
    // Outside "databases", so list refreshes don't measure the volume again.
    container: (relayId: string, databaseId: string) =>
      ["database-container", relayId, databaseId] as const,
    // Outside "databases": it asks the Relay for every instance's limits.
    capacity: (relayId: string, databaseId: string) =>
      resourceLimitsCapacityKey(relayId, "database", databaseId),
  },
  fileActivity: (relayId: string, instanceId: string) =>
    ["file-activity", relayId, instanceId] as const,
  relay: {
    all: ["relay"] as const,
    connection: ["relay", "connection"] as const,
    reachability: ["relay", "reachability"] as const,
    console: (relayId: string, resource: RelayConsoleResource) =>
      [
        "relay",
        relayId,
        `${resource.kind}s`,
        resource.id,
        "console",
        resource.stream ?? null,
      ] as const,
    file: (relayId: string, instanceId: string, path: string) =>
      [
        "relay",
        relayId,
        "instances",
        instanceId,
        "files",
        "content",
        path,
      ] as const,
    recipe: (relayId: string, instanceId: string) =>
      ["relay", relayId, "instances", instanceId, "recipe"] as const,
    snapshot: ["relay", "snapshot"] as const,
    // One game server's page: its server and node, and its Relay.
    servers: ["relay", "server"] as const,
    server: (serverId: string) => ["relay", "server", serverId] as const,
    instances: ["relay", "instances"] as const,
    nodeReadings: ["relay", "node-readings"] as const,
    resources: (relayId: string) => ["relay", "resources", relayId] as const,
    webRoutes: (relayId: string, instanceId: string) =>
      ["web-routes", relayId, instanceId] as const,
    tree: (relayId: string, instanceId: string) =>
      ["relay", relayId, "instances", instanceId, "files", "tree"] as const,
  },
  schedules: {
    all: ["schedules"] as const,
    options: ["schedules", "options"] as const,
  },
  relays: ["relays"] as const,
  relayProxy: (relayId: string) => ["relays", "proxy", relayId] as const,
  relayProxyModes: ["relays", "proxy-modes"] as const,
  // Beside each game server's own routes, so route changes refresh both.
  relayWebRoutes: (relayId: string) => ["web-routes", relayId] as const,
  relayHostFiles: (relayId: string) =>
    ["relays", "host-files", relayId] as const,
  tailscale: (relayId: string) => ["tailscale", "relays", relayId] as const,
  tailscaleStacks: ["tailscale", "stacks"] as const,
  updates: ["updates", "overview"] as const,
  releaseHistory: ["updates", "release-history"] as const,
  relayRelease: (relayId: string, version: string) =>
    ["updates", "relay", relayId, version] as const,
  instanceFavorites: ["instance-favorites"] as const,
  notifications: ["notifications"] as const,
  uiPreferences: ["ui", "preferences"] as const,
}

export function schedulesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.schedules.all,
    queryFn: () => getSchedules(),
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
    staleTime: 5_000,
  })
}

export function scheduleOptionsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.schedules.options,
    queryFn: () => getScheduleOptions(),
    staleTime: 30_000,
  })
}

export function replaceRelaySnapshotInstance(
  snapshot: RelayFleetSnapshot | undefined,
  updated: RelayInstance & { relayId: string }
): RelayFleetSnapshot | undefined {
  return snapshot
    ? {
        ...snapshot,
        instances: snapshot.instances.map((instance) =>
          instance.id === updated.id && instance.relayId === updated.relayId
            ? mergeRelaySnapshotInstance(instance, updated)
            : instance
        ),
      }
    : snapshot
}

function mergeRelaySnapshotInstance(
  current: RelayFleetSnapshot["instances"][number],
  updated: RelayInstance & { relayId: string }
): RelayFleetSnapshot["instances"][number] {
  const endpointUnchanged =
    current.publicHost === updated.publicHost &&
    current.publicPort === updated.publicPort
  return {
    ...updated,
    connectAddress: endpointUnchanged
      ? current.connectAddress
      : updated.connectAddress,
    relayName: current.relayName,
    relayStatus: current.relayStatus,
    routeId: current.routeId,
  }
}

export function authStateQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.auth.state,
    queryFn: () => getAuthState(),
    staleTime: 30_000,
  })
}

export function minecraftProfileQueryOptions(displayName: string) {
  const username = minecraftUsernameKey(displayName)
  return queryOptions({
    queryKey: queryKeys.minecraft.profile(username),
    queryFn: ({ signal }) => getMinecraftProfile({ signal }),
    enabled: isMinecraftUsername(displayName),
    gcTime: 60 * 60_000,
    retry: false,
    staleTime: 60 * 60_000,
  })
}

/** Keyed by the visible owners so pairing or sharing a Relay refetches. */
export function relayOwnerMinecraftProfilesQueryOptions(ownerNames: string) {
  return queryOptions({
    queryKey: queryKeys.minecraft.relayOwners(ownerNames),
    queryFn: ({ signal }) => getRelayOwnerMinecraftProfiles({ signal }),
    enabled: ownerNames.length > 0,
    gcTime: 60 * 60_000,
    retry: false,
    staleTime: 60 * 60_000,
  })
}

export function backupRunsInfiniteQueryOptions(input: BackupRunsQuery) {
  const normalized = normalizeBackupRunsQuery(input)
  const { cursor: _, ...query } = normalized
  return infiniteQueryOptions({
    queryKey: queryKeys.backups.runs(query),
    queryFn: ({ pageParam, signal }) =>
      getBackupRunsPage({
        data: { ...query, cursor: pageParam },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: (previousData, previousQuery) => {
      const previousInput = previousQuery
        ? backupRunsInputFromQueryKey(previousQuery.queryKey)
        : null
      return backupRunScopesEqual(previousInput?.scope, query.scope)
        ? previousData
        : undefined
    },
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

export function backupStorageQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.backups.storage,
    queryFn: () => getBackupStorage(),
    staleTime: 30_000,
  })
}

// How many people the Access page lists for a resource, with its owner.
// Keyed under the Access page's own queries, so access changes refresh it.
export function resourceUserCountQueryOptions(scope: {
  relayId: string
  resourceId: string
  resourceType: "database" | "instance" | "relay"
}) {
  return queryOptions({
    queryKey: [
      "resource-access",
      scope.relayId,
      scope.resourceType,
      scope.resourceId,
      "count",
    ] as const,
    queryFn: () => getResourceUserCount({ data: scope }),
    retry: false,
    staleTime: Infinity,
  })
}

// Who owns a resource, or null when the platform does. Keyed under the
// Access page's own queries, so a transfer refreshes it; nothing announces
// an owner renaming themselves, so it goes stale after a while too.
export function resourceOwnerQueryOptions(scope: {
  relayId: string
  resourceId: string
  resourceType: "database" | "instance" | "relay"
}) {
  return queryOptions({
    queryKey: [
      "resource-access",
      scope.relayId,
      scope.resourceType,
      scope.resourceId,
      "owner",
    ] as const,
    queryFn: () => getResourceOwner({ data: scope }),
    retry: false,
    staleTime: 30_000,
  })
}

// The owner's Minecraft head, apart from the owner so their card shows
// before Mojang answers. Keyed by the owner's name too, so a new owner or
// name looks the head up again.
export function resourceOwnerMinecraftProfileQueryOptions(
  scope: {
    relayId: string
    resourceId: string
    resourceType: "database" | "instance" | "relay"
  },
  ownerName: string
) {
  return queryOptions({
    queryKey: [
      "resource-access",
      scope.relayId,
      scope.resourceType,
      scope.resourceId,
      "owner",
      "minecraft",
      ownerName,
    ] as const,
    queryFn: ({ signal }) =>
      getResourceOwnerMinecraftProfileId({ data: scope, signal }),
    gcTime: 60 * 60_000,
    retry: false,
    staleTime: 60 * 60_000,
  })
}

// How many backups a target keeps, against its quantity limit. Backup and
// limit changes refresh it.
export function backupUsageQueryOptions(relayId: string, target: BackupTarget) {
  return queryOptions({
    queryKey: queryKeys.backups.usage(relayId, target),
    queryFn: () => getBackupUsage({ data: { relayId, target } }),
    retry: false,
    staleTime: Infinity,
  })
}

export function backupPolicyQueryOptions(
  relayId: string,
  target: BackupTarget
) {
  return queryOptions({
    queryKey: queryKeys.backups.policy(relayId, target),
    queryFn: () => getBackupPolicy({ data: { relayId, target } }),
    staleTime: 5_000,
  })
}

export function relayConnectionQueryOptions(queryClient: QueryClient) {
  return queryOptions({
    queryKey: queryKeys.relay.connection,
    queryFn: async () => {
      const connection = await getRelayConnectionState({
        headers: relayPollHeaders,
      })
      if (
        connection.status === "connected" ||
        connection.status === "unreachable"
      ) {
        // Each router owns one QueryClient per SSR request or browser session.
        // Prime that same client from the connection's canonical snapshot so
        // snapshot consumers do not make a second Relay request.
        const snapshot = reconcilePendingPowerSnapshot(connection.snapshot)
        return connectionWithCanonicalSnapshot(queryClient, {
          ...connection,
          snapshot,
        })
      }
      return connection
    },
    refetchInterval: (query) => {
      if (query.state.data?.status === "paused") return false
      return query.state.data?.status === "connected"
        ? false
        : disconnectedRelayPollDelayMs
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (query) => query.state.data?.status !== "connected",
    staleTime: connectedRelayPollDelayMs,
  })
}

export type RelayReachability = Awaited<ReturnType<typeof getRelayReachability>>

/**
 * Which visible Relays Hearth is connected to, for connection toasts.
 * Realtime Relay status events patch it; it polls only while one is away.
 */
export function relayReachabilityQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.relay.reachability,
    queryFn: (context) =>
      readRelayReachability(context, () =>
        getRelayReachability({
          headers: relayPollHeaders,
          signal: context.signal,
        })
      ),
    refetchInterval: (query) =>
      query.state.data?.some((relay) => relay.status === "unreachable")
        ? disconnectedRelayPollDelayMs
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (query) =>
      query.state.data?.some((relay) => relay.status === "unreachable") ?? true,
    staleTime: connectedRelayPollDelayMs,
  })
}

/** Polled only while a Relay memory cell is mounted and the tab is visible. */
export type RelayNodeReading = Awaited<
  ReturnType<typeof getRelayNodeReadings>
>[number]

export function relayNodeReadingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.relay.nodeReadings,
    queryFn: ({ signal }) => getRelayNodeReadings({ signal }),
    refetchInterval: connectedRelayPollDelayMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: connectedRelayPollDelayMs,
  })
}

/** The Relay's own usage, polled while its meters are mounted and visible. */
export function relayResourcesQueryOptions(relayId: string) {
  return queryOptions({
    queryKey: queryKeys.relay.resources(relayId),
    queryFn: ({ signal }) => getRelayResources({ data: { relayId }, signal }),
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 2_000,
  })
}

export function relaySnapshotQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.relay.snapshot,
    queryFn: ({ client }) => fetchRelaySnapshot(client),
    refetchOnWindowFocus: false,
    staleTime: connectedRelayPollDelayMs,
  })
}

export async function fetchRelaySnapshot(
  queryClient: QueryClient
): Promise<RelayFleetSnapshot> {
  return snapshotWithCanonicalState(
    queryClient,
    reconcilePendingPowerSnapshot(await getRelaySnapshot())
  )
}

function snapshotWithCanonicalState(
  queryClient: QueryClient,
  fetched: RelayFleetSnapshot
): RelayFleetSnapshot {
  const connection = queryClient.getQueryData<RelayConnection>(
    queryKeys.relay.connection
  )
  const cached = queryClient.getQueryData<RelayFleetSnapshot>(
    queryKeys.relay.snapshot
  )
  // A connection poll can finish behind newer SSE deltas. Keep the live
  // snapshot canonical even while every Relay is unreachable; the stream
  // watchdog performs the authoritative recovery if SSE itself has stalled.
  const snapshot =
    (connection?.status === "connected" ||
      connection?.status === "unreachable") &&
    cached
      ? cached
      : fetched
  queryClient.setQueryData(queryKeys.relay.instances, snapshot.instances)
  return snapshot
}

function connectionWithCanonicalSnapshot(
  queryClient: QueryClient,
  connection: Extract<RelayConnection, { status: "connected" | "unreachable" }>
): Extract<RelayConnection, { status: "connected" | "unreachable" }> {
  const snapshot = snapshotWithCanonicalState(queryClient, connection.snapshot)
  queryClient.setQueryData(queryKeys.relay.snapshot, snapshot)
  return { ...connection, snapshot }
}

export function managedDatabaseDirectoryQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.databases.directory,
    queryFn: ({ signal }) => getManagedDatabaseDirectory({ signal }),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
}

export function serverDirectoryQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.servers.directory,
    queryFn: ({ signal }) => getInfraServerDirectory({ signal }),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
}

export function serverNavigationQueryOptions(input: ServerNavigationInput) {
  return queryOptions({
    queryKey: [
      ...queryKeys.servers.navigation,
      "serverId" in input ? input.serverId : null,
      "selectedRouteId" in input ? input.selectedRouteId : null,
    ],
    queryFn: ({ signal }) => getServerNavigation({ data: input, signal }),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
}

export function appDirectoryQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.apps.directory,
    queryFn: ({ signal }) => getAppDirectory({ signal }),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
}

export function appWebRoutesQueryOptions(relayId: string, appId: string) {
  return queryOptions({
    queryKey: queryKeys.apps.webRoutes(relayId, appId),
    queryFn: () => getAppWebRoutes({ data: { appId, relayId } }),
    staleTime: 10_000,
  })
}

// Who created the app, outside "apps" so its changes don't refetch it. Like
// a resource's owner, it goes stale after a while for owners who rename
// themselves.
export function appOwnerQueryOptions(relayId: string, appId: string) {
  return queryOptions({
    queryKey: ["app-owner", relayId, appId] as const,
    queryFn: () => getAppOwner({ data: { appId, relayId } }),
    retry: false,
    staleTime: 30_000,
  })
}

// The owner's Minecraft head, keyed by their name so a new name looks it up
// again.
export function appOwnerMinecraftProfileQueryOptions(
  relayId: string,
  appId: string,
  ownerName: string
) {
  return queryOptions({
    queryKey: ["app-owner", relayId, appId, "minecraft", ownerName] as const,
    queryFn: ({ signal }) =>
      getAppOwnerMinecraftProfileId({ data: { appId, relayId }, signal }),
    gcTime: 60 * 60_000,
    retry: false,
    staleTime: 60 * 60_000,
  })
}

export function appConfigQueryOptions(relayId: string, appId: string) {
  return queryOptions({
    queryKey: queryKeys.apps.config(relayId, appId),
    queryFn: () => getAppConfig({ data: { appId, relayId } }),
    staleTime: 30_000,
  })
}

export function managedDatabaseCredentialQueryOptions(
  relayId: string,
  databaseId: string
) {
  return queryOptions({
    queryKey: queryKeys.databases.credential(relayId, databaseId),
    queryFn: () =>
      getManagedDatabaseCredential({ data: { databaseId, relayId } }),
    staleTime: Infinity,
  })
}

// Docker walks the volume to measure it, so this is read only while the Info
// page shows it, and not refetched often.
export function managedDatabaseContainerQueryOptions(
  relayId: string,
  databaseId: string
) {
  return queryOptions({
    queryKey: queryKeys.databases.container(relayId, databaseId),
    queryFn: () =>
      getManagedDatabaseContainer({ data: { databaseId, relayId } }),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

function resourceLimitsCapacityKey(
  relayId: string,
  kind: "app" | "database",
  id: string
) {
  return ["resource-limits-capacity", relayId, kind, id] as const
}

// What the node can still give an app or database, for its limits editor;
// null for those who can't see the node.
export function resourceLimitsCapacityQueryOptions(
  relayId: string,
  kind: "app" | "database",
  id: string
) {
  return queryOptions({
    queryKey: resourceLimitsCapacityKey(relayId, kind, id),
    queryFn: () => getResourceLimitsCapacity({ data: { id, kind, relayId } }),
    retry: false,
    staleTime: 30_000,
  })
}

export function managedDatabaseCapacityQueryOptions(
  relayId: string,
  databaseId: string
) {
  return resourceLimitsCapacityQueryOptions(relayId, "database", databaseId)
}

export function accessCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.access.capabilities,
    queryFn: () => getAccessCapabilities(),
    staleTime: 30_000,
  })
}

export function activityQueryOptions(from?: string, to?: string) {
  return queryOptions({
    queryKey: queryKeys.activity(from, to),
    queryFn: () =>
      getActivity({
        data: {
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      }),
    staleTime: 10_000,
  })
}

export function invitationPreviewQueryOptions(token: string) {
  return queryOptions({
    queryKey: queryKeys.access.invitation(token),
    queryFn: () => getInvitationPreview({ data: { token } }),
    staleTime: 30_000,
  })
}

export function instanceFavoritesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.instanceFavorites,
    queryFn: () => getInstanceFavorites(),
    staleTime: Infinity,
  })
}

const setInstanceFavoriteMutationKey = ["instance-favorites", "set"] as const

function withInstanceFavorite(
  favorites: ReadonlyArray<InstanceFavorite>,
  favorite: InstanceFavorite,
  starred: boolean
): Array<InstanceFavorite> {
  const key = instanceFavoriteKey(favorite)
  const rest = favorites.filter(
    (candidate) => instanceFavoriteKey(candidate) !== key
  )
  return starred ? [...rest, favorite] : rest
}

export function setInstanceFavoriteMutationOptions(
  queryClient: QueryClient,
  onFailure: (error: Error) => void
) {
  const { queryKey } = instanceFavoritesQueryOptions()
  return mutationOptions({
    mutationKey: setInstanceFavoriteMutationKey,
    mutationFn: (input: { favorite: InstanceFavorite; starred: boolean }) =>
      setInstanceFavorite({ data: input }),
    onMutate: async ({ favorite, starred }) => {
      await queryClient.cancelQueries({ queryKey })
      const key = instanceFavoriteKey(favorite)
      const wasStarred =
        queryClient
          .getQueryData(queryKey)
          ?.some((candidate) => instanceFavoriteKey(candidate) === key) ?? false
      queryClient.setQueryData(queryKey, (current = []) =>
        withInstanceFavorite(current, favorite, starred)
      )
      return { wasStarred }
    },
    onError: (error, { favorite }, context) => {
      // Undo only this favorite; other toggles may have landed meanwhile.
      if (context) {
        queryClient.setQueryData(queryKey, (current = []) =>
          withInstanceFavorite(current, favorite, context.wasStarred)
        )
      }
      onFailure(error)
    },
    onSettled: async () => {
      // Reconcile once the last overlapping toggle settles, so an earlier
      // refetch can't overwrite a later optimistic change.
      const pending = queryClient.isMutating({
        mutationKey: setInstanceFavoriteMutationKey,
      })
      if (pending === 1) await queryClient.invalidateQueries({ queryKey })
    },
  })
}

export function uiPreferencesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.uiPreferences,
    queryFn: () => getUiPreferences(),
    staleTime: Infinity,
  })
}

export function relaysQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.relays,
    queryFn: () => getRelays(),
    staleTime: Infinity,
  })
}

/** Which readable Relays run which proxy, read from Hearth's connections. */
export function relayProxyModesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.relayProxyModes,
    queryFn: () => getRelayProxyModes(),
    staleTime: 30_000,
  })
}

/** The web routes a Relay's proxy serves, with the resource each reaches. */
export function relayWebRoutesQueryOptions(relayId: string) {
  return queryOptions({
    queryKey: queryKeys.relayWebRoutes(relayId),
    queryFn: () => getRelayWebRoutes({ data: { id: relayId } }),
    retry: false,
    staleTime: 15_000,
  })
}

export function relayProxyQueryOptions(relayId: string) {
  return queryOptions({
    queryFn: () => getRelayProxy({ data: { id: relayId } }),
    queryKey: queryKeys.relayProxy(relayId),
    retry: false,
    staleTime: 10_000,
  })
}

// The paths only move if the Relay's data or proxy mode does, so they're read
// rarely; a proxy change refreshes them, and keying by the Relay's version
// reads them again after it updates.
export function relayHostFilesQueryOptions(
  relayId: string,
  version: string | null
) {
  return queryOptions({
    queryFn: () => getRelayHostFiles({ data: { id: relayId } }),
    queryKey: [...queryKeys.relayHostFiles(relayId), version] as const,
    retry: false,
    staleTime: 5 * 60_000,
  })
}

export function relayTailscaleQueryOptions(relayId: string) {
  return queryOptions({
    queryKey: queryKeys.tailscale(relayId),
    queryFn: () => getRelayTailscale({ data: { id: relayId } }),
    retry: false,
    staleTime: 5_000,
  })
}

export function tailscaleStacksQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.tailscaleStacks,
    queryFn: () => getTailscaleStacks(),
    retry: false,
    staleTime: 10_000,
  })
}

export function updateOverviewQueryOptions() {
  return queryOptions({
    ...systemUpdateOverviewRefetchPolicy,
    queryKey: queryKeys.updates,
    queryFn: () => getUpdateOverview(),
    staleTime: 30_000,
  })
}

// Keyed by the version the Relay runs, so an update refreshes it.
export function relayReleaseQueryOptions(relayId: string, version: string) {
  return queryOptions({
    queryKey: queryKeys.relayRelease(relayId, version),
    queryFn: ({ signal }) => getRelayRelease({ data: { relayId }, signal }),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 10 * 60_000,
  })
}

export function releaseHistoryInfiniteQueryOptions() {
  return infiniteQueryOptions({
    queryKey: queryKeys.releaseHistory,
    initialPageParam: null as ReleaseHistoryCursor | null,
    queryFn: ({ pageParam, signal }) =>
      getReleaseHistory({ data: { cursor: pageParam }, signal }),
    getNextPageParam: (page) => page.nextCursor,
    // Releases rarely change once published; new ones arrive with the
    // overview, which refreshes this list. Pages stay cached between visits,
    // so reopening the changelog shows them at once while they refresh.
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  })
}

export function brickCatalogQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.bricks,
    queryFn: () => getBrickCatalog(),
  })
}

export function brickIconPresentationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.brickIcons,
    queryFn: () => getBrickIconPresentations(),
    staleTime: 5 * 60_000,
  })
}

export function brickCatalogsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.brickCatalogs.all,
    queryFn: () => listBrickCatalogs(),
  })
}

export function brickCatalogDetailsQueryOptions(catalogId: string) {
  return queryOptions({
    queryKey: queryKeys.brickCatalogs.detail(catalogId),
    queryFn: () => getBrickCatalogDetails({ data: { catalogId } }),
  })
}

export function brickVersionsQueryOptions(type: string, variant: string) {
  return queryOptions({
    queryKey: queryKeys.brickVersions(type, variant),
    queryFn: () => getBrickVersions({ data: { type, variant } }),
    staleTime: 30 * 60 * 1000,
  })
}

export function domainSettingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.domains.settings,
    queryFn: () => getDomainSettings(),
  })
}

export function githubSyncOverviewQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.github.overview,
    queryFn: () => getGitHubSyncOverview(),
  })
}

export function githubSyncRunsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.github.runs,
    queryFn: () => getGitHubSyncRuns(),
  })
}

export function githubSourcesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.github.sources,
    queryFn: () => getGitHubSources(),
  })
}

export function githubSourceRepositoryCountQueryOptions(connectionId: string) {
  return queryOptions({
    queryKey: queryKeys.github.repositoryCount(connectionId),
    queryFn: () =>
      getGitHubSourceRepositoryCount({ data: { id: connectionId } }),
    retry: false,
    staleTime: 60_000,
  })
}

// What a connection can reach on GitHub changes rarely; a minute keeps the
// sync dialog's pickers from refetching as it reopens.
export function githubRepositoriesQueryOptions(connectionId: string) {
  return queryOptions({
    queryKey: queryKeys.github.repositories(connectionId),
    queryFn: () => listGitHubRepositories({ data: { connectionId } }),
    retry: false,
    staleTime: 60_000,
  })
}

export function githubBranchesQueryOptions(
  connectionId: string,
  repository: string
) {
  return queryOptions({
    queryKey: queryKeys.github.branches(connectionId, repository),
    queryFn: () => listGitHubBranches({ data: { connectionId, repository } }),
    retry: false,
    staleTime: 60_000,
  })
}

export function githubFoldersQueryOptions(
  connectionId: string,
  repository: string,
  branch: string
) {
  return queryOptions({
    queryKey: queryKeys.github.folders(connectionId, repository, branch),
    queryFn: () =>
      listGitHubFolders({ data: { branch, connectionId, repository } }),
    retry: false,
    staleTime: 60_000,
  })
}

// Fixed for the life of the page: the address comes from Hearth's
// configuration and the edge from the request path.
export function hearthEdgeQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.hearthEdge,
    queryFn: () => getHearthEdge(),
    staleTime: Infinity,
  })
}

export function instanceDomainQueryOptions(
  relayId: string,
  instanceId: string
) {
  return queryOptions({
    queryKey: queryKeys.domains.instance(relayId, instanceId),
    queryFn: () => getInstanceDomain({ data: { instanceId, relayId } }),
    retry: false,
    staleTime: 10_000,
  })
}

export function instanceStartupQueryOptions(
  relayId: string,
  instanceId: string
) {
  return queryOptions({
    queryKey: ["relay", relayId, "instances", instanceId, "startup"] as const,
    queryFn: () => getInstanceStartup({ data: { instanceId, relayId } }),
    staleTime: 15_000,
  })
}

export function instanceRecipeQueryOptions(
  relayId: string,
  instanceId: string
) {
  return queryOptions({
    queryKey: queryKeys.relay.recipe(relayId, instanceId),
    queryFn: () => getInstanceRecipe({ data: { instanceId, relayId } }),
    staleTime: 30_000,
  })
}

export function relayTreeQueryOptions(relayId: string, instanceId: string) {
  return queryOptions({
    queryKey: queryKeys.relay.tree(relayId, instanceId),
    queryFn: () => getRelayTree({ data: { instanceId, relayId } }),
    staleTime: 15_000,
  })
}

export function relayDirectoryQueryOptions(
  relayId: string,
  instanceId: string,
  directory = ""
) {
  const path = directory.replace(/^\/+|\/+$/gu, "")
  return infiniteQueryOptions({
    queryKey: [
      ...queryKeys.relay.tree(relayId, instanceId),
      "directory",
      path ? `${path}/` : "",
    ] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      traceFileWork(
        "directory",
        {
          attributes: {
            "kiln.files.continued": pageParam !== undefined,
            "kiln.files.depth": path ? path.split("/").length : 0,
          },
          signal,
          describe: (page) => ({
            "kiln.files.entries": page.entries.length,
            "kiln.files.has_more": page.cursor !== null,
          }),
        },
        () =>
          getRelayDirectoryPage({
            data: { instanceId, path, relayId, cursor: pageParam },
            signal,
          })
      ),
    getNextPageParam: (page) => page.cursor ?? undefined,
    retry: 3,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2_000),
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  })
}

export function relayRootDirectoryQueryOptions(
  relayId: string,
  instanceId: string
) {
  return relayDirectoryQueryOptions(relayId, instanceId)
}

export function relayFileQueryOptions(
  relayId: string,
  instanceId: string,
  path: string
) {
  return queryOptions({
    queryKey: queryKeys.relay.file(relayId, instanceId, path),
    queryFn: ({ signal }) =>
      traceFileWork(
        "file",
        {
          signal,
          describe: (file) => ({
            "kiln.files.bytes": file.size,
            "kiln.files.encoding": file.encoding,
          }),
        },
        () => getRelayFile({ data: { instanceId, path, relayId }, signal })
      ),
    staleTime: 15_000,
  })
}

/**
 * Whether to read a file alongside its entry rather than after it, saving a
 * round trip. The entry still decides what the path is; this skips paths the
 * read would fail on or go unused for: directories and database files.
 */
export function readsFileWithEntry(
  path: string,
  kind: RelayFileEntry["kind"] | undefined
) {
  if (!path || path.endsWith("/") || isDatabaseFilePath(path)) return false
  if (kind) return kind === "file"
  // An unlisted path, as on a direct load. The router can trim a directory's
  // trailing slash from its splat, so check the URL; past that, a name with
  // an extension is almost always a file.
  if (typeof window === "undefined" || window.location.pathname.endsWith("/")) {
    return false
  }
  const name = path.slice(path.lastIndexOf("/") + 1)
  return name.lastIndexOf(".") > 0
}

export function relayFileEntryQueryOptions(
  relayId: string,
  instanceId: string,
  path: string
) {
  return queryOptions({
    queryKey: [...queryKeys.relay.file(relayId, instanceId, path), "stat"],
    queryFn: ({ signal }) =>
      traceFileWork("entry", { signal }, () =>
        getRelayFileEntry({ data: { instanceId, path, relayId }, signal })
      ),
    retry: false,
    staleTime: 15_000,
  })
}

export function instanceWebRoutesQueryOptions(
  relayId: string,
  instanceId: string
) {
  return queryOptions({
    queryKey: queryKeys.relay.webRoutes(relayId, instanceId),
    queryFn: () => getInstanceWebRoutes({ data: { instanceId, relayId } }),
    staleTime: 10_000,
  })
}

export function relayFileActivityQueryOptions(
  relayId: string,
  instanceId: string
) {
  return queryOptions({
    queryKey: queryKeys.fileActivity(relayId, instanceId),
    queryFn: ({ signal }) =>
      traceFileWork("activity", { signal }, () =>
        getRelayFileActivity({ data: { instanceId, relayId }, signal })
      ),
    staleTime: 15_000,
  })
}
