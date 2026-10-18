import { createFileRoute } from "@tanstack/react-router"

// Deliveries from connected GitHub Apps, verified by each app's secret.
export const Route = createFileRoute("/api/github/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleGitHubWebhook } =
          await import("@/server/github-sync.server")
        return handleGitHubWebhook(request)
      },
    },
  },
})
