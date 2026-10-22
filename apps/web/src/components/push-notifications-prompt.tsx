import * as React from "react"
import { BellRing } from "lucide-react"
import { Result } from "effect"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import { recoverPromise } from "@/effect/promise"
import {
  isInstalledApp,
  pushSupported,
  showPushFailure,
  subscribeThisDevice,
} from "@/lib/push-subscription"

// Set once the prompt was answered either way, so each device asks once.
const promptedKey = "kiln:push-prompted"

// Lets the app settle after sign-in before asking.
const promptDelayMs = 1_500

/**
 * Asks once, in Kiln installed as an app, whether to turn on push
 * notifications, since otherwise nothing says the app can send them. "Turn
 * on" goes straight to the browser's own permission prompt. Push stays on
 * the Notifications page for anyone who says not now.
 */
export const PushNotificationsPrompt = React.memo(
  function PushNotificationsPrompt() {
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
      if (
        !isInstalledApp() ||
        !pushSupported() ||
        Notification.permission !== "default" ||
        Result.getOrElse(
          Result.try(() => localStorage.getItem(promptedKey) !== null),
          () => true
        )
      )
        return
      const timer = setTimeout(() => setOpen(true), promptDelayMs)
      return () => clearTimeout(timer)
    }, [])

    const close = () => {
      setOpen(false)
      Result.try(() => localStorage.setItem(promptedKey, String(Date.now())))
    }

    return (
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <span className="mb-2 grid size-10 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <BellRing className="size-5" aria-hidden />
            </span>
            <DialogTitle>Get notified on this device?</DialogTitle>
            <DialogDescription>
              Kiln can tell you about invitations, Kiln updates, and disk
              warnings, even when the app is closed. You can change this
              anytime on the Notifications page.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Not now
            </Button>
            <Button
              onClick={() => {
                // Safari asks only from within the tap itself.
                const permission = Notification.requestPermission()
                close()
                void recoverPromise(
                  () => subscribeThisDevice(permission),
                  (error) => showPushFailure("turn on notifications", error)
                )
              }}
            >
              Turn on notifications
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
)
