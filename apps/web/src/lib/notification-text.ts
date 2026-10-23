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

// "a Game Server", "an App".
function withArticle(label: string) {
  return `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label}`
}

// Titles say what happened to whose thing, short enough for a phone's lock
// screen; the detail names it.
export function notificationTitle(content: NotificationContent): string {
  switch (content.kind) {
    case "kiln.release":
      return "Your Kiln has an update available"
    case "kiln.updated":
      return "Your Kiln has been updated"
    case "access.invited": {
      const type = resourceTypeLabels[content.resource.type]
      switch (content.outcome) {
        case undefined:
          return `You've been invited to ${withArticle(type)}`
        case "accepted":
          return `You joined ${withArticle(type)}`
        case "declined":
          return "You declined an invite"
        case "cancelled":
          return "Your invite was cancelled"
        case "expired":
          return "Your invite expired"
      }
    }
    case "access.removed":
      return "Your access was removed"
    case "resource.disk-limit": {
      const type = resourceTypeLabels[content.resource.type]
      // Apps stop at their limit; databases keep running.
      return content.resource.type === "app"
        ? `Your ${type} was stopped at its disk limit`
        : `Your ${type} is over its disk limit`
    }
    case "app.image-update":
      return "Your App has an update available"
    case "app.deployed":
      return content.status === "failed"
        ? "Your App failed to deploy"
        : content.update
          ? "Your App has been updated"
          : "Your App has been deployed"
  }
}

export function notificationDetail(
  content: NotificationContent
): string | null {
  switch (content.kind) {
    case "kiln.release":
      return releaseName(content.name, content.version)
    case "kiln.updated":
      return `to ${releaseName(content.name, content.version)}`
    case "access.invited":
      return `${content.resource.name} - ${
        content.outcome === undefined ? "by" : "from"
      } ${content.actorName}`
    case "access.removed":
      return `${content.resource.name} - by ${content.actorName}`
    case "resource.disk-limit":
      return `${content.resource.name} - ${formatBytes(content.usedBytes)} of ${formatBytes(content.limitBytes)}`
    case "app.image-update":
      return `Image - ${content.image}`
    case "app.deployed":
      return content.status === "failed"
        ? `${content.resource.name} couldn't deploy`
        : `${content.resource.name} has deployed successfully`
  }
}
