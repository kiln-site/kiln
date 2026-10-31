import type { RelayInstancePortInput } from "@workspace/contracts"

import { provisionInstanceDomainLater } from "@/server/domains.server"

/** A change to a game server's public port moves its domains' address. */
export async function syncInstanceDomainAfterPortUpdate(
  relayId: string,
  instanceId: string,
  ports: ReadonlyArray<RelayInstancePortInput>
): Promise<void> {
  const updatesPrimaryPublicPort = ports.some(
    (port) => port.id === "primary" && port.externalPort !== undefined
  )
  if (updatesPrimaryPublicPort) {
    await provisionInstanceDomainLater(relayId, instanceId)
  }
}
