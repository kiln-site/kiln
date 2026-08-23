import * as React from "react"

import { Area, Line } from "@/components/dither-kit/area"
import { AreaChart, LineChart } from "@/components/dither-kit/area-chart"
import { useChartPart } from "@/components/dither-kit/chart-context"
import type { ChartConfig } from "@/components/dither-kit/chart-context"
import { Grid } from "@/components/dither-kit/grid"
import type { Rgb, Seed } from "@/components/dither-kit/palette"
import { Tooltip } from "@/components/dither-kit/tooltip"

const NETWORK_SENT_COLOR = "oklch(0.73 0.15 65)"
const NETWORK_RECEIVED_COLOR = "oklch(0.78 0.11 205)"
const NETWORK_SENT_SEED = seedFromCssColor(NETWORK_SENT_COLOR)
const NETWORK_RECEIVED_SEED = seedFromCssColor(NETWORK_RECEIVED_COLOR)
const NODE_STORAGE_COLOR = "oklch(0.72 0.13 75)"
const NODE_STORAGE_SEED = seedFromCssColor(NODE_STORAGE_COLOR)
const RESOURCE_VISUAL_FLOOR_RATIO = 0.06

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

function oklchToRgb(L: number, C: number, h: number): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l_ = L + 0.396_337_777_4 * a + 0.215_803_757_3 * b
  const m_ = L - 0.105_561_345_8 * a - 0.063_854_172_8 * b
  const s_ = L - 0.089_484_177_5 * a - 1.291_485_548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const rLin = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s
  const gLin = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s
  const bLin = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s
  const toSrgb = (channel: number) => {
    const c =
      channel <= 0.003_130_8
        ? 12.92 * channel
        : 1.055 * channel ** (1 / 2.4) - 0.055
    return Math.round(clamp01(c) * 255)
  }
  return [toSrgb(rLin), toSrgb(gLin), toSrgb(bLin)]
}

function seedFromOklch(L: number, C: number, h: number): Seed {
  const fill = oklchToRgb(L, C, h)
  const line = oklchToRgb(Math.min(0.92, L + 0.08), C * 0.85, h)
  const star = oklchToRgb(Math.min(0.95, L + 0.14), C * 0.7, h)
  return { fill, line, star }
}

