import type { TerminalTarget } from "@workspace/contracts"

import { isPlatformAdmin, requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { PersistedRelay } from "@/lib/relay-registry"
import { authorizedAppFor } from "@/server/app-access"
import { requiredRelay } from "@/server/managed-database-access"

// The one check every terminal request makes: opening its stream, checking
// again while the stream stays open, and each write, claim, and restart.
// Throws once the person may not use the target's terminal; otherwise
// returns the Relay it runs on.
export async function authorizeTerminal(
  user: AuthenticatedUser,
  relayId: string,
  target: TerminalTarget
): Promise<PersistedRelay> {
  switch (target.kind) {
    case "app": {
      const { relay } = await authorizedAppFor(
        user,
        { appId: target.id, relayId },
        "app.terminal"
      )
      return relay
    }
    case "database":
      await requireRelayPermission({
        databaseId: target.id,
        permission: "database.terminal",
        relayId,
        user,
      })
      return requiredRelay(relayId)
    case "relay":
      await requireRelayPermission({
        permission: "relay.terminal",
        relayId,
        user,
      })
      return requiredRelay(relayId)
    // Kiln's own containers are for platform administrators.
    case "platform": {
      const { platformRelay } = await import("@/server/platform-access.server")
      if (!isPlatformAdmin(user)) {
        throw new Error("Only platform administrators can open Kiln's terminals")
      }
      return platformRelay(relayId)
    }
  }
}
