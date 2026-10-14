import {
  appIdSchema,
  appServiceNameSchema,
  databaseIdSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { requireEligibleResourceIdentity } from "@/server/auth"
import { authorizedApp } from "@/server/app-access"
import { authorizedDatabase } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"
import {
  appTerminalTarget,
  databaseTerminalTarget,
  relayTerminalTarget,
  openTerminalStream,
} from "@/server/terminal-stream"

const sizeShape = {
  cols: z.coerce.number().int().min(10).max(500),
  rows: z.coerce.number().int().min(4).max(300),
  relayId: relayIdSchema,
}
const targetSchema = z.discriminatedUnion("kind", [
  z.object({
    ...sizeShape,
    kind: z.literal("app"),
    id: appIdSchema,
    service: appServiceNameSchema,
  }),
  z.object({ ...sizeShape, kind: z.literal("database"), id: databaseIdSchema }),
  z.object({ ...sizeShape, kind: z.literal("relay"), id: relayIdSchema }),
])

// All terminal routes share authentication, validation, and stream headers.
export async function terminalResponse(
  request: Request,
  resource: { kind: "app" | "database" | "relay"; id: string }
) {
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
  const input = targetSchema.safeParse({
    ...Object.fromEntries(new URL(request.url).searchParams),
    ...(resource.kind === "relay" ? { relayId: resource.id } : {}),
    ...resource,
  })
  if (!input.success)
    return Response.json(
      {
        code: "invalid_terminal_target",
        error: "The terminal target is invalid.",
      },
      { status: 400 }
    )
  const data = input.data
  const access = await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        switch (data.kind) {
          case "app": {
            const access = await authorizedApp(
              { appId: data.id, relayId: data.relayId },
              "app.terminal"
            )
            return {
              ...access,
              target: appTerminalTarget(
                access.relay,
                data.id,
                data.service,
                access.user
              ),
            }
          }
          case "database": {
            const access = await authorizedDatabase(
              { databaseId: data.id, relayId: data.relayId },
              "database.terminal"
            )
            return {
              ...access,
              target: databaseTerminalTarget(
                access.relay,
                data.id,
                access.user
              ),
            }
          }
          case "relay": {
            const access = await authorizedRelay(data.id, "relay.terminal")
            return {
              ...access,
              target: relayTerminalTarget(access.relay, access.user),
            }
          }
        }
      },
      catch: (cause) => cause,
    }).pipe(Effect.option)
  )
  if (access._tag === "None")
    return Response.json(
      { code: "forbidden", error: "You can't open this terminal." },
      { status: 403 }
    )
  return new Response(
    openTerminalStream({
      authSessionId: identity.value.sessionId,
      cols: data.cols,
      rows: data.rows,
      headers: request.headers,
      signal: request.signal,
      ...access.value,
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
