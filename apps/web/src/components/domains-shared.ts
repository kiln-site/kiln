import { showToast } from "@workspace/ui/components/sonner"

import type { IdentityStatusPresentation } from "@/components/identity-name"
import type { getDomainSettings, ManagedDomainOverview } from "@/server/domains"
import type { getInfraServerDirectory } from "@/server/infra-directory"

// Shared by the Domains page and its dialogs, which load separately.

export type DirectoryServer = Awaited<
  ReturnType<typeof getInfraServerDirectory>
>[number]

export type DomainSettings = Awaited<ReturnType<typeof getDomainSettings>>

/** A Cloudflare connection as the Domains page shows it. */
export type DomainConnectionOverview = DomainSettings["connections"][number]

/** A vanity domain the person may put a game server's address under. */
export interface VanityDomainChoice {
  domain: string
  /** The platform's, rather than one of the person's connections'. */
  platform: boolean
}

/**
 * The vanity domains the person may put addresses under: their own, then the
 * shared ones. An administrator's shared connections count as shared.
 */
export function vanityDomainChoices(
  data: Pick<DomainSettings, "connections" | "platformDomains">
): Array<VanityDomainChoice> {
  const choices = new Map<string, VanityDomainChoice>()
  for (const connection of data.connections) {
    if (connection.platform) continue
    for (const domain of connection.domains) {
      if (domain.enabled) {
        choices.set(domain.domain, { domain: domain.domain, platform: false })
      }
    }
  }
  for (const domain of data.platformDomains) {
    if (!choices.has(domain.domain)) {
      choices.set(domain.domain, { domain: domain.domain, platform: true })
    }
  }
  return [...choices.values()]
}

export function serverKey(relayId: string, instanceId: string): string {
  return `${relayId}:${instanceId}`
}

export function domainHostname(domain: ManagedDomainOverview): string {
  return `${domain.vanityLabel}.${domain.domain}`
}

// Cloudflare resolves `:account` to the signed-in account that owns the zone.
export function cloudflareDnsRecordsUrl(zoneName: string): string {
  return `https://dash.cloudflare.com/?to=/:account/${encodeURIComponent(zoneName)}/dns/records`
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not save the domain"
}

export function showErrorToast(cause: Error) {
  showToast({ message: errorMessage(cause), type: "error" })
}

export function domainStatusPresentation(
  domain: ManagedDomainOverview
): IdentityStatusPresentation {
  if (domain.status === "active") return { label: "Active", tone: "success" }
  if (domain.status === "pending") {
    return { label: "Pending", pulse: true, tone: "warning" }
  }
  // Only stays deleting when Cloudflare refused; deleting again finishes it.
  if (domain.status === "removing") {
    return domain.lastError
      ? { detail: domain.lastError, label: "Delete failed", tone: "danger" }
      : { label: "Deleting", pulse: true, tone: "warning" }
  }
  return {
    detail: domain.lastError ?? undefined,
    label: "Error",
    tone: "danger",
  }
}
