import * as React from "react"
import type { RelayConsoleLine } from "@workspace/contracts"

import {
  ConsoleLevelMenu,
  ConsoleSearchControl,
} from "@/components/console/console-filters"
import { ConsoleLogViewportController } from "@/components/console/console-log-viewport"
import { ConsoleRetryButton } from "@/components/console/console-retry-button"
import {
  createConsoleStreamStore,
  createConsoleUiStore,
  type ConsoleStreamSnapshot,
  type ConsoleStreamStore,
  type ConsoleUiStore,
} from "@/components/console/console-stores"
import {
  ConsoleRedactButton,
  ConsoleSelectionControl,
  ConsoleTimestampButton,
  ConsoleWrapButton,
} from "@/components/console/console-toolbar-actions"
import { databaseRelayAvailable } from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import { ensuringPromise, forkPromise, recoverPromise } from "@/effect/promise"
import {
  databaseLogsStreamUrl,
  type DatabaseLogsStreamRecord,
} from "@/lib/database-logs-stream"

// Lines a page keeps, like a server console.
const MAX_LINES = 5_000
const RECONNECT_MAX_DELAY_MS = 5_000
// A database that has written nothing yet shows as empty after this long.
const EMPTY_AFTER_MS = 750

const relayUnavailableMessage = "Hearth cannot reach this Relay right now."

// The server console without its command bar: the database container's
// output, followed live.
export function DatabaseLogsPage() {
  const { database } = useDatabaseWorkspace()
  return (
    <DatabaseLogsSession
      key={`${database.relayId}:${database.id}`}
      containerUp={
        database.observedState === "running" ||
        database.observedState === "starting"
      }
      databaseId={database.id}
      relayAvailable={databaseRelayAvailable(database)}
      relayId={database.relayId}
    />
  )
}

function DatabaseLogsSession({
  containerUp,
  databaseId,
  relayAvailable,
  relayId,
}: {
  containerUp: boolean
  databaseId: string
  relayAvailable: boolean
  relayId: string
}) {
  const [uiStore] = React.useState(createConsoleUiStore)
  const [streamStore] = React.useState(createConsoleStreamStore)

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-card">
      <DatabaseLogsStreamController
        containerUp={containerUp}
        databaseId={databaseId}
        relayAvailable={relayAvailable}
        relayId={relayId}
        streamStore={streamStore}
      />
      <DatabaseLogsToolbar streamStore={streamStore} uiStore={uiStore} />
      <ConsoleLogViewportController
        active
        streamStore={streamStore}
        uiStore={uiStore}
      />
    </section>
  )
}

