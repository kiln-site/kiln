import { createHash } from "node:crypto"
import { chmodSync, rmSync } from "node:fs"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

// Waking the Relay's dialer from another process. `kiln-relay pair join`
// runs beside the Relay server, in the same container, and saves where to
// dial Hearth in the state they share; the server would only find it on its
// next pass (control-dial.ts). So the server listens on a local socket, and
// opening it is the whole message: look now. Nothing is read from it, so
// whoever can open it can only make the Relay read its own state again.

/** The wake socket of the Relay that keeps its data in `dataDirectory`. */
export function dialWakePath(dataDirectory: string): string {
  const id = createHash("sha256")
    .update(dataDirectory)
    .digest("hex")
    .slice(0, 16)
  return join(tmpdir(), `kiln-relay-${id}.sock`)
}

/** Calls `onWake` whenever another process opens the wake socket. */
export function listenForDialWake(
  path: string,
  onWake: () => void
): { readonly close: () => void } {
  // Left behind by a Relay that didn't shut down cleanly.
  rmSync(path, { force: true })
  const server = createServer((socket) => {
    socket.on("error", () => undefined)
    socket.end()
    onWake()
  })
  server.on("error", (cause) => {
    console.warn(
      `Couldn't listen for joins finishing, so the Relay finds them within 15 seconds instead: ${cause.message}`
    )
  })
  server.listen(path, () => {
    chmodSync(path, 0o600)
  })
  server.unref()
  return {
    close: () => {
      server.close()
      rmSync(path, { force: true })
    },
  }
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
