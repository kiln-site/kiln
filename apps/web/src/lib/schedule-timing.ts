import * as React from "react"

import {
  normalizeScheduleCron,
  validateScheduleCron,
} from "@workspace/contracts/schedules"

// Schedules are saved and run in UTC. The editor's presets take a time in the
// viewer's browser time zone and save the UTC cron it matches today, so a
// local time moves by an hour when daylight saving starts or ends.

export type SchedulePreset =
  | { readonly kind: "hourly"; readonly minute: number }
  | { readonly kind: "daily"; readonly minutes: number }
  | {
      readonly kind: "weekly"
      readonly minutes: number
      readonly weekday: number
    }
  | { readonly kind: "monthly"; readonly day: number; readonly minutes: number }

export type SchedulePresetKind = SchedulePreset["kind"]

/** The days a monthly preset offers, which every month has. */
export const scheduleMonthDays = 28

const minutesPerDay = 24 * 60
const integer = /^\d+$/u

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

/** How many minutes `timeZone` is ahead of UTC at `at`. */
export function timeZoneOffsetMinutes(timeZone: string, at: number) {
  let formatter = offsetFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      timeZone,
      year: "numeric",
    })
    offsetFormatters.set(timeZone, formatter)
  }
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {}
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  const local = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0
  )
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000)
}

/** Whether `timeZone` moves its clocks during the year containing `at`. */
export function timeZoneObservesDaylightSaving(timeZone: string, at: number) {
  const year = new Date(at).getUTCFullYear()
  return (
    timeZoneOffsetMinutes(timeZone, Date.UTC(year, 0, 1)) !==
    timeZoneOffsetMinutes(timeZone, Date.UTC(year, 6, 1))
  )
}

/**
 * The UTC cron for a preset in `timeZone`, or null when cron can't say it:
 * a monthly day that lands outside days 1–28 in UTC.
 */
export function schedulePresetCron(
  preset: SchedulePreset,
  timeZone: string,
  at: number
): string | null {
  const offset = timeZoneOffsetMinutes(timeZone, at)
  if (preset.kind === "hourly") {
    return `${mod(preset.minute - offset, 60)} * * * *`
  }
  const utc = preset.minutes - offset
  const dayShift = Math.floor(utc / minutesPerDay)
  const minutes = mod(utc, minutesPerDay)
  const time = `${minutes % 60} ${Math.floor(minutes / 60)}`
  if (preset.kind === "daily") return `${time} * * *`
  if (preset.kind === "weekly") {
    return `${time} * * ${mod(preset.weekday + dayShift, 7)}`
  }
  const day = preset.day + dayShift
  if (day < 1 || day > scheduleMonthDays) return null
  return `${time} ${day} * *`
}

/**
 * The preset a UTC cron is in `timeZone`, or null when it is a custom cron
 * the presets can't show.
 */
export function schedulePresetFromCron(
  cron: string,
  timeZone: string,
  at: number
): SchedulePreset | null {
  if (!validateScheduleCron(cron)) return null
  const fields = normalizeScheduleCron(cron).split(/\s+/u)
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields
  if (!integer.test(minute) || month !== "*") return null
  const offset = timeZoneOffsetMinutes(timeZone, at)
  if (hour === "*" && day === "*" && weekday === "*") {
    return { kind: "hourly", minute: mod(Number(minute) + offset, 60) }
  }
  if (!integer.test(hour)) return null
  const local = Number(hour) * 60 + Number(minute) + offset
  const dayShift = Math.floor(local / minutesPerDay)
  const minutes = mod(local, minutesPerDay)
  if (day === "*" && weekday === "*") return { kind: "daily", minutes }
  if (day === "*" && /^[0-7]$/u.test(weekday)) {
    return {
      kind: "weekly",
      minutes,
      weekday: mod(Number(weekday) + dayShift, 7),
    }
  }
  if (weekday === "*" && integer.test(day)) {
    // Both days must be ones the preset offers, or saving it again would
    // change the cron or be refused.
    const localDay = Number(day) + dayShift
    if (Number(day) > scheduleMonthDays) return null
    if (localDay < 1 || localDay > scheduleMonthDays) return null
    return { kind: "monthly", day: localDay, minutes }
  }
  return null
}

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
})
const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
})
const shortWeekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
})

/** "3:00 PM", for minutes after midnight. */
export function scheduleTimeLabel(minutes: number) {
  return timeFormatter.format(Date.UTC(2000, 0, 1, 0, minutes))
}

/** "Monday", for a cron weekday where 0 is Sunday. */
export function scheduleWeekdayLabel(weekday: number) {
  // 2 January 2000 was a Sunday.
  return weekdayFormatter.format(Date.UTC(2000, 0, 2 + weekday))
}

/** "Every day at 3:00 PM", in the time zone the preset was read in. */
export function schedulePresetLabel(preset: SchedulePreset) {
  switch (preset.kind) {
    case "hourly":
      return preset.minute === 0
        ? "Every hour"
        : `Every hour at :${String(preset.minute).padStart(2, "0")}`
    case "daily":
      return `Every day at ${scheduleTimeLabel(preset.minutes)}`
    case "weekly":
      return `Every ${scheduleWeekdayLabel(preset.weekday)} at ${scheduleTimeLabel(preset.minutes)}`
    case "monthly":
      return `Monthly on the ${ordinal(preset.day)} at ${scheduleTimeLabel(preset.minutes)}`
  }
}

/** "Daily, 3:00 PM", short enough for a table cell. */
export function schedulePresetShortLabel(preset: SchedulePreset) {
  switch (preset.kind) {
    case "hourly":
      return preset.minute === 0
        ? "Hourly"
        : `Hourly at :${String(preset.minute).padStart(2, "0")}`
    case "daily":
      return `Daily, ${scheduleTimeLabel(preset.minutes)}`
    case "weekly":
      return `${shortWeekdayFormatter.format(Date.UTC(2000, 0, 2 + preset.weekday))}, ${scheduleTimeLabel(preset.minutes)}`
    case "monthly":
      return `${ordinal(preset.day)}, ${scheduleTimeLabel(preset.minutes)}`
  }
}

const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>()

/** "CST", or "GMT+5:30" where a zone has no short name. */
export function timeZoneShortName(timeZone: string, at: number) {
  let formatter = zoneNameFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    })
    zoneNameFormatters.set(timeZone, formatter)
  }
  return (
    formatter.formatToParts(at).find((part) => part.type === "timeZoneName")
      ?.value ?? timeZone
  )
}

const subscribe = () => () => {}
const browserTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
const serverTimeZone = () => "UTC"

/**
 * The viewer's browser time zone. The server and the first client render use
 * UTC, so labels built from it hydrate and then switch to local time.
 */
export function useBrowserTimeZone() {
  return React.useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone)
}

function ordinal(value: number) {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  const suffix = ["th", "st", "nd", "rd"][value % 10] ?? "th"
  return `${value}${suffix}`
}

function mod(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor
}
