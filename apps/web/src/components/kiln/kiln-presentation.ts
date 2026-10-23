import { useSuspenseQuery } from "@tanstack/react-query"
import type {
  RelayPlatformProxy,
  RelayPlatformService,
  RelayPlatformStatus,
  RelayPlatformTarget,
} from "@workspace/contracts"

import type { IdentityStatusPresentation } from "@/components/identity-name"
import { kilnPlatformQueryOptions } from "@/lib/query-options"
import type { KilnPlatformHost } from "@/server/platform"

// Kiln itself, as an instance: Hearth, its database and cache, and the
// Traefik in front of them, on the host of the Relay that reports them.

/** One of Kiln's containers, a service or the proxy in front of them. */
export type KilnContainer = Omit<RelayPlatformService, "role"> & {
  managedBy?: RelayPlatformProxy["managedBy"]
  target: RelayPlatformTarget
}

export const kilnTargets = [
  "hearth",
  "database",
  "cache",
  "proxy",
] as const satisfies ReadonlyArray<RelayPlatformTarget>

export const kilnCopy: Record<
  RelayPlatformTarget,
  { description: string; noun: string; restart: string; title: string }
> = {
  cache: {
    description: "Valkey, which Hearth caches Relay reads in",
    noun: "the cache",
    restart: "Hearth reads from its Relays directly until the cache is back.",
    title: "Cache",
  },
  database: {
    description: "MySQL, which holds Hearth's users, settings, and catalog",
    noun: "the database",
    restart:
      "Hearth can't sign anyone in or save changes until MySQL is back, usually within a minute. Game servers, Apps, and databases keep running.",
    title: "Database",
  },
  hearth: {
    description: "This panel",
    noun: "Hearth",
    restart:
      "Everyone's pages reconnect once Hearth is back, usually within a minute. Game servers, Apps, and databases keep running.",
    title: "Hearth",
  },
  proxy: {
    description: "Traefik, which serves Hearth over HTTPS",
    noun: "Traefik",
    restart:
      "Hearth's address stops answering for a few seconds while Traefik restarts. Its certificates are kept.",
    title: "Traefik",
  },
}

/**
 * The host this Hearth runs on: the Relay that installed it, or else one that
 * installed some Kiln, or else the first that reports its services.
 */
export function selectKilnHost(
  hosts: ReadonlyArray<KilnPlatformHost>
): KilnPlatformHost | null {
  return (
    hosts.find((host) => host.status?.canManage === true) ??
    hosts.find((host) => host.status?.management === "relay") ??
    hosts.find((host) => host.status !== null) ??
    hosts[0] ??
    null
  )
}

export function useKilnHost(): KilnPlatformHost | null {
  return useSuspenseQuery({
    ...kilnPlatformQueryOptions(),
    select: (data) => selectKilnHost(data.hosts),
  }).data
}

/** Kiln's containers in order, the proxy last when there is one. */
export function kilnContainers(
  status: RelayPlatformStatus
): ReadonlyArray<KilnContainer> {
  const services = status.services.map(({ role, ...service }) => ({
    ...service,
    target: role,
  }))
  return status.proxy
    ? [...services, { ...status.proxy, target: "proxy" as const }]
    : services
}

/** Hearth's version, from its container's label. */
export function kilnVersion(status: RelayPlatformStatus | null) {
  return (
    status?.services.find((service) => service.role === "hearth")?.version ??
    null
  )
}

/**
 * Whether a shell can open in it: Kiln manages it, the Relay opens shells
 * (`relay-platform-v2`), and its image has one.
 */
export function kilnShellAvailable(
  host: KilnPlatformHost,
  container: KilnContainer
): boolean {
  return (
    host.v2 &&
    host.status?.canManage === true &&
    container.shell === true &&
    (container.target !== "proxy" || container.managedBy === "kiln")
  )
}

export function kilnContainerPresentation(
  container: Pick<KilnContainer, "state">
): IdentityStatusPresentation {
  switch (container.state) {
    case "running":
      return { label: "Running", tone: "success" }
    case "starting":
      return { label: "Starting", pulse: true, tone: "info" }
    case "restarting":
      return { label: "Restarting", pulse: true, tone: "info" }
    case "updating":
      return { label: "Updating", pulse: true, tone: "info" }
    case "unhealthy":
      return {
        detail: "Its health check is failing; its logs may say why.",
        label: "Unhealthy",
        tone: "danger",
      }
    case "stopped":
      return { label: "Stopped", tone: "warning" }
    case "missing":
      return {
        detail: "Its container doesn't exist.",
        label: "Missing",
        tone: "danger",
      }
  }
}

/** Kiln as a whole: the worst of its services, or why it can't be read. */
export function kilnPresentation(
  host: KilnPlatformHost | null
): IdentityStatusPresentation {
  const status = host?.status
  if (!status) {
    return host?.error
      ? { detail: host.error, label: "Unreachable", tone: "warning" }
      : { label: "Not reported", tone: "neutral" }
  }
  if (status.phase === "blocked") {
    return {
      detail: status.issue ?? undefined,
      label: "Needs attention",
      tone: "danger",
    }
  }
  if (status.phase === "installing") {
    return { label: "Installing", pulse: true, tone: "info" }
  }
  if (status.phase === "maintenance") {
    return { label: "Hearth held stopped", tone: "warning" }
  }
  const order = ["danger", "warning", "info", "success"] as const
  const presentations = status.services.map(kilnContainerPresentation)
  for (const tone of order) {
    const worst = presentations.find(
      (presentation) => presentation.tone === tone
    )
    if (worst) return worst
  }
  return { label: "Running", tone: "success" }
}

export const kilnPhaseLabels: Record<RelayPlatformStatus["phase"], string> = {
  blocked: "Needs attention",
  installing: "Installing",
  maintenance: "Hearth held stopped",
  ready: "Running",
}
