import * as Sentry from "@sentry/tanstackstart-react"

import {
  isExpectedAppError,
  parseSampleRate,
} from "./observability/sentry-policy"

const dsn = import.meta.env.VITE_SENTRY_DSN?.trim()

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_KILN_BUILD_SHA || undefined,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    tracesSampleRate: import.meta.env.PROD
      ? parseSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE, 0.05)
      : 0,
    replaysSessionSampleRate: parseSampleRate(
      import.meta.env.VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
      0.05
    ),
    replaysOnErrorSampleRate: 1,
    beforeSend(event, hint) {
      return isExpectedAppError(hint.originalException) ? null : event
    },
    initialScope: {
      tags: { "kiln.service": "hearth-browser" },
    },
  })
}

if (
  dsn &&
  import.meta.env.DEV &&
  import.meta.env.VITE_SENTRY_VERIFICATION_ENABLED === "true"
) {
  Object.defineProperty(window, "__kilnVerifySentry", {
    configurable: true,
    value: async () => {
      const eventId = Sentry.captureException(
        new Error("Kiln browser Sentry verification")
      )
      await Sentry.flush(5_000)
      return eventId
    },
  })
}
