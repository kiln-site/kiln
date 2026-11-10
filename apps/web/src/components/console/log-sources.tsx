import * as React from "react"
import { LoaderCircle } from "lucide-react"

import { formatDuration } from "@/components/app/app-deployment-presentation"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import {
  SizedPanelHandle,
  type PanelSize,
} from "@/components/sized-panel-handle"
import { StatusDot, StatusIndicator } from "@/components/status-indicator"

// The parts of an instance's Logs page that every kind shares: a rail that
// lists what it has output from, its containers and each deployment the
// Relay kept a log of, and the bar above whichever one is shown.

/** `deployment` in a Logs page's `stream` asks for the latest deployment. */
export const DEPLOYMENT_STREAM = "deployment"

// Laid out like a database's table list, which is the same kind of panel.
const logRailSize: PanelSize = {
  defaultSize: 256,
  label: "Resize log sources",
  maxSize: (panel) => {
    const page = panel.parentElement?.getBoundingClientRect().width
    return page ? Math.min(440, Math.floor(page * 0.4)) : 440
  },
  // Wide enough for the Runtime and Deployments tabs at every type scale.
  minSize: () =>
    14 * parseFloat(getComputedStyle(document.documentElement).fontSize),
  storageKey: "kiln:app-log-sources-width",
  variable: "--app-log-sources-width",
}

/** The rail beside a log: its tabs, the sources under the one chosen. */
export function LogSourcesRail({
  children,
  footer,
  tabs,
}: {
  children: React.ReactNode
  footer?: React.ReactNode
  tabs: React.ReactNode
}) {
  const panelRef = React.useRef<HTMLElement>(null)
  return (
    <aside
      ref={panelRef}
      className="relative hidden w-[var(--app-log-sources-width,16rem)] min-w-56 shrink-0 flex-col bg-muted/[0.06] md:flex"
    >
      <div className="flex h-12 shrink-0 border-b">{tabs}</div>
      <nav
        aria-label="Log source"
        className="min-h-0 flex-1 overflow-y-auto py-1.5"
      >
        {children}
      </nav>
      {footer ? (
        <div className="flex min-h-10 shrink-0 items-center border-t">
          {footer}
        </div>
      ) : null}
      {/* Same edge as the file tree: a hairline the resize handle overlaps. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-30 w-px bg-border/80"
      />
      <SizedPanelHandle panelRef={panelRef} size={logRailSize} />
    </aside>
  )
}

// The look of the rail's tabs, its rows and its footer link. Each page
// links to its own route, so it brings the link and takes the look.
export const logRailTabClassName =
  "relative flex flex-1 basis-auto items-center justify-center gap-1.5 px-3 text-xs whitespace-nowrap font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:bg-accent/55 aria-disabled:pointer-events-none aria-disabled:opacity-40 [&_svg]:size-3.5"
export const logRailTabActiveClassName =
  "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"
export const logRailRowClassName =
  "flex w-full gap-2 px-3 py-1.5 text-left text-xs text-foreground/85 outline-none hover:bg-accent/45 focus-visible:bg-accent/55 aria-[current]:bg-primary/12 aria-[current]:font-medium aria-[current]:text-primary-ink"
export const logRailFooterLinkClassName =
  "flex h-10 flex-1 items-center gap-2 px-3 text-xs text-muted-foreground transition-colors outline-none hover:bg-accent/45 hover:text-foreground focus-visible:bg-accent/55 [&_svg]:size-3.5"

/** Every source the rail lists, whatever it is, in the same two lines. */
export function LogRailRowContent({
  children,
  live = false,
  status,
  title,
}: {
  children: React.ReactNode
  live?: boolean
  status: IdentityStatusPresentation
  title: string
}) {
  return (
    <>
      <span className="grid h-[1.125rem] w-3.5 shrink-0 place-items-center">
        <StatusDot status={status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 leading-[1.125rem]">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {live ? (
            <span className="type-label shrink-0 border border-emerald-400/40 px-1 text-[0.625rem] leading-3.5 text-emerald-300 light:text-emerald-700">
              Live
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 overflow-hidden text-[0.6875rem] leading-4 font-normal whitespace-nowrap text-muted-foreground">
          {children}
        </span>
      </span>
    </>
  )
}

/** The bar above any log: what it is on the left, the rest on the right. */
export function LogHeader({
  children,
  status,
  title,
}: {
  children?: React.ReactNode
  status?: IdentityStatusPresentation
  title: string
}) {
  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 sm:px-4 md:flex-nowrap md:py-0">
      {status ? <StatusIndicator status={status} /> : null}
      <span className="type-control-sm min-w-0 flex-1 basis-48 truncate">
        {title}
      </span>
      {children ? (
        <span className="type-meta flex shrink-0 items-center gap-2 text-muted-foreground">
          {children}
        </span>
      ) : null}
    </div>
  )
}

/** A row's second line and the header's right side, separated the same way. */
export function LogMeta({ children }: { children: React.ReactNode }) {
  return React.Children.toArray(children).flatMap((item, index) =>
    index === 0
      ? [item]
      : [
          <span key={`separator-${index}`} aria-hidden>
            ·
          </span>,
          item,
        ]
  )
}

/** In place of a log there is none of: still loading, or why not. */
export function LogMessage({
  header,
  loading = false,
  message,
}: {
  header: React.ReactNode
  loading?: boolean
  message?: string
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-card">
      {header}
      <div className="grid min-h-0 flex-1 place-items-center bg-background p-6 text-center">
        {loading ? (
          <LoaderCircle className="size-4 animate-spin text-primary-ink" />
        ) : (
          <p className="text-sm text-muted-foreground">{message}</p>
        )}
      </div>
    </section>
  )
}

/** Ticks by itself, so a running deployment re-renders nothing else. */
export function RunningFor({ startedAt }: { startedAt: string }) {
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span className="tabular-nums">
      Running for {formatDuration(now - Date.parse(startedAt))}
    </span>
  )
}
