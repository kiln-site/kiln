import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/platform-terminal/$relayId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { terminalResponse } = await import("@/server/terminal-response")
        return terminalResponse(request, {
          kind: "platform",
          id: params.relayId,
        })
      },
    },
  },
})
