import type { RelayServer } from "@workspace/contracts"

export function retainProvisioningServers(
  servers: Array<RelayServer>,
  retainedServers: Iterable<RelayServer>
): Array<RelayServer> {
  const visibleIds = new Set(servers.map((server) => server.id))
  const provisioning = Array.from(retainedServers)
    .filter((server) => !visibleIds.has(server.id))
    .map(provisioningServer)

  return provisioning.length === 0 ? servers : [...servers, ...provisioning]
}

function provisioningServer(server: RelayServer): RelayServer {
  return {
    ...server,
    containerId: null,
    lifecycle: [],
    observedState: "provisioning",
    stateReason: null,
    recovery: null,
    resources: null,
    status: "Reprovisioning",
  }
}
