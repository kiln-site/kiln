import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/app-terminal/$appId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { terminalResponse } = await import("@/server/terminal-response")
        return terminalResponse(request, { kind: "app", id: params.appId })
      },
    },
  },
})
