import { createHash } from "node:crypto"
import { chmodSync, rmSync } from "node:fs"
import { createConnection, createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Result, Schema } from "effect"

// Waking the Relay's dialer from another process. `kiln-relay pair join`
// runs beside the Relay server, in the same container, and saves where to
// dial Hearth in the state they share; the server would only find it on its
// next pass (control-dial.ts). So the server listens on a local socket, and
// opening it is the whole message: look now. Nothing is read from it, so
// whoever can open it can only make the Relay read its own state again.

export class DialWakeError extends Schema.TaggedError<DialWakeError>()(
  "DialWakeError",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason
  }
}

/** The wake socket of the Relay that keeps its data in `dataDirectory`. */
export function dialWakePath(dataDirectory: string): string {
  const id = createHash("sha256")
    .update(dataDirectory)
    .digest("hex")
    .slice(0, 16)
  return join(tmpdir(), `kiln-relay-${id}.sock`)
}

/**
 * Listens on the wake socket for as long as the scope lasts, only for this
 * user, calling `onWake` whenever another process opens it.
 */
export const listenForDialWake = (path: string, onWake: () => void) =>
  Effect.acquireRelease(
    Effect.try({
      // Left behind by a Relay that didn't shut down cleanly.
      try: () => rmSync(path, { force: true }),
      catch: dialWakeError,
    }).pipe(
      Effect.andThen(
        Effect.callback<Server, DialWakeError>((resume) => {
          const server = createServer((socket) => {
            socket.on("error", () => undefined)
            socket.end()
            onWake()
          })
          let listening = false
          server.on("error", (cause) => {
            if (!listening) resume(Effect.fail(dialWakeError(cause)))
          })
          server.listen(path, () => {
            const secured = Result.try({
              try: () => chmodSync(path, 0o600),
              catch: dialWakeError,
            })
            if (Result.isFailure(secured)) {
              server.close()
              resume(Effect.fail(secured.failure))
              return
            }
            listening = true
            resume(Effect.succeed(server))
          })
          server.unref()
          return Effect.sync(() => {
            server.close()
          })
        })
      )
    ),
    (server) =>
      Effect.sync(() => {
        server.close()
        rmSync(path, { force: true })
      })
  )

function dialWakeError(cause: unknown): DialWakeError {
  return new DialWakeError({
    reason: cause instanceof Error ? cause.message : String(cause),
  })
}

/** Wakes the Relay server's dialer; false when no server answered. */
export const sendDialWake = (path: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = createConnection(path)
    const done = (woke: boolean) => {
      socket.destroy()
      resume(Effect.succeed(woke))
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(1_000, () => done(false))
    return Effect.sync(() => {
      socket.destroy()
    })
  })
