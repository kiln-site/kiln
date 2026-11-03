import { createServerFn } from "@tanstack/react-start"
import {
  relayDesktopAttachedSchema,
  relayDesktopSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { requireEligibleResourceIdentity } from "@/server/auth"
import { databaseRpc } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const targetSchema = z.object({ relayId: relayIdSchema })

// Watching and driving a node's desktop is as much as a root shell on it,
// so it takes the same permission as the host terminal.

/** The node's desktop: whether someone is signed in to one Kiln can show. */
export const getRelayDesktop = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.terminal")
    return relayDesktopSchema.parse(
      await databaseRpc(relay, "relay.desktop.read", {}, 20_000)
    )
  })

/**
 * Starts streaming the node's desktop for this page and returns the session
 * its client connects with (lib/relay-desktop.server.ts).
 */
export const openRelayDesktop = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const identity = await requireEligibleResourceIdentity()
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.terminal"
    )
    const attached = relayDesktopAttachedSchema.parse(
      await databaseRpc(relay, "relay.desktop.attach", {}, 240_000, user.id)
    )
    const { openDesktopSession } = await import("@/lib/relay-desktop.server")
    return {
      desktop: attached.desktop,
      session: openDesktopSession({
        authSessionId: identity.sessionId,
        relay,
        ticket: attached.ticket,
        user,
      }),
    }
  })

const sessionSchema = targetSchema.extend({ session: z.string().max(64) })

/** Whether this page's session stands: it ends if the stream can't go on. */
export const getRelayDesktopSession = createServerFn({ method: "GET" })
  .validator(sessionSchema)
  .handler(async ({ data }) => {
    const identity = await requireEligibleResourceIdentity()
    const { desktopSessionOpen } = await import("@/lib/relay-desktop.server")
    return { open: desktopSessionOpen(data.session, identity.user.id) }
  })

/** Ends this page's desktop session, when it leaves the Desktop tab. */
export const closeRelayDesktop = createServerFn({ method: "POST" })
  .validator(sessionSchema)
  .handler(async ({ data }) => {
    const identity = await requireEligibleResourceIdentity()
    const { closeDesktopSession } = await import("@/lib/relay-desktop.server")
    closeDesktopSession(data.session, identity.user.id)
    return { closed: true }
  })
