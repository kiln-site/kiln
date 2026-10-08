import type {
  DatabaseTerminalEnd,
  RelayDatabaseTerminalAttached,
} from "@workspace/contracts"

// One line of the database terminal stream (NDJSON) Hearth sends a page.
export type DatabaseTerminalStreamRecord =
  // First: the session as it is now, and the database user its client signed
  // in as. Output records continue after it.
  | ({ type: "attached"; user: string } & RelayDatabaseTerminalAttached)
  // Output shown at the session's size, which every page renders at.
  | { type: "output"; cols: number; data: string; offset: number; rows: number }
  // The session ended; the page offers a new one instead of reattaching.
  | { type: "ended"; ended: DatabaseTerminalEnd }
  // The stream stopped; the page reconnects unless the code says not to.
  | { type: "error"; code: DatabaseTerminalStreamError; message: string }
  // Keeps idle streams open through proxies.
  | { type: "ping" }

export type DatabaseTerminalStreamError =
  // The Relay dropped this viewer (it restarted, or the viewer fell behind).
  "detached" | "failed" | "not-running" | "relay-unavailable"

export function databaseTerminalStreamUrl(input: {
  cols: number
  databaseId: string
  relayId: string
  restart: boolean
  rows: number
}) {
  const search = new URLSearchParams({
    cols: String(input.cols),
    relayId: input.relayId,
    restart: input.restart ? "1" : "0",
    rows: String(input.rows),
  })
  return `/api/database-terminal/${encodeURIComponent(input.databaseId)}?${search}`
}
