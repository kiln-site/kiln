import type { GitHubSyncResourceKind } from "@/effect/github-sync"
import { partKey, relayKey, resourceKey } from "@/operations/lanes"

/**
 * The lane keys GitHub syncs take (docs/hearth-operations.md). A sync's run
 * holds its `#files`, and its `#settings`, what it writes into and its
 * connection shared, from reading GitHub to recording what it wrote.
 */

/** A GitHub sync: changing it, or writing a file for it. */
export const githubSyncKey = (id: string) => `github-sync:${id}`

/**
 * A GitHub connection: changing or deleting it, which takes its syncs with
 * it. What reads through it holds it shared.
 */
export const githubConnectionKey = (id: string) => `github-connection:${id}`

/** What a sync writes files into: a game server, an App, or Relay files. */
export function githubSyncTargetKey(target: {
  kind: GitHubSyncResourceKind
  relayId: string
  resourceId: string
}): string {
  return target.kind === "relay"
    ? partKey(relayKey(target.relayId), "host-files")
    : resourceKey(target.kind, target.relayId, target.resourceId)
}
