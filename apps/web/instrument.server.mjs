import * as Sentry from "@sentry/tanstackstart-react"

const dsn = process.env.SENTRY_DSN?.trim()

if (dsn && !Sentry.isInitialized()) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ||
      process.env.KILN_ENVIRONMENT ||
      "production",
    release:
      process.env.SENTRY_RELEASE ||
      process.env.KILN_BUILD_SHA ||
      process.env.SOURCE_COMMIT,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
    tracesSampleRate: parseSampleRate(
      process.env.SENTRY_TRACES_SAMPLE_RATE,
      process.env.NODE_ENV === "production" ? 0.05 : 1
    ),
    beforeSend(event, hint) {
      return isExpectedAppError(hint.originalException) ? null : event
    },
    initialScope: {
      tags: { "kiln.service": "hearth-server" },
    },
  })
}

function parseSampleRate(value, fallback) {
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback
}

function isExpectedAppError(value) {
  if (!value || typeof value !== "object") return false
  if (value.name === "AbortError") return true
  if (
    [
      "AuthenticationError",
      "PermissionDeniedError",
      "ResourceNotFoundError",
    ].includes(value._tag)
  ) {
    return true
  }
  return value._tag === "RelayResponseError" && value.status < 500
}
