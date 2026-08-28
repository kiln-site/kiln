export const realtimeHeartbeatIntervalMs = 15_000
export const realtimeWatchdogTimeoutMs = realtimeHeartbeatIntervalMs * 3

export function encodeRealtimeHeartbeat(encoder: TextEncoder): Uint8Array {
  return encoder.encode(": heartbeat\nevent: ping\ndata: {}\n\n")
}

export function realtimeStreamIsStale(
  lastActivityAt: number,
  now: number,
  timeoutMs = realtimeWatchdogTimeoutMs
): boolean {
  return now - lastActivityAt >= timeoutMs
}
