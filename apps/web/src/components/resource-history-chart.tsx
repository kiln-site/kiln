import * as React from "react"

import { areaY, defineChart, lineY } from "@tanstack/charts"
import { crosshair } from "@tanstack/charts/crosshair"
import { decorative } from "@tanstack/charts/mark/decorative"
import { motion } from "@tanstack/charts/motion"
import { Chart } from "@tanstack/charts/react/core"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"

const NETWORK_SENT_COLOR = "oklch(0.73 0.15 65)"
const NETWORK_RECEIVED_COLOR = "oklch(0.78 0.11 205)"
const NODE_STORAGE_COLOR = "oklch(0.72 0.13 75)"
const RESOURCE_VISUAL_FLOOR_RATIO = 0.06
const CHART_HEIGHT = 128

const chartRenderer = motion({
  transition: { type: "tween", duration: 700, easing: "ease-out" },
})

const chartStyle = {
  "--ts-chart-tooltip-background": "var(--popover)",
  "--ts-chart-tooltip-color": "var(--popover-foreground)",
  "--ts-chart-tooltip-border": "1px solid var(--border)",
  "--ts-chart-tooltip-border-radius": "0.375rem",
  "--ts-chart-tooltip-shadow": "0 1px 2px rgb(0 0 0 / 0.2)",
  "--ts-chart-tooltip-padding": "0.25rem 0.5rem",
  "--ts-chart-tooltip-font": "0.6875rem/1.4 var(--font-mono)",
} as React.CSSProperties

type HistorySample = {
  timestamp: number
  value: number | null
  secondary: number | null
  received: number | null
  sent: number | null
}

type HistoryRow = {
  timestamp: number
  value: number
  secondary: number
  received: number
  sent: number
}

type SeriesKey = "value" | "secondary" | "received" | "sent"

type Series = {
  key: SeriesKey
  label: string
  color: string
}

