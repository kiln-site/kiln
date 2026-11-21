import {
  appIdFromFileRoot,
  databaseIdFromFileRoot,
  isRelayFileRoot,
  volumeIdFromTransferRoot,
} from "@workspace/contracts"

import { partKey, relayKey, resourceKey } from "@/operations/lanes"

/**
 * What a root belongs to (docs/hearth-operations.md): its game server, the
 * App whose folder it is, the database whose dumps it holds, the volume a
 * transfer copies, or its Relay's host files. A change to it holds it shared; its Relay orders the writes
 * themselves.
 */
export function fileRootKey(relayId: string, rootId: string): string {
  if (isRelayFileRoot(rootId)) return partKey(relayKey(relayId), "host-files")
  const databaseId = databaseIdFromFileRoot(rootId)
  if (databaseId !== null) return resourceKey("database", relayId, databaseId)
  const volumeId = volumeIdFromTransferRoot(rootId)
  if (volumeId !== null) return resourceKey("volume", relayId, volumeId)
  const appId = appIdFromFileRoot(rootId)
  return appId
    ? resourceKey("app", relayId, appId)
    : resourceKey("instance", relayId, rootId)
}

/**
 * A file root's pins: pinning or unpinning a file, so two at once can't
 * both find room under the limit. It takes the root shared too.
 */
export function filePinsKey(relayId: string, rootId: string): string {
  return partKey(`file-activity:${relayId}/${rootId}`, "pins")
}
