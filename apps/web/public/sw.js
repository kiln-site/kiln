// Hearth's service worker. It shows the offline page when a page load can't
// reach Hearth, and shows the push notifications Hearth sends. Every other
// request goes to the network untouched, and nothing else is cached.

const offlineCache = "kiln-offline-v1"
const offlineUrl = "/offline.html"

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(offlineCache)
      .then((cache) => cache.add(new Request(offlineUrl, { cache: "reload" })))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith("kiln-") && name !== offlineCache)
          .map((name) => caches.delete(name))
      )
      // Starts each page request while the worker boots, so handling page
      // loads here adds no wait.
      await self.registration.navigationPreload?.enable()
      await self.clients.claim()
    })()
  )
})

// What a proxy in front of Hearth answers while Hearth is down or restarting,
// as during an update. Hearth's own pages never answer with these.
const gatewayErrors = new Set([502, 503, 504])

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return
  event.respondWith(
    (async () => {
      try {
        const response =
          (await event.preloadResponse) ?? (await fetch(event.request))
        if (!gatewayErrors.has(response.status)) return response
      } catch {
        // Offline, or Hearth can't be reached.
      }
      return (await caches.match(offlineUrl)) ?? Response.error()
    })()
  )
})

self.addEventListener("push", (event) => {
  const message = readPushMessage(event.data)
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(message.title, {
        badge: message.badge,
        body: message.body,
        // When it was shown, so an open page can tell one cleared since
        // from one its inbox hasn't loaded yet.
        data: { shownAt: Date.now(), url: message.url },
        icon: message.icon,
        tag: message.tag,
      }),
      closeNotifications(message.close).catch(() => undefined),
    ])
  )
})

// Closes the notifications this device still shows that were read or cleared
// since, on this device or another. Browsers let a push close notifications
// only alongside one it shows, so this rides along with the next one; an open
// Kiln page closes them right away (see `notifications.tsx`).
async function closeNotifications(tags) {
  if (!Array.isArray(tags) || !tags.length) return
  const closing = new Set(tags.filter((tag) => typeof tag === "string"))
  for (const notification of await self.registration.getNotifications())
    if (closing.has(notification.tag)) notification.close()
}

// Browsers require every push to show a notification, so one that can't be
// read still says something.
function readPushMessage(data) {
  try {
    const message = data?.json()
    if (message && typeof message.title === "string") return message
  } catch {
    // Not JSON.
  }
  return { title: "Kiln", body: data?.text() ?? undefined, url: "/" }
}

// Opens what the notification is about in an open Kiln window, or a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin)
  if (url.origin !== self.location.origin) return
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      })
      const open = windows.find(
        (client) => new URL(client.url).origin === url.origin
      )
      if (!open) return self.clients.openWindow(url.href)
      // A Kiln page navigates in place, without a reload, and says so (see
      // `ServiceWorker` in service-worker.tsx). Any other page, such as the
      // offline page, is navigated instead, and a window that closed
      // meanwhile is replaced by a new one.
      try {
        await open.focus()
        if (await askToNavigate(open, url.pathname + url.search)) return
        await open.navigate(url.href)
      } catch {
        await self.clients.openWindow(url.href)
      }
    })()
  )
})

function askToNavigate(client, href) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(false), 1000)
    channel.port1.onmessage = () => {
      clearTimeout(timer)
      resolve(true)
    }
    client.postMessage({ type: "kiln.navigate", href }, [channel.port2])
  })
}
