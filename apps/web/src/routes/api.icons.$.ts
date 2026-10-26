import { createFileRoute } from "@tanstack/react-router"

// Icons for game servers, apps, databases (`/api/icons/<kind>/<relayId>/<id>`)
// and accounts (`/api/icons/user/<userId>`), for whoever may see them.
export const Route = createFileRoute("/api/icons/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { iconResponse } = await import("@/server/icon-response.server")
        return iconResponse(request, params._splat ?? "")
      },
    },
  },
})
