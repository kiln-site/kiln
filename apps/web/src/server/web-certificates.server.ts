import type { RelayPendingCertificate } from "@workspace/contracts"

import { relayConnectionSnapshot } from "@/lib/relay-connection"
import type { WebHostnameCertificate } from "@/server/domains"

interface CertificateOwner {
  readonly relayId: string
  readonly resourceId: string
  readonly resourceType: "app" | "instance"
}

/**
 * The web route hostnames of a game server or App still waiting on a
 * certificate, as its Relay's last snapshot says. Empty while the Relay is
 * away: Hearth shows nothing it doesn't know.
 */
export function pendingWebCertificates(
  owner: CertificateOwner
): Array<WebHostnameCertificate & { hostname: string }> {
  const kind = owner.resourceType === "app" ? "app" : "server"
  return (
    relayConnectionSnapshot(owner.relayId)?.relay?.certificates ?? []
  ).flatMap((pending) =>
    pending.owner.kind === kind && pending.owner.id === owner.resourceId
      ? [{ hostname: pending.hostname, ...certificateState(pending) }]
      : []
  )
}

/** What one of its hostnames waits for; null when nothing does. */
export function pendingWebCertificate(
  owner: CertificateOwner,
  hostname: string
): WebHostnameCertificate | null {
  const name = hostname.toLowerCase()
  const found = pendingWebCertificates(owner).find(
    (pending) => pending.hostname === name
  )
  return found ? certificateState(found) : null
}

export function certificateState(
  pending: Pick<RelayPendingCertificate, "failed" | "waitingFor">
): WebHostnameCertificate {
  return { failed: pending.failed, waitingFor: pending.waitingFor }
}
