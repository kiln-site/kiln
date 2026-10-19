import { appFileRootId } from "@workspace/contracts"

import type { AccessPermission } from "@/lib/permissions"

export type GitHubSyncTargetKind = "app" | "relay" | "server"

export interface GitHubSyncTargetRef {
  id: string
  kind: GitHubSyncTargetKind
  relayId: string
}

export interface GitHubSyncTargetAccess {
  /** The Relay file root the sync writes through. */
  fileRootId: string
  read: AccessPermission
  scope: { instanceId?: string; relayId: string }
  write: AccessPermission
}

const resourceIdPattern = /^[a-f0-9]{40}$/u

/**
 * Where a sync target's files are written, and the permissions that cover
 * them. The Relay picks a file root by the shape of its ID, so the ID must
 * match the kind: a game server's ID can't name a Relay's host files. Null
 * for a target that can't exist.
 */
export function githubSyncTargetAccess(
  target: GitHubSyncTargetRef
): GitHubSyncTargetAccess | null {
  if (target.kind === "relay") {
    return target.id === target.relayId
      ? {
          fileRootId: target.id,
          read: "relay.files.read",
          scope: { relayId: target.relayId },
          write: "relay.files.write",
        }
      : null
  }
  if (!resourceIdPattern.test(target.id)) return null
  return target.kind === "app"
    ? {
        fileRootId: appFileRootId(target.id),
        read: "app.files.read",
        // App permissions are granted on the Relay, for every app on it.
        scope: { relayId: target.relayId },
        write: "app.files.write",
      }
    : {
        fileRootId: target.id,
        read: "instance.files.read",
        scope: { instanceId: target.id, relayId: target.relayId },
        write: "instance.files.write",
      }
}
