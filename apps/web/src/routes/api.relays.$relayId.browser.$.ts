import { createFileRoute } from "@tanstack/react-router"

// Browser transfers to a Relay browsers can't reach directly, passed
// through Hearth (lib/relay-browser-passthrough.server.ts). Each request is
// authorized by its own Relay capability, which the Relay checks.
const pass = async ({
  params,
  request,
}: {
  params: { relayId: string; _splat?: string }
  request: Request
}) => {
  const { passRelayBrowserRequest } =
    await import("@/lib/relay-browser-passthrough.server")
  return passRelayBrowserRequest(params.relayId, params._splat ?? "", request)
}

export const Route = createFileRoute("/api/relays/$relayId/browser/$")({
  server: {
    handlers: { GET: pass, HEAD: pass, POST: pass, PUT: pass },
  },
})
