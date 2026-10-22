import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import { Predicate } from "effect"

import { forkPromise } from "@/effect/promise"

/**
 * Registers Hearth's service worker, which shows the offline page and push
 * notifications, once the page has loaded. A notification tapped while Kiln
 * is open opens its page in this tab without a reload.
 */
export const ServiceWorker = React.memo(function ServiceWorker() {
  const router = useRouter()
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const container = navigator.serviceWorker
    const onMessage = (event: MessageEvent<unknown>) => {
      const { data } = event
      if (
        Predicate.hasProperty(data, "type") &&
        data.type === "kiln.navigate" &&
        Predicate.hasProperty(data, "href") &&
        Predicate.isString(data.href) &&
        data.href.startsWith("/") &&
        !data.href.startsWith("//")
      ) {
        event.ports[0]?.postMessage("navigating")
        void router.navigate({ href: data.href })
      }
    }
    container.addEventListener("message", onMessage)
    container.startMessages()
    // Kiln works without it, as in a private window that refuses it.
    const register = () => forkPromise(() => container.register("/sw.js"))
    if (document.readyState === "complete") register()
    else window.addEventListener("load", register, { once: true })
    return () => {
      container.removeEventListener("message", onMessage)
      window.removeEventListener("load", register)
    }
  }, [router])
  return null
})
