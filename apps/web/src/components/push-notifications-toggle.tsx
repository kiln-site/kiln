import * as React from "react"
import { BellOff, BellRing } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { recoverPromise } from "@/effect/promise"
import {
  isAppleMobile,
  pushChangedEvent,
  pushRegistration,
  pushSupported,
  showPushFailure,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from "@/lib/push-subscription"
import { getPushNotificationState } from "@/server/push-notifications"

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

    // Loads again when push changes elsewhere, as from the installed app's
    // prompt.
    React.useEffect(() => {
      let cancelled = false
      const load = () =>
        void recoverPromise(
          loadPushState,
          (): PushState => ({ status: "unsupported" })
        ).then((next) => !cancelled && setState(next))
      load()
      window.addEventListener(pushChangedEvent, load)
      return () => {
        cancelled = true
        window.removeEventListener(pushChangedEvent, load)
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
          async (): Promise<PushState> => {
            const answer = await subscribeThisDevice(permission, publicKey)
            return answer === "granted"
              ? { status: "on", publicKey }
              : answer === "denied"
                ? { status: "blocked" }
                : { status: "off", publicKey }
          },
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
          async (): Promise<PushState> => {
            await unsubscribeThisDevice()
            return { status: "off", publicKey }
          },
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
  if (!pushSupported())
    // Safari in a tab on iPhone and iPad has no push at all.
    return isAppleMobile() ? { status: "install" } : { status: "unsupported" }
  if (Notification.permission === "denied") return { status: "blocked" }
  const registration = await pushRegistration()
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
