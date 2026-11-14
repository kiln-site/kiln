import { withRenderedAccount } from "@/lib/browser-accounts"
import type {
  RelayTerminalAttached,
  TerminalControl,
  TerminalEnd,
  TerminalTarget,
} from "@workspace/contracts"

// One line of the terminal stream (NDJSON) Hearth sends a page.
export type TerminalStreamRecord =
  // First: the session as it is now, this page's attachment (to claim
  // control with), and who its shell runs as. Output records continue after
  // it.
  | ({
      attachmentId: string
      type: "attached"
      user: string
    } & RelayTerminalAttached)
  // Output shown at the session's size, which every page renders at.
  | {
      type: "output"
      cols: number
      control: TerminalControl
      data: string
      offset: number
      rows: number
      seq: number
    }
  // The session ended; the page offers a new one instead of reattaching.
  | { type: "ended"; ended: TerminalEnd }
  // The stream stopped; the page reconnects unless the code says not to.
  | { type: "error"; code: TerminalStreamError; message: string }
  // Keeps idle streams open through proxies.
  | { type: "ping" }

export type TerminalStreamError =
  // The Relay dropped this viewer (it restarted, or the viewer fell behind).
  "detached" | "failed" | "not-running" | "relay-unavailable"

// The stream of one person's session on a terminal target. The target goes
// in the query, as the route reads it.
export function terminalStreamUrl(input: {
  cols: number
  relayId: string
  rows: number
  target: TerminalTarget
}) {
  const { target } = input
  const search = new URLSearchParams({
    cols: String(input.cols),
    kind: target.kind,
    relayId: input.relayId,
    rows: String(input.rows),
    ...("id" in target ? { id: target.id } : {}),
    ...("service" in target ? { service: target.service } : {}),
    ...("role" in target ? { role: target.role } : {}),
  })
  return withRenderedAccount(`/api/terminal?${search}`)
}
