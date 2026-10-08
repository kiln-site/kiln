import "@xterm/xterm/css/xterm.css"

import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { Effect } from "effect"
import { LoaderCircle, RotateCw, TerminalSquare } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  closeDatabaseTerminal,
  openDatabaseTerminal,
  readDatabaseTerminal,
  resizeDatabaseTerminal,
  writeDatabaseTerminal,
} from "@/server/databases"

type TerminalStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "ended" }
  | { kind: "failed"; message: string }

// Keystrokes typed while a write is in flight go out together, in order.
const INPUT_FLUSH_MS = 8
const RESIZE_DEBOUNCE_MS = 150

export function DatabaseTerminal({
  client,
  databaseId,
  relayId,
}: {
  // The command-line client the session runs, for the toolbar.
  client: string
  databaseId: string
  relayId: string
}) {
  // Reconnecting remounts the session with a fresh terminal.
  const [attempt, setAttempt] = React.useState(0)
  const [status, setStatus] = React.useState<TerminalStatus>({
    kind: "connecting",
  })
  const reconnect = React.useCallback(() => {
    setStatus({ kind: "connecting" })
    setAttempt((current) => current + 1)
  }, [])

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-3 md:px-4">
        <TerminalSquare className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Terminal</p>
          <p className="type-code truncate text-muted-foreground">{client}</p>
        </div>
        <TerminalStatusLabel status={status} />
        {status.kind === "ended" || status.kind === "failed" ? (
          <Button size="sm" variant="outline" onClick={reconnect}>
            <RotateCw />
            Reconnect
          </Button>
        ) : null}
      </div>
      {status.kind === "failed" ? (
        <p className="border-b border-destructive/25 bg-destructive/6 px-4 py-2 text-xs text-destructive">
          {status.message}
        </p>
      ) : null}
      <TerminalSession
        key={attempt}
        databaseId={databaseId}
        relayId={relayId}
        onStatus={setStatus}
      />
    </section>
  )
}

function TerminalStatusLabel({ status }: { status: TerminalStatus }) {
  if (status.kind === "connecting") {
    return (
      <span className="type-meta flex items-center gap-1.5 text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        Connecting
      </span>
    )
  }
  const [dot, label] =
    status.kind === "connected"
      ? ["bg-emerald-400", "Connected"]
      : status.kind === "ended"
        ? ["bg-muted-foreground", "Session ended"]
        : ["bg-destructive", "Disconnected"]
  return (
    <span className="type-meta flex items-center gap-1.5 text-muted-foreground">
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

const TerminalSession = React.memo(function TerminalSession({
  databaseId,
  onStatus,
  relayId,
}: {
  databaseId: string
  onStatus: (status: TerminalStatus) => void
  relayId: string
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const target = { databaseId, relayId }
    const style = getComputedStyle(container)
    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: style.getPropertyValue("--font-mono") || "monospace",
      fontSize: 13,
      scrollback: 5_000,
      theme: {
        background: "#00000000",
        cursor: style.color,
        foreground: style.color,
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    fit.fit()
    terminal.focus()

    let sessionId: string | null = null
    let closed = false
    let pendingInput = ""
    let writing = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null

    const flushInput = () => {
      flushTimer = null
      if (!sessionId || writing || !pendingInput || closed) return
      const data = pendingInput
      pendingInput = ""
      writing = true
      forkPromise(
        () =>
          ensuringPromise(
            () =>
              writeDatabaseTerminal({
                data: { ...target, data, sessionId: sessionId! },
              }),
            () => {
              writing = false
              if (pendingInput) flushTimer = setTimeout(flushInput, 0)
            }
          ),
        () => undefined
      )
    }
    const input = terminal.onData((data) => {
      pendingInput += data
      if (!flushTimer) flushTimer = setTimeout(flushInput, INPUT_FLUSH_MS)
    })
    const resized = terminal.onResize(({ cols, rows }) => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!sessionId || closed) return
        forkPromise(
          () =>
            resizeDatabaseTerminal({
              data: { ...target, cols, rows, sessionId: sessionId! },
            }),
          () => undefined
        )
      }, RESIZE_DEBOUNCE_MS)
    })
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(container)

    const session = Effect.runFork(
      Effect.gen(function* () {
        const opened = yield* Effect.tryPromise(() =>
          openDatabaseTerminal({
            data: { ...target, cols: terminal.cols, rows: terminal.rows },
          })
        )
        sessionId = opened.sessionId
        yield* Effect.sync(() => {
          onStatus({ kind: "connected" })
          flushInput()
        })
        let cursor = 0
        for (;;) {
          const output = yield* Effect.tryPromise(() =>
            readDatabaseTerminal({
              data: { ...target, cursor, sessionId: opened.sessionId },
            })
          )
          if (output.data) terminal.write(decodeBase64(output.data))
          cursor = output.cursor
          if (output.closed) {
            sessionId = null
            return yield* Effect.sync(() => onStatus({ kind: "ended" }))
          }
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            onStatus({
              kind: "failed",
              message:
                cause.cause instanceof Error
                  ? cause.cause.message
                  : "The terminal connection failed",
            })
          )
        )
      )
    )

    return () => {
      closed = true
      session.interruptUnsafe()
      observer.disconnect()
      input.dispose()
      resized.dispose()
      if (flushTimer) clearTimeout(flushTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      terminal.dispose()
      const openSession = sessionId
      if (openSession) {
        forkPromise(
          () =>
            closeDatabaseTerminal({
              data: { ...target, sessionId: openSession },
            }),
          () => undefined
        )
      }
    }
  }, [databaseId, onStatus, relayId])

  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-background/40 p-2 text-foreground">
      <div ref={containerRef} className="size-full" />
    </div>
  )
})

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
