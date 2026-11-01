import { appIdFromFileRoot, isRelayFileRoot } from "@workspace/contracts"

import { partKey, relayKey, resourceKey } from "@/operations/lanes"

/**
 * What a file root's files belong to (docs/hearth-operations.md): its game
 * server, the App whose folder it is, or its Relay's host files. A change to
 * files holds it shared; its Relay orders the writes themselves.
 */
export function fileRootKey(relayId: string, rootId: string): string {
  if (isRelayFileRoot(rootId)) return partKey(relayKey(relayId), "host-files")
  const appId = appIdFromFileRoot(rootId)
  return appId
    ? resourceKey("app", relayId, appId)
    : resourceKey("instance", relayId, rootId)
}
