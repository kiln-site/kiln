import type {
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import { formatBytes } from "@/lib/format-bytes"
import { kilnReleaseLabel } from "@/lib/release-version"

// What a notification says in a line or two, shared by the inbox and the
// push notifications Hearth sends to devices.

const resourceTypeLabels = {
  app: "App",
  database: "Database",
  instance: "Game Server",
  relay: "Relay",
} satisfies Record<NotificationResource["type"], string>

// The release name GitHub gave the build, e.g. "v0.1.0 Nightly #17", or one
// made from its version for notifications written without it.
function releaseName(name: string | undefined, version: string) {
  return name ?? kilnReleaseLabel(version)
}

export function notificationTitle(content: NotificationContent): string {
  switch (content.kind) {
    case "kiln.release":
      return `${releaseName(content.name, content.version)} available`
    case "kiln.updated":
      return `Updated to ${releaseName(content.name, content.version)}`
    case "access.invited": {
      const { actorName, resource } = content
      switch (content.outcome) {
        case undefined:
          return `${actorName} invited you to ${resource.name}`
        case "accepted":
          return `Joined ${resource.name}`
        case "declined":
          return `Declined ${actorName}'s invite to ${resource.name}`
        case "cancelled":
          return `${actorName}'s invite to ${resource.name} was cancelled`
        case "expired":
          return `${actorName}'s invite to ${resource.name} expired`
      }
    }
    case "access.removed":
      return `Removed from ${content.resource.name}`
    case "resource.disk-limit":
      // Apps stop at their limit; databases keep running.
      return content.resource.type === "app"
        ? `${content.resource.name} was stopped at its disk limit`
        : `${content.resource.name} is over its disk limit`
    case "app.image-update":
      return `Update available for ${content.resource.name}`
  }
}

export function notificationDetail(content: NotificationContent): string | null {
  switch (content.kind) {
    case "kiln.release":
      return null
    case "kiln.updated":
      return `from ${releaseName(content.previousName, content.previousVersion)}`
    case "access.invited":
      return content.outcome === "accepted"
        ? `invited by ${content.actorName}`
        : resourceTypeLabels[content.resource.type]
    case "access.removed":
      return `by ${content.actorName}`
    case "resource.disk-limit":
      return `${formatBytes(content.usedBytes)} of ${formatBytes(content.limitBytes)}`
    case "app.image-update":
      return `New image for ${content.image}`
  }
}
