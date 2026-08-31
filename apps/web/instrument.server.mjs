import * as Sentry from "@sentry/tanstackstart-react"

import {
  isExpectedAppError,
  parseSampleRate,
} from "./src/observability/sentry-policy.ts"

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
    tracesSampleRate:
      process.env.NODE_ENV === "production"
        ? parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.05)
        : 0,
    beforeSend(event, hint) {
      return isExpectedAppError(hint.originalException) ? null : event
    },
    initialScope: {
      tags: { "kiln.service": "hearth-server" },
    },
  })
}
