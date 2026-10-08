export function replaceRelayUpdateVersion<
  Relay extends {
    relayId: string
    currentReleaseName: string | null
    currentVersion: string | null
  },
>(
  relays: ReadonlyArray<Relay>,
  relayId: string,
  version: string,
  releaseName: string
): Array<Relay> {
  return relays.map((relay) =>
    relay.relayId === relayId
      ? { ...relay, currentReleaseName: releaseName, currentVersion: version }
      : relay
  )
}
