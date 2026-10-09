import { createFileRoute } from "@tanstack/react-router"
import { databaseIdSchema, relayIdSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { requireEligibleResourceIdentity } from "@/server/auth"

const logsTargetSchema = z.object({
  databaseId: databaseIdSchema,
  relayId: relayIdSchema,
})

// One database's container output as an NDJSON stream. See
// lib/database-logs-stream.ts for the records.
export const Route = createFileRoute("/api/database-logs/$databaseId")({
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
        const target = logsTargetSchema.safeParse({
          databaseId: params.databaseId,
          relayId: url.searchParams.get("relayId"),
        })
        if (!target.success) {
          return Response.json(
            {
              code: "invalid_logs_target",
              error: "The logs target is invalid.",
            },
            { status: 400 }
          )
        }
        // Loaded here so the server-only modules stay out of the client
        // bundle, which includes every route file.
        const [{ authorizedDatabase }, { openDatabaseLogsStream }] =
          await Promise.all([
            import("@/server/managed-database-access"),
            import("@/server/database-logs-stream"),
          ])
        const access = await Effect.runPromise(
          Effect.tryPromise({
            try: () => authorizedDatabase(target.data, "database.logs.read"),
            catch: (cause) => cause,
          }).pipe(Effect.option)
        )
        if (access._tag === "None") {
          return Response.json(
            {
              code: "forbidden",
              error: "You can't view this database's logs.",
            },
            { status: 403 }
          )
        }
        return new Response(
          openDatabaseLogsStream({
            authSessionId: identity.value.sessionId,
            databaseId: target.data.databaseId,
            headers: request.headers,
            relay: access.value.relay,
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
