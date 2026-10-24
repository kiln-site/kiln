import type { KilnPlatformHost } from "@/server/platform"

/** What Hearth knows of Kiln's hosts: the Relays that report its services. */
export interface KilnPlatform {
  hosts: ReadonlyArray<KilnPlatformHost>
  /** This Hearth's installation, which the right host reports. */
  installationId: string | null
}

/**
 * The host this Hearth runs on. Relays reporting this installation come
 * first, since a Relay can report another Kiln beside it. Among them: the
 * Relay that installed it, or else one that installed some Kiln, or else the
 * first that reports its services.
 */
export function selectKilnHost(
  platform: KilnPlatform
): KilnPlatformHost | null {
  const own = platform.hosts.filter(
    (host) =>
      platform.installationId !== null &&
      host.status?.installationId === platform.installationId
  )
  const hosts = own.length > 0 ? own : platform.hosts
  return (
    hosts.find((host) => host.status?.canManage === true) ??
    hosts.find((host) => host.status?.management === "relay") ??
    hosts.find((host) => host.status !== null) ??
    hosts[0] ??
    null
  )
}
