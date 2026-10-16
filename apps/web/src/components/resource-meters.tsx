import * as React from "react"
import type { RelayInstanceResources } from "@workspace/contracts"

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@workspace/ui/components/hover-card"

import {
  RESOURCE_HISTORY_WINDOW_MS,
  type ResourceHistoryStore,
} from "@/lib/resource-history-store"

// Usage cards for a workspace header: a server's, or a Relay's own.

const ResourceHistoryChart = React.lazy(async () => {
  const module = await import("@/components/resource-history-chart")
  return { default: module.ResourceHistoryChart }
})
const localTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
})
const RESOURCE_VISUAL_FLOOR_PERCENT = 6

function hasKnownStorageUsage(
  storage: RelayInstanceResources["storage"] | undefined
): storage is RelayInstanceResources["storage"] & {
  percent: number
  usedBytes: number
} {
  return (
    storage !== undefined &&
    storage.totalBytes > 0 &&
    storage.usedBytes !== null &&
    storage.percent !== null
  )
}

function clampResourcePercent(value: number | null | undefined): number {
  return value === null || value === undefined
    ? 0
    : Math.max(RESOURCE_VISUAL_FLOOR_PERCENT, Math.min(value, 100))
}

const RESOURCE_STYLES = {
  cpu: {
    indicator: "bg-sky-400/85",
    value: "text-sky-300/95",
    chart: "oklch(0.74 0.13 235)",
  },
  memory: {
    indicator: "bg-violet-400/85",
    value: "text-violet-300/95",
    chart: "oklch(0.7 0.15 292)",
  },
  storage: {
    indicator: "bg-emerald-400/80",
    value: "text-emerald-300/95",
    chart: "oklch(0.72 0.13 160)",
  },
  network: {
    indicator: "bg-cyan-300/85",
    value: "text-cyan-200/95",
    chart: "oklch(0.78 0.11 205)",
  },
} as const

export type ResourceId = keyof typeof RESOURCE_STYLES

// One usage card: its label, value, and bar, with its recent history on
// hover.
export function ResourceMeter({
  historyStore,
  resource,
}: {
  historyStore: ResourceHistoryStore
  resource: ResourceItem
}) {
  return (
    <ResourceHistoryPopover resource={resource} historyStore={historyStore}>
      <button
        type="button"
        className={`group min-w-0 text-left outline-none first:pl-1.5 focus-visible:bg-muted/25 ${resource.id === "network" ? "px-1.5" : "px-2.5"}`}
      >
        <div className="type-meta flex items-center justify-between gap-1.5 font-mono tracking-[0.065em]">
          <span className="shrink-0 font-medium text-muted-foreground transition-colors group-hover:text-foreground">
            {resource.label}
          </span>
          {resource.id === "network" ? (
            <NetworkTransferValue
              historyStore={historyStore}
              received={resource.receivedDisplayValue ?? "—"}
              sent={resource.sentDisplayValue ?? "—"}
            />
          ) : (
            <span
              className={`truncate font-medium tabular-nums ${resource.valueClassName}`}
            >
              {resource.displayValue}
            </span>
          )}
        </div>
        <ResourceBar resource={resource} className="mt-2" />
      </button>
    </ResourceHistoryPopover>
  )
}

// Time since `startedAt` while running, with the start time on hover.
export function UptimeMeter({
  label,
  running,
  startedAt,
}: {
  // For example "Server uptime".
  label: string
  running: boolean
  startedAt: string | null
}) {
  const uptime = useUptime(startedAt, running)
  const startedAtLabel = useBrowserLocalTimestamp(startedAt)

  return (
    <HoverCard openDelay={160} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div
          className="type-meta min-w-0 px-1.5 font-mono outline-none focus-visible:bg-muted/25 xl:px-2"
          aria-label={`${label} ${uptime ?? "unavailable"}`}
          tabIndex={startedAtLabel ? 0 : undefined}
        >
          <span className="block font-medium tracking-[0.065em] text-muted-foreground">
            UPTIME
          </span>
          <div className="mt-2.5 flex h-2 items-center justify-center">
            <span className="type-code font-medium tracking-[-0.045em] whitespace-nowrap text-foreground tabular-nums">
              {uptime ?? "—"}
            </span>
          </div>
        </div>
      </HoverCardTrigger>
      {startedAtLabel ? (
        <HoverCardContent
          align="end"
          side="bottom"
          sideOffset={8}
          collisionPadding={12}
          className="w-max max-w-[calc(100vw-1.5rem)] rounded-none border-border/90 bg-popover px-3 py-2 shadow-xl"
        >
          <div className="text-left">
            <p className="type-technical-label text-muted-foreground">
              Started on
            </p>
            <time
              dateTime={startedAt ?? undefined}
              className="type-code mt-1 block whitespace-nowrap text-foreground"
            >
              {startedAtLabel}
            </time>
          </div>
        </HoverCardContent>
      ) : null}
    </HoverCard>
  )
}

