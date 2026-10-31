import {
  saveAppImageUpdatePolicyEffect,
  skipAppImageUpdateEffect,
  type AppImageUpdateMode,
} from "@/effect/app-image-updates"
import { runAppEffect } from "@/effect/runtime"
import {
  askAppDeploymentEffect,
  publishAppDeploymentChange,
} from "@/lib/app-deployments.server"
import {
  askAppImageEffect,
  recheckAppImage,
  recordCheckedAppImageEffect,
  resolveAppImageUpdateNotificationsEffect,
  type AppImageAnswer,
} from "@/lib/app-image-updates.server"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { authorizedAppFor } from "@/server/app-access"

// What people who can deploy an image app decide about its updates. Each
// one changes what Kiln does next for everyone who sees the app.

interface AppInput {
  appId: string
  relayId: string
}

/**
 * Turns checks off, or on to notify or deploy once an update has waited.
 * Turned on, the app is checked now rather than within the hour.
 */
export async function saveAppImageUpdatePolicyHandler(
  user: AuthenticatedUser,
  data: AppInput & { delayHours: number; mode: AppImageUpdateMode }
) {
  const { app, relay } = await imageApp(user, data)
  await runAppEffect(
    "apps.imageUpdates.policy",
    saveAppImageUpdatePolicyEffect(app.appId, {
      delayHours: data.delayHours,
      mode: data.mode,
    })
  )
  if (data.mode !== "off") recheckAppImage(relay.id, app.appId, user.id)
  else
    await runAppEffect(
      "apps.imageUpdates.policy.resolveNotifications",
      resolveAppImageUpdateNotificationsEffect(relay.id, app.appId, {
        unchecked: true,
      })
    )
  publishAppDeploymentChange(relay.id)
}

/**
 * Asks about the app's tag now, holding no lane while registries answer;
 * `recordAppImageCheckHandler` records the answer holding the app.
 */
export async function askAppImageUpdateHandler(
  user: AuthenticatedUser,
  data: AppInput
) {
  const { app, relay } = await imageApp(user, data)
  return runAppEffect(
    "apps.imageUpdates.askApp",
    askAppImageEffect(relay, app.appId)
  )
}

export async function recordAppImageCheckHandler(
  user: AuthenticatedUser,
  data: AppInput & {
    asked: { answers: ReadonlyArray<AppImageAnswer>; unchecked: boolean }
  }
) {
  const { app, relay } = await imageApp(user, data)
  await runAppEffect(
    "apps.imageUpdates.recordApp",
    recordCheckedAppImageEffect(relay, app.appId, data.asked, user.id)
  )
  publishAppDeploymentChange(relay.id)
}

/** Passes over the update on offer: it neither notifies nor deploys. */
export async function skipAppImageUpdateHandler(
  user: AuthenticatedUser,
  data: AppInput & { digest: string }
) {
  const { app, relay } = await imageApp(user, data)
  const skipped = await runAppEffect(
    "apps.imageUpdates.skip",
    skipAppImageUpdateEffect(app.appId, data.digest)
  )
  if (!skipped) throw new Error("That update is no longer on offer")
  await runAppEffect(
    "apps.imageUpdates.skip.resolveNotifications",
    resolveAppImageUpdateNotificationsEffect(relay.id, app.appId)
  )
  publishAppDeploymentChange(relay.id)
}

/** Deploys the update on offer now, skipped or not, whatever its wait. */
export async function deployAppImageUpdateHandler(
  user: AuthenticatedUser,
  data: AppInput
) {
  const { app, relay } = await imageApp(user, data)
  // Queued behind any deployment running, joining any deploy already asked
  // for; it deploys the update on offer when its turn comes.
  await runAppEffect(
    "apps.imageUpdates.deploy",
    askAppDeploymentEffect({
      appId: app.appId,
      relayId: relay.id,
      trigger: "update",
      userId: user.id,
    })
  )
  return { queued: true as const }
}

// Deciding an app's updates is configuring it, so it takes what deploying
// it does.
async function imageApp(user: AuthenticatedUser, data: AppInput) {
  const authorized = await authorizedAppFor(user, data, "app.manage")
  if (authorized.app.config.sourceType !== "image") {
    throw new Error("Only apps deployed from an image check for updates")
  }
  return authorized
}
