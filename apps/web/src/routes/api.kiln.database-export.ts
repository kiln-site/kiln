import { createFileRoute } from "@tanstack/react-router"
import { Effect, Stream } from "effect"

// Hearth's own database as a SQL file, streamed as it's read. Platform
// administrators only; it holds everything Hearth knows.
export const Route = createFileRoute("/api/kiln/database-export")({
  server: {
    handlers: {
      GET: async () => {
        const allowed = await Effect.runPromise(
          Effect.tryPromise(async () => {
            const { requirePlatformAdministrator } =
              await import("@/server/platform-access.server")
            await requirePlatformAdministrator()
          }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false))
          )
        )
        if (!allowed) {
          return Response.json(
            {
              error: "Only a platform administrator can export Kiln's database",
            },
            { headers: { "Cache-Control": "no-store" }, status: 403 }
          )
        }
        const { kilnDatabaseDump } =
          await import("@/server/kiln-database-dump.server")
        const createdAt = new Date()
        const fileName = `kiln-${createdAt.toISOString().slice(0, 10)}.sql`
        return new Response(
          kilnDatabaseDump(createdAt).pipe(
            Stream.encodeText,
            Stream.toReadableStream()
          ),
          {
            headers: {
              "Cache-Control": "no-store",
              "Content-Disposition": `attachment; filename="${fileName}"`,
              "Content-Type": "application/sql; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
            },
          }
        )
      },
    },
  },
})
