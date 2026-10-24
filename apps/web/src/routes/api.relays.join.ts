import { createFileRoute } from "@tanstack/react-router"

import { runAppEffect } from "@/effect/runtime"

// Relays announcing themselves with a join link from the Add Relay dialog,
// verified by the join's secret (server/relay-join.server.ts).
export const Route = createFileRoute("/api/relays/join")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { answerRelayJoinAnnouncement } =
          await import("@/server/relay-join.server")
        const forwarded = request.headers.get("x-forwarded-for")
        return runAppEffect(
          "relay.join.announce",
          answerRelayJoinAnnouncement(
            request,
            forwarded?.split(",")[0]?.trim() ||
              request.headers.get("x-real-ip")?.trim() ||
              "unknown"
          )
        )
      },
    },
  },
})
