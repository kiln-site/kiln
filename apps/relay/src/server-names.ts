import type { RelayServer } from "@workspace/contracts"

import type { RelayStoredServerName } from "./effect/state.js"

export function applyStoredServerNames(
  servers: ReadonlyArray<RelayServer>,
  storedNames: ReadonlyArray<RelayStoredServerName>
): Array<RelayServer> {
  const names = new Map(
    storedNames.map((stored) => [stored.instanceId, stored.name])
  )
  return servers.map((server) => ({
    ...server,
    name: names.get(server.id) ?? server.name,
  }))
}
