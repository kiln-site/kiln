import { createFileRoute } from "@tanstack/react-router"
import {
  appIdSchema,
  appServiceNameSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { requireEligibleResourceIdentity } from "@/server/auth"

const terminalTargetSchema = z.object({
  appId: appIdSchema,
  cols: z.coerce.number().int().min(10).max(500),
  relayId: relayIdSchema,
  rows: z.coerce.number().int().min(4).max(300),
  service: appServiceNameSchema,
})

// The person's shell in one of an app's services, as an NDJSON stream. See
// lib/database-terminal-stream.ts for the records.
export const Route = createFileRoute("/api/app-terminal/$appId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const identity = await Effect.runPromise(
          Effect.tryPromise({
            try: requireEligibleResourceIdentity,
            catch: (cause) => cause,
          }).pipe(Effect.option)
        )
        if (identity._tag === "None") {
          return Response.json(
            {
              code: "authentication_required",
              error: "Authentication required.",
            },
            { status: 401 }
          )
        }
        const url = new URL(request.url)
        const target = terminalTargetSchema.safeParse({
          ...Object.fromEntries(url.searchParams),
          appId: params.appId,
        })
        if (!target.success) {
          return Response.json(
            {
              code: "invalid_terminal_target",
              error: "The terminal target is invalid.",
            },
            { status: 400 }
          )
        }
        // Loaded here so the server-only modules stay out of the client
        // bundle, which includes every route file.
        const [{ authorizedApp }, { appTerminalTarget, openTerminalStream }] =
          await Promise.all([
            import("@/server/app-access"),
            import("@/server/terminal-stream"),
          ])
        const access = await Effect.runPromise(
          Effect.tryPromise({
            try: () => authorizedApp(target.data, "app.terminal"),
            catch: (cause) => cause,
          }).pipe(Effect.option)
        )
        if (access._tag === "None") {
          return Response.json(
            {
              code: "forbidden",
              error: "You can't open this app's terminal.",
            },
            { status: 403 }
          )
        }
        return new Response(
          openTerminalStream({
            authSessionId: identity.value.sessionId,
            cols: target.data.cols,
            headers: request.headers,
            relay: access.value.relay,
            rows: target.data.rows,
            signal: request.signal,
            target: appTerminalTarget(
              access.value.relay,
              target.data.appId,
              target.data.service,
              access.value.user
            ),
            user: access.value.user,
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
      },
    },
  },
})
