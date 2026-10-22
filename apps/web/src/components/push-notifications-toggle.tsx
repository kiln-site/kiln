import * as React from "react"
import { BellOff, BellRing } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { recoverPromise } from "@/effect/promise"
import {
  getPushNotificationState,
  subscribePushNotifications,
  unsubscribePushNotifications,
} from "@/server/push-notifications"

type PushState =
  | { status: "checking" | "unsupported" | "install" | "blocked" | "busy" }
  | { status: "off" | "on"; publicKey: string }

/**
 * Turns push notifications on or off for the signed-in user on this device.
 * Safari on iPhone and iPad offers push only to Kiln added to the Home
 * Screen, so there the button says how.
 */
export const PushNotificationsToggle = React.memo(
  function PushNotificationsToggle() {
    const [state, setState] = React.useState<PushState>({
      status: "checking",
    })

    React.useEffect(() => {
      let cancelled = false
      void recoverPromise(
        loadPushState,
        (): PushState => ({ status: "unsupported" })
      ).then((next) => !cancelled && setState(next))
      return () => {
        cancelled = true
      }
    }, [])

    if (state.status === "unsupported") return null

    const enable = async (
      publicKey: string,
      permission: Promise<NotificationPermission>
    ) => {
      setState({ status: "busy" })
      setState(
        await recoverPromise(
          () => turnPushOn(publicKey, permission),
          (error): PushState => {
            showPushFailure("turn on push notifications", error)
            return { status: "off", publicKey }
          }
        )
      )
    }

    const disable = async (publicKey: string) => {
      setState({ status: "busy" })
      setState(
        await recoverPromise(
          () => turnPushOff(publicKey),
          (error): PushState => {
            showPushFailure("turn off push notifications", error)
            return { status: "on", publicKey }
          }
        )
      )
    }

    const on = state.status === "on"
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={state.status === "checking" || state.status === "busy"}
        onClick={() => {
          switch (state.status) {
            case "install":
              showToast({
                message:
                  "To get push notifications on iPhone or iPad, add Kiln to your Home Screen: tap Share, then Add to Home Screen, and open Kiln from there.",
                type: "info",
              })
              return
            case "blocked":
              showToast({
                message:
                  "Notifications are blocked for Kiln. Allow them in this browser's site settings, then try again.",
                type: "info",
              })
              return
            case "off":
              // Safari asks only from within the tap itself.
              void enable(state.publicKey, Notification.requestPermission())
              return
            case "on":
              void disable(state.publicKey)
              return
          }
        }}
      >
        {on ? <BellOff /> : <BellRing />}
        <span className="max-sm:sr-only">
          {on ? "Disable push" : "Enable push"}
        </span>
      </Button>
    )
  }
)

async function loadPushState(): Promise<PushState> {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    // Safari in a tab on iPhone and iPad has no push at all. iPads say
    // they're Macs.
    const appleMobile =
      /iPhone|iPad/u.test(navigator.userAgent) ||
      (/Macintosh/u.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    return appleMobile ? { status: "install" } : { status: "unsupported" }
  }
  if (Notification.permission === "denied") return { status: "blocked" }
  // The worker registers once the page loads; one that never does, as in a
  // private window, means no push here.
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("No service worker")), 10_000)
    ),
  ])
  const subscription = await registration.pushManager.getSubscription()
  const { publicKey, subscribed } = await getPushNotificationState({
    data: { endpoint: subscription?.endpoint ?? null },
  })
  return {
    status:
      subscribed && Notification.permission === "granted" ? "on" : "off",
    publicKey,
  }
}

async function turnPushOn(
  publicKey: string,
  permission: Promise<NotificationPermission>
): Promise<PushState> {
  const answer = await permission
  if (answer !== "granted")
    return answer === "denied"
      ? { status: "blocked" }
      : { status: "off", publicKey }
  const subscription = await browserSubscription(publicKey)
  const { endpoint, keys } = subscription.toJSON()
  if (!endpoint || !keys?.auth || !keys.p256dh)
    throw new Error("The browser returned an incomplete subscription")
  await subscribePushNotifications({
    data: { endpoint, keys: { auth: keys.auth, p256dh: keys.p256dh } },
  })
  return { status: "on", publicKey }
}

async function turnPushOff(publicKey: string): Promise<PushState> {
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  // The browser's subscription stays, for other Kiln accounts signed in here
  // that use it; this account just stops sending to it.
  if (subscription)
    await unsubscribePushNotifications({
      data: { endpoint: subscription.endpoint },
    })
  return { status: "off", publicKey }
}

// This browser's subscription for Kiln's key, replacing one made for another
// key, as before the database was reset.
async function browserSubscription(publicKey: string) {
  const registration = await navigator.serviceWorker.ready
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

function showPushFailure(action: string, error: unknown) {
  showToast({
    message: `Could not ${action}: ${error instanceof Error ? error.message : String(error)}`,
    type: "error",
  })
}
