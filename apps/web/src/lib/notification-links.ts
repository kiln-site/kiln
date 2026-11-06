import type {
  KilnNotification,
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import { securityScopeKey } from "@/lib/security"

// Where notifications lead. Pages resolve full IDs and fall back to their list
// for something that's gone, so a stored notification's link stays good.

const resourcePaths = {
  app: "app",
  database: "db",
  instance: "server",
  relay: "relay",
} satisfies Record<NotificationResource["type"], string>

export function notificationResourceHref(resource: NotificationResource) {
  return `/${resourcePaths[resource.type]}/${encodeURIComponent(resource.id)}`
}

function resourceInfoHref(resource: NotificationResource) {
  return `${notificationResourceHref(resource)}/info`
}

export function deploymentsHref(resource: NotificationResource) {
  const search = new URLSearchParams({
    appId: resource.id,
    relayId: resource.relayId,
  })
  return `/infra/deployments?${search}`
}

export function securityReportHref(
  resources: ReadonlyArray<NotificationResource>,
  platformAdmin: boolean
): string | null {
  const only = resources.length === 1 ? resources[0] : undefined
  if (!platformAdmin) return only ? notificationResourceHref(only) : null
  if (!only) return "/kiln/security"
  const scope = securityScopeKey(only.type, only.relayId, only.id)
  return `/kiln/security?scope=${encodeURIComponent(scope)}`
}

/**
 * The page a notification is about, or null when there's nothing to open: a
 * resource the user lost access to, or a report about several of them for
 * someone the Security page isn't open to.
 */
export function notificationHref(
  content: NotificationContent,
  platformAdmin: boolean
): string | null {
  switch (content.kind) {
    case "kiln.release":
      return "/infra/updates"
    case "kiln.updated":
      return "/infra/updates/changelog"
    case "access.invited":
      return content.outcome === "accepted"
        ? notificationResourceHref(content.resource)
        : null
    case "access.removed":
      return null
    case "resource.disk-limit":
    case "app.image-update":
      return resourceInfoHref(content.resource)
    case "app.deployed":
      return content.status === "failed"
        ? `${notificationResourceHref(content.resource)}/logs?stream=deployment`
        : notificationResourceHref(content.resource)
    case "security.report":
      return securityReportHref(content.resources, platformAdmin)
    case "server.migration":
      return notificationResourceHref(
        content.outcome === "completed" ? content.destination : content.source
      )
  }
}

/** Where a notification opens, or its place in the inbox if it has no page. */
export function notificationDestination(
  { content, id }: KilnNotification,
  platformAdmin: boolean
) {
  return (
    notificationHref(content, platformAdmin) ?? `/notifications?focus=${id}`
  )
}
