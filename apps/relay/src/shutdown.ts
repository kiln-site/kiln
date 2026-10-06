import type { Server } from "node:http"
import { Effect } from "effect"

type RelayShutdownResult = "forced" | "graceful"

const shutdownDeadlineMs = 10_000

export function closeRelayServer(server: Server): Promise<RelayShutdownResult> {
  const graceful = Effect.callback<RelayShutdownResult>((resume) => {
    server.close(() => resume(Effect.succeed("graceful")))
    server.closeIdleConnections()
  })
  const forced = Effect.sleep(shutdownDeadlineMs).pipe(
    Effect.andThen(
      Effect.sync(() => {
        server.closeAllConnections()
        return "forced" as const
      })
    )
  )
  return Effect.runPromise(Effect.raceFirst(graceful, forced))
}
