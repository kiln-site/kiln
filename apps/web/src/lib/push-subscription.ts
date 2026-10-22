import { showToast } from "@workspace/ui/components/sonner"

import {
  getPushNotificationState,
  subscribePushNotifications,
  unsubscribePushNotifications,
} from "@/server/push-notifications"

// Turning push on and off for this device, from the Notifications page or the
// installed app's first-run prompt.

/** Fired on `window` when this device's push turns on or off. */
export const pushChangedEvent = "kiln:push-changed"

/** Whether this browser can receive push notifications at all. */
export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
}

/**
 * iPhone or iPad, where Safari offers push only to Kiln added to the Home
 * Screen. iPads say they're Macs.
 */
export function isAppleMobile(): boolean {
  return (
    /iPhone|iPad/u.test(navigator.userAgent) ||
    (/Macintosh/u.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  )
}

/** Whether Kiln is running as an installed app rather than in a tab. */
export function isInstalledApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true)
  )
}

/**
 * The service worker's registration. It registers once the page loads; one
 * that never does, as in a private window, means no push here.
 */
export function pushRegistration(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("No service worker")), 10_000)
    ),
  ])
}

/**
 * Sends the signed-in user's notifications to this device once `permission`
 * is granted, and answers what the user chose. Ask for permission from within
 * the tap itself, since Safari asks only then; `publicKey` saves a request
 * when the caller already has it.
 */
export async function subscribeThisDevice(
  permission: Promise<NotificationPermission>,
  publicKey?: string
): Promise<NotificationPermission> {
  const answer = await permission
  if (answer !== "granted") return answer
  const key =
    publicKey ??
    (await getPushNotificationState({ data: { endpoint: null } })).publicKey
  const subscription = await browserSubscription(key)
  const { endpoint, keys } = subscription.toJSON()
  if (!endpoint || !keys?.auth || !keys.p256dh)
    throw new Error("The browser returned an incomplete subscription")
  await subscribePushNotifications({
    data: { endpoint, keys: { auth: keys.auth, p256dh: keys.p256dh } },
  })
  window.dispatchEvent(new Event(pushChangedEvent))
  return answer
}

/** Stops sending the signed-in user's notifications to this device. */
export async function unsubscribeThisDevice(): Promise<void> {
  const registration = await pushRegistration()
  const subscription = await registration.pushManager.getSubscription()
  // The browser's subscription stays, for other Kiln accounts signed in here
  // that use it; this account just stops sending to it.
  if (subscription)
    await unsubscribePushNotifications({
      data: { endpoint: subscription.endpoint },
    })
  window.dispatchEvent(new Event(pushChangedEvent))
}

// This browser's subscription for Kiln's key, replacing one made for another
// key, as before the database was reset.
async function browserSubscription(publicKey: string) {
  const registration = await pushRegistration()
  const applicationServerKey = base64UrlBytes(publicKey)
  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    const key = existing.options.applicationServerKey
    if (key && sameBytes(new Uint8Array(key), applicationServerKey))
      return existing
    await existing.unsubscribe()
  }
  return registration.pushManager.subscribe({
    applicationServerKey,
    userVisibleOnly: true,
  })
}

function base64UrlBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  )
}

export function showPushFailure(action: string, error: unknown) {
  showToast({
    message: `Could not ${action}: ${error instanceof Error ? error.message : String(error)}`,
    type: "error",
  })
}
