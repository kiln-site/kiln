import { createFileRoute } from "@tanstack/react-router"

import { forwardBrowserTelemetry } from "@/server/browser-telemetry"

export const Route = createFileRoute("/api/telemetry/v1/$signal")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        forwardBrowserTelemetry(request, params.signal),
    },
  },
})