const DatabaseLogsToolbar = React.memo(function DatabaseLogsToolbar({
  streamStore,
  uiStore,
}: {
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  return (
    <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
      <ConsoleSearchControl uiStore={uiStore} />
      <ConsoleLevelMenu uiStore={uiStore} />
      <ConsoleRetryButton streamStore={streamStore} />
      <div className="ml-auto flex items-center gap-1.5">
        <ConsoleSelectionControl active uiStore={uiStore} />
        <ConsoleRedactButton uiStore={uiStore} />
        <ConsoleWrapButton uiStore={uiStore} />
        <ConsoleTimestampButton uiStore={uiStore} />
      </div>
    </div>
  )
})

const DatabaseLogsStreamController = React.memo(
  function DatabaseLogsStreamController({
    containerUp,
    databaseId,
    relayAvailable,
    relayId,
    streamStore,
  }: {
    containerUp: boolean
    databaseId: string
    relayAvailable: boolean
    relayId: string
    streamStore: ConsoleStreamStore
  }) {
    const retryVersion = React.useSyncExternalStore(
      streamStore.subscribeRetry,
      streamStore.getRetrySnapshot,
      streamStore.getRetrySnapshot
    )
    const containerUpRef = React.useRef(containerUp)
    React.useLayoutEffect(() => {
      containerUpRef.current = containerUp
    }, [containerUp])

    // Follows again whenever the container starts or stops, so the page
    // shows the output of the run it is on.
    React.useEffect(() => {
      if (!relayAvailable) {
        updateSnapshot(streamStore, {
          connection: "unavailable",
          error: relayUnavailableMessage,
          loading: false,
        })
        return
      }
      const abort = new AbortController()
      forkPromise(() =>
        followDatabaseLogs({
          databaseId,
          isContainerUp: () => containerUpRef.current,
          relayId,
          signal: abort.signal,
          streamStore,
        })
      )
      return () => abort.abort()
    }, [
      containerUp,
      databaseId,
      relayAvailable,
      relayId,
      retryVersion,
      streamStore,
    ])
    return null
  }
)

type StreamOutcome =
  | { kind: "stop" }
  // The container stopped; it may be restarting.
  | { kind: "ended" }
  | { attached: boolean; immediate: boolean; kind: "retry" }

// Streams the database's output into the store, and follows again with
// backoff when the stream drops or the container restarts underneath it.
async function followDatabaseLogs(input: {
  databaseId: string
  isContainerUp: () => boolean
  relayId: string
  signal: AbortSignal
  streamStore: ConsoleStreamStore
}) {
  const { signal, streamStore } = input
  let attempt = 0
  while (!signal.aborted) {
    const hasLines = streamStore.getSnapshot().consoleData !== null
    updateSnapshot(streamStore, {
      connection: attempt === 0 || !hasLines ? "opening" : "reconnecting",
      error: null,
      loading: !hasLines,
    })
    const outcome = await recoverPromise(
      () => streamOnce(input),
      (): StreamOutcome => ({
        attached: false,
        immediate: false,
        kind: "retry",
      })
    )
    if (signal.aborted || outcome.kind === "stop") return
    if (outcome.kind === "ended" && !input.isContainerUp()) {
      updateSnapshot(streamStore, {
        connection: "unavailable",
        error: null,
        loading: false,
      })
      return
    }
    attempt = outcome.kind === "retry" && outcome.attached ? 1 : attempt + 1
    if (outcome.kind === "retry" && outcome.immediate) continue
    await wait(Math.min(250 * 2 ** attempt, RECONNECT_MAX_DELAY_MS), signal)
  }
}

async function streamOnce(input: {
  databaseId: string
  relayId: string
  signal: AbortSignal
  streamStore: ConsoleStreamStore
}): Promise<StreamOutcome> {
  const { databaseId, streamStore } = input
  const response = await fetch(
    databaseLogsStreamUrl({ databaseId, relayId: input.relayId }),
    { credentials: "same-origin", signal: input.signal }
  )
  if (response.status === 401 || response.status === 403) {
    updateSnapshot(streamStore, {
      connection: "unavailable",
      error:
        response.status === 401
          ? "Your sign-in expired. Reload the page to sign in again."
          : "You no longer have access to this database's logs.",
      loading: false,
    })
    return { kind: "stop" }
  }
  if (!response.ok || !response.body) {
    return { attached: false, immediate: false, kind: "retry" }
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let attached = false
  // The first lines after attaching are the container's recent output, which
  // replaces what the page showed from an earlier stream.
  let fresh = true
  const showEmpty = () => {
    if (!fresh) return
    fresh = false
    showLines(streamStore, databaseId, [], true)
  }
  let emptyTimer: ReturnType<typeof setTimeout> | null = null

  const handle = (record: DatabaseLogsStreamRecord): StreamOutcome | null => {
    switch (record.type) {
      case "attached":
        attached = true
        updateSnapshot(streamStore, { connection: "live", error: null })
        emptyTimer = setTimeout(showEmpty, EMPTY_AFTER_MS)
        return null
      case "lines":
        showLines(streamStore, databaseId, record.lines, fresh)
        fresh = false
        return null
      case "ended":
        showEmpty()
        if (record.ended === "failed") {
          updateSnapshot(streamStore, {
            connection: "unavailable",
            error: "Hearth couldn't follow this database's output.",
            loading: false,
          })
          return { kind: "stop" }
        }
        return { kind: "ended" }
      case "error":
        if (record.code === "unsupported" || record.code === "failed") {
          updateSnapshot(streamStore, {
            connection: "unavailable",
            error:
              record.code === "unsupported"
                ? "Update this Relay to view database logs."
                : "Hearth couldn't follow this database's output.",
            loading: false,
          })
          return { kind: "stop" }
        }
        return {
          attached,
          immediate: record.code === "detached",
          kind: "retry",
        }
      case "ping":
        return null
    }
  }

  return ensuringPromise(
    async (): Promise<StreamOutcome> => {
      let buffered = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return { attached, immediate: false, kind: "retry" }
        buffered += value
        let newline = buffered.indexOf("\n")
        while (newline !== -1) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          newline = buffered.indexOf("\n")
          if (!line) continue
          const outcome = handle(JSON.parse(line) as DatabaseLogsStreamRecord)
          if (outcome) return outcome
        }
      }
    },
    () => {
      if (emptyTimer) clearTimeout(emptyTimer)
      forkPromise(() => reader.cancel())
    }
  )
}

function showLines(
  streamStore: ConsoleStreamStore,
  databaseId: string,
  lines: Array<RelayConsoleLine>,
  replace: boolean
) {
  const current = streamStore.getSnapshot()
  const previous = replace ? [] : (current.consoleData?.lines ?? [])
  const joined = previous.length > 0 ? [...previous, ...lines] : lines
  // Docker sends stdout and stderr apart, so their lines can arrive out of
  // order. The sort is stable for lines sharing a timestamp.
  const combined = joined.some(
    (line, index) =>
      index > 0 &&
      lineTime(line).localeCompare(lineTime(joined[index - 1]!)) < 0
  )
    ? [...joined].sort((left, right) =>
        lineTime(left).localeCompare(lineTime(right))
      )
    : joined
  const next =
    combined.length > MAX_LINES ? combined.slice(-MAX_LINES) : combined
  streamStore.setSnapshot({
    ...current,
    consoleData: {
      instanceId: databaseId,
      lifecycle: [],
      lines: next,
      truncated: combined.length > MAX_LINES,
    },
    loading: false,
  })
}

function lineTime(line: RelayConsoleLine) {
  return line.timestamp ?? ""
}

function updateSnapshot(
  streamStore: ConsoleStreamStore,
  patch: Partial<ConsoleStreamSnapshot>
) {
  streamStore.setSnapshot({ ...streamStore.getSnapshot(), ...patch })
}

function wait(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
