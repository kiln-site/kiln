import { exclusive, partKey, relayKey, resourceKey } from "@/operations/lanes"

/**
 * What starting an App's deployment holds: its `#deploy`, and its Relay's
 * handover of Apps' database connections, which the deployment may finish
 * first. Whatever deploys it declares these too, so the deployment runs
 * under them.
 */
export const appDeploymentLocks = (relayId: string, appId: string) => [
  exclusive(partKey(resourceKey("app", relayId, appId), "deploy")),
  exclusive(partKey(relayKey(relayId), "database-connections")),
]
