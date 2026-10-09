import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
} from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import type {
  BackupTarget,
  RelayConsoleResource,
  RelayInstance,
} from "@workspace/contracts"

import { getAccessCapabilities, getInvitationPreview } from "@/server/access"
import { getActivity } from "@/server/activity"
import { getBackupPolicy, getBackupRunsPage } from "@/server/backups"
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
import { getDomainSettings, getInstanceDomain } from "@/server/domains"
import {
  getManagedDatabaseCredential,
  getManagedDatabaseDirectory,
  getManagedDatabases,
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
import { reconcilePendingPowerSnapshot } from "@/lib/instance-power-state"
import { systemUpdateOverviewRefetchPolicy } from "@/lib/system-update-presence"
import {
  getRelayConnectionState,
  getRelayDirectoryPage,
  getRelayFileEntry,
  getRelayFile,
  getRelayFileActivity,
  getRelaySnapshot,
  getRelayTree,
} from "@/server/relay"
import {
  getRelays,
  getRelayOwnerMinecraftProfiles,
  getRelayTailscale,
} from "@/server/relays"
import { getTailscaleStacks } from "@/server/tailscale"
import { getAuthState } from "@/server/auth"
import type { ReleaseHistoryCursor } from "@/effect/kiln-release-feed"
import { getReleaseHistory, getUpdateOverview } from "@/server/updates"
import { getScheduleOptions, getSchedules } from "@/server/schedules"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { withDatabaseRelayStatus } from "@/lib/database-relay-status"
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
  databases: {
    all: ["databases"] as const,
    credential: (relayId: string, databaseId: string) =>
      ["databases", relayId, databaseId, "credential"] as const,
    directory: ["databases", "directory"] as const,
    list: ["databases", "list"] as const,
  },
  fileActivity: (relayId: string, instanceId: string) =>
    ["file-activity", relayId, instanceId] as const,
  relay: {
    all: ["relay"] as const,
    connection: ["relay", "connection"] as const,
    console: (relayId: string, resource: RelayConsoleResource) =>
      ["relay", relayId, `${resource.kind}s`, resource.id, "console"] as const,
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
    instances: ["relay", "instances"] as const,
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
  tailscale: (relayId: string) => ["tailscale", "relays", relayId] as const,
  tailscaleStacks: ["tailscale", "stacks"] as const,
  updates: ["updates", "overview"] as const,
  releaseHistory: ["updates", "release-history"] as const,
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
    queryFn: () => getManagedDatabaseDirectory(),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
}

export function managedDatabasesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.databases.list,
    queryFn: ({ client }) => fetchManagedDatabases(client),
    refetchOnWindowFocus: "always",
    staleTime: 5_000,
  })
}

/**
 * Inventory responses can resolve after newer Relay status events, so the
 * live Relay status from the connection cache is reapplied to every result.
 */
export async function fetchManagedDatabases(queryClient: QueryClient) {
  const overview = await getManagedDatabases()
  const connection = queryClient.getQueryData<RelayConnection>(
    queryKeys.relay.connection
  )
  if (
    connection?.status !== "connected" &&
    connection?.status !== "unreachable"
  ) {
    return overview
  }
  return withDatabaseRelayStatus(
    overview,
    new Map(
      connection.relays.map((relay) => [
        relay.id,
        { status: relay.status, updating: relay.updating === true },
      ])
    )
  )
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
      getRelayDirectoryPage({
        data: { instanceId, path, relayId, cursor: pageParam },
        signal,
      }),
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
      getRelayFile({ data: { instanceId, path, relayId }, signal }),
    staleTime: 15_000,
  })
}

export function relayFileEntryQueryOptions(
  relayId: string,
  instanceId: string,
  path: string
) {
  return queryOptions({
    queryKey: [...queryKeys.relay.file(relayId, instanceId, path), "stat"],
    queryFn: ({ signal }) =>
      getRelayFileEntry({ data: { instanceId, path, relayId }, signal }),
    retry: false,
    staleTime: 15_000,
  })
}

export function relayFileActivityQueryOptions(
  relayId: string,
  instanceId: string
) {
  return queryOptions({
    queryKey: queryKeys.fileActivity(relayId, instanceId),
    queryFn: ({ signal }) =>
      getRelayFileActivity({ data: { instanceId, relayId }, signal }),
    staleTime: 15_000,
  })
}
