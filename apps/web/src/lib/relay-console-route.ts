import type { RelayProxyMode } from "@workspace/contracts"

export function relayConsoleTransport(
  proxyMode: RelayProxyMode | undefined
): "direct" | "hearth" | null {
  switch (proxyMode) {
    case undefined:
      return null
    case "hearth":
      return "hearth"
    case "coolify":
    case "none":
    case "traefik":
      return "direct"
    default:
      return proxyMode satisfies never
  }
}
