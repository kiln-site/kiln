const EXPECTED_ERROR_TAGS = new Set([
  "AuthenticationError",
  "PermissionDeniedError",
  "ResourceNotFoundError",
])

export function parseSampleRate(
  value: string | undefined,
  fallback: number
): number {
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback
}

export function isExpectedAppError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }
  if ("name" in value && value.name === "AbortError") return true
  if (!("_tag" in value)) return false
  if (typeof value._tag !== "string") return false
  if (EXPECTED_ERROR_TAGS.has(value._tag)) return true
  if (value._tag !== "RelayResponseError" || !("status" in value)) return false
  return typeof value.status === "number" && value.status < 500
}
