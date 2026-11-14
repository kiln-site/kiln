import { relayIdSchema, terminalTargetSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { requireEligibleResourceIdentity } from "@/server/auth"
import { authorizeTerminal } from "@/server/terminal-access"
import { openTerminalStream } from "@/server/terminal-stream"

const querySchema = z.object({
  cols: z.coerce.number().int().min(10).max(500),
  relayId: relayIdSchema,
  rows: z.coerce.number().int().min(4).max(300),
})

// Opens the stream of one person's session on a terminal target, named in
// the query (`terminalStreamUrl`).
export async function terminalResponse(request: Request) {
  const identity = await Effect.runPromise(
    Effect.tryPromise({
      try: requireEligibleResourceIdentity,
      catch: (cause) => cause,
    }).pipe(Effect.option)
  )
  if (identity._tag === "None")
    return Response.json(
      { code: "authentication_required", error: "Authentication required." },
      { status: 401 }
    )
  const query = Object.fromEntries(new URL(request.url).searchParams)
  const input = querySchema.safeParse(query)
  const target = terminalTargetSchema.safeParse(
    Object.fromEntries(
      Object.entries(query).filter(([key]) =>
        ["id", "kind", "role", "service"].includes(key)
      )
    )
  )
  if (!input.success || !target.success)
    return Response.json(
      {
        code: "invalid_terminal_target",
        error: "The terminal target is invalid.",
      },
      { status: 400 }
    )
  const user = identity.value.user
  const relay = await Effect.runPromise(
    Effect.tryPromise({
      try: () => authorizeTerminal(user, input.data.relayId, target.data),
      catch: (cause) => cause,
    }).pipe(Effect.option)
  )
  if (relay._tag === "None")
    return Response.json(
      { code: "forbidden", error: "You can't open this terminal." },
      { status: 403 }
    )
  return new Response(
    openTerminalStream({
      authSessionId: identity.value.sessionId,
      cols: input.data.cols,
      headers: request.headers,
      relay: relay.value,
      rows: input.data.rows,
      signal: request.signal,
      target: target.data,
      user,
    }),
    {
      headers: {
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    }
  )
}