function NetworkTransferValue({
  historyStore,
  received,
  sent,
}: {
  historyStore: ResourceHistoryStore
  received: string
  sent: string
}) {
  const sampleSequence = React.useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getLatestSampleSequence,
    () => 0
  )
  const isReceived = sampleSequence % 2 === 0
  return (
    <span
      className={`min-w-0 truncate font-medium tracking-[-0.045em] tabular-nums ${isReceived ? "text-cyan-200/95" : "text-primary/90"}`}
      aria-label={`Download ${received}, upload ${sent}`}
    >
      {isReceived ? "↓" : "↑"} {isReceived ? received : sent}
    </span>
  )
}

export interface ResourceItem {
  id: "cpu" | "memory" | "storage" | "network"
  label: string
  // Names the measured share in the storage history, beside the node.
  historyLabel?: string
  value: number | null
  barValue: number | null
  chartMax?: number
  displayValue: string
  historyDisplayValue?: string
  historySecondaryDisplayValue?: string
  receivedDisplayValue?: string
  sentDisplayValue?: string
  receivedValue?: number | null
  sentValue?: number | null
  detail: string
  historyDetail?: string
  indicatorClassName: string
  valueClassName: string
  chartColor: string
}

export function useUptime(
  startedAt: string | null,
  running: boolean
): string | null {
  const [now, setNow] = React.useState<number | null>(null)
  const startedAtMs = Date.parse(startedAt ?? "")

  React.useEffect(() => {
    setNow(Date.now())
    if (!running || !Number.isFinite(startedAtMs)) return

    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [running, startedAtMs])

  if (!running || !Number.isFinite(startedAtMs) || now === null) return null
  return formatUptime(Math.max(0, Math.floor((now - startedAtMs) / 1_000)))
}

function useBrowserLocalTimestamp(value: string | null): string | null {
  return React.useSyncExternalStore(
    subscribeToBrowserLocale,
    () => formatBrowserLocalTimestamp(value),
    () => null
  )
}

function subscribeToBrowserLocale(): () => void {
  // Locale has no browser change event; this store only defers formatting until hydration.
  return () => undefined
}

function formatBrowserLocalTimestamp(value: string | null): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? localTimestampFormatter.format(new Date(timestamp))
    : null
}

