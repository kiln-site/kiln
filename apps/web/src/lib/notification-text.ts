import type {
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import { formatBytes } from "@/lib/format-bytes"
import { securitySeverityLabels } from "@/lib/security"
import { kilnReleaseLabel } from "@/lib/release-version"

// What a notification says in a line or two, shared by the inbox and the
// push notifications Hearth sends to devices.

export const resourceTypeLabels = {
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

// "Hearth and 3 Relays", "Frankfurt".
function updatedParts({
  hearth = true,
  relays = [],
}: Extract<NotificationContent, { kind: "kiln.updated" }>) {
  const relayPart =
    relays.length > 1 ? `${relays.length} Relays` : relays[0]?.name
  if (!hearth) return relayPart ?? "Kiln"
  return relayPart ? `Hearth and ${relayPart}` : "Hearth"
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
      return "Kiln has been updated"
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
    case "app.deployed": {
      if (content.status === "failed") return "Your App failed to deploy"
      const times = (content.count ?? 1) > 1 ? ` ${content.count} times` : ""
      return content.update
        ? `Your App has been updated${times}`
        : `Your App has been deployed${times}`
    }
    case "security.report":
      return content.count === 1
        ? "1 new vulnerability found"
        : `${content.count} new vulnerabilities found`
    case "server.migration": {
      const action = content.mode === "migrate" ? "move" : "copy"
      switch (content.outcome) {
        case "completed":
          return content.mode === "migrate"
            ? "Your Game Server was moved"
            : "Your Game Server was duplicated"
        case "failed":
          return `Your Game Server couldn't ${action}`
        case "cancelled":
          return `Your Game Server ${action} was cancelled`
      }
    }
  }
}

export function notificationDetail(
  content: NotificationContent
): string | null {
  switch (content.kind) {
    case "kiln.release":
      return releaseName(content.name, content.version)
    case "kiln.updated":
      return `${releaseName(content.previousName, content.previousVersion)} to ${releaseName(content.name, content.version)} · ${updatedParts(content)}`
    case "access.invited":
      return `${content.resource.name} - ${
        content.outcome === undefined ? "by" : "from"
      } ${content.actorName}`
    case "access.removed":
      return `${content.resource.name} - by ${content.actorName}`
    case "resource.disk-limit":
      return `${content.resource.name} - ${formatBytes(content.usedBytes)} of ${formatBytes(content.limitBytes)}`
    case "app.image-update":
      return `${content.resource.name} - ${content.image}`
    case "app.deployed": {
      const { count = 1, failures, resource, status } = content
      if (failures && count > 1)
        return `${resource.name} - ${failures} of ${count} failed`
      return status === "failed"
        ? `${resource.name} couldn't deploy`
        : `${resource.name} has deployed successfully`
    }
    case "security.report": {
      // "Up to critical in Survival and 2 more, 1 exploited".
      const { count, knownExploited, resources, severity } = content
      const label = securitySeverityLabels[severity]
      const others = resources.length - 1
      const where = `${resources[0]?.name ?? ""}${others ? ` and ${others} more` : ""}`
      const exploited = !knownExploited
        ? ""
        : count === 1
          ? ", exploited"
          : `, ${knownExploited} exploited`
      return `${count === 1 ? label : `Up to ${label.toLowerCase()}`} in ${where}${exploited}`
    }
    case "server.migration":
      return content.outcome === "failed"
        ? `${content.source.name} - ${content.error ?? "The copy stopped"}`
        : content.sourceDeleting && !content.sourceDeleted
          ? `${content.source.name} to ${content.destination.name} - the old server is deleted after its final backup`
          : `${content.source.name} to ${content.destination.name}`
  }
}
