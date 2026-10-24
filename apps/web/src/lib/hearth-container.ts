import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"

import {
  hostnameContainerId,
  relayHearthContainerTranscript,
  type RelayAuthChallenge,
} from "@workspace/contracts"
import { Result } from "effect"

// The container Hearth runs in, from its mounts: null outside Docker,
// undefined until read.
let containerId: string | null | undefined

/**
 * The container Hearth runs in and proof of it, sent to each Relay as it
 * connects. A Relay on the same host checks the proof against that
 * container's BETTER_AUTH_SECRETS, then finds Kiln's services beside it
 * without Kiln's labels, as when Coolify deployed them.
 */
export function hearthContainerClaim(
  challenge: Omit<RelayAuthChallenge, "signature">,
  clientId: string
): { id: string; proof: string } | null {
  if (containerId === undefined) {
    const mountinfo = Result.getOrNull(
      Result.try(() => readFileSync("/proc/self/mountinfo", "utf8"))
    )
    containerId = mountinfo ? hostnameContainerId(mountinfo) : null
  }
  const secret = process.env.BETTER_AUTH_SECRETS
  if (!containerId || !secret) return null
  return {
    id: containerId,
    proof: createHmac("sha256", secret)
      .update(relayHearthContainerTranscript(challenge, clientId, containerId))
      .digest("base64url"),
  }
}
