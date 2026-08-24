import type { RelayAuditRecord } from "@workspace/contracts"
import { z } from "zod"

export const activityTypes = [
  "server",
  "power",
  "console",
  "files",
  "network",
  "access",
  "relay",
  "updates",
  "system",
] as const

export type ActivityType = (typeof activityTypes)[number]

export const activitySources = ["web", "cli"] as const
export type ActivitySource = (typeof activitySources)[number]
const activitySourceValues: ReadonlySet<string> = new Set(activitySources)

export function isActivitySource(value: string): value is ActivitySource {
  return activitySourceValues.has(value)
}

const activityTypeValues: ReadonlySet<string> = new Set(activityTypes)

export function isActivityType(value: string): value is ActivityType {
  return activityTypeValues.has(value)
}

export const activityInstantSchema = z.iso.datetime()

export interface ActivityScope {
  allInstances: boolean
  instanceIds: ReadonlySet<string>
}

export function auditInstanceId(audit: RelayAuditRecord): string | null {
  return typeof audit.details.instanceId === "string"
    ? audit.details.instanceId
    : null
}

export function auditInstanceCreatorId(
  audit: RelayAuditRecord,
  instanceId: string
): string | null {
  if (
    (audit.details.operation !== "instance.create" &&
      audit.details.operation !== "instance.provision.prepare") ||
    auditInstanceId(audit) !== instanceId
  ) {
    return null
  }
  return auditUserId(audit)
}

export function scopeAllowsAudit(
  scope: ActivityScope,
  audit: RelayAuditRecord
): boolean {
  if (scope.allInstances) return true
  const instanceId = auditInstanceId(audit)
  return instanceId !== null && scope.instanceIds.has(instanceId)
}

export function activityLocalRangeToUtc(
  from: Date,
  to: Date
): { from: string; to: string } {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(23, 59, 59, 999)
  return {
    from: start.toISOString(),
    to: end.toISOString(),
  }
}

export function activityTypeForAudit(audit: RelayAuditRecord): ActivityType {
  const operation = auditOperation(audit)
  if (
    audit.event === "browser.console.write" ||
    operation === "instance.console.write"
  ) {
    return "console"
  }
  if (
    audit.event.startsWith("browser.file.") ||
    operation === "instance.files.write" ||
    operation === "instance.files.upload-url"
  ) {
    return "files"
  }
  if (operation === "instance.action") return "power"
  if (
    operation?.startsWith("instance.network.") ||
    operation?.startsWith("relay.networking.") ||
    operation?.startsWith("relay.proxy.") ||
    operation?.startsWith("relay.tailscale.")
  ) {
    return "network"
  }
  if (
    operation?.startsWith("instance.") ||
    audit.event.startsWith("instance.")
  ) {
    return "server"
  }
  if (
    audit.event.includes("invitation") ||
    audit.event.includes("client.") ||
    operation?.startsWith("relay.pairing.") ||
    operation?.startsWith("relay.clients.")
  ) {
    return "access"
  }
  if (
    audit.event.includes("update") ||
    operation?.startsWith("relay.update.")
  ) {
    return "updates"
  }
  if (audit.event.startsWith("relay.") || operation?.startsWith("relay.")) {
    return "relay"
  }
  return "system"
}

