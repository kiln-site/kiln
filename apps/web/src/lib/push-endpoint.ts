// Push services browsers hand out subscriptions for: Chrome and other
// Chromium browsers (FCM), Firefox (Mozilla), Safari (Apple), and Edge
// (Windows Push Notification Services).
const pushServiceHosts = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
])
const pushServiceHostSuffixes = [".push.apple.com", ".notify.windows.com"]

/**
 * Whether a subscription's endpoint is a known browser push service. Hearth
 * posts to the endpoint a browser gives it, so anything else, such as an
 * address inside the network Hearth runs in, is refused.
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false
  const url = new URL(endpoint)
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    return false
  const host = url.hostname
  return (
    pushServiceHosts.has(host) ||
    pushServiceHostSuffixes.some((suffix) => host.endsWith(suffix))
  )
}
