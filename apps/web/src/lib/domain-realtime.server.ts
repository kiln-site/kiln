import { publishRealtimeChange } from "@/lib/realtime-source.server"

export function publishDomainChange(scope?: {
  instanceId: string
  relayId: string
}): void {
  publishRealtimeChange({
    audience: scope
      ? { kind: "relays", relayIds: [scope.relayId] }
      : { kind: "authenticated" },
    scope,
    topics: ["domains"],
    type: "hearth.invalidate",
  })
}
