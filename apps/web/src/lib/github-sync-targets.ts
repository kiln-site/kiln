import {
  appFileRootId,
  INSTANCE_ID_PATTERN,
  relayFileRootId,
} from "@workspace/contracts"

import {
  fileRootPermission,
  type FileRootPermission,
} from "@/lib/file-root-permissions"
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
  scope: FileRootPermission["scope"] & { relayId: string }
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
  // A Relay's own ID names its host files, never a game server or App.
  if (
    target.kind === "relay"
      ? target.id !== target.relayId
      : !resourceIdPattern.test(target.id) || target.id === target.relayId
  )
    return null
  const fileRootId =
    target.kind === "relay"
      ? relayFileRootId(target.id)
      : target.kind === "app"
        ? appFileRootId(target.id)
        : target.id
  const read = fileRootPermission(target.relayId, fileRootId, "read")
  const write = fileRootPermission(target.relayId, fileRootId, "write")
  if (!read || !write) return null
  return {
    fileRootId,
    read: read.permission,
    scope: { ...read.scope, relayId: target.relayId },
    write: write.permission,
  }
}
