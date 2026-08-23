const relativeFileMinuteMs = 60_000
const relativeFileHourMs = 60 * relativeFileMinuteMs
const relativeFileDayMs = 24 * relativeFileHourMs

export function shortRelativeFileTime(timestamp: number): string | null {
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < relativeFileMinuteMs) return "just now"
  if (elapsed < relativeFileHourMs) {
    return `${Math.floor(elapsed / relativeFileMinuteMs)}m ago`
  }
  if (elapsed < relativeFileDayMs) {
    return `${Math.floor(elapsed / relativeFileHourMs)}h ago`
  }
  if (elapsed < 7 * relativeFileDayMs) {
    return `${Math.floor(elapsed / relativeFileDayMs)}d ago`
  }
  return null
}
