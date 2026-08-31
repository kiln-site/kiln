import * as Sentry from "@sentry/node"

const dsn = process.env.SENTRY_DSN?.trim()
const bakedCommit = String(import.meta.env?.KILN_BUILD_SHA ?? "").trim()

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ||
      process.env.KILN_ENVIRONMENT ||
      "production",
    release: process.env.SENTRY_RELEASE || bakedCommit || undefined,
    sendDefaultPii: false,
    tracesSampleRate:
      process.env.NODE_ENV === "production"
        ? parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.05)
        : 0,
    initialScope: {
      tags: { "kiln.service": "relay" },
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
