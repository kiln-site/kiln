import { createFileRoute } from "@tanstack/react-router"

// Every terminal's stream, whatever its shell runs in.
export const Route = createFileRoute("/api/terminal")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { terminalResponse } = await import("@/server/terminal-response")
        return terminalResponse(request)
      },
    },
  },
})
