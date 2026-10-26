import { createFileRoute } from "@tanstack/react-router"

// Copies another Relay pulls from this one when it can't reach it, passed
// through Hearth (lib/relay-browser-passthrough.server.ts). Each request
// carries a grant and a proof the source Relay checks itself.
const pass = async ({
  params,
  request,
}: {
  params: { relayId: string; _splat?: string }
  request: Request
}) => {
  const { passRelayPeerRequest } =
    await import("@/lib/relay-browser-passthrough.server")
  return passRelayPeerRequest(params.relayId, params._splat ?? "", request)
}

export const Route = createFileRoute("/api/relays/$relayId/peer/$")({
  server: {
    handlers: { GET: pass, HEAD: pass },
  },
})
