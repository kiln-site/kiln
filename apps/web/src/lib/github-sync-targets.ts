import {
  appFileRootId,
  INSTANCE_ID_PATTERN,
  relayFileRootId,
} from "@workspace/contracts"

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
  scope: { appId?: string; instanceId?: string; relayId: string }
  write: AccessPermission
}

const resourceIdPattern = INSTANCE_ID_PATTERN

/**
 * Where a sync target's files are written, and the permissions that cover
 * them: a game server's own files, an App's folder (`app:<id>`), or a
 * Relay's host files (`relay:<id>`). Null for a target that can't exist.
 */
export function githubSyncTargetAccess(
  target: GitHubSyncTargetRef
): GitHubSyncTargetAccess | null {
  if (target.kind === "relay") {
    return target.id === target.relayId
      ? {
          fileRootId: relayFileRootId(target.id),
          read: "relay.files.read",
          scope: { relayId: target.relayId },
          write: "relay.files.write",
        }
      : null
  }
  // A Relay's own ID names its host files, never a game server or App.
  if (!resourceIdPattern.test(target.id) || target.id === target.relayId)
    return null
  return target.kind === "app"
    ? {
        fileRootId: appFileRootId(target.id),
        read: "app.files.read",
        scope: { appId: target.id, relayId: target.relayId },
        write: "app.files.write",
      }
    : {
        fileRootId: target.id,
        read: "server.files.read",
        scope: { instanceId: target.id, relayId: target.relayId },
        write: "server.files.write",
      }
}
