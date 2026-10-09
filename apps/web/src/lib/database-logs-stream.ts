import type {
  HearthDatabaseLogsOutput,
  RelayConsoleLine,
} from "@workspace/contracts"

// One line of the database logs stream (NDJSON) Hearth sends a page.
export type DatabaseLogsStreamRecord =
  // First: the Relay is following the container. Lines follow, starting with
  // its recent output.
  | { type: "attached" }
  | { type: "lines"; lines: Array<RelayConsoleLine> }
  // The container stopped, or its output couldn't be followed. The page
  // follows again once the database is running.
  | { type: "ended"; ended: NonNullable<HearthDatabaseLogsOutput["ended"]> }
  // The stream stopped; the page reconnects unless the code says not to.
  | { type: "error"; code: DatabaseLogsStreamError; message: string }
  // Keeps idle streams open through proxies.
  | { type: "ping" }

export type DatabaseLogsStreamError =
  // The Relay dropped this page (it restarted, or the page fell behind).
  | "detached"
  | "failed"
  | "relay-unavailable"
  // The Relay is too old to follow database logs.
  | "unsupported"

export function databaseLogsStreamUrl(input: {
  databaseId: string
  relayId: string
}) {
  const search = new URLSearchParams({ relayId: input.relayId })
  return `/api/database-logs/${encodeURIComponent(input.databaseId)}?${search}`
}
