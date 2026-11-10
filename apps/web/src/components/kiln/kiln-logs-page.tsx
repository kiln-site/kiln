import * as React from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import type { RelayPlatformTarget } from "@workspace/contracts"

import { cn } from "@workspace/ui/lib/utils"

import { ResourceLogsSession } from "@/components/console/resource-logs"
import {
  kilnContainers,
  kilnCopy,
  useKilnHost,
  type KilnContainer,
} from "@/components/kiln/kiln-presentation"

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
  return (
    <ResourceLogsSession
      key={`${host.relayId}:${selected.target}`}
      header={header}
      id={host.relayId}
      kind="platform"
      logName={`kiln-${selected.target}`}
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
