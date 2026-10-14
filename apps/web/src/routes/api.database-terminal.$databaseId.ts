import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/database-terminal/$databaseId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { terminalResponse } = await import("@/server/terminal-response")
        return terminalResponse(request, {
          kind: "database",
          id: params.databaseId,
        })
      },
    },
  },
})
