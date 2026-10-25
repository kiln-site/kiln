import type {
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import { formatBytes } from "@/lib/format-bytes"
import { securitySeverityLabels } from "@/lib/security"
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
    case "security.vulnerabilities": {
      const subject = securitySubject(content)
      if (content.count > 1) {
        return `${subject} has ${content.count} new vulnerabilities`
      }
      return content.knownExploited
        ? `${subject} has an exploited vulnerability`
        : `${subject} has ${withArticle(securitySeverityLabels[content.severity]).toLowerCase()} vulnerability`
    }
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
    case "security.vulnerabilities": {
      const { top } = content
      const fix = top.fixedVersion ? `, fixed in ${top.fixedVersion}` : ""
      return `${content.resource.name} - ${top.id} in ${top.packageName} ${top.packageVersion}${fix}`
    }
    case "server.migration":
      return content.outcome === "failed"
        ? `${content.source.name} - ${content.error ?? "The copy stopped"}`
        : `${content.source.name} to ${content.destination.name}`
  }
}

type SecurityContent = Extract<
  NotificationContent,
  { kind: "security.vulnerabilities" }
>

// Whose thing it's about, as titles say it: "Your App", or for a Relay, its
// host or the Kiln service on it.
function securitySubject(content: SecurityContent): string {
  const { component, resource } = content
  const type = resourceTypeLabels[resource.type]
  if (resource.type !== "relay" || component === null) return `Your ${type}`
  return component === "host"
    ? "Your Relay's host"
    : `Your Relay's ${component}`
}
