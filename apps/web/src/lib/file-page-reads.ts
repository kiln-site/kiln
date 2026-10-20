import type { QueryClient } from "@tanstack/react-query"
import { Predicate } from "effect"

import {
  readsFileWithEntry,
  relayFileActivityQueryOptions,
  relayFileEntryQueryOptions,
  relayFileQueryOptions,
  relayRootDirectoryQueryOptions,
} from "@/lib/query-options"
import { renderRead } from "@/lib/render-reads"

/** The Files page a URL opens: Files home, or a path under the root. */
export interface FilePageLocation {
  /** The route's `files/$` path, absent on Files home. */
  readonly splat: string | undefined
  /** Whether the URL ends in a slash, which the router trims from the path. */
  readonly directory: boolean
}

/**
 * The Files page a route's loader is opening. Every match's loader gets the
 * whole location's params, so a Files route sees its `files/$` child's path.
 */
export function filePageLocation({
  location,
  params,
}: {
  location: { pathname: string }
  params: object
}): FilePageLocation {
  return {
    splat:
      Predicate.hasProperty(params, "_splat") &&
      Predicate.isString(params._splat)
        ? params._splat
        : undefined,
    directory: location.pathname.endsWith("/"),
  }
}

/**
 * Starts the reads a Files page opens with, from its route's loader so they
 * begin with the navigation: the root folder, and either recent files on
 * Files home or the selected path's entry, with its contents when the path
 * names a file. While Hearth renders the page they stream into it.
 */
export function startFilePageReads(
  queryClient: QueryClient,
  root: { instanceId: string; relayId: string },
  { directory, splat }: FilePageLocation
) {
  const { instanceId, relayId } = root
  const path = splat?.replace(/^\/+/u, "") ?? ""
  void queryClient.prefetchInfiniteQuery(
    renderRead("directory", relayRootDirectoryQueryOptions(relayId, instanceId))
  )
  if (!path) {
    void queryClient.prefetchQuery(
      renderRead("activity", relayFileActivityQueryOptions(relayId, instanceId))
    )
    return
  }
  void queryClient.prefetchQuery(
    renderRead("entry", relayFileEntryQueryOptions(relayId, instanceId, path))
  )
  if (readsFileWithEntry(path, directory ? "directory" : undefined)) {
    void queryClient.prefetchQuery(
      renderRead("file", relayFileQueryOptions(relayId, instanceId, path))
    )
  }
}
