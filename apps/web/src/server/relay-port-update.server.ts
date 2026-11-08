import type {
  RelayServer,
  RelayServerPortInput,
} from "@workspace/contracts"

import { provisionInstanceDomainBestEffort } from "@/server/domains.server"

export async function syncInstanceDomainAfterPortUpdateBestEffort(
  instance: RelayServer,
  relayId: string,
  ports: ReadonlyArray<RelayServerPortInput>
): Promise<void> {
  const updatesPrimaryPublicPort = ports.some(
    (port) => port.id === "primary" && port.externalPort !== undefined
  )
  if (updatesPrimaryPublicPort) {
    await provisionInstanceDomainBestEffort(instance, relayId)
  }
}
