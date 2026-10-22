import { Effect } from "effect"

import {
  WebPush,
  hasPendingPushesEffect,
  pushPendingNotificationsEffect,
} from "@/effect/push-notifications"
import { runAppEffect, runAppEffectUntraced } from "@/effect/runtime"
import { startPollingWorker, type WorkerPass } from "@/lib/polling-worker"

/** Pushes new notifications to devices as `publishNotificationChange` wakes it. */
export function startNotificationPushes(): void {
  startPollingWorker("Notifications.push", pushPendingNotifications)
}

async function pushPendingNotifications(): Promise<WorkerPass> {
  if (!(await runAppEffectUntraced(hasPendingPushesEffect()))) {
    return { outcome: "idle", nextAttemptAt: null }
  }
  await runAppEffect(
    "Notifications.push.pass",
    pushPendingNotificationsEffect().pipe(Effect.provide(WebPush.layer))
  )
  return { outcome: "worked" }
}
