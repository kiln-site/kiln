import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query"
import type {
  RelayDirectoryPage,
  RelayDirectorySizes,
  RelayFileEntry,
} from "@workspace/contracts"

import { queryKeys } from "@/lib/query-options"
import { getRelayDirectorySizes, searchRelayFiles } from "@/server/relay"

export function directoryPageEntries(
  data: InfiniteData<RelayDirectoryPage>
): ReadonlyArray<RelayFileEntry> {
  const entries = new Map(
    data.pages.flatMap((page) =>
      page.entries.map((entry) => [entry.path, entry] as const)
    )
  )
  return [...entries.values()].sort((left, right) =>
    left.kind === right.kind
      ? left.path.localeCompare(right.path)
      : left.kind === "directory"
        ? -1
        : 1
  )
}

export function relayFileSearchQueryOptions(
  relayId: string,
  instanceId: string,
  query: string
) {
  return infiniteQueryOptions({
    queryKey: [
      ...queryKeys.relay.tree(relayId, instanceId),
      "search",
      query,
    ] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      searchRelayFiles({
        data: { instanceId, relayId, query, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (page) => page.cursor ?? undefined,
    retry: 3,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

interface DirectorySizeData extends RelayDirectorySizes {
  pollAttempt: number
  backoffAttempt: number
}

export function directorySizeBatches(
  entries: ReadonlyArray<RelayFileEntry>
): Array<ReadonlyArray<string>> {
  const paths = entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right))
  const batches: Array<ReadonlyArray<string>> = []
  for (let index = 0; index < paths.length; index += 128)
    batches.push(paths.slice(index, index + 128))
  return batches
}

export function relayDirectorySizesQueryOptions(
  queryClient: QueryClient,
  relayId: string,
  instanceId: string,
  paths: ReadonlyArray<string>
) {
  const queryKey = [
    ...queryKeys.relay.tree(relayId, instanceId),
    "sizes",
    paths,
  ] as const
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }): Promise<DirectorySizeData> => {
      const state = queryClient.getQueryState<DirectorySizeData>(queryKey)
      const previous = state?.isInvalidated ? undefined : state?.data
      const requested = previous?.pending.length ? previous.pending : paths
      const result = await getRelayDirectorySizes({
        data: { instanceId, relayId, paths: [...requested] },
        signal,
      })
      const sizes = { ...previous?.sizes, ...result.sizes }
      const progressed =
        !previous ||
        result.pending.length !== previous.pending.length ||
        result.pending.some(
          (path, index) => path !== previous.pending[index]
        ) ||
        Object.keys(result.sizes).some(
          (path) => sizes[path] !== previous.sizes[path]
        )
      return {
        ...result,
        sizes,
        pollAttempt: previous ? previous.pollAttempt + 1 : 0,
        backoffAttempt: progressed ? 0 : previous.backoffAttempt + 1,
      }
    },
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.pending.length && data.pollAttempt < 30
        ? Math.min(1_000 * 2 ** data.backoffAttempt, 10_000)
        : false
    },
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

export async function refreshFileQueries(
  queryClient: QueryClient,
  relayId: string,
  instanceId: string
) {
  const treeKey = queryKeys.relay.tree(relayId, instanceId)
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: [...treeKey, "directory"],
      refetchType: "all",
    }),
    queryClient.invalidateQueries({
      queryKey: treeKey.slice(0, -1),
      predicate: (query) =>
        !(query.queryKey[5] === "tree" && query.queryKey[6] === "directory"),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.fileActivity(relayId, instanceId),
    }),
    queryClient.invalidateQueries({
      queryKey: ["relay", relayId, "instances", instanceId, "database"],
    }),
  ])
}
