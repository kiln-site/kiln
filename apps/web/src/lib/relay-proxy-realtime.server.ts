import { publishRealtimeChange } from "@/lib/realtime-source.server"

/** Tells whoever can see a Relay that its proxy changed. */
export function publishRelayProxyChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["relay-proxy"],
    type: "hearth.invalidate",
  })
}
