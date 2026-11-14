import {
  relayIdSchema,
  relayTerminalClaimSchema,
  relayTerminalRestartSchema,
  relayTerminalWriteSchema,
} from "@workspace/contracts"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { requireEligibleResourceUser } from "@/server/auth"
import { databaseRpc } from "@/server/managed-database-access"
import { authorizeTerminal } from "@/server/terminal-access"

// Typing and window size go to the person's own session on a target; the
// Relay rejects a session that isn't theirs or has ended. Output arrives
// through the terminal stream (routes/api.terminal.ts).

const relayShape = { relayId: relayIdSchema }

export const writeTerminal = createServerFn({ method: "POST" })
  .validator(relayTerminalWriteSchema.extend(relayShape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const user = await requireEligibleResourceUser()
    const relay = await authorizeTerminal(user, relayId, input.target)
    await databaseRpc(relay, "terminal.write", input, 15_000, user.id)
    return { accepted: true }
  })

// Puts this page in control of the person's session, sized to its window.
export const claimTerminal = createServerFn({ method: "POST" })
  .validator(relayTerminalClaimSchema.extend(relayShape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const user = await requireEligibleResourceUser()
    const relay = await authorizeTerminal(user, relayId, input.target)
    const claimed = await databaseRpc(
      relay,
      "terminal.claim",
      input,
      15_000,
      user.id
    )
    // The state change that put this page in control.
    return z.object({ seq: z.number().int().nonnegative() }).parse(claimed)
  })

// Ends the person's session on a target. A POST server function, so it
// carries the request forgery protection a navigation would not.
export const restartTerminal = createServerFn({ method: "POST" })
  .validator(relayTerminalRestartSchema.extend(relayShape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const user = await requireEligibleResourceUser()
    const relay = await authorizeTerminal(user, relayId, input.target)
    await databaseRpc(relay, "terminal.restart", input, 30_000, user.id)
    return { restarted: true }
  })