export function activityLabelForAudit(audit: RelayAuditRecord): string {
  const operation = auditOperation(audit)
  if (audit.event === "browser.console.write") return "Sent a console command"
  if (audit.event === "browser.file.upload") return "Uploaded a file"
  if (audit.event === "browser.file.download") return "Downloaded a file"
  if (audit.event === "relay.client.paired") return "Paired a Hearth client"
  if (audit.event === "system.update_started") return "Started a system update"
  if (audit.event === "invitation.created") {
    return "Created a Relay invitation"
  }
  if (audit.event === "invitation.revoked") {
    return "Revoked a Relay invitation"
  }
  if (audit.event === "client.policy_changed") {
    return "Changed a Hearth client policy"
  }
  if (audit.event === "client.revoked") return "Revoked a Hearth client"
  if (audit.event === "relay.renamed") return "Renamed a Relay"

  if (operation === "instance.action") {
    const action = audit.details.action
    if (action === "start") return "Started a server"
    if (action === "restart") return "Restarted a server"
    if (action === "stop") return "Stopped a server"
    if (action === "kill") return "Killed a server process"
    return "Changed a server power state"
  }
  if (operation === "instance.create") return "Created a server"
  if (operation === "instance.delete") return "Deleted a server"
  if (operation === "instance.rename") return "Renamed a server"
  if (operation === "instance.startup.write") {
    return audit.details.reinstall === true
      ? "Reinstalled a server Brick"
      : "Updated server startup settings"
  }
  if (operation === "instance.files.write") return "Saved a server file"
  if (operation === "instance.files.upload-url") {
    return "Downloaded a URL to a server"
  }
  if (operation === "instance.console.write") return "Sent a console command"
  if (operation === "instance.network.ports.write") {
    return "Updated server port allocations"
  }
  if (operation === "instance.network.routes.write") {
    return "Updated server network routes"
  }
  if (operation === "relay.rename") return "Renamed a Relay"
  if (operation === "relay.proxy.write") return "Updated Relay proxy settings"
  if (operation === "relay.networking.write") {
    return "Updated Relay networking"
  }
  if (operation === "relay.tailscale.install") return "Installed Tailscale"
  if (operation === "relay.tailscale.write") {
    return "Updated Tailscale settings"
  }
  if (operation === "relay.tailscale.stack.apply") {
    return "Applied a Tailscale stack"
  }
  if (operation === "relay.tailscale.stack.dns") {
    return "Updated Tailscale DNS"
  }
  if (operation === "relay.tailscale.stack.remove") {
    return "Removed a Tailscale stack"
  }
  if (operation === "relay.update.apply") return "Applied a Relay update"
  if (operation === "relay.pairing.create") {
    return "Created a Relay invitation"
  }
  if (operation === "relay.pairing.revoke") {
    return "Revoked a Relay invitation"
  }
  if (operation === "relay.clients.update") {
    return "Changed a Hearth client policy"
  }
  if (operation === "relay.clients.revoke") {
    return "Revoked a Hearth client"
  }

  return humanizeEvent(operation ?? audit.event)
}

export function activityPermissionForAudit(
  audit: RelayAuditRecord
): string | null {
  if (typeof audit.details.permission === "string") {
    return audit.details.permission
  }

  if (audit.event === "browser.console.write") {
    return "instance.console.write"
  }
  if (audit.event === "browser.file.upload") {
    return "instance.files.upload"
  }
  if (audit.event === "browser.file.download") {
    return "instance.files.download"
  }
  if (audit.event === "system.update_started") return "relay.update"
  if (audit.event === "invitation.created") return "relay.pairing.create"
  if (audit.event === "invitation.revoked") return "relay.pairing.revoke"
  if (audit.event === "client.policy_changed") return "relay.clients.update"
  if (audit.event === "client.revoked") return "relay.clients.revoke"
  if (audit.event === "relay.renamed") return "relay.rename"

  const operation = auditOperation(audit)
  if (operation === "relay.update.apply") return "relay.update"
  if (operation === "relay.rename") return "relay.rename"
  if (operation === "relay.networking.write") return "relay.configure"
  if (
    operation === "relay.tailscale.install" ||
    operation === "relay.tailscale.write" ||
    operation === "relay.proxy.write"
  ) {
    return "relay.configure"
  }
  if (operation === "relay.tailscale.stack.apply") return "instance.create"
  if (operation === "relay.tailscale.stack.dns") {
    return "instance.network.write"
  }
  if (operation === "relay.tailscale.stack.remove") return "instance.delete"
  if (
    operation === "relay.pairing.create" ||
    operation === "relay.pairing.revoke" ||
    operation === "relay.clients.update" ||
    operation === "relay.clients.revoke" ||
    operation === "instance.create" ||
    operation === "instance.rename" ||
    operation === "instance.delete" ||
    operation === "instance.files.write" ||
    operation === "instance.files.upload-url" ||
    operation === "instance.console.write" ||
    operation === "instance.network.ports.write" ||
    operation === "instance.network.routes.write"
  ) {
    return operation === "instance.network.ports.write" ||
      operation === "instance.network.routes.write"
      ? "instance.network.write"
      : operation
  }
  if (operation === "instance.startup.write") return "instance.create"
  if (operation === "instance.action") {
    const action = audit.details.action
    if (
      action === "start" ||
      action === "stop" ||
      action === "restart" ||
      action === "kill"
    ) {
      return `instance.power.${action}`
    }
  }
  return null
}

export function auditUserId(audit: RelayAuditRecord): string | null {
  return typeof audit.details.subject === "string"
    ? audit.details.subject
    : null
}

export function activitySourceForAudit(
  audit: RelayAuditRecord
): ActivitySource {
  return audit.details.source === "cli" ? "cli" : "web"
}

function auditOperation(audit: RelayAuditRecord): string | null {
  return typeof audit.details.operation === "string"
    ? audit.details.operation
    : null
}

function humanizeEvent(value: string): string {
  const words = value
    .split(/[._-]/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
  if (words.length === 0) return "Recorded activity"
  const [first, ...rest] = words
  return `${first?.charAt(0).toUpperCase()}${first?.slice(1)} ${rest.join(" ")}`.trim()
}
