import { Effect } from "effect"

import {
  WebPush,
  nextPushDueEffect,
  pushPendingNotificationsEffect,
} from "@/effect/push-notifications"
import { runAppEffect, runAppEffectUntraced } from "@/effect/runtime"
import { startPollingWorker, type WorkerPass } from "@/lib/polling-worker"

/** Pushes new notifications to devices as `publishNotificationChange` wakes it. */
export function startNotificationPushes(): void {
  startPollingWorker("Notifications.push", pushPendingNotifications)
}

// A push waits a few seconds for an open tab to show it, so the pass that
// sends it runs when it's due.
async function pushPendingNotifications(): Promise<WorkerPass> {
  const due = await runAppEffectUntraced(nextPushDueEffect())
  if (due === null || due > Date.now()) {
    return { outcome: "idle", nextAttemptAt: due }
  }
  await runAppEffect(
    "Notifications.push.pass",
    pushPendingNotificationsEffect().pipe(Effect.provide(WebPush.layer))
  )
  return { outcome: "worked" }
}
