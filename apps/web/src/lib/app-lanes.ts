import { exclusive, partKey, resourceKey } from "@/operations/lanes"

/**
 * What an App's deployment holds, from sending it until its Relay says it
 * ended: its `#deploy`, so its deployments go one at a time.
 */
export const appDeploymentLocks = (relayId: string, appId: string) => [
  exclusive(partKey(resourceKey("app", relayId, appId), "deploy")),
]
