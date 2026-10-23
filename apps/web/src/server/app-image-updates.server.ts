import {
  saveAppImageUpdatePolicyEffect,
  skipAppImageUpdateEffect,
  type AppImageUpdateMode,
} from "@/effect/app-image-updates"
import { runAppEffect } from "@/effect/runtime"
import {
  publishAppDeploymentChange,
  startAppDeploymentEffect,
} from "@/lib/app-deployments.server"
import {
  checkAppImageEffect,
  recheckAppImage,
  resolveAppImageUpdateNotificationsEffect,
} from "@/lib/app-image-updates.server"
import { authorizedApp } from "@/server/app-access"

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
  data: AppInput & { delayHours: number; mode: AppImageUpdateMode }
) {
  const { app, relay, user } = await imageApp(data)
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
      resolveAppImageUpdateNotificationsEffect(app.appId, { unchecked: true })
    )
  publishAppDeploymentChange(relay.id)
}

/** Checks the app's tag now. */
export async function checkAppImageUpdateHandler(data: AppInput) {
  const { app, relay, user } = await imageApp(data)
  await runAppEffect(
    "apps.imageUpdates.checkApp",
    checkAppImageEffect(relay, app.appId, user.id)
  )
  publishAppDeploymentChange(relay.id)
}

/** Passes over the update on offer: it neither notifies nor deploys. */
export async function skipAppImageUpdateHandler(
  data: AppInput & { digest: string }
) {
  const { app, relay } = await imageApp(data)
  const skipped = await runAppEffect(
    "apps.imageUpdates.skip",
    skipAppImageUpdateEffect(app.appId, data.digest)
  )
  if (!skipped) throw new Error("That update is no longer on offer")
  await runAppEffect(
    "apps.imageUpdates.skip.resolveNotifications",
    resolveAppImageUpdateNotificationsEffect(app.appId)
  )
  publishAppDeploymentChange(relay.id)
}

/** Deploys the update on offer now, skipped or not, whatever its wait. */
export async function deployAppImageUpdateHandler(data: AppInput) {
  const { app, relay, user } = await imageApp(data)
  const started = await runAppEffect(
    "apps.imageUpdates.deploy",
    startAppDeploymentEffect({
      appId: app.appId,
      relayId: relay.id,
      trigger: "update",
      userId: user.id,
    })
  )
  publishAppDeploymentChange(relay.id)
  return { deployment: started?.deployment ?? null }
}

// Deciding an app's updates is configuring it, so it takes what deploying
// it does.
async function imageApp(data: AppInput) {
  const authorized = await authorizedApp(data, "app.manage")
  if (authorized.app.config.sourceType !== "image") {
    throw new Error("Only apps deployed from an image check for updates")
  }
  return authorized
}
