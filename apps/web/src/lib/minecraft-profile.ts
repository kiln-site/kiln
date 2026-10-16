const minecraftUsernamePattern = /^[a-z\d_]{3,16}$/iu

export function isMinecraftUsername(value: string): boolean {
  return minecraftUsernamePattern.test(value.trim())
}

export function minecraftUsernameKey(value: string): string {
  return value.trim().toLowerCase()
}

export function minecraftHeadUrl(profileId: string): string {
  return `https://mc-heads.net/avatar/${encodeURIComponent(profileId)}/32.png`
}

// The Minecraft usernames among Relay owners, as the key their avatars are
// cached under.
export function relayOwnerNamesKey(
  relays: ReadonlyArray<{ ownerName: string | null }> | undefined
): string {
  const names = new Set<string>()
  for (const relay of relays ?? []) {
    if (relay.ownerName && isMinecraftUsername(relay.ownerName)) {
      names.add(minecraftUsernameKey(relay.ownerName))
    }
  }
  return [...names].sort().join(",")
}

// Profile IDs by username key.
export function selectOwnerProfileIds(
  profiles: Array<{ displayName: string; profileId: string }>
): ReadonlyMap<string, string> {
  return new Map(
    profiles.map((profile) => [
      minecraftUsernameKey(profile.displayName),
      profile.profileId,
    ])
  )
}
