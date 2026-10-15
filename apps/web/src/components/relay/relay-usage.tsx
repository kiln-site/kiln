import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { InfoHint, InfoMeter, InfoTiles } from "@/components/info-page"
import { RelayMemoryDetails } from "@/components/relay-memory-cell"
import { formatBytes } from "@/lib/format-bytes"
import {
  relayNodeReadingsQueryOptions,
  type RelayNodeReading,
} from "@/lib/query-options"

// Live CPU, memory, and storage of the machine a Relay runs on, from the shared
// node poll. A new sample re-renders only these tiles.
export const RelayUsage = React.memo(function RelayUsage({
  connected,
  relayId,
}: {
  connected: boolean
  relayId: string
}) {
  const select = React.useCallback(
    (readings: ReadonlyArray<RelayNodeReading>) =>
      readings.find((reading) => reading.relayId === relayId) ?? null,
    [relayId]
  )
  const { data } = useQuery({
    ...relayNodeReadingsQueryOptions(),
    enabled: connected,
    notifyOnChangeProps: ["data"],
    select,
  })
  // A paused or unreachable Relay keeps its last poll in the cache; don't
  // present it as current.
  const reading = connected ? data : null

  return (
    <InfoTiles className="sm:grid-cols-2 lg:grid-cols-4">
      <InfoMeter
        label="CPU load"
        accessory={
          <InfoHint label="About CPU load" title="CPU load">
            <p>
              The machine’s average load over the last minute, relative to its
              cores. Above 100% means work is waiting for a free core.
            </p>
          </InfoHint>
        }
        value={reading ? `${Math.round(reading.cpu.loadPercent)}%` : "—"}
        detail={reading ? `of ${reading.cpu.cores} cores` : undefined}
        percent={reading ? reading.cpu.loadPercent : null}
      />
      <UsageMeter label="Memory" usage={reading?.memory} />
      <UsageMeter label="Storage" usage={reading?.storage} />
      <RelayProcessMeter reading={reading} />
    </InfoTiles>
  )
})

function UsageMeter({
  label,
  usage,
}: {
  label: string
  usage: { totalBytes: number; usedBytes: number } | undefined
}) {
  return (
    <InfoMeter
      label={label}
      value={usage ? formatBytes(usage.usedBytes) : "—"}
      detail={usage ? `of ${formatBytes(usage.totalBytes)}` : undefined}
      percent={usage ? percentOf(usage.usedBytes, usage.totalBytes) : null}
    />
  )
}

function RelayProcessMeter({
  reading,
}: {
  reading: RelayNodeReading | null | undefined
}) {
  const memory = reading?.relayMemory
  return (
    <InfoMeter
      label="Relay process"
      accessory={
        memory ? (
          <InfoHint label="About Relay memory" title="Relay memory">
            <RelayMemoryDetails memory={memory} />
          </InfoHint>
        ) : null
      }
      value={
        memory ? (
          formatBytes(memory.process.rssBytes)
        ) : memory === null ? (
          <span className="text-sm font-normal text-muted-foreground">
            Update the Relay to see this
          </span>
        ) : (
          "—"
        )
      }
      detail={memory ? "in use" : undefined}
      percent={
        memory && reading
          ? percentOf(memory.process.rssBytes, reading.memory.totalBytes)
          : null
      }
    />
  )
}

function percentOf(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0
}
