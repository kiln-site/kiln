import { exclusive, partKey, resourceKey } from "@/operations/lanes"

/**
 * What an App's deployment holds, from its start until its Relay says the
 * build ended: its `#deploy`, so its deployments go one at a time.
 */
export const appDeploymentLocks = (relayId: string, appId: string) => [
  exclusive(partKey(resourceKey("app", relayId, appId), "deploy")),
]
