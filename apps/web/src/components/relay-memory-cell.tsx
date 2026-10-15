import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Info } from "lucide-react"
import type { RelayProcessMemory } from "@workspace/contracts"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { relayMemoryReadingsQueryOptions } from "@/lib/query-options"

type RelayMemoryReading = RelayProcessMemory | null | undefined

/**
 * Live Relay memory for one Relays table row. Each cell selects its own Relay
 * from the shared poll, so a new sample re-renders only the memory cells.
 */
export const RelayMemoryCell = React.memo(function RelayMemoryCell({
  connected,
  relayId,
}: {
  connected: boolean
  relayId: string
}) {
  const select = React.useCallback(
    (
      readings: ReadonlyArray<{
        relayId: string
        relayMemory: RelayProcessMemory | null
      }>
    ): RelayMemoryReading =>
      readings.find((reading) => reading.relayId === relayId)?.relayMemory,
    [relayId]
  )
  const { data: memory } = useQuery({
    ...relayMemoryReadingsQueryOptions(),
    enabled: connected,
    notifyOnChangeProps: ["data"],
    select,
  })

  if (!connected || memory === undefined) {
    return <span className="type-meta text-muted-foreground">—</span>
  }
  if (memory === null) {
    return (
      <span
        className="type-meta block truncate text-muted-foreground"
        title="Update this Relay to see its memory use"
      >
        Not reported
      </span>
    )
  }
  return <RelayMemorySummary memory={memory} />
})

function RelayMemorySummary({ memory }: { memory: RelayProcessMemory }) {
  const { container, process } = memory
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex cursor-default items-center gap-1.5 rounded-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-label={`Relay process ${formatMemory(process.rssBytes)}${
            container ? `, container ${formatMemory(container.usedBytes)}` : ""
          }`}
        >
          <span className="type-meta text-foreground tabular-nums">
            {formatMemory(process.rssBytes)}
          </span>
          <Info
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <RelayMemoryDetails memory={memory} />
      </TooltipContent>
    </Tooltip>
  )
}

function RelayMemoryDetails({ memory }: { memory: RelayProcessMemory }) {
  const { container, process } = memory
  return (
    <div className="flex max-w-72 flex-col gap-2 py-0.5">
      <MemorySection title="Relay process">
        <MemoryRow label="Resident (RSS)" bytes={process.rssBytes} />
        <MemoryRow
          label="JS heap"
          bytes={process.heapUsedBytes}
          total={process.heapTotalBytes}
        />
        <MemoryRow label="Native buffers" bytes={process.externalBytes} />
      </MemorySection>
      {container ? (
        <MemorySection title="Container">
          <MemoryRow
            label="Charged"
            bytes={container.usedBytes}
            total={container.limitBytes}
          />
          <MemoryRow label="Anonymous" bytes={container.anonBytes} />
          <MemoryRow label="File cache" bytes={container.fileBytes} />
          {/* Some kernels (OrbStack's, for one) report no kernel usage. */}
          <MemoryRow label="Kernel" bytes={container.kernelBytes || null} />
          {container.inactiveFileBytes !== null ? (
            <MemoryRow
              label="Docker stats"
              bytes={Math.max(
                0,
                container.usedBytes - container.inactiveFileBytes
              )}
            />
          ) : null}
        </MemorySection>
      ) : null}
    </div>
  )
}

function MemorySection({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground">{title}</span>
      {children}
    </div>
  )
}

function MemoryRow({
  bytes,
  label,
  total,
}: {
  bytes: number | null
  label: string
  total?: number | null
}) {
  if (bytes === null) return null
  return (
    <span className="flex justify-between gap-4 text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono text-foreground">
        {formatMemory(bytes)}
        {total != null ? (
          <span className="text-muted-foreground">
            {" "}
            / {formatMemory(total)}
          </span>
        ) : null}
      </span>
    </span>
  )
}

function formatMemory(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KiB`
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}
