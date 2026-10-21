import * as React from "react"

import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { WorkspaceFrame } from "@/components/workspace-frame"

import {
  createStatsStore,
  historyLines,
  type StatsStore,
} from "~/components/demos/console-stats"
import ConsoleView from "~/components/demos/console-view"
import { DemoHeader, type DemoView } from "~/components/demos/demo-header"
import { createDemoServer } from "~/components/demos/demo-server"

const FilesView = React.lazy(() => import("~/components/demos/files-view"))

// One of Hearth's pages for a game server, running in the page: the
// server's header and its Console or Files, for a simulated server. Each
// window runs its own.
export default function HearthDemo({ view }: { view: DemoView }) {
  const [server] = React.useState(() => createDemoServer(view))
  const state = React.useSyncExternalStore(
    server.subscribe,
    server.getState,
    server.getState
  )
  const [statsStore] = React.useState(createStatsStore)
  const windowRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const element = windowRef.current
    return element ? server.sampleWhileVisible(element) : undefined
  }, [server])

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex flex-col gap-3">
        <div
          ref={windowRef}
          className="@container/window flex h-[40rem] flex-col overflow-hidden border border-border bg-background pb-2 text-left shadow-2xl shadow-black/40 sm:h-[44rem]"
        >
          <WorkspaceFrame
            header={<DemoHeader server={server} state={state} view={view} />}
          >
            {view === "console" ? (
              <ConsoleView
                running={state.observedState === "running"}
                server={server}
                statsStore={statsStore}
              />
            ) : (
              <React.Suspense fallback={<div className="flex-1 bg-card" />}>
                <FilesView />
              </React.Suspense>
            )}
          </WorkspaceFrame>
        </div>
        {view === "console" ? <ConsoleStatus statsStore={statsStore} /> : null}
      </div>
    </TooltipProvider>
  )
}

// The demo's own numbers, under the window rather than in it.
function ConsoleStatus({ statsStore }: { statsStore: StatsStore }) {
  const stats = React.useSyncExternalStore(
    statsStore.subscribe,
    statsStore.get,
    statsStore.get
  )
  const ready = stats.lines >= historyLines && stats.loadedIn !== null
  return (
    <p
      aria-live="polite"
      className="type-meta flex min-h-4 flex-wrap gap-x-4 gap-y-1 font-mono text-muted-foreground tabular-nums"
    >
      {!ready ? (
        <span>Writing {stats.lines.toLocaleString("en-US")} lines…</span>
      ) : (
        <>
          <span>
            <span className="text-foreground">
              {stats.lines.toLocaleString("en-US")}
            </span>{" "}
            lines, ready in {formatMs(stats.loadedIn ?? 0)}
          </span>
          {stats.searchedIn !== null ? (
            <span>
              {stats.matches.toLocaleString("en-US")} matches in{" "}
              <span className="text-primary">{formatMs(stats.searchedIn)}</span>
            </span>
          ) : null}
        </>
      )}
    </p>
  )
}

function formatMs(ms: number) {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`
}
