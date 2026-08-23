export const DISPLAY_NAME_MAX_LENGTH = 16

export function parseDisplayName(value: string): string {
  const displayName = value.trim()
  if (!displayName) throw new Error("Enter a display name")
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(
      `Use no more than ${DISPLAY_NAME_MAX_LENGTH} characters for your display name`
    )
  }
  return displayName
}

export function displayNameFromEmail(email: string): string {
  return (
    email
      .trim()
      .toLowerCase()
      .split("@")[0]
      ?.slice(0, DISPLAY_NAME_MAX_LENGTH) || "Kiln operator"
  )
}

export function resolveDisplayName(
  displayName: string | null | undefined,
  email: string
): string {
  const normalized = displayName?.trim()
  return normalized
    ? normalized.slice(0, DISPLAY_NAME_MAX_LENGTH)
    : displayNameFromEmail(email)
}
