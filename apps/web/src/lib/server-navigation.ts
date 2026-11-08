import { findRelayServer } from "@/lib/relay-selectors"

/**
 * Which game server the sidebar and command menu open: the one in the URL,
 * else the one last selected, else the first the user can reach.
 */
export type ServerNavigationInput =
  | { serverId: string }
  | { selectedServerId: string | null }

export interface ServerNavigation<T> {
  instance: T | null
  serverCount: number
}

export function resolveServerNavigation<T extends { id: string }>(
  instances: Array<T>,
  input: ServerNavigationInput
): ServerNavigation<T> {
  const instance =
    "serverId" in input
      ? findRelayServer(instances, input.serverId)
      : (findRelayServer(instances, input.selectedServerId) ?? instances[0])
  return { instance: instance ?? null, serverCount: instances.length }
}