// `unavailable` stands in for values while there is no sample. A server's
// storage is measured against its quota; Kiln's, everything in the Relay's
// data directory, against the node's disk.
export function resourceItem(
  resources: RelayInstanceResources | null | undefined,
  id: ResourceId,
  {
    storageScope = "server",
    unavailable,
  }: { storageScope?: "server" | "kiln"; unavailable: string }
): ResourceItem {
  if (id === "cpu") {
    return {
      id: "cpu",
      label: "CPU",
      value: resources?.cpu.percent ?? null,
      barValue: resources
        ? (resources.cpu.percent / resources.cpu.capacityPercent) * 100
        : null,
      chartMax: resources?.cpu.capacityPercent,
      displayValue: formatPercent(resources?.cpu.percent),
      detail: resources
        ? `${formatPercent(resources.cpu.percent)} of ${formatPercent(resources.cpu.capacityPercent)} · ${resources.cpu.capacityPercent / 100} threads`
        : unavailable,
      indicatorClassName: RESOURCE_STYLES.cpu.indicator,
      valueClassName: RESOURCE_STYLES.cpu.value,
      chartColor: RESOURCE_STYLES.cpu.chart,
    }
  }
  if (id === "memory") {
    return {
      id: "memory",
      label: "RAM",
      value: resources?.memory.percent ?? null,
      barValue: resources?.memory.percent ?? null,
      displayValue: formatPercent(resources?.memory.percent),
      historyDisplayValue: resources
        ? formatResourceBytePair(
            resources.memory.usedBytes,
            resources.memory.totalBytes
          )
        : "—",
      detail: resources
        ? `${formatBytes(resources.memory.usedBytes)} of ${formatBytes(resources.memory.totalBytes)}`
        : unavailable,
      indicatorClassName: RESOURCE_STYLES.memory.indicator,
      valueClassName: RESOURCE_STYLES.memory.value,
      chartColor: RESOURCE_STYLES.memory.chart,
    }
  }
  if (id === "storage" && storageScope === "kiln") {
    const storage = resources?.storage
    const usageKnown = hasKnownStorageUsage(storage)
    return {
      id: "storage",
      label: "DISK",
      historyLabel: "Kiln",
      value: usageKnown ? storage.percent : null,
      barValue: usageKnown ? storage.percent : null,
      displayValue: usageKnown ? formatBytes(storage.usedBytes) : "—",
      historyDisplayValue: usageKnown
        ? formatResourceBytePair(storage.usedBytes, storage.totalBytes)
        : storage
          ? "Scanning"
          : "—",
      historySecondaryDisplayValue: storage
        ? formatResourceBytePair(storage.nodeUsedBytes, storage.nodeTotalBytes)
        : "—",
      detail: usageKnown
        ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)} disk`
        : storage
          ? "Scanning Kiln's data"
          : unavailable,
      historyDetail: storage
        ? `Node ${formatBytes(storage.nodeUsedBytes)} of ${formatBytes(storage.nodeTotalBytes)}`
        : unavailable,
      indicatorClassName: RESOURCE_STYLES.storage.indicator,
      valueClassName: RESOURCE_STYLES.storage.value,
      chartColor: RESOURCE_STYLES.storage.chart,
    }
  }
  if (id === "storage") {
    const storage = resources?.storage
    const usageKnown = hasKnownStorageUsage(storage)
    return {
      id: "storage",
      label: "DISK",
      value: usageKnown ? storage.percent : null,
      barValue: usageKnown ? storage.percent : null,
      displayValue: usageKnown ? formatPercent(storage.percent) : "—",
      historyDisplayValue: usageKnown
        ? formatResourceBytePair(storage.usedBytes, storage.totalBytes)
        : storage
          ? "Scanning"
          : "—",
      historySecondaryDisplayValue: storage
        ? formatResourceBytePair(storage.nodeUsedBytes, storage.nodeTotalBytes)
        : "—",
      detail: usageKnown
        ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)} quota`
        : storage
          ? `Scanning folder usage · ${formatBytes(storage.totalBytes)} quota`
          : unavailable,
      historyDetail: storage
        ? `Node ${formatBytes(storage.nodeUsedBytes)} of ${formatBytes(storage.nodeTotalBytes)}`
        : unavailable,
      indicatorClassName: RESOURCE_STYLES.storage.indicator,
      valueClassName: RESOURCE_STYLES.storage.value,
      chartColor: RESOURCE_STYLES.storage.chart,
    }
  }
  return {
    id: "network",
    label: "NET",
    value: resources?.network
      ? networkActivityPercent(
          resources.network.receivedBytesPerSecond +
            resources.network.sentBytesPerSecond
        )
      : null,
    barValue: resources?.network
      ? networkActivityPercent(
          resources.network.receivedBytesPerSecond +
            resources.network.sentBytesPerSecond
        )
      : null,
    displayValue: resources?.network
      ? `${formatBytesPerSecond(
          resources.network.receivedBytesPerSecond +
            resources.network.sentBytesPerSecond
        )}`
      : "—",
    receivedDisplayValue: resources?.network
      ? formatCompactBytesPerSecond(resources.network.receivedBytesPerSecond)
      : "—",
    sentDisplayValue: resources?.network
      ? formatCompactBytesPerSecond(resources.network.sentBytesPerSecond)
      : "—",
    receivedValue: resources?.network
      ? networkActivityPercent(resources.network.receivedBytesPerSecond)
      : null,
    sentValue: resources?.network
      ? networkActivityPercent(resources.network.sentBytesPerSecond)
      : null,
    detail: resources?.network
      ? `↓ ${formatBytesPerSecond(resources.network.receivedBytesPerSecond)} · ↑ ${formatBytesPerSecond(resources.network.sentBytesPerSecond)} · ${formatBytes(resources.network.receivedBytes + resources.network.sentBytes)} total`
      : unavailable,
    historyDetail: resources?.network
      ? `${formatBytes(resources.network.receivedBytes + resources.network.sentBytes)} transferred`
      : unavailable,
    indicatorClassName: RESOURCE_STYLES.network.indicator,
    valueClassName: RESOURCE_STYLES.network.value,
    chartColor: RESOURCE_STYLES.network.chart,
  }
}