function numericOrZero(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function formatAgo(timestamp: number, latest: number) {
  const seconds = Math.round((latest - timestamp) / 1000)
  if (seconds < 5) return "Now"
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `-${seconds}s`
  const remainder = seconds % 60
  return remainder === 0 ? `-${minutes}m` : `-${minutes}m ${remainder}s`
}

function formatTick(timestamp: number, first: number, latest: number) {
  if (timestamp >= latest) return "Now"
  const seconds = (latest - timestamp) / 1000
  return latest - first >= 120_000
    ? `-${Math.round(seconds / 60)}m`
    : `-${Math.round(seconds)}s`
}

export function ResourceHistoryChart({
  data,
  resourceId,
  label,
  color,
  maxValue,
  formatValue,
}: {
  data: Array<HistorySample>
  resourceId: "cpu" | "memory" | "storage" | "network"
  label: string
  color: string
  maxValue?: number
  formatValue: (value: number) => string
}) {
  const formatValueRef = React.useRef(formatValue)
  React.useLayoutEffect(() => {
    formatValueRef.current = formatValue
  })

  const rows = React.useMemo((): Array<HistoryRow> => {
    const firstKnownInstanceUsage =
      resourceId === "storage"
        ? data.findIndex((sample) => sample.value !== null)
        : 0
    const source =
      firstKnownInstanceUsage > 0 ? data.slice(firstKnownInstanceUsage) : data
    return source.map((sample) => ({
      timestamp: sample.timestamp,
      value: numericOrZero(sample.value),
      secondary: numericOrZero(sample.secondary),
      received: numericOrZero(sample.received),
      sent: numericOrZero(sample.sent),
    }))
  }, [data, resourceId])

  const hasPrimaryValues = React.useMemo(
    () =>
      resourceId !== "storage" || data.some((sample) => sample.value !== null),
    [data, resourceId]
  )

  const series = React.useMemo((): Array<Series> => {
    if (resourceId === "network") {
      return [
        { key: "received", label: "↓ In", color: NETWORK_RECEIVED_COLOR },
        { key: "sent", label: "↑ Out", color: NETWORK_SENT_COLOR },
      ]
    }
    if (resourceId === "storage") {
      const storage: Array<Series> = [
        { key: "secondary", label: "Node volume", color: NODE_STORAGE_COLOR },
      ]
      // Instance is painted last so it stays in front of node usage.
      if (hasPrimaryValues) {
        storage.push({ key: "value", label: "Instance quota", color })
      }
      return storage
    }
    return [{ key: "value", label, color }]
  }, [color, hasPrimaryValues, label, resourceId])

  const definition = React.useMemo(() => {
    const isNetwork = resourceId === "network"
    const peak = rows.reduce(
      (maximum, row) =>
        Math.max(maximum, isNetwork ? row.received + row.sent : row.value),
      isNetwork ? 1 : 0
    )
    const yMaximum = isNetwork
      ? peak * (1 + RESOURCE_VISUAL_FLOOR_RATIO / 2)
      : resourceId === "memory" || resourceId === "storage"
        ? 100
        : resourceId === "cpu" && maxValue
          ? maxValue
          : Math.max(10, Math.ceil(peak * 1.15))
    // Keep idle series visible as a sliver instead of vanishing into the axis.
    const floor = isNetwork
      ? peak * (RESOURCE_VISUAL_FLOOR_RATIO / 2)
      : yMaximum * RESOURCE_VISUAL_FLOOR_RATIO
    const first = rows[0]?.timestamp ?? 0
    const latest = rows.at(-1)?.timestamp ?? 0
    const seriesByLine = new Map(
      series.map((entry) => [`${entry.key}-line`, entry])
    )

    const marks = series.flatMap((entry) => {
      const y = (row: HistoryRow) => Math.max(row[entry.key], floor)
      const line = lineY(rows, {
        id: `${entry.key}-line`,
        x: "timestamp",
        y,
        z: () => entry.key,
        key: "timestamp",
        stroke: entry.color,
        strokeWidth: isNetwork ? 1.75 : 1.5,
      })
      if (isNetwork) return [line]
      return [
        decorative(
          areaY(rows, {
            id: `${entry.key}-area`,
            x: "timestamp",
            y1: 0,
            y2: y,
            key: "timestamp",
            fill: `url(#${entry.key}-fill)`,
            fillOpacity: 1,
          })
        ),
        line,
      ]
    })

    return defineChart({
      marks: [
        crosshair({
          y: false,
          x: { stroke: "currentColor", strokeOpacity: 0.35 },
        }),
        ...marks,
      ],
      scales: {
        x: {
          scale: () =>
            scaleLinear().domain([first, Math.max(latest, first + 1)]),
          axis: {
            line: false,
            ticks: {
              values: [first, (first + latest) / 2, latest],
              size: 0,
              format: (value) => formatTick(value, first, latest),
            },
            tickLabels: {
              thin: false,
              anchor: ({ index }) =>
                index === 0 ? "start" : index === 2 ? "end" : "middle",
            },
          },
        },
        y: {
          scale: () => scaleLinear().domain([0, yMaximum]),
          grid: { strokeDasharray: "2 4", strokeOpacity: 0.12 },
          axis: false,
        },
      },
      gradients: series.map((entry) => ({
        id: `${entry.key}-fill`,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 1,
        stops: [
          { offset: 0, color: entry.color, opacity: 0.42 },
          { offset: 1, color: entry.color, opacity: 0.02 },
        ],
      })),
      clip: true,
      margin: {
        top: isNetwork || resourceId === "storage" ? 18 : 7,
        right: 6,
        bottom: 22,
        left: 6,
      },
      motion: {
        path: {
          update: "rolling",
          x: "shift",
          y: "reproject",
          fallback: "snap",
        },
      },
      focus: "group-x",
      focusRing: false,
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        motion: false,
        content: (points) => ({
          title: formatAgo(points[0]?.datum.timestamp ?? latest, latest),
          rows: points.flatMap((point) => {
            const entry = seriesByLine.get(point.markId)
            if (!entry) return []
            return [
              {
                label: entry.label,
                value: formatValueRef.current(point.datum[entry.key]),
                color: entry.color,
              },
            ]
          }),
        }),
      },
    })
  }, [maxValue, resourceId, rows, series])

  return (
    <div className="relative text-muted-foreground">
      {resourceId === "network" || resourceId === "storage" ? (
        <div className="type-meta pointer-events-none absolute top-0 right-3 z-10 flex items-center gap-3 font-mono tracking-[0.07em] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-3"
              style={{
                backgroundColor:
                  resourceId === "network"
                    ? NETWORK_RECEIVED_COLOR
                    : NODE_STORAGE_COLOR,
              }}
            />
            {resourceId === "network" ? "↓ IN" : "NODE"}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-3"
              style={{
                backgroundColor:
                  resourceId === "network" ? NETWORK_SENT_COLOR : color,
              }}
            />
            {resourceId === "network" ? "↑ OUT" : "INSTANCE"}
          </span>
        </div>
      ) : null}

      <Chart
        definition={definition}
        renderer={chartRenderer}
        height={CHART_HEIGHT}
        initialWidth={308}
        ariaLabel={`${label} history`}
        className="font-mono text-[0.625rem]"
        style={chartStyle}
      />
    </div>
  )
}
