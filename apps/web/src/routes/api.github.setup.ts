import { createFileRoute } from "@tanstack/react-router"

// GitHub sends the browser here after the app is installed on an account,
// or its repository access changes.
export const Route = createFileRoute("/api/github/setup")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { githubSetupRedirect } =
          await import("@/lib/github-setup-route.server")
        const { completeGitHubInstallation } =
          await import("@/server/github-sync.server")
        return githubSetupRedirect(request, (user, url) => {
          const installationId = Number(url.searchParams.get("installation_id"))
          if (!Number.isSafeInteger(installationId) || installationId <= 0) {
            throw new Error("GitHub didn't say where the app was installed")
          }
          return completeGitHubInstallation({
            installationId,
            state: url.searchParams.get("state"),
            user,
          })
        })
      },
    },
  },
})