function ResourceBar({
  resource,
  className = "",
}: {
  resource: ResourceItem
  className?: string
}) {
  return (
    <div
      className={`h-3 ${resource.id === "network" ? "grid grid-rows-2 gap-px" : "overflow-hidden bg-muted/55"} ${className}`}
      role="progressbar"
      aria-label={`${resource.label} usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={
        resource.barValue === null
          ? undefined
          : Math.min(resource.barValue, 100)
      }
      aria-valuetext={
        resource.id === "network" || resource.value === null
          ? resource.detail
          : resource.displayValue
      }
    >
      {resource.id === "network" ? (
        <>
          <div className="overflow-hidden bg-muted/55">
            <div
              className="h-full bg-cyan-300/85 transition-[width] duration-500 ease-out"
              style={{
                width: `${clampResourcePercent(resource.receivedValue)}%`,
              }}
            />
          </div>
          <div className="overflow-hidden bg-muted/55">
            <div
              className="h-full bg-primary/75 transition-[width] duration-500 ease-out"
              style={{ width: `${clampResourcePercent(resource.sentValue)}%` }}
            />
          </div>
        </>
      ) : (
        <div
          className={`h-full transition-[width] duration-500 ease-out ${resource.indicatorClassName}`}
          style={{ width: `${clampResourcePercent(resource.barValue)}%` }}
        />
      )}
    </div>
  )
}

function ResourceHistoryPopover({
  resource,
  historyStore,
  children,
}: {
  resource: ResourceItem
  historyStore: ResourceHistoryStore
  children: React.ReactElement
}) {
  return (
    <HoverCard openDelay={160} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="center"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(20rem,calc(100vw-1.5rem))] border-border/90 bg-popover p-0 shadow-2xl"
      >
        <ResourceHistoryCard resource={resource} historyStore={historyStore} />
      </HoverCardContent>
    </HoverCard>
  )
}

function ResourceHistoryCard({
  resource,
  historyStore,
}: {
  resource: ResourceItem
  historyStore: ResourceHistoryStore
}) {
  const history = React.useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getSnapshot,
    historyStore.getSnapshot
  )
  const visibleHistory = React.useMemo(() => {
    const domainStart = Date.now() - RESOURCE_HISTORY_WINDOW_MS
    return history.filter((sample) => sample.timestamp >= domainStart)
  }, [history])
  const values = visibleHistory
    .map((sample) => sample[resource.id])
    .filter((value): value is number => value !== null)
  const average = values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null
  const peak = values.length ? Math.max(...values) : null
  const latest = visibleHistory.at(-1)
  const chartData = React.useMemo(
    () =>
      visibleHistory.map((sample) => ({
        timestamp: sample.timestamp,
        value: sample[resource.id],
        secondary: sample.storageNode,
        received: sample.networkReceived,
        sent: sample.networkSent,
      })),
    [resource.id, visibleHistory]
  )

  return (
    <div className="overflow-hidden rounded-[inherit]">
      <ResourceHistoryHeader
        resource={resource}
        average={average}
        peak={peak}
        networkReceived={latest?.networkReceived ?? null}
        networkSent={latest?.networkSent ?? null}
      />

      <div className="px-1.5 pt-2.5">
        <React.Suspense
          fallback={
            <div className="type-technical-label grid h-32 place-items-center border-y border-border/40 text-muted-foreground">
              Loading history
            </div>
          }
        >
          <ResourceHistoryChart
            data={chartData}
            resourceId={resource.id}
            label={resource.label}
            color={resource.chartColor}
            maxValue={resource.chartMax}
            formatValue={(value) => formatHistoryValue(resource.id, value)}
            storageLabel={resource.historyLabel}
          />
        </React.Suspense>
      </div>
    </div>
  )
}

function ResourceHistoryHeader({
  resource,
  average,
  peak,
  networkReceived,
  networkSent,
}: {
  resource: ResourceItem
  average: number | null
  peak: number | null
  networkReceived: number | null
  networkSent: number | null
}) {
  if (resource.id === "network") {
    return (
      <div className="grid h-12 grid-cols-2 divide-x divide-border/55 border-b border-border/70 bg-muted/[0.08]">
        <NetworkHistoryValue direction="down" value={networkReceived} />
        <NetworkHistoryValue direction="up" value={networkSent} />
      </div>
    )
  }

  if (resource.id === "storage") {
    return (
      <div className="grid h-12 grid-cols-2 divide-x divide-border/55 border-b border-border/70 bg-muted/[0.08]">
        <DiskHistoryValue
          label={resource.historyLabel ?? "Server"}
          value={resource.historyDisplayValue ?? "—"}
          valueClassName={resource.valueClassName}
        />
        <DiskHistoryValue
          label="Node"
          value={resource.historySecondaryDisplayValue ?? "—"}
          valueClassName="text-foreground"
        />
      </div>
    )
  }

  return (
    <div className="grid h-12 grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] divide-x divide-border/55 border-b border-border/70 bg-muted/[0.08]">
      <HistoryStat
        align="left"
        label="Now"
        value={resource.historyDisplayValue ?? resource.displayValue}
        valueClassName={resource.valueClassName}
      />
      <HistoryStat
        label="Avg"
        value={
          average === null ? "—" : formatHistoryValue(resource.id, average)
        }
      />
      <HistoryStat
        label="Peak"
        value={peak === null ? "—" : formatHistoryValue(resource.id, peak)}
      />
    </div>
  )
}

function DiskHistoryValue({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName: string
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
      <span className="type-technical-label text-muted-foreground">
        {label}
      </span>
      <span
        className={`type-code truncate leading-none font-medium tracking-[-0.035em] tabular-nums ${valueClassName}`}
      >
        {value}
      </span>
    </div>
  )
}

function HistoryStat({
  align = "right",
  label,
  value,
  valueClassName = "text-foreground",
}: {
  align?: "left" | "right"
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div
      className={`flex min-w-0 flex-col justify-center gap-1 px-2 ${align === "left" ? "text-left" : "text-right"}`}
    >
      <span className="type-technical-label text-muted-foreground">
        {label}
      </span>
      <span
        className={`type-code truncate leading-none font-medium tracking-[-0.025em] tabular-nums ${valueClassName}`}
      >
        {value}
      </span>
    </div>
  )
}

function NetworkHistoryValue({
  direction,
  value,
}: {
  direction: "down" | "up"
  value: number | null
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
      <span className="type-technical-label text-muted-foreground">
        {direction === "down" ? "↓ In" : "↑ Out"}
      </span>
      <span
        className={`type-code truncate leading-none font-medium tracking-[-0.035em] tabular-nums ${direction === "down" ? "text-cyan-200" : "text-primary"}`}
      >
        {value === null ? "—" : formatBytesPerSecond(value)}
      </span>
    </div>
  )
}

function formatHistoryValue(
  resource: ResourceItem["id"],
  value: number
): string {
  return resource === "network"
    ? formatBytesPerSecond(value)
    : formatPercent(value)
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "—"
  if (value >= 100) return `${Math.round(value)}%`
  return `${value.toFixed(value < 10 ? 1 : 0)}%`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function resourceByteValue(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "0", unit: "B" }
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** exponent
  return {
    value: String(Number(value.toPrecision(3))),
    unit: units[exponent] ?? "B",
  }
}

function formatResourceBytePair(usedBytes: number, totalBytes: number): string {
  const used = resourceByteValue(usedBytes)
  const total = resourceByteValue(totalBytes)
  return used.unit === total.unit
    ? `${used.value} / ${total.value} ${total.unit}`
    : `${used.value} ${used.unit} / ${total.value} ${total.unit}`
}

function formatBytesPerSecond(bytes: number): string {
  return `${formatBytes(bytes)}/s`
}

function formatCompactBytesPerSecond(bytes: number): string {
  return formatBytesPerSecond(bytes).replace(" ", "")
}

function formatUptime(totalSeconds: number): string {
  const totalMinutes = Math.floor(totalSeconds / 60)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function networkActivityPercent(bytesPerSecond: number): number {
  if (bytesPerSecond <= 0) return 0
  return Math.min(
    (Math.log10(bytesPerSecond + 1) / Math.log10(10 * 1024 * 1024 + 1)) * 100,
    100
  )
}
