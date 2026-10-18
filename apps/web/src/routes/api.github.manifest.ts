import { createFileRoute } from "@tanstack/react-router"

// GitHub sends the browser here after creating the app from Kiln's manifest.
export const Route = createFileRoute("/api/github/manifest")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { githubSetupRedirect } =
          await import("@/lib/github-setup-route.server")
        const { completeGitHubManifest } =
          await import("@/server/github-sync.server")
        return githubSetupRedirect(request, (user, url) => {
          const code = url.searchParams.get("code")
          const state = url.searchParams.get("state")
          if (!code || !state) {
            throw new Error("GitHub didn't return the new app")
          }
          return completeGitHubManifest({ code, state, user })
        })
      },
    },
  },
})
