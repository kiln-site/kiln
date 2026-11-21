const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—"
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—"
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${Math.max(minutes, 0)}m`
}

// Hermes has no Intl.RelativeTimeFormat, so spell out the few forms needed.
export function formatRelative(time: number | string): string {
  const ms = typeof time === "number" ? time : Date.parse(time)
  const seconds = Math.round((ms - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return "just now"
  const [amount, unit] =
    abs < 3_600
      ? [Math.round(abs / 60), "m"]
      : abs < 86_400
        ? [Math.round(abs / 3_600), "h"]
        : [Math.round(abs / 86_400), "d"]
  return seconds < 0 ? `${amount}${unit} ago` : `in ${amount}${unit}`
}

export function formatClock(time: string | null): string {
  if (!time) return ""
  const date = new Date(time)
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}
