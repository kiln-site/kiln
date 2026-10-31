import type {
  RelayInstance,
  RelayInstancePortInput,
} from "@workspace/contracts"

import { provisionInstanceDomainBestEffort } from "@/server/domains.server"

export async function syncInstanceDomainAfterPortUpdateBestEffort(
  instance: RelayInstance,
  relayId: string,
  ports: ReadonlyArray<RelayInstancePortInput>
): Promise<void> {
  const updatesPrimaryPublicPort = ports.some(
    (port) => port.id === "primary" && port.externalPort !== undefined
  )
  if (updatesPrimaryPublicPort) {
    await provisionInstanceDomainBestEffort(instance, relayId)
  }
}
