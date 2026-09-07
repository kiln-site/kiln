export type RelayConsoleOperation = "console.complete" | "console.write"

export interface RelayConsoleOperationClient {
  request: (
    operation: RelayConsoleOperation,
    payload: Record<string, unknown>
  ) => Promise<unknown>
}

const activeClients = new Map<string, RelayConsoleOperationClient>()

export function registerRelayConsoleOperationClient(
  relayId: string,
  instanceId: string,
  client: RelayConsoleOperationClient
): () => void {
  const id = `${relayId}:${instanceId}`
  activeClients.set(id, client)
  return () => {
    if (activeClients.get(id) === client) activeClients.delete(id)
  }
}

export function relayConsoleOperationClient(
  relayId: string,
  instanceId: string
): RelayConsoleOperationClient | null {
  return activeClients.get(`${relayId}:${instanceId}`) ?? null
}
