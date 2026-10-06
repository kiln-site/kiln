import type { Server } from "node:http"
import { Effect } from "effect"

type RelayShutdownResult = "forced" | "graceful"

export function closeRelayServer(
  server: Server,
  activeStreamControllers: ReadonlySet<AbortController>,
  timeoutMs = 10_000
): Promise<RelayShutdownResult> {
  const graceful = Effect.callback<RelayShutdownResult>((resume) => {
    server.close(() => resume(Effect.succeed("graceful")))
    server.closeIdleConnections()
  })
  const forced = Effect.sleep(timeoutMs).pipe(
    Effect.andThen(
      Effect.sync(() => {
        server.closeAllConnections()
        return "forced" as const
      })
    )
  )
  return Effect.runPromise(
    Effect.sync(() => {
      for (const controller of activeStreamControllers) controller.abort()
    }).pipe(Effect.andThen(Effect.raceFirst(graceful, forced)))
  )
}
