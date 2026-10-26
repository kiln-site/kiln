import { showToast } from "@workspace/ui/components/sonner"

import type { DomainAssignmentStrategy } from "@/effect/domains"
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

export const strategyOptions: ReadonlyArray<{
  label: string
  value: DomainAssignmentStrategy
}> = [
  {
    label: "Default only",
    value: "default",
  },
  {
    label: "Random",
    value: "random",
  },
  {
    label: "Spread evenly",
    value: "balanced",
  },
]

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
