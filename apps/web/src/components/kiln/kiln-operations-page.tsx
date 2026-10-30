import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Lock, Workflow } from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

import { operationsOverviewQueryOptions } from "@/lib/operations-queries"
import type {
  LaneView,
  OperationView,
  OperationsOverview,
} from "@/operations/overview.server"

// Hearth's operations for its operator: what's in the lanes now and what
// each waiting one waits on, durable operations running, and what ended
// last, with anything that failed or was cut off.
export function KilnOperationsPage() {
  const { data } = useQuery(operationsOverviewQueryOptions())
  const overview: OperationsOverview = data ?? {
    lanes: [],
    recent: [],
    running: [],
  }
  const waiting = overview.lanes.filter((item) => item.startedAt === null)
  const attention = overview.recent.filter(
    (item) => item.state === "failed" || item.state === "interrupted"
  )
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-5 px-3 py-3 sm:px-5 sm:py-5">
        <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/65 sm:grid-cols-4">
          <Count
            label="In the lanes"
            value={overview.lanes.length - waiting.length}
          />
          <Count label="Waiting" value={waiting.length} />
          <Count label="Durable running" value={overview.running.length} />
          <Count
            label="Failed or cut off"
            tone={attention.length > 0 ? "destructive" : undefined}
            value={attention.length}
          />
        </dl>
        <section>
          <h2 className="type-technical-label mb-2 text-muted-foreground">
            In the lanes
          </h2>
          {overview.lanes.length === 0 ? (
            <Empty text="Nothing holds or waits for a lane." />
          ) : (
            <ul className="divide-y divide-border/65 overflow-hidden rounded-lg border border-border/65">
              {overview.lanes.map((item) => (
                <LaneRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>
        <Section
          empty="No durable operation is running."
          items={overview.running}
          title="Durable, running"
        />
        <Section
          empty="No operation has ended yet."
          items={overview.recent}
          title="Ended recently"
        />
      </div>
    </div>
  )
}

function Count({
  label,
  tone,
  value,
}: {
  label: string
  tone?: "destructive"
  value: number
}) {
  return (
    <div className="border-l border-border/65 px-3 py-2.5 first:border-l-0">
      <dt className="type-technical-label text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 font-mono text-lg font-medium tabular-nums",
          tone === "destructive" && "text-destructive"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function Section({
  empty,
  items,
  title,
}: {
  empty: string
  items: ReadonlyArray<OperationView>
  title: string
}) {
  return (
    <section>
      <h2 className="type-technical-label mb-2 text-muted-foreground">
        {title}
      </h2>
      {items.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <ul className="divide-y divide-border/65 overflow-hidden rounded-lg border border-border/65">
          {items.map((item) => (
            <OperationRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-border/65 px-6 py-10 text-center">
      <Workflow className="mb-2 size-6 text-muted-foreground/45" />
      <p className="type-meta text-muted-foreground">{text}</p>
    </div>
  )
}

const LaneRow = React.memo(function LaneRow({ item }: { item: LaneView }) {
  const waiting = item.startedAt === null
  return (
    <li className="grid gap-1.5 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate font-mono text-xs font-medium text-foreground">
          {item.name}
        </span>
        <Badge
          variant={waiting ? "outline" : "secondary"}
          className="type-meta h-4 px-1.5"
        >
          {waiting ? "Waiting" : "Running"}
        </Badge>
        {item.durable ? (
          <Badge variant="outline" className="type-meta h-4 px-1 font-mono">
            durable
          </Badge>
        ) : null}
        <span className="type-meta text-muted-foreground">
          {item.actor ? item.actor.name : "Hearth"}
        </span>
      </div>
      <span className="type-meta font-mono text-muted-foreground tabular-nums sm:row-span-3 sm:self-start sm:text-right">
        {waiting ? "waiting " : "running "}
        <Since at={item.startedAt ?? item.admittedAt} />
      </span>
      <div className="flex min-w-0 flex-wrap gap-1">
        {item.locks.map((lock) => (
          <Badge
            key={lock.key}
            variant="outline"
            className="type-meta h-5 gap-1 px-1.5 font-mono"
            title={`${lock.mode} ${lock.key}`}
          >
            <Lock className="size-3" />
            {lock.key}
            {lock.mode === "shared" ? (
              <span className="text-muted-foreground">shared</span>
            ) : null}
          </Badge>
        ))}
      </div>
      {item.waitingOn.length > 0 ? (
        <p className="type-meta min-w-0 text-muted-foreground">
          {item.waitingOn.map((reason, index) => (
            <React.Fragment key={`${reason.name}:${reason.key}`}>
              {index > 0 ? "; " : null}
              {reason.holds ? "Behind " : "In line after "}
              <span className="font-mono text-foreground/90">
                {reason.name}
              </span>
              {" on "}
              <span className="font-mono">{reason.key}</span>
            </React.Fragment>
          ))}
        </p>
      ) : null}
    </li>
  )
})

const OperationRow = React.memo(function OperationRow({
  item,
}: {
  item: OperationView
}) {
  return (
    <li className="grid gap-1.5 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate font-mono text-xs font-medium text-foreground">
          {item.kind}
        </span>
        <StateBadge state={item.state} />
        <span className="type-meta text-muted-foreground">
          {item.actor ? item.actor.name : "Hearth"}
        </span>
      </div>
      <span className="type-meta font-mono text-muted-foreground tabular-nums sm:row-span-2 sm:self-start sm:text-right">
        <Timing item={item} />
      </span>
      {item.error ? (
        <p className="type-meta min-w-0 break-words text-destructive">
          {item.error}
        </p>
      ) : null}
    </li>
  )
})

const stateLabels: Record<OperationView["state"], string> = {
  cancelled: "Cancelled",
  failed: "Failed",
  interrupted: "Cut off",
  running: "Running",
  succeeded: "Done",
}

function StateBadge({ state }: { state: OperationView["state"] }) {
  return (
    <Badge
      variant={
        state === "failed" || state === "interrupted"
          ? "destructive"
          : state === "running"
            ? "secondary"
            : "outline"
      }
      className="type-meta h-4 px-1.5"
    >
      {stateLabels[state]}
    </Badge>
  )
}

// How long it has run so far, or how long it took once it ended.
function Timing({ item }: { item: OperationView }) {
  if (item.finishedAt !== null) {
    return (
      <>
        took {formatElapsed(item.finishedAt - item.createdAt)} ·{" "}
        <Ago at={item.finishedAt} />
      </>
    )
  }
  return (
    <>
      running <Since at={item.createdAt} />
    </>
  )
}

// Only these spans tick, not the rows around them. The server's clock and
// the browser's read differently, so their first text may too.
function Since({ at }: { at: number }) {
  const now = useNow()
  return <span suppressHydrationWarning>{formatElapsed(now - at)}</span>
}

function Ago({ at }: { at: number }) {
  const now = useNow()
  return <span suppressHydrationWarning>{formatElapsed(now - at)} ago</span>
}

function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
