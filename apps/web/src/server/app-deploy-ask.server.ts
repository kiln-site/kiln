import { runAppEffect } from "@/effect/runtime"
import type { AppDeploymentAsk } from "@/effect/app-deployments"
import { authorizedAppFor } from "@/server/app-access"
import { resourceOperation } from "@/server/resource-operation.server"

export interface AppDeployAsk {
  appId: string
  /** A redeploy's commit, and the repository and branch it's from. */
  commit?: { sha: string; source: string }
  /** A redeploy's digest, and the image it was of. */
  image?: { digest: string; source: string }
  relayId: string
  trigger: Extract<AppDeploymentAsk, "manual" | "redeploy">
}

/**
 * A person asking an app to deploy, as a push does: their ask joins the
 * app's request, the newest winning, and it deploys once any deployment
 * running ends. It holds the app shared, beside its build and everyday
 * changes, so it returns at once, and is refused while the app is
 * replaced or removed.
 */
export const askAppDeploy = resourceOperation({
  kind: "app",
  id: (input: AppDeployAsk) => input.appId,
  name: "app.deploy.ask",
  doing: "Asking this App to deploy",
  permission: () => "app.manage",
  lock: "shared",
  run: async (user, input) => {
    const { relay } = await authorizedAppFor(user, input, "app.manage")
    const { askAppDeploymentEffect } =
      await import("@/lib/app-deployments.server")
    await runAppEffect(
      "apps.deploy.ask",
      askAppDeploymentEffect({ ...input, relayId: relay.id, userId: user.id })
    )
    return { queued: true as const }
  },
})
