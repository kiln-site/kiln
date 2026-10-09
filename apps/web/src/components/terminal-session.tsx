import "@xterm/xterm/css/xterm.css"

import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { Terminal } from "@xterm/xterm"
import {
  DATABASE_TERMINAL_WRITE_MAX_CHARACTERS,
  type DatabaseTerminalControl,
  type DatabaseTerminalEnd,
} from "@workspace/contracts"
import { Effect } from "effect"
import {
  AppWindow,
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Copy,
  Info,
  LoaderCircle,
  RotateCcw,
  Search,
  TerminalSquare,
  TriangleAlert,
  User,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { showToast } from "@workspace/ui/components/sonner"

import { OverlayNotice } from "@/components/overlay-notice"
import { WorkspaceToolbarTooltip } from "@/components/workspace-toolbar-tooltip"
import { ensuringPromise, forkPromise, recoverPromise } from "@/effect/promise"
import type { DatabaseTerminalStreamRecord } from "@/lib/database-terminal-stream"

// What a terminal page attaches to: a database's client or a shell in one of
// an app's services. The session works the same way for both.
export interface TerminalBackend {
  readonly claim: (input: {
    attachmentId: string
    cols: number
    rows: number
    sessionId: string
  }) => Promise<{ seq: number }>
  // Lowercase, as in "the database stopped".
  readonly noun: string
  readonly restart: () => Promise<unknown>
  readonly streamUrl: (size: { cols: number; rows: number }) => string
  readonly write: (sessionId: string, data: string) => Promise<unknown>
}

// The person's terminal session lives on the Relay and outlives this page.
// The page shows a recreation of it: a snapshot of the screen when it
// attaches, then live output. Losing the page, Hearth, or the Relay
// connection only pauses the view; the session keeps running until it ends or
// sits unviewed past its idle timeout.

type TerminalStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  // The session keeps running; the page is reattaching.
  | { kind: "reconnecting"; cause: "hearth" | "relay" }
  | { kind: "ended"; ended: DatabaseTerminalEnd }
  | { kind: "not-running" }
  | { kind: "failed"; message: string }

// Shown briefly over the terminal when a new session replaced an earlier one.
type SessionNotice =
  | { kind: "previous"; ended: DatabaseTerminalEnd }
  | { kind: "relay-restarted" }

// Whether this page is the one in control of the session: it sets the size
// and is the one typed in. Only one of the person's pages is at a time.
// "claiming" is this page taking control, until the Relay confirms it.
type TerminalControl = DatabaseTerminalControl | "claiming"

interface TerminalSize {
  cols: number
  rows: number
}

// Who the client is signed in as, and since when, for the toolbar.
interface TerminalSessionInfo {
  startedAt: string
  user: string
}

const CLAIM_DEBOUNCE_MS = 150
const RECONNECT_MAX_DELAY_MS = 5_000

// A session notice stays up this long unless dismissed sooner.
const NOTICE_VISIBLE_MS = 10_000
// How long a tab that took over from another says it's now the active one.
const ACTIVATED_VISIBLE_MS = 2_500

export function TerminalSession({
  backend,
  toolbarActions,
}: {
  // Stable while the target is; a new backend starts a new connection.
  backend: TerminalBackend
  // Extra toolbar buttons from the page, before the terminal's own.
  toolbarActions?: React.ReactNode
}) {
  const [status, setStatus] = React.useState<TerminalStatus>({
    kind: "connecting",
  })
  const [notice, setNotice] = React.useState<SessionNotice | null>(null)
  const [control, setControl] = React.useState<TerminalControl>("none")
  const [activated, setActivated] = React.useState(false)
  const [session, setSession] = React.useState<TerminalSessionInfo | null>(null)
  const [hasSelection, setHasSelection] = React.useState(false)
  const [atBottom, setAtBottom] = React.useState(true)
  const surface = React.useRef<TerminalSurfaceHandle>(null)
  const events = React.useMemo<TerminalSurfaceEvents>(
    () => ({
      onActivated: () => setActivated(true),
      onControl: setControl,
      onNotice: setNotice,
      onScrolledToBottom: setAtBottom,
      onSelection: setHasSelection,
      onSession: setSession,
      onStatus: setStatus,
    }),
    []
  )
  const restart = React.useCallback(() => {
    setNotice(null)
    surface.current?.connect(true)
  }, [])
  const reconnect = React.useCallback(() => {
    setNotice(null)
    surface.current?.connect(false)
  }, [])
  React.useEffect(() => {
    if (!activated) return
    const timer = window.setTimeout(
      () => setActivated(false),
      ACTIVATED_VISIBLE_MS
    )
    return () => window.clearTimeout(timer)
  }, [activated])
  React.useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  return (
    <section
      data-terminal-frame
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-card transition-transform duration-150"
    >
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
        <TerminalSearch surface={surface} />
        {session ? (
          <span className="type-code flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <User className="size-3.5 shrink-0" />
            <span className="truncate text-foreground">{session.user}</span>
            <span className="shrink-0">
              · since {formatStartedAt(session.startedAt)}
            </span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {toolbarActions}
          <WorkspaceToolbarTooltip content="Copy selection">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Copy selection"
              disabled={!hasSelection}
              onClick={() => surface.current?.copySelection()}
            >
              <Copy className="size-4" />
            </Button>
          </WorkspaceToolbarTooltip>
          <RestartSessionButton
            disabled={status.kind === "connecting"}
            onRestart={restart}
          />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalSurface ref={surface} backend={backend} events={events} />
        {!atBottom && status.kind === "live" ? (
          <Button
            size="sm"
            variant="secondary"
            className="absolute right-4 bottom-4 z-10 gap-1.5 shadow-lg shadow-black/30"
            onClick={() => surface.current?.scrollToBottom()}
          >
            <ArrowDown className="size-3.5" />
            Jump to latest
          </Button>
        ) : null}
        <TerminalNotice
          activated={activated}
          control={control}
          noun={backend.noun}
          notice={notice}
          status={status}
          onDismissNotice={() => setNotice(null)}
        />
        <TerminalOverlay
          noun={backend.noun}
          status={status}
          onReconnect={reconnect}
        />
      </div>
    </section>
  )
}

function TerminalSearch({
  surface,
}: {
  surface: React.RefObject<TerminalSurfaceHandle | null>
}) {
  const [query, setQuery] = React.useState("")
  return (
    <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        placeholder="Search terminal"
        aria-label="Search terminal"
        className="h-9 border-border/80 bg-background pr-20 pl-8 text-base shadow-none sm:text-xs"
        onChange={(event) => {
          setQuery(event.target.value)
          surface.current?.search(event.target.value, "next", true)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            surface.current?.search(
              query,
              event.shiftKey ? "previous" : "next",
              false
            )
          }
          if (event.key === "Escape") {
            setQuery("")
            surface.current?.search("", "next", false)
          }
        }}
      />
      {query ? (
        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
          <button
            type="button"
            aria-label="Previous match"
            className="grid size-6 place-items-center text-muted-foreground hover:text-foreground"
            onClick={() => surface.current?.search(query, "previous", false)}
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            className="grid size-6 place-items-center text-muted-foreground hover:text-foreground"
            onClick={() => surface.current?.search(query, "next", false)}
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Clear terminal search"
            className="grid size-6 place-items-center text-muted-foreground hover:text-foreground"
            onClick={() => {
              setQuery("")
              surface.current?.search("", "next", false)
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function RestartSessionButton({
  disabled,
  onRestart,
}: {
  disabled: boolean
  onRestart: () => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WorkspaceToolbarTooltip content="Restart session">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Restart session"
            disabled={disabled}
          >
            <RotateCcw className="size-4" />
          </Button>
        </PopoverTrigger>
      </WorkspaceToolbarTooltip>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b px-3 py-2.5">
          <p className="text-xs font-semibold">Restart session?</p>
          <p className="type-support mt-1 text-muted-foreground">
            This ends the running client, including anything it is doing, and
            starts a new one. Other open pages switch to it too.
          </p>
        </div>
        <div className="flex justify-end gap-1.5 p-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setOpen(false)
              onRestart()
            }}
          >
            <RotateCcw />
            Restart
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Floats over the terminal so the screen never shifts under the person.
function TerminalNotice({
  activated,
  control,
  noun,
  notice,
  onDismissNotice,
  status,
}: {
  // This tab just took over from another.
  activated: boolean
  control: TerminalControl
  noun: string
  notice: SessionNotice | null
  onDismissNotice: () => void
  status: TerminalStatus
}) {
  if (status.kind === "reconnecting") {
    return (
      <OverlayNotice
        loading
        message={
          status.cause === "relay"
            ? "CAN'T REACH THE RELAY · SESSION STILL RUNNING · RECONNECTING…"
            : "LOST HEARTH · SESSION STILL RUNNING · RECONNECTING…"
        }
      />
    )
  }
  if (status.kind !== "live") return null
  if (control === "self" && activated) {
    return (
      <OverlayNotice
        icon={otherTabIcon}
        message="THIS TAB IS NOW ACTIVE"
        tone="info"
      />
    )
  }
  // Still active elsewhere until the Relay confirms this tab took over.
  if (control === "other" || control === "claiming") {
    return (
      <OverlayNotice
        icon={otherTabIcon}
        message={
          window.matchMedia("(pointer: coarse)").matches
            ? "ACTIVE IN ANOTHER TAB · TAP TO USE"
            : "ACTIVE IN ANOTHER TAB · CLICK TO USE"
        }
        tone="info"
      />
    )
  }
  if (!notice) return null
  return (
    <OverlayNotice
      icon={noticeIcon}
      message={`NEW SESSION · ${
        notice.kind === "relay-restarted"
          ? "THE RELAY RESTARTED"
          : endedLabel(notice.ended, noun)
      }`}
      tone="info"
      onDismiss={onDismissNotice}
    />
  )
}

const noticeIcon = <Info className="size-3" />
const otherTabIcon = <AppWindow className="size-3" />

function TerminalOverlay({
  noun,
  onReconnect,
  status,
}: {
  noun: string
  onReconnect: () => void
  status: TerminalStatus
}) {
  if (status.kind === "connecting") {
    return (
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <span className="type-meta flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          Opening your session…
        </span>
      </div>
    )
  }
  if (
    status.kind !== "ended" &&
    status.kind !== "failed" &&
    status.kind !== "not-running"
  ) {
    return null
  }
  const [title, detail, action, onAction] =
    status.kind === "ended"
      ? [
          "Session ended",
          endedDescription(status.ended, noun),
          "Start new session",
          onReconnect,
        ]
      : status.kind === "not-running"
        ? [
            `${capitalized(noun)} isn't running`,
            `Start the ${noun} to open its terminal.`,
            "Try again",
            onReconnect,
          ]
        : ["Terminal unavailable", status.message, "Try again", onReconnect]
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-card/80 px-6 backdrop-blur-[2px]">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
          {status.kind === "ended" ? (
            <TerminalSquare className="size-5" />
          ) : (
            <TriangleAlert className="size-5" />
          )}
        </div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
        <Button size="sm" className="mt-4" onClick={onAction}>
          <RotateCcw />
          {action}
        </Button>
      </div>
    </div>
  )
}

function endedDescription(ended: DatabaseTerminalEnd, noun: string) {
  switch (ended.reason) {
    case "exited":
      return "The client exited."
    case "database-stopped":
      return `The ${noun} stopped or restarted, which ended the session.`
    case "timed-out":
      return "The session ended after a while without an open page."
    case "restarted":
      return "The session was restarted."
    case "failed":
      return "The client stopped unexpectedly."
  }
}

// Why the last session ended, short enough for a notice.
function endedLabel(ended: DatabaseTerminalEnd, noun: string) {
  switch (ended.reason) {
    case "exited":
      return "THE CLIENT EXITED"
    case "database-stopped":
      return `THE ${noun.toUpperCase()} STOPPED`
    case "timed-out":
      return "THE LAST ONE TIMED OUT"
    case "restarted":
      return "RESTARTED FROM ANOTHER PAGE"
    case "failed":
      return "THE CLIENT STOPPED UNEXPECTEDLY"
  }
}

const startedAtFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
})

function formatStartedAt(value: string) {
  return startedAtFormatter.format(new Date(value))
}

interface TerminalSurfaceEvents {
  // This page took control over from another of the person's pages.
  onActivated: () => void
  onControl: (control: TerminalControl) => void
  onNotice: (notice: SessionNotice | null) => void
  onScrolledToBottom: (atBottom: boolean) => void
  onSelection: (hasSelection: boolean) => void
  onSession: (session: TerminalSessionInfo) => void
  onStatus: (status: TerminalStatus) => void
}

interface TerminalSurfaceHandle {
  connect: (restart: boolean) => void
  copySelection: () => void
  scrollToBottom: () => void
  search: (
    query: string,
    direction: "next" | "previous",
    incremental: boolean
  ) => void
}

// Owns the xterm instance and the session connection. Output never passes
// through React state; only status changes do.
const TerminalSurface = React.memo(
  React.forwardRef<
    TerminalSurfaceHandle,
    { backend: TerminalBackend; events: TerminalSurfaceEvents }
  >(function TerminalSurface({ backend, events }, ref) {
    const containerRef = React.useRef<HTMLDivElement>(null)
    const handle = React.useRef<TerminalSurfaceHandle | null>(null)
    React.useImperativeHandle(ref, () => ({
      connect: (restart) => handle.current?.connect(restart),
      copySelection: () => handle.current?.copySelection(),
      scrollToBottom: () => handle.current?.scrollToBottom(),
      search: (query, direction, incremental) =>
        handle.current?.search(query, direction, incremental),
    }))

    React.useEffect(() => {
      const container = containerRef.current
      if (!container) return
      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily:
          getComputedStyle(container).getPropertyValue("--font-mono").trim() ||
          "monospace",
        // 16px on touch screens, so iOS doesn't zoom in when typing.
        fontSize: window.matchMedia("(pointer: coarse)").matches ? 16 : 13,
        lineHeight: 1.3,
        scrollback: 5_000,
        theme: terminalTheme(container),
      })
      const fit = new FitAddon()
      const search = new SearchAddon()
      terminal.loadAddon(fit)
      terminal.loadAddon(search)
      terminal.open(container)
      fit.fit()
      terminal.focus()

      // The size this page's window fits, within what the Relay accepts.
      const measure = () => {
        const size = fit.proposeDimensions()
        if (!size || !size.cols || !size.rows) return null
        return {
          cols: Math.min(Math.max(size.cols, 10), 500),
          rows: Math.min(Math.max(size.rows, 4), 300),
        }
      }
      const connection = new TerminalConnection(
        terminal,
        backend,
        events,
        measure
      )
      handle.current = {
        connect: (restart) => connection.connect(restart),
        copySelection: () => {
          const selection = terminal.getSelection()
          if (!selection) return
          forkPromise(
            async () => {
              await navigator.clipboard.writeText(selection)
              showToast({ message: "Copied", type: "success" })
            },
            () => showToast({ message: "Could not copy", type: "error" })
          )
        },
        scrollToBottom: () => terminal.scrollToBottom(),
        search: (query, direction, incremental) => {
          if (!query) {
            search.clearDecorations()
            return
          }
          const options = {
            decorations: {
              activeMatchColorOverviewRuler: "#f59e0b",
              matchOverviewRuler: "#f59e0b80",
            },
            incremental,
          }
          if (direction === "next") search.findNext(query, options)
          else search.findPrevious(query, options)
        },
      }

      let wasAtBottom = true
      const scrolled = terminal.onScroll(() => {
        const buffer = terminal.buffer.active
        const atBottom = buffer.viewportY >= buffer.baseY
        if (atBottom !== wasAtBottom) {
          wasAtBottom = atBottom
          events.onScrolledToBottom(atBottom)
        }
      })
      let hadSelection = false
      const selected = terminal.onSelectionChange(() => {
        const has = terminal.hasSelection()
        if (has !== hadSelection) {
          hadSelection = has
          events.onSelection(has)
        }
      })
      const typed = terminal.onData((data) => connection.input(data))
      // Focusing or clicking the terminal puts this page in control (a click
      // on an already focused terminal fires no focus). While in control,
      // its window resizing resizes the session.
      const focused = () => connection.claim()
      terminal.textarea?.addEventListener("focus", focused)
      terminal.element?.addEventListener("pointerdown", focused)
      const observer = new ResizeObserver(() => connection.windowResized())
      observer.observe(container)
      const keyboard = followKeyboard(terminal, container)
      connection.connect(false)

      return () => {
        connection.stop()
        observer.disconnect()
        keyboard()
        scrolled.dispose()
        selected.dispose()
        typed.dispose()
        terminal.textarea?.removeEventListener("focus", focused)
        terminal.element?.removeEventListener("pointerdown", focused)
        handle.current = null
        terminal.dispose()
      }
    }, [backend, events])

    return (
      <div className="absolute inset-0 overflow-hidden bg-black py-3 pr-2 pl-4 text-foreground [&_.xterm-helper-textarea]:!text-[16px]">
        <div ref={containerRef} className="size-full" />
      </div>
    )
  })
)

// Keeps the page attached to the session: streams it, writes typing and size
// back, and reattaches with backoff when the stream drops.
class TerminalConnection {
  readonly #events: TerminalSurfaceEvents
  readonly #measure: () => TerminalSize | null
  readonly #backend: TerminalBackend
  readonly #terminal: Terminal
  #abort: AbortController | null = null
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #generation = 0
  #live = false
  #offset = 0
  // Typed input not yet sent, and the session it was typed into. It never
  // goes to any other session.
  #pendingInput = ""
  #pendingSessionId: string | null = null
  #attachmentId: string | null = null
  #claimTimer: ReturnType<typeof setTimeout> | null = null
  // This page's claim on control, from the request until the Relay's state
  // reaches the change it made (`seq`, known once the request returns).
  // Kept apart from who the Relay last reported in control, so a claim
  // always settles, whoever ends up in control.
  #claim: { request: number; seq: number | null } | null = null
  // The window changed while a claim was pending, so the size it claimed
  // may be stale.
  #resizedDuringClaim = false
  #claimRequests = 0
  #reported: DatabaseTerminalControl = "none"
  // The last state change this page has seen.
  #seq = 0
  #shownControl: TerminalControl = "none"
  // Claiming control that another of the person's pages had.
  #takingOver = false
  // Whether this page asked for the session it is attaching to.
  #restarting = false
  #sessionId: string | null = null
  // The session's size, which this page renders at whatever its window.
  #sessionSize: TerminalSize | null = null
  #stopped = false
  #writing = false

  constructor(
    terminal: Terminal,
    backend: TerminalBackend,
    events: TerminalSurfaceEvents,
    measure: () => TerminalSize | null
  ) {
    this.#terminal = terminal
    this.#backend = backend
    this.#events = events
    this.#measure = measure
  }

  connect(restart: boolean) {
    if (this.#stopped) return
    this.#abort?.abort()
    const generation = ++this.#generation
    this.#live = false
    this.#restarting = restart
    if (restart) this.#pendingInput = ""
    this.#events.onStatus({ kind: "connecting" })
    forkPromise(() => this.#run(generation, restart))
  }

  stop() {
    this.#stopped = true
    this.#generation += 1
    this.#abort?.abort()
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    if (this.#claimTimer) clearTimeout(this.#claimTimer)
  }

  input(data: string) {
    if (!this.#live || !this.#sessionId) return
    if (this.#pendingSessionId !== this.#sessionId) {
      this.#pendingInput = ""
      this.#pendingSessionId = this.#sessionId
    }
    this.#pendingInput += data
    // Typing takes control back from another page that took it meanwhile.
    if (this.#reported !== "self" && !this.#claim) this.claim()
    // Sent right away; keys typed while a write is in flight go together.
    if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => this.#flushInput(), 0)
    }
  }

  // Puts this page in control, sized to its window. Every other page then
  // shows that another tab is active.
  claim() {
    const sessionId = this.#sessionId
    const attachmentId = this.#attachmentId
    const size = this.#measure()
    if (!this.#live || !sessionId || !attachmentId || !size) return
    const current = this.#sessionSize
    if (
      !this.#claim &&
      this.#reported === "self" &&
      current?.cols === size.cols &&
      current.rows === size.rows
    ) {
      return
    }
    if (!this.#claim) this.#takingOver = this.#reported === "other"
    const request = ++this.#claimRequests
    this.#claim = { request, seq: null }
    this.#showControl()
    if (this.#claimTimer) clearTimeout(this.#claimTimer)
    this.#claimTimer = setTimeout(() => {
      this.#claimTimer = null
      forkPromise(
        async () => {
          const { seq } = await this.#backend.claim({
            ...size,
            attachmentId,
            sessionId,
          })
          if (this.#claim?.request !== request) return
          this.#claim.seq = seq
          this.#settleClaim()
        },
        () => {
          if (this.#claim?.request !== request) return
          this.#claim = null
          this.#takingOver = false
          this.#resizedDuringClaim = false
          this.#showControl()
        }
      )
    }, CLAIM_DEBOUNCE_MS)
  }

  // The page in control follows its own window.
  windowResized() {
    if (this.#claim) this.#resizedDuringClaim = true
    else if (this.#reported === "self") this.claim()
  }

  // Records who the Relay says is in control as of state change `seq`.
  #report(control: DatabaseTerminalControl, seq: number) {
    this.#reported = control
    this.#seq = seq
    this.#settleClaim()
    this.#showControl()
  }

  #settleClaim() {
    const claim = this.#claim
    if (claim?.seq === null || claim === null || this.#seq < claim.seq) return
    this.#claim = null
    if (this.#reported === "self" && this.#takingOver) {
      this.#events.onActivated()
    }
    this.#takingOver = false
    this.#showControl()
    // Still in control: catch up with the window's latest size.
    const resized = this.#resizedDuringClaim
    this.#resizedDuringClaim = false
    if (resized && this.#reported === "self") this.claim()
  }

  #showControl() {
    const control: TerminalControl = this.#claim ? "claiming" : this.#reported
    if (control === this.#shownControl) return
    this.#shownControl = control
    this.#events.onControl(control)
  }

  // Output already written was at the old size, so the resize waits for it.
  #applySize(cols: number, rows: number) {
    const current = this.#sessionSize
    if (current?.cols === cols && current.rows === rows) return
    this.#sessionSize = { cols, rows }
    this.#terminal.write("", () => this.#terminal.resize(cols, rows))
  }

  #flushInput() {
    this.#flushTimer = null
    const sessionId = this.#pendingSessionId
    if (this.#writing || !this.#pendingInput || !sessionId) return
    if (sessionId !== this.#sessionId) {
      this.#pendingInput = ""
      return
    }
    // Reattaching to the same session: sent once it is live again.
    if (!this.#live) return
    const data = inputChunk(this.#pendingInput)
    this.#pendingInput = this.#pendingInput.slice(data.length)
    this.#writing = true
    forkPromise(
      () =>
        ensuringPromise(
          () => this.#backend.write(sessionId, data),
          () => {
            this.#writing = false
            if (this.#pendingInput) {
              this.#flushTimer = setTimeout(() => this.#flushInput(), 0)
            }
          }
        ),
      () => {
        // A session that was replaced meanwhile already said why it ended.
        if (sessionId !== this.#sessionId) return
        // The rest would arrive without what failed, so it goes too.
        if (this.#pendingSessionId === sessionId) this.#pendingInput = ""
        showToast({
          message: "Couldn't send your input to the terminal",
          type: "error",
        })
      }
    )
  }

  async #run(generation: number, restart: boolean) {
    if (restart) {
      const restarted = await recoverPromise(
        async () => {
          await this.#backend.restart()
          return true
        },
        () => false
      )
      if (generation !== this.#generation) return
      if (!restarted) {
        showToast({ message: "Couldn't restart the session", type: "error" })
      }
      // The page that restarted takes control of the new session.
      this.#terminal.focus()
    }
    let attempt = 0
    while (generation === this.#generation) {
      const outcome = await Effect.runPromise(
        Effect.tryPromise(() => this.#streamOnce(generation)).pipe(
          Effect.catch(() =>
            Effect.succeed<StreamOutcome>({ cause: "hearth", kind: "retry" })
          )
        )
      )
      if (generation !== this.#generation || outcome.kind === "stop") return
      attempt = outcome.attached ? 1 : attempt + 1
      this.#live = false
      this.#events.onStatus(
        this.#sessionId && outcome.cause !== "detached"
          ? { cause: outcome.cause, kind: "reconnecting" }
          : { kind: "connecting" }
      )
      const delay =
        outcome.cause === "detached"
          ? 0
          : Math.min(250 * 2 ** attempt, RECONNECT_MAX_DELAY_MS)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  async #streamOnce(generation: number): Promise<StreamOutcome> {
    const abort = new AbortController()
    this.#abort = abort
    const response = await fetch(
      this.#backend.streamUrl({
        // Used only when this starts a session; joining keeps its size.
        cols: this.#measure()?.cols ?? this.#terminal.cols,
        rows: this.#measure()?.rows ?? this.#terminal.rows,
      }),
      { credentials: "same-origin", signal: abort.signal }
    )
    if (response.status === 401 || response.status === 403) {
      this.#events.onStatus({
        kind: "failed",
        message:
          response.status === 401
            ? "Your sign-in expired. Reload the page to sign in again."
            : `You no longer have access to this ${this.#backend.noun}'s terminal.`,
      })
      return { kind: "stop" }
    }
    if (!response.ok || !response.body) {
      return { cause: "hearth", kind: "retry" }
    }
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader()
    let buffered = ""
    let attached = false
    for (;;) {
      const { done, value } = await reader.read()
      if (generation !== this.#generation) {
        abort.abort()
        return { kind: "stop" }
      }
      if (done) return { attached, cause: "hearth", kind: "retry" }
      buffered += value
      let newline = buffered.indexOf("\n")
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf("\n")
        if (!line) continue
        const record = JSON.parse(line) as DatabaseTerminalStreamRecord
        if (record.type === "attached") attached = true
        const outcome = this.#handle(record)
        if (outcome) {
          abort.abort()
          return outcome.kind === "retry" ? { ...outcome, attached } : outcome
        }
      }
    }
  }

  #handle(record: DatabaseTerminalStreamRecord): StreamOutcome | null {
    switch (record.type) {
      case "attached": {
        const previousSession = this.#sessionId
        if (previousSession !== record.sessionId) {
          this.#events.onNotice(
            sessionNotice(previousSession, record, this.#restarting)
          )
        }
        this.#restarting = false
        // Rebuild the screen from the session's own snapshot, at its size, so
        // every page shows the same thing whatever it missed.
        this.#sessionSize = { cols: record.cols, rows: record.rows }
        this.#terminal.resize(record.cols, record.rows)
        this.#terminal.reset()
        this.#terminal.write(record.snapshot)
        this.#offset = record.offset
        if (this.#sessionId !== record.sessionId) {
          // A claim on an earlier session can't settle on this one.
          this.#claim = null
          this.#takingOver = false
          this.#resizedDuringClaim = false
        }
        this.#sessionId = record.sessionId
        this.#attachmentId = record.attachmentId
        this.#report(record.control, record.seq)
        this.#live = true
        if (this.#pendingInput && !this.#flushTimer) {
          this.#flushTimer = setTimeout(() => this.#flushInput(), 0)
        }
        this.#events.onSession({
          startedAt: record.startedAt,
          user: record.user,
        })
        this.#events.onStatus({ kind: "live" })
        // A page opened or brought back in use takes control.
        if (
          document.hasFocus() &&
          document.activeElement === this.#terminal.textarea
        ) {
          this.claim()
        }
        return null
      }
      case "output": {
        // Older than what this page shows already, size included.
        if (record.offset < this.#offset) return null
        // Size and control changes arrive in order with the output, each
        // applied between the bytes it happened between.
        this.#applySize(record.cols, record.rows)
        this.#report(record.control, record.seq)
        if (record.offset === this.#offset) return null
        const bytes = decodeBase64(record.data)
        const start = record.offset - bytes.length
        this.#terminal.write(
          start < this.#offset ? bytes.subarray(this.#offset - start) : bytes
        )
        this.#offset = record.offset
        return null
      }
      case "ended":
        this.#live = false
        // Another page restarted the session: follow it to the new one.
        if (record.ended.reason === "restarted") {
          return { cause: "detached", kind: "retry" }
        }
        this.#sessionId = null
        this.#events.onStatus({ ended: record.ended, kind: "ended" })
        return { kind: "stop" }
      case "error":
        if (record.code === "not-running") {
          this.#live = false
          this.#events.onStatus({ kind: "not-running" })
          return { kind: "stop" }
        }
        if (record.code === "failed") {
          this.#live = false
          this.#events.onStatus({ kind: "failed", message: record.message })
          return { kind: "stop" }
        }
        return {
          cause: record.code === "relay-unavailable" ? "relay" : "detached",
          kind: "retry",
        }
      case "ping":
        return null
    }
  }
}

// The next write's worth of input, never splitting a surrogate pair.
function inputChunk(input: string) {
  if (input.length <= DATABASE_TERMINAL_WRITE_MAX_CHARACTERS) return input
  const end = DATABASE_TERMINAL_WRITE_MAX_CHARACTERS
  const last = input.charCodeAt(end - 1)
  return input.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

type StreamOutcome =
  | { kind: "stop" }
  | {
      attached?: boolean
      cause: "detached" | "hearth" | "relay"
      kind: "retry"
    }

// A page that opens a session this young says why the last one ended.
const FRESH_SESSION_MS = 60_000

// What to tell the person when this page sees a new session: why the last one
// ended, when the Relay knows, or that the Relay restarted under it. A page
// opening an older session, or the page that restarted it, needs no note.
function sessionNotice(
  previousSession: string | null,
  attached: Extract<DatabaseTerminalStreamRecord, { type: "attached" }>,
  restartedHere: boolean
): SessionNotice | null {
  const witnessed =
    previousSession !== null ||
    Date.now() - Date.parse(attached.startedAt) < FRESH_SESSION_MS
  if (!witnessed || restartedHere) return null
  // Only a page that was showing the old session can tell a restart came
  // from elsewhere.
  if (
    attached.previous &&
    (attached.previous.reason !== "restarted" || previousSession !== null)
  ) {
    return { ended: attached.previous, kind: "previous" }
  }
  if (
    previousSession !== null &&
    bootOf(previousSession) !== bootOf(attached.sessionId)
  ) {
    return { kind: "relay-restarted" }
  }
  return null
}

// Session ids start with the id of the Relay process that runs them.
function bootOf(sessionId: string) {
  return sessionId.split(".", 1)[0]
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

// On phones the on-screen keyboard covers the bottom of the page without
// resizing it. While the terminal is focused, the whole terminal moves up so
// the cursor's line sits just above the keyboard; its top may go off screen.
// Returns a cleanup.
function followKeyboard(terminal: Terminal, container: HTMLElement) {
  const viewport = window.visualViewport
  const frame = container.closest<HTMLElement>("[data-terminal-frame]")
  if (!viewport || !frame) return () => undefined
  let shift = 0
  let frameRequest: number | null = null
  const place = (next: number) => {
    if (next === shift) return
    shift = next
    frame.style.transform = shift ? `translateY(${-shift}px)` : ""
  }
  const update = () => {
    frameRequest = null
    const keyboardOpen =
      viewport.scale < 1.01 && window.innerHeight - viewport.height > 80
    if (!keyboardOpen || document.activeElement !== terminal.textarea) {
      place(0)
      return
    }
    const screen = terminal.element?.querySelector(".xterm-screen")
    if (!screen) return
    const bounds = screen.getBoundingClientRect()
    const rowHeight = bounds.height / terminal.rows
    // Where the cursor's line ends without the current shift.
    const cursorBottom =
      bounds.top + shift + (terminal.buffer.active.cursorY + 1) * rowHeight
    const visibleBottom = viewport.offsetTop + viewport.height - 8
    place(Math.max(0, Math.round(cursorBottom - visibleBottom)))
  }
  const schedule = () => {
    frameRequest ??= requestAnimationFrame(update)
  }
  viewport.addEventListener("resize", schedule)
  viewport.addEventListener("scroll", schedule)
  terminal.textarea?.addEventListener("focus", schedule)
  terminal.textarea?.addEventListener("blur", schedule)
  const moved = terminal.onCursorMove(schedule)
  return () => {
    viewport.removeEventListener("resize", schedule)
    viewport.removeEventListener("scroll", schedule)
    terminal.textarea?.removeEventListener("focus", schedule)
    terminal.textarea?.removeEventListener("blur", schedule)
    moved.dispose()
    if (frameRequest !== null) cancelAnimationFrame(frameRequest)
    frame.style.transform = ""
  }
}

// xterm wants concrete colors; the app's are CSS variables in any color
// space, so they are resolved by painting them.
function terminalTheme(element: HTMLElement) {
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })
  const style = getComputedStyle(element)
  const resolve = (variable: string, fallback: string) => {
    const value = style.getPropertyValue(variable).trim()
    if (!context || !value) return fallback
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = fallback
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    return `rgb(${red}, ${green}, ${blue})`
  }
  const foreground = resolve("--foreground", "#e7e5e4")
  const primary = resolve("--primary", "#f97316")
  return {
    background: "#00000000",
    black: "#1c1917",
    blue: "#60a5fa",
    brightBlack: "#78716c",
    brightBlue: "#93c5fd",
    brightCyan: "#67e8f9",
    brightGreen: "#86efac",
    brightMagenta: "#f0abfc",
    brightRed: "#fca5a5",
    brightWhite: "#fafaf9",
    brightYellow: "#fde68a",
    cursor: primary,
    cursorAccent: "#0c0a09",
    cyan: "#22d3ee",
    foreground,
    green: "#4ade80",
    magenta: "#e879f9",
    red: "#f87171",
    selectionBackground: primary
      .replace("rgb(", "rgba(")
      .replace(")", ", 0.3)"),
    white: "#d6d3d1",
    yellow: "#facc15",
  }
}

function capitalized(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}
