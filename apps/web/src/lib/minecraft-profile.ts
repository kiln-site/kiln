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