function seedFromCssColor(color: string): Seed {
  const match = color.match(/oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)/i)
  if (match) {
    return seedFromOklch(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  return seedFromOklch(0.72, 0.1, 200)
}

function HistoryXAxis() {
  const ctx = useChartPart("XAxis")
  if (!ctx.ready || ctx.dataLength === 0) return null

  const last = ctx.dataLength - 1
  const mid = Math.round(last / 2)
  const y = ctx.plot.height + 7

  return (
    <g className="fill-current font-mono text-[0.625rem] text-muted-foreground">
      {[
        { index: 0, label: "-6m" },
        { index: mid, label: "-3m" },
        { index: last, label: "Now" },
      ].map(({ index, label }) => (
        <text
          key={`${index}-${label}`}
          x={ctx.xCenter(index) ?? 0}
          y={y}
          textAnchor="middle"
          dominantBaseline="hanging"
          fill="currentColor"
        >
          {label}
        </text>
      ))}
    </g>
  )
}

function numericOrZero(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function ResourceHistoryChart({
  data,
  resourceId,
  label,
  color,
  maxValue,
  replayToken,
  formatValue,
}: {
  data: Array<{
    timestamp: number
    value: number | null
    secondary: number | null
    received: number | null
    sent: number | null
  }>
  resourceId: "cpu" | "memory" | "storage" | "network"
  label: string
  color: string
  domainStart: number
  domainEnd: number
  maxValue?: number
  replayToken: number
  formatValue: (value: number) => string
}) {
  const chartSourceData = React.useMemo(() => {
    if (resourceId !== "storage") return data
    const firstKnownInstanceUsage = data.findIndex(
      (sample) => sample.value !== null
    )
    return firstKnownInstanceUsage < 0
      ? data
      : data.slice(firstKnownInstanceUsage)
  }, [data, resourceId])
  const hasPrimaryValues = React.useMemo(
    () => chartSourceData.some((sample) => sample.value !== null),
    [chartSourceData]
  )
  const chartConfig = React.useMemo<ChartConfig>(() => {
    if (resourceId === "network") {
      const config: ChartConfig = {
        receivedVisual: {
          label: "In",
          color: NETWORK_RECEIVED_SEED,
          tooltipDataKey: "received",
        },
        sentVisual: {
          label: "Out",
          color: NETWORK_SENT_SEED,
          tooltipDataKey: "sent",
        },
      }
      return config
    }
    if (resourceId === "storage") {
      const config: ChartConfig = {
        secondaryVisual: {
          label: "Node volume",
          color: NODE_STORAGE_SEED,
          tooltipDataKey: "secondary",
        },
      }
      if (hasPrimaryValues) {
        config.valueVisual = {
          label: "Instance quota",
          color: seedFromCssColor(color),
          tooltipDataKey: "value",
        }
      }
      return config
    }
    const config: ChartConfig = {
      valueVisual: {
        label,
        color: seedFromCssColor(color),
        tooltipDataKey: "value",
      },
    }
    return config
  }, [color, hasPrimaryValues, label, resourceId])

  const values = React.useMemo(
    () =>
      chartSourceData.map((sample) => ({
        timestamp: sample.timestamp,
        value: numericOrZero(sample.value),
        secondary: numericOrZero(sample.secondary),
        received: numericOrZero(sample.received),
        sent: numericOrZero(sample.sent),
      })),
    [chartSourceData]
  )

  const networkMaximum = React.useMemo(
    () =>
      values.reduce(
        (maximum, sample) => Math.max(maximum, sample.received + sample.sent),
        1
      ),
    [values]
  )

  const yDomain = React.useMemo((): [number, number] | undefined => {
    if (resourceId === "network") {
      return [0, networkMaximum * (1 + RESOURCE_VISUAL_FLOOR_RATIO / 2)]
    }
    if (resourceId === "memory" || resourceId === "storage") return [0, 100]
    if (resourceId === "cpu" && maxValue) return [0, maxValue]
    const peak = values.reduce((max, sample) => Math.max(max, sample.value), 0)
    return [0, Math.max(10, Math.ceil(peak * 1.15))]
  }, [maxValue, networkMaximum, resourceId, values])

  const chartData = React.useMemo(() => {
    const maximum = yDomain?.[1] ?? 1
    const floor = maximum * RESOURCE_VISUAL_FLOOR_RATIO
    const networkFloor = networkMaximum * (RESOURCE_VISUAL_FLOOR_RATIO / 2)

    return values.map((sample) => ({
      ...sample,
      valueVisual: Math.max(sample.value, floor),
      secondaryVisual: Math.max(sample.secondary, floor),
      receivedVisual: Math.max(sample.received, networkFloor),
      sentVisual: Math.max(sample.sent, networkFloor),
    }))
  }, [networkMaximum, values, yDomain])

  const margins = {
    top: resourceId === "network" || resourceId === "storage" ? 18 : 7,
    right: 6,
    bottom: 22,
    left: 6,
  }

  const chartClassName = "h-32 w-full"

  return (
    <div className="relative">
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

      {resourceId === "network" ? (
        <LineChart
          data={chartData}
          config={chartConfig}
          animate
          bloom="off"
          hovered
          margins={margins}
          replayOnDataChange={false}
          replayToken={replayToken}
          className={chartClassName}
          yDomain={yDomain}
        >
          <Grid horizontal vertical={false} strokeDasharray="2 4" />
          <HistoryXAxis />
          <Tooltip
            valueFormatter={(value, name) =>
              `${name === "receivedVisual" ? "↓" : "↑"} ${formatValue(value)}`
            }
          />
          <Line dataKey="receivedVisual" />
          <Line dataKey="sentVisual" />
        </LineChart>
      ) : (
        <AreaChart
          data={chartData}
          config={chartConfig}
          animate
          bloom="off"
          hovered
          margins={margins}
          replayOnDataChange={false}
          replayToken={replayToken}
          className={chartClassName}
          yDomain={yDomain}
        >
          <Grid horizontal vertical={false} strokeDasharray="2 4" />
          <HistoryXAxis />
          <Tooltip valueFormatter={(value) => formatValue(value)} />
          {resourceId === "storage" ? (
            <Area dataKey="secondaryVisual" variant="gradient" />
          ) : null}
          {/* Instance is painted last so it stays in front of node usage. */}
          {hasPrimaryValues ? (
            <Area dataKey="valueVisual" variant="gradient" />
          ) : null}
        </AreaChart>
      )}
    </div>
  )
}
