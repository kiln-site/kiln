import * as React from "react"

import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { WorkspaceFrame } from "@/components/workspace-frame"

import {
  createStatsStore,
  historyLines,
  type StatsStore,
} from "~/components/demos/console-stats"
import ConsoleView from "~/components/demos/console-view"
import { DemoHeader } from "~/components/demos/demo-header"
import { createDemoServer } from "~/components/demos/demo-server"
import { DemoSidebar, type DemoView } from "~/components/demos/demo-sidebar"

const FilesView = React.lazy(() => import("~/components/demos/files-view"))

// Hearth as it looks with a game server open, running in the page: the
// sidebar, the server's header, and its Console or Files page, for a
// simulated server.
export default function HearthDemo({ className }: { className?: string }) {
  const [server] = React.useState(createDemoServer)
  const state = React.useSyncExternalStore(
    server.subscribe,
    server.getState,
    server.getState
  )
  const [view, setView] = React.useState<DemoView>("console")
  // Pages stay mounted once opened, so switching back keeps their state.
  const [opened, setOpened] = React.useState(
    () => new Set<DemoView>(["console"])
  )
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false)
  const [sidebarOverlay, setSidebarOverlay] = React.useState(false)
  const [statsStore] = React.useState(createStatsStore)
  const windowRef = React.useRef<HTMLDivElement>(null)
  const running = state.observedState === "running"

  React.useEffect(() => {
    const element = windowRef.current
    return element ? server.sampleWhileVisible(element) : undefined
  }, [server])

  const changeView = React.useCallback((next: DemoView) => {
    setView(next)
    setOpened((current) =>
      current.has(next) ? current : new Set([...current, next])
    )
    setSidebarOverlay(false)
  }, [])

  // Hearth's sidebar collapses to icons on a wide screen and slides over the
  // page on a narrow one. The window's width shows or hides the docked one.
  const toggleSidebar = React.useCallback(() => {
    const docked = windowRef.current?.querySelector(":scope > nav")
    if (docked && getComputedStyle(docked).display !== "none") {
      setSidebarCollapsed((collapsed) => !collapsed)
    } else {
      setSidebarOverlay((open) => !open)
    }
  }, [])

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex flex-col gap-3">
        {/* Tall enough for all of Hearth's sidebar, so it never scrolls. */}
        <div
          ref={windowRef}
          className={cn(
            "@container/window relative flex h-[51rem] overflow-hidden border border-border bg-background text-left shadow-2xl shadow-black/40",
            className
          )}
        >
          <DemoSidebar
            className="hidden @4xl/window:flex"
            collapsed={sidebarCollapsed}
            running={running}
            view={view}
            onViewChange={changeView}
          />
          {sidebarOverlay ? (
            <div className="absolute inset-0 z-40 flex @4xl/window:hidden">
              <DemoSidebar
                className="relative shadow-2xl shadow-black/60"
                collapsed={false}
                running={running}
                view={view}
                onViewChange={changeView}
              />
              <button
                type="button"
                aria-label="Close sidebar"
                className="flex-1 bg-black/50"
                onClick={() => setSidebarOverlay(false)}
              />
            </div>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <WorkspaceFrame
              header={
                <DemoHeader
                  server={server}
                  state={state}
                  view={view}
                  onToggleSidebar={toggleSidebar}
                />
              }
            >
              {opened.has("console") ? (
                <Page shown={view === "console"}>
                  <ConsoleView
                    active={view === "console"}
                    running={running}
                    server={server}
                    statsStore={statsStore}
                  />
                </Page>
              ) : null}
              {opened.has("files") ? (
                <Page shown={view === "files"}>
                  <React.Suspense fallback={<div className="flex-1 bg-card" />}>
                    <FilesView />
                  </React.Suspense>
                </Page>
              ) : null}
            </WorkspaceFrame>
            <PanelFooter />
          </div>
        </div>
        {opened.has("console") ? (
          <ConsoleStatus statsStore={statsStore} />
        ) : null}
      </div>
    </TooltipProvider>
  )
}

function Page({
  children,
  shown,
}: {
  children: React.ReactNode
  shown: boolean
}) {
  return (
    <div className={shown ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
      {children}
    </div>
  )
}

// Hearth's footer, without the links that only make sense in the panel.
function PanelFooter() {
  return (
    <footer className="type-meta grid h-2 shrink-0 bg-background text-center tracking-wide text-muted-foreground @3xl/window:h-14 @3xl/window:grid-rows-2">
      <p className="hidden items-center justify-center gap-1.5 self-end pb-0.5 @3xl/window:flex">
        Kiln · Hearth Panel
        <span className="font-mono text-primary/80">0.1.0</span>
      </p>
      <p className="hidden items-center justify-center gap-x-2 self-start pt-0.5 @3xl/window:flex">
        QuartzDev © 2026
        <span className="text-border" aria-hidden="true">
          /
        </span>
        Terms of Use
        <span>Privacy Policy</span>
      </p>
    </footer>
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
