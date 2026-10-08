import { createFileRoute } from "@tanstack/react-router"
import { databaseIdSchema, relayIdSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { requireEligibleResourceIdentity } from "@/server/auth"

const terminalTargetSchema = z.object({
  cols: z.coerce.number().int().min(10).max(500),
  databaseId: databaseIdSchema,
  relayId: relayIdSchema,
  restart: z.enum(["0", "1"]),
  rows: z.coerce.number().int().min(4).max(300),
})

// The person's terminal session on one database, as an NDJSON stream. See
// lib/database-terminal-stream.ts for the records.
export const Route = createFileRoute("/api/database-terminal/$databaseId")({
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
          databaseId: params.databaseId,
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
        const [{ authorizedDatabase }, { openDatabaseTerminalStream }] =
          await Promise.all([
            import("@/server/managed-database-access"),
            import("@/server/database-terminal-stream"),
          ])
        const access = await Effect.runPromise(
          Effect.tryPromise({
            try: () => authorizedDatabase(target.data, "database.terminal"),
            catch: (cause) => cause,
          }).pipe(Effect.option)
        )
        if (access._tag === "None") {
          return Response.json(
            {
              code: "forbidden",
              error: "You can't open this database's terminal.",
            },
            { status: 403 }
          )
        }
        return new Response(
          openDatabaseTerminalStream({
            cols: target.data.cols,
            databaseId: target.data.databaseId,
            relay: access.value.relay,
            restart: target.data.restart === "1",
            rows: target.data.rows,
            signal: request.signal,
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
