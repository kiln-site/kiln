import { request as httpRequest } from "node:http"
import type { ClientRequest, IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Duplex } from "node:stream"

import { relayControlEndpoint } from "@/lib/relay-control-endpoint"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  openRelayTunnel,
  relayReachedThroughTunnel,
} from "@/lib/relay-tunnel.server"

const IDLE_TIMEOUT_MS = 60_000

function stopped(outgoing: ClientRequest): void {
  outgoing.destroy(new Error("The backup copy stopped making progress"))
}

// A tunnel over plain HTTP is a bare stream with no socket timeouts, and
// asking one for them throws where nothing can catch it. So its progress is
// watched here, across the response headers and the body both.
function watchTunnel(outgoing: ClientRequest, tunnel: Duplex): void {
  let idle: NodeJS.Timeout
  const progressed = () => {
    clearTimeout(idle)
    idle = setTimeout(() => stopped(outgoing), IDLE_TIMEOUT_MS)
  }
  const finished = () => clearTimeout(idle)
  progressed()
  outgoing.once("socket", () => tunnel.on("data", progressed))
  outgoing.once("close", finished)
  tunnel.once("close", finished)
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname
}

/**
 * Asks a Relay for `path` as Hearth reaches it for anything else: through a
 * tunnel when the Relay dials it, which already speaks TLS to its listener
 * when that needs it, else at its listener.
 */
export async function requestRelayBackup(
  relay: PersistedRelay,
  caCertificatePem: string | null,
  path: string,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const endpoint = relayControlEndpoint(relay)
  const tunnel = relayReachedThroughTunnel(relay.id)
    ? await openRelayTunnel(relay)
    : null
  const useTls = endpoint.useTls && !tunnel
  const url = new URL(
    path,
    `${useTls ? "https" : "http"}://${formatHost(endpoint.hostname)}:${endpoint.port}`
  )
  const request = useTls ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        ca: useTls ? (caCertificatePem ?? undefined) : undefined,
        ...(tunnel ? { createConnection: () => tunnel } : {}),
        method: "GET",
        rejectUnauthorized: useTls,
        signal,
      },
      resolve
    )
    outgoing.once("error", reject)
    if (tunnel) watchTunnel(outgoing, tunnel)
    else outgoing.setTimeout(IDLE_TIMEOUT_MS, () => stopped(outgoing))
    outgoing.end()
  })
}
