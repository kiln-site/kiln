import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { LoaderCircle, RotateCw } from "lucide-react"
import type { RelayPlatformTarget } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { ResourceLogsSession } from "@/components/console/resource-logs"
import {
  kilnContainers,
  kilnCopy,
  useKilnHost,
  type KilnContainer,
} from "@/components/kiln/kiln-presentation"
import { messageFrom } from "@/components/relay/relay-actions"
import { kilnPlatformLogsQueryOptions } from "@/lib/query-options"

// Each of Kiln's containers' output, followed live like an app's.
export function KilnLogsPage() {
  const host = useKilnHost()
  const navigate = useNavigate()
  const requested = useSearch({
    from: "/_app/kiln/logs",
    select: (search) => search.service,
  })
  const containers = React.useMemo(
    () =>
      host?.status
        ? kilnContainers(host.status).filter(
            (container) => container.container !== null
          )
        : [],
    [host?.status]
  )
  const selected =
    containers.find((container) => container.target === requested) ??
    containers[0]
  const select = React.useCallback(
    (next: RelayPlatformTarget) =>
      void navigate({
        replace: true,
        search: { service: next },
        to: "/kiln/logs",
      }),
    [navigate]
  )
  if (!host || !selected) {
    return (
      <p className="grid min-h-0 flex-1 place-items-center bg-card text-xs text-muted-foreground">
        No containers to read yet.
      </p>
    )
  }
  const header = (
    <KilnLogSources
      containers={containers}
      selected={selected.target}
      onSelect={select}
    />
  )
  // Older Relays only read a container's latest lines.
  if (!host.v2) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-card">
        {header}
        <KilnLatestLogs relayId={host.relayId} target={selected.target} />
      </div>
    )
  }
  return (
    <ResourceLogsSession
      key={`${host.relayId}:${selected.target}`}
      header={header}
      id={host.relayId}
      kind="platform"
      relayAvailable={host.status !== null}
      relayId={host.relayId}
      stream={selected.target}
    />
  )
}

function KilnLogSources({
  containers,
  onSelect,
  selected,
}: {
  containers: ReadonlyArray<KilnContainer>
  onSelect: (target: RelayPlatformTarget) => void
  selected: RelayPlatformTarget
}) {
  return (
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      <div
        role="tablist"
        aria-label="Log source"
        className="flex rounded-lg border bg-background/60 p-0.5"
      >
        {containers.map((container) => (
          <button
            key={container.target}
            role="tab"
            aria-selected={container.target === selected}
            type="button"
            className={cn(
              "type-control-sm rounded-md px-2.5 py-1 transition-colors",
              container.target === selected
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => onSelect(container.target)}
          >
            {kilnCopy[container.target].title}
          </button>
        ))}
      </div>
    </div>
  )
}

function KilnLatestLogs({
  relayId,
  target,
}: {
  relayId: string
  target: RelayPlatformTarget
}) {
  const logs = useQuery(kilnPlatformLogsQueryOptions(relayId, target))
  const end = React.useRef<HTMLDivElement>(null)
  const lines = logs.data?.lines
  React.useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [lines])
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <span>Its last 500 lines. Update this Relay to follow them live.</span>
        <Button
          disabled={logs.isFetching}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void logs.refetch()}
        >
          {logs.isFetching ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RotateCw />
          )}
          Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {logs.isPending ? (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        ) : logs.error ? (
          <p role="alert" className="type-meta text-destructive">
            {messageFrom(logs.error, "Couldn't read its logs.")}
          </p>
        ) : lines && lines.length > 0 ? (
          <pre className="font-mono text-[11px] leading-5 break-all whitespace-pre-wrap text-foreground/85">
            {lines.join("\n")}
          </pre>
        ) : (
          <p className="type-meta text-muted-foreground">No output yet.</p>
        )}
        <div ref={end} />
      </div>
    </>
  )
}
