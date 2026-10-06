export interface RelayEndpoint {
  hostname: string
  id: string
  managedTls?: boolean
  port: number
  useTls: boolean
}

export function relayControlEndpoint(relay: RelayEndpoint): RelayEndpoint {
  const initializedHostname = managedRelayHost()
  if (!initializedHostname || relay.hostname !== initializedHostname) {
    return relay
  }

  const configured = process.env.KILN_RELAY_CONTROL_URL?.trim()
  if (configured) {
    const url = new URL(configured)
    if (
      (url.protocol !== "ws:" && url.protocol !== "wss:") ||
      (url.pathname !== "/" && url.pathname !== "/v1/socket") ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error(
        "KILN_RELAY_CONTROL_URL must be a WS/WSS origin or /v1/socket URL without credentials, query, or fragment"
      )
    }
    return {
      ...relay,
      hostname: url.hostname,
      port: effectiveWebSocketPort(url),
      useTls: url.protocol === "wss:",
    }
  }
  if (!relay.managedTls) return relay

  return {
    ...relay,
    hostname: initializedHostname,
    port: managedRelayPort(),
    useTls: true,
  }
}

interface RelayPairingOriginOptions {
  browserOrigin: URL
  caCertificatePem: string | null
  enrollmentOrigin?: URL
}

export function relayPairingOrigin({
  browserOrigin,
  caCertificatePem,
  enrollmentOrigin,
}: RelayPairingOriginOptions): URL {
  if (enrollmentOrigin) return enrollmentOrigin
  if (!caCertificatePem) return browserOrigin

  const hostname = managedRelayHost()
  if (!hostname) return browserOrigin
  const port = managedRelayPort()

  const directOrigin = new URL(`https://${formatHost(hostname)}:${port}`)
  return directOrigin.hostname === browserOrigin.hostname
    ? directOrigin
    : browserOrigin
}

// KILN_RELAY_HOST/PORT name the environment-managed Relay's direct TLS
// listener; only a Relay advertising that exact host is redirected to it.
function managedRelayHost(): string | undefined {
  return process.env.KILN_RELAY_HOST?.trim() || undefined
}

function managedRelayPort(): number {
  const port = Number(process.env.KILN_RELAY_PORT?.trim() || 4100)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("KILN_RELAY_PORT must be a valid TCP port")
  }
  return port
}

function effectiveWebSocketPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "wss:" ? 443 : 80
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname
}
